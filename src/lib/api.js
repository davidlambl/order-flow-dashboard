// src/lib/api.js
// Centralized API helpers — all calls route through Netlify Functions.
// src/lib/api.test.js drives askLLMStream under jsdom. Still Node-loadable: relative
// imports carry their extension and nothing touches browser globals at import time.

import { getAuthHeaders, clearTokenIfDead } from './auth.js';
import { getPreference } from './store.js';
import { drainSSEBuffer, parseSSEEvents, STOP_REASON } from './sse.js';

const FUNCTION_BASE = '/.netlify/functions';

/**
 * Build an Error from a function's JSON error body. Clears the stored access
 * token when the server says it is expired/invalid/revoked, so the UI re-locks.
 */
function apiError(body, status, fallback) {
  const code = body?.code || null;
  clearTokenIfDead(code);
  const err = new Error(
    body?.error
      || (status === 401 ? 'Access token required' : status === 429 ? 'Too many requests' : `${fallback}: ${status}`),
  );
  err.code = code;
  err.status = status;
  if (body?.requestId) err.requestId = body.requestId;
  return err;
}

/**
 * Fetch computed market data from our serverless function.
 * Supports BYOK Tradier for real-time data (or the server's key for access-token holders,
 * hence the Authorization header); falls back to free CBOE delayed quotes.
 * @param {string} ticker - Stock symbol
 * @param {AbortSignal|null} [signal] - Optional abort signal for cancellation
 */
export async function fetchMarketData(ticker, signal = null) {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getMarketData?${params}`;

  const headers = { ...getAuthHeaders() };
  const tradierKey = getPreference('data_tradier_key');
  if (tradierKey) headers['x-tradier-key'] = tradierKey;

  const options = { headers };
  if (signal) options.signal = signal;

  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    throw new Error(`Network error: ${networkErr.message}`, { cause: networkErr });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'API error');
  }
  return res.json();
}

/** Stop reasons meaning the model declined, as opposed to running out of room or erroring. */
const DECLINED = new Set([STOP_REASON.REFUSAL, STOP_REASON.SAFETY, STOP_REASON.PROMPT_BLOCKED]);

/** The error to throw once `signal` has aborted: its reason when that is an Error (an AbortError by default). */
function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The stream was aborted', 'AbortError');
}

/**
 * Stream a message to the AI co-pilot with financial context. askLLM relays the
 * provider's SSE body (Anthropic, OpenAI or Gemini; the X-Provider header says which),
 * and each text delta is passed to `onChunk` as it arrives.
 *
 * @param {object} params - { messages, financialContext, ticker, userApiKey, model, provider }
 * @param {(text: string) => void} onChunk
 * @param {AbortSignal|null} [signal] - aborts the request and cancels the body reader; the
 *   returned promise then rejects with the signal's reason (an AbortError by default)
 * @returns {Promise<{ stopReason: string|null, chars: number, requestId: string|null, provider: string }>}
 *   `stopReason` is a STOP_REASON value (the last one the stream reported), or null when the
 *   stream ended without one (cut off upstream); `chars` counts the text delivered.
 * @throws {Error} the function's JSON error (see apiError); code 'STREAM_ERROR' when the provider
 *   reports an error mid-stream (`providerCode`, and `partial` when text was already delivered);
 *   'REFUSED' when the model declined without any text; 'EMPTY_RESPONSE' when no text arrived.
 *   Stream errors carry `requestId` (X-Request-Id) for the function log.
 */
export async function askLLMStream({ messages, financialContext, ticker, userApiKey, model, provider }, onChunk, signal = null) {
  const options = {
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
    throw Object.assign(new Error('The model returned an empty response'), { code: 'EMPTY_RESPONSE', requestId });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Cancelling the reader settles a pending read even when the body is not tied to the
  // fetch signal (a relayed or test stream), so an abort never waits for the next chunk.
  const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });

  let buffer = '';
  let chars = 0;
  let stopReason = null;
  let stopRaw = null;
  const handle = (payloads) => {
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
          });
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
      });
    }
    throw Object.assign(new Error('The model returned an empty response'), { code: 'EMPTY_RESPONSE', stopReason, requestId });
  }
  return { stopReason, chars, requestId, provider: effectiveProvider };
}

/**
 * Fetch enriched ticker context from Finnhub (news, earnings, analyst, technicals, fundamentals).
 * @param {string} ticker - Stock symbol
 * @param {AbortSignal|null} [signal] - Optional abort signal for cancellation
 */
export async function fetchTickerContext(ticker, signal = null) {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getTickerContext?${params}`;

  const headers = { ...getAuthHeaders() };
  const finnhubKey = getPreference('data_finnhub_key');
  if (finnhubKey) headers['x-finnhub-key'] = finnhubKey;

  const options = { headers };
  if (signal) options.signal = signal;

  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    throw new Error(`Network error: ${networkErr.message}`, { cause: networkErr });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'Ticker context error');
  }
  return res.json();
}

/**
 * Fetch available models from any supported provider.
 * @param {string} userApiKey - User-provided API key
 * @param {string} provider - 'anthropic' | 'openai' | 'gemini'
 */
export async function fetchModels(userApiKey = null, provider = 'anthropic') {
  const headers = { ...getAuthHeaders() };
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
 * @param {string} ticker - Stock symbol
 * @param {AbortSignal|null} [signal] - Optional abort signal for request cancellation
 * @returns {Promise<Object>} Quote data with source indicator (yahoo-post, yahoo-pre, yahoo-regular, or finnhub)
 */
export async function fetchLiveQuote(ticker, signal = null) {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getLiveQuote?${params}`;

  const headers = { ...getAuthHeaders() };
  const finnhubKey = getPreference('data_finnhub_key');
  if (finnhubKey) headers['x-finnhub-key'] = finnhubKey;

  const options = { headers };
  if (signal) options.signal = signal;

  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    throw new Error(`Network error: ${networkErr.message}`, { cause: networkErr });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw apiError(err, res.status, 'Live quote error');
  }
  return res.json();
}
