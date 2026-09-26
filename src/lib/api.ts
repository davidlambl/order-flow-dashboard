// src/lib/api.ts
// Centralized API helpers — all calls route through Netlify Functions.
// src/lib/api.test.js drives askLLMStream under jsdom. Still Node-loadable: relative
// imports carry their extension and nothing touches browser globals at import time.

import { getAuthHeaders, clearTokenIfDead } from './auth.js';
import { getPreference } from './store.js';
import { drainSSEBuffer, parseSSEEvents, STOP_REASON } from './sse.js';
import type { StopReason } from './sse.js';
import type { MarketData, LiveQuote, TickerContext, ModelList, ApiErrorBody } from '../../types/market.js';

const FUNCTION_BASE = '/.netlify/functions';

/**
 * The Error apiError() builds: a plain Error (its name stays 'Error') with the function's `code`, null when the body
 * had none, the HTTP `status`, and `requestId` only when the body had one. `code` is any string, not an ApiErrorCode:
 * the client cannot verify the server's vocabulary.
 */
export interface ApiError extends Error {
  code: string | null;
  status: number;
  requestId?: string;
}

/**
 * Build an Error from a function's JSON error body. Clears the stored access
 * token when the server says it is expired/invalid/revoked, so the UI re-locks.
 * `body` is the parsed error response, or `{ error: res.statusText }` when it was not JSON.
 */
function apiError(body: Partial<ApiErrorBody> | null | undefined, status: number, fallback: string): ApiError {
  const code = body?.code || null;
  clearTokenIfDead(code);
  const message = body?.error
    || (status === 401 ? 'Access token required' : status === 429 ? 'Too many requests' : `${fallback}: ${status}`);
  const err: ApiError = Object.assign(new Error(message), { code, status });
  if (body?.requestId) err.requestId = body.requestId;
  return err;
}

/**
 * Fetch computed market data from our serverless function.
 * Supports BYOK Tradier for real-time data (or the server's key for access-token holders,
 * hence the Authorization header); falls back to free CBOE delayed quotes.
 * @param ticker - Stock symbol
 * @param signal - Optional abort signal for cancellation
 */
export async function fetchMarketData(ticker: string, signal: AbortSignal | null = null): Promise<MarketData> {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getMarketData?${params}`;

  const headers: Record<string, string> = { ...getAuthHeaders() };
  const tradierKey = getPreference('data_tradier_key');
  if (tradierKey) headers['x-tradier-key'] = tradierKey;

  const options: RequestInit = { headers };
  if (signal) options.signal = signal;

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    // A catch binding is unknown. fetch rejects with an Error (a TypeError, or the signal's reason: an AbortError by
    // default), so this asserts that instead of narrowing, which would change what any other abort reason does:
    // `.message` stays the unguarded read it was. The same in fetchTickerContext and fetchLiveQuote.
    throw new Error(`Network error: ${(networkErr as Error).message}`, { cause: networkErr });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'API error');
  }
  return res.json();
}

/** Stop reasons meaning the model declined, as opposed to running out of room or erroring. */
const DECLINED: ReadonlySet<StopReason | null> = new Set([STOP_REASON.REFUSAL, STOP_REASON.SAFETY, STOP_REASON.PROMPT_BLOCKED]);

/** The error to throw once `signal` has aborted: its reason when that is an Error (an AbortError by default). */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The stream was aborted', 'AbortError');
}

/** One conversation turn as askLLM takes it: it rejects any other role and reads nothing but role and content. */
export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** askLLMStream's request, posted to askLLM as JSON with `stream: true`. */
export interface AskLLMParams {
  messages: LLMMessage[];
  financialContext: string;
  ticker: string;
  /** The user's own key for `provider` (BYOK), or null for the server's key. */
  userApiKey: string | null;
  /** A model id, or '' for askLLM's default for the provider. */
  model: string;
  /** 'anthropic', 'openai' or 'gemini'. */
  provider: string;
}

/** What askLLMStream resolves to (see its @returns). */
export interface StreamResult {
  stopReason: StopReason | null;
  chars: number;
  requestId: string | null;
  /** Whose stream was parsed: the X-Provider header, else the requested provider, else 'anthropic'. */
  provider: string;
}

/**
 * The errors askLLMStream throws about the reply itself (see its @throws): plain Errors (name 'Error') with these
 * properties. `providerCode` and `partial` come with STREAM_ERROR; `stopReason` with REFUSED, and with EMPTY_RESPONSE
 * unless the response had no body at all.
 */
export interface LLMStreamError extends Error {
  code: 'STREAM_ERROR' | 'REFUSED' | 'EMPTY_RESPONSE';
  requestId: string | null;
  providerCode?: string | number | null;
  partial?: boolean;
  stopReason?: StopReason | null;
}

/** What each throw site's Object.assign source is checked against (`satisfies`): LLMStreamError's own properties. */
type LLMStreamErrorProps = Omit<LLMStreamError, keyof Error>;

/**
 * Stream a message to the AI co-pilot with financial context. askLLM relays the
 * provider's SSE body (Anthropic, OpenAI or Gemini; the X-Provider header says which),
 * and each text delta is passed to `onChunk` as it arrives.
 *
 * @param signal - aborts the request and cancels the body reader; the
 *   returned promise then rejects with the signal's reason (an AbortError by default)
 * @returns `stopReason` is a STOP_REASON value (the last one the stream reported), or null when the
 *   stream ended without one (cut off upstream); `chars` counts the text delivered.
 * @throws {Error} the function's JSON error (see apiError); code 'STREAM_ERROR' when the provider
 *   reports an error mid-stream (`providerCode`, and `partial` when text was already delivered);
 *   'REFUSED' when the model declined without any text; 'EMPTY_RESPONSE' when no text arrived.
 *   Stream errors carry `requestId` (X-Request-Id) for the function log.
 */
export async function askLLMStream(
  { messages, financialContext, ticker, userApiKey, model, provider }: AskLLMParams,
  onChunk: (text: string) => void,
  signal: AbortSignal | null = null,
): Promise<StreamResult> {
  const options: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({
      messages, financialContext, ticker, userApiKey, model, provider, stream: true,
    }),
  };
  if (signal) options.signal = signal;
  const res = await fetch(`${FUNCTION_BASE}/askLLM`, options);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'LLM error');
  }

  const effectiveProvider = res.headers.get('X-Provider') || provider || 'anthropic';
  const requestId = res.headers.get('X-Request-Id') || null;
  if (!res.body) {
    throw Object.assign(new Error('The model returned an empty response'), { code: 'EMPTY_RESPONSE', requestId } satisfies LLMStreamErrorProps);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Cancelling the reader settles a pending read even when the body is not tied to the
  // fetch signal (a relayed or test stream), so an abort never waits for the next chunk.
  // onAbort is only ever added to a non-null signal (just below), so `signal?.reason` is always the reason; the `?.`
  // is for the compiler, which cannot see that from inside the closure (reader.cancel(undefined) is reader.cancel()).
  const onAbort = () => { reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });

  let buffer = '';
  let chars = 0;
  let stopReason: StopReason | null = null;
  let stopRaw: string | null = null;
  const handle = (payloads: string[]) => {
    for (const payload of payloads) {
      for (const event of parseSSEEvents(payload, effectiveProvider)) {
        if (event.type === 'text') {
          chars += event.text.length;
          onChunk(event.text);
        } else if (event.type === 'stop') {
          stopReason = event.reason; // the last one wins; keep reading
          stopRaw = event.raw;
        } else if (event.type === 'error') {
          throw Object.assign(new Error(event.message || `The ${effectiveProvider} API reported an error`), {
            code: 'STREAM_ERROR', providerCode: event.code || null, requestId, partial: chars > 0,
          } satisfies LLMStreamErrorProps);
        }
      }
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError(signal); // a cancel settles the read as done
      if (done) {
        buffer += decoder.decode(); // flush a split multi-byte character
        handle(drainSSEBuffer(buffer, { final: true }).payloads); // the last line may lack its newline
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSSEBuffer(buffer);
      buffer = drained.rest;
      handle(drained.payloads);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {}); // releases the upstream on an early exit; a no-op once done
  }

  if (chars === 0) {
    if (DECLINED.has(stopReason)) {
      throw Object.assign(new Error(`The model declined to answer (${stopRaw || stopReason})`), {
        code: 'REFUSED', stopReason, requestId,
      } satisfies LLMStreamErrorProps);
    }
    throw Object.assign(new Error('The model returned an empty response'), { code: 'EMPTY_RESPONSE', stopReason, requestId } satisfies LLMStreamErrorProps);
  }
  return { stopReason, chars, requestId, provider: effectiveProvider };
}

/**
 * Fetch enriched ticker context from Finnhub (news, earnings, analyst, technicals, fundamentals).
 * @param ticker - Stock symbol
 * @param signal - Optional abort signal for cancellation
 */
export async function fetchTickerContext(ticker: string, signal: AbortSignal | null = null): Promise<TickerContext> {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getTickerContext?${params}`;

  const headers: Record<string, string> = { ...getAuthHeaders() };
  const finnhubKey = getPreference('data_finnhub_key');
  if (finnhubKey) headers['x-finnhub-key'] = finnhubKey;

  const options: RequestInit = { headers };
  if (signal) options.signal = signal;

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    // Asserted as in fetchMarketData.
    throw new Error(`Network error: ${(networkErr as Error).message}`, { cause: networkErr });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'Ticker context error');
  }
  return res.json();
}

/**
 * Fetch available models from any supported provider.
 * @param userApiKey - User-provided API key
 * @param provider - 'anthropic' | 'openai' | 'gemini'
 */
export async function fetchModels(userApiKey: string | null = null, provider = 'anthropic'): Promise<ModelList> {
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (userApiKey) headers['x-api-key'] = userApiKey;

  const params = new URLSearchParams({ provider });
  const res = await fetch(`${FUNCTION_BASE}/getModels?${params}`, { headers });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'Models API error');
  }
  return res.json();
}

/**
 * Fetches real-time stock quote via Netlify function.
 * Uses Yahoo Finance (including extended hours where available) and falls back to Finnhub.
 * @param ticker - Stock symbol
 * @param signal - Optional abort signal for request cancellation
 * @returns Quote data with source indicator (yahoo-post, yahoo-pre, yahoo-regular, or finnhub)
 */
export async function fetchLiveQuote(ticker: string, signal: AbortSignal | null = null): Promise<LiveQuote> {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getLiveQuote?${params}`;

  const headers: Record<string, string> = { ...getAuthHeaders() };
  const finnhubKey = getPreference('data_finnhub_key');
  if (finnhubKey) headers['x-finnhub-key'] = finnhubKey;

  const options: RequestInit = { headers };
  if (signal) options.signal = signal;

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    // Asserted as in fetchMarketData.
    throw new Error(`Network error: ${(networkErr as Error).message}`, { cause: networkErr });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'Live quote error');
  }
  return res.json();
}
