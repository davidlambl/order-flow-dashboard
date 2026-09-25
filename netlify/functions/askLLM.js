// netlify/functions/askLLM.js
// Multi-provider chat proxy with SSE streaming: Anthropic, OpenAI, Google Gemini.
//
// Key handling:
//   - BYOK (userApiKey in the body): the caller pays; any provider, any model.
//   - Server key (ANTHROPIC_API_KEY): only for holders of a valid access token,
//     subject to a model allowlist, an output-token cap and a daily quota.
//   If TOKEN_SECRET is not configured, server-key requests are refused (503).
//
// Timeouts: LLM_TIMEOUT_MS bounds the time to the upstream's first byte (response
// headers) only; a streamed reply is relayed for as long as it runs, bounded by the
// platform's function timeout, and stops early if the client disconnects.

import {
  corsHeaders, preflight, jsonResponse, errorResponse, newRequestId,
  fetchWithTimeout, isTimeoutError, clientIp, rateLimit, rateLimitResponse,
} from './lib/http.js';
import { verifyRequestToken } from './lib/auth.js';
import { checkDailyQuota, logUsage } from './lib/quota.js';
import { parseTicker } from './lib/ticker.js';
import { PUT_CALL } from '../../shared/thresholds.js';

const ALLOWED_HEADERS = 'x-api-key';
const PROVIDERS = ['anthropic', 'openai', 'gemini'];
const KEY_PREFIX = { anthropic: 'sk-ant-', openai: 'sk-', gemini: 'AIza' };
// Used when the request names no model. The OpenAI and Gemini defaults are re-verified each
// phase against the providers' model lists: gpt-4o and gemini-2.0-flash were retired in 2026.
const DEFAULT_MODEL = { anthropic: 'claude-opus-5', openai: 'gpt-5.1', gemini: 'gemini-3.8-flash' };

// Request-shape limits (cost control + abuse resistance)
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8 * 1024;
const MAX_CONTEXT_CHARS = 32 * 1024;
const MAX_MODEL_CHARS = 100;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60_000; // time to first byte, not the whole stream

function buildSystemPrompt(ticker, financialContext) {
  return `You are a senior institutional equity & options analyst embedded in a trading dashboard. Your role is to provide concise, actionable analysis based on the live market data provided below.

CURRENT TICKER: ${ticker || 'UNKNOWN'}
TIMESTAMP: ${new Date().toISOString()}

=== LIVE DASHBOARD DATA ===
${financialContext || 'No data available yet.'}
=== END DATA ===

ANALYSIS GUIDELINES:
- Reference the exact numbers from the data above. Never make up values.
- "Premium Traded" is calls minus puts by volume × mid price with no buy/sell inference; say which side dominated and by how much, and do not present it as confirmed directional flow.
- For GEX/Gamma Exposure, identify the "pin" strikes where dealers will hedge.
- Dark Pool % is a statistical estimate derived from IV, not measured off-exchange volume; treat it as low-confidence colour, not evidence.
- For Max Pain, explain how far the current price is from max pain and what that implies for expiration.
- For Put/Call Ratio, contextualize: <${PUT_CALL.bullishBelow} is bullish, ${PUT_CALL.bullishBelow}-${PUT_CALL.bearishAbove} neutral, >${PUT_CALL.bearishAbove} bearish.
- Be direct. Use short paragraphs. Bold key numbers and levels.
- If the data is unavailable or stale, say so rather than speculating.
- Metrics shown as "—" or "n/a" are unavailable; say so instead of inferring them.
- Sign off observations with a confidence level: HIGH / MEDIUM / LOW.`;
}

// ─── Model policy ────────────────────────────────────────────────────────────

/** Comma-separated patterns; a trailing '*' matches any suffix. Default: any Claude model. */
function allowedModelPatterns() {
  const raw = process.env.ALLOWED_MODELS || 'claude-*';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function modelAllowed(model, patterns = allowedModelPatterns()) {
  return patterns.some((p) => (p.endsWith('*') ? model.startsWith(p.slice(0, -1)) : model === p));
}

/**
 * Maximum output tokens per model family, as [model-id prefix, cap]. Lookup uses the LONGEST
 * matching prefix, so order does not matter and a dated id ('claude-3-haiku-20240307')
 * or a point release ('gpt-5.1', 'gemini-2.5-flash') resolves to its family. A request
 * above the model's limit is rejected upstream (400), which is why an unknown model
 * gets the conservative DEFAULT_OUTPUT_CAP.
 */
export const PROVIDER_OUTPUT_CAPS = [
  // Anthropic
  ['claude-fable-5-1', 128000], ['claude-fable-5', 128000], ['claude-mythos-', 128000],
  ['claude-opus-5-5', 128000], ['claude-opus-5', 128000], ['claude-opus-4-8', 128000],
  ['claude-opus-4-7', 128000], ['claude-opus-4-6', 128000], ['claude-sonnet-5', 128000],
  ['claude-sonnet-4-6', 128000],
  ['claude-haiku-4-5', 64000], ['claude-opus-4-5', 64000], ['claude-sonnet-4-5', 64000],
  ['claude-sonnet-4-0', 64000], ['claude-sonnet-4-20250514', 64000], ['claude-3-7-sonnet', 64000],
  ['claude-opus-4-1', 32000], ['claude-opus-4-0', 32000], ['claude-opus-4-20250514', 32000], // 4.0: alias and dated id
  ['claude-3-5-haiku', 8192], ['claude-3-5-sonnet', 8192],
  ['claude-3-haiku', 4096], ['claude-3-opus', 4096],
  // OpenAI (gpt-5.x and o-series need max_completion_tokens; see callOpenAI)
  ['gpt-5', 128000], ['o1', 100000], ['o3', 100000], ['o4', 100000],
  ['gpt-4.1', 32768], ['gpt-4o', 16384], ['chatgpt-4o', 16384],
  ['gpt-4-turbo', 4096], ['gpt-4', 8192], ['gpt-3.5', 4096],
  // Google
  ['gemini-3', 65536], ['gemini-2.5', 65536], ['gemini-2.0', 8192], ['gemini-1.5', 8192],
];

/** Cap for a model the table does not know. */
export const DEFAULT_OUTPUT_CAP = 16384;

/** Ceiling for bring-your-own-key requests, whatever the model allows: bounds one reply's size and latency. */
export const BYOK_OUTPUT_CAP = 16384;

/** The model's own output limit: the longest matching prefix in PROVIDER_OUTPUT_CAPS, else DEFAULT_OUTPUT_CAP. */
export function providerOutputCap(model) {
  if (typeof model !== 'string') return DEFAULT_OUTPUT_CAP;
  let best = null;
  for (const [prefix, cap] of PROVIDER_OUTPUT_CAPS) {
    if (model.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, cap];
  }
  return best ? best[1] : DEFAULT_OUTPUT_CAP;
}

/**
 * Output cap for one request: the model's limit, further capped at BYOK_OUTPUT_CAP for a
 * user's own key, or by MAX_OUTPUT_TOKENS (default 4096) for server-key spend.
 */
export function maxOutputTokens(model, keySource) {
  const cap = providerOutputCap(model);
  if (keySource !== 'server') return Math.min(cap, BYOK_OUTPUT_CAP);
  const envCap = Number(process.env.MAX_OUTPUT_TOKENS);
  return Math.min(cap, Number.isFinite(envCap) && envCap > 0 ? envCap : 4096);
}

// ─── Provider calls ──────────────────────────────────────────────────────────

function callAnthropic({ apiKey, model, messages, systemPrompt, stream, maxTokens, signal }) {
  return fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      stream,
      messages,
    }),
  }, LLM_TIMEOUT_MS, signal, { bodyTimeout: false });
}

function callOpenAI({ apiKey, model, messages, systemPrompt, stream, maxTokens, signal }) {
  // o-series and gpt-5.x reject max_tokens and take the system prompt as a developer message.
  const isReasoning = /^(o[134]|gpt-5)/.test(model);
  return fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      stream,
      ...(isReasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      messages: [
        { role: isReasoning ? 'developer' : 'system', content: systemPrompt },
        ...messages,
      ],
    }),
  }, LLM_TIMEOUT_MS, signal, { bodyTimeout: false });
}

function callGemini({ apiKey, model, messages, systemPrompt, stream, maxTokens, signal }) {
  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}`);
  if (stream) url.searchParams.set('alt', 'sse');
  return fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  }, LLM_TIMEOUT_MS, signal, { bodyTimeout: false });
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini };

function extractText(provider, data) {
  switch (provider) {
    case 'openai': return data.choices?.[0]?.message?.content || 'No response generated.';
    case 'gemini': return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || 'No response generated.';
    default: return data.content?.find((b) => b.type === 'text')?.text || 'No response generated.';
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Returns { error: { code, message } } or { value }. */
export function validatePayload(payload) {
  const { messages, financialContext, ticker, userApiKey, model, provider, stream } = payload || {};

  if (!PROVIDERS.includes(provider)) {
    return { error: { code: 'PROVIDER_REQUIRED', message: `provider must be one of ${PROVIDERS.join(', ')}` } };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: { code: 'MESSAGES_REQUIRED', message: 'messages array is required' } };
  }
  if (messages.length > MAX_MESSAGES) {
    return { error: { code: 'TOO_MANY_MESSAGES', message: `at most ${MAX_MESSAGES} messages per request` } };
  }
  const cleanMessages = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return { error: { code: 'INVALID_MESSAGE', message: 'each message needs role user|assistant and string content' } };
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return { error: { code: 'MESSAGE_TOO_LONG', message: `message content exceeds ${MAX_MESSAGE_CHARS} characters` } };
    }
    cleanMessages.push({ role: m.role, content: m.content });
  }
  if (financialContext != null && (typeof financialContext !== 'string' || financialContext.length > MAX_CONTEXT_CHARS)) {
    return { error: { code: 'CONTEXT_TOO_LONG', message: `financialContext must be a string of at most ${MAX_CONTEXT_CHARS} characters` } };
  }
  let cleanTicker = null;
  if (ticker != null && ticker !== '') {
    cleanTicker = parseTicker(ticker);
    if (!cleanTicker) return { error: { code: 'INVALID_TICKER', message: 'ticker has an invalid format' } };
  }
  const hasUserKey = typeof userApiKey === 'string' && userApiKey.trim().length > 0;
  if (hasUserKey && !userApiKey.trim().startsWith(KEY_PREFIX[provider])) {
    return { error: { code: 'KEY_PROVIDER_MISMATCH', message: `The API key does not look like a ${provider} key` } };
  }
  let cleanModel = DEFAULT_MODEL[provider];
  if (model != null && model !== '') {
    if (typeof model !== 'string' || model.length > MAX_MODEL_CHARS || !MODEL_RE.test(model)) {
      return { error: { code: 'INVALID_MODEL', message: 'model has an invalid format' } };
    }
    cleanModel = model;
  }
  return {
    value: {
      provider,
      messages: cleanMessages,
      financialContext: financialContext || '',
      ticker: cleanTicker,
      userApiKey: hasUserKey ? userApiKey.trim() : null,
      model: cleanModel,
      stream: Boolean(stream),
    },
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight(req, ALLOWED_HEADERS);
  if (req.method !== 'POST') return jsonResponse(req, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' }, 405);

  const requestId = newRequestId();

  const rl = rateLimit(`askLLM:${clientIp(req)}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(req, rl.retryAfterSec, requestId);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(req, { error: 'Invalid JSON body', code: 'INVALID_JSON', requestId }, 400);
  }

  const validated = validatePayload(payload);
  if (validated.error) {
    return jsonResponse(req, { ...validated.error, error: validated.error.message, requestId }, 400);
  }
  const { provider, messages, financialContext, ticker, userApiKey, model, stream } = validated.value;

  // ── Key selection ──
  let apiKey = userApiKey;
  let keySource = 'user';
  let claims = null;

  if (!apiKey) {
    if (provider !== 'anthropic' || !process.env.ANTHROPIC_API_KEY) {
      return jsonResponse(req, {
        error: `No API key for ${provider}. Add your key in Settings.`, code: 'KEY_REQUIRED', requestId,
      }, 400);
    }
    const auth = await verifyRequestToken(req);
    if (!auth.ok) {
      return jsonResponse(req, { error: auth.message, code: auth.code, requestId }, auth.status);
    }
    claims = auth.claims;
    if (!modelAllowed(model)) {
      return jsonResponse(req, {
        error: 'That model is not available with the shared key. Add your own API key in Settings to use it.',
        code: 'MODEL_NOT_ALLOWED', requestId,
      }, 403);
    }
    const quota = await checkDailyQuota({ sub: claims.sub, tier: claims.tier });
    if (!quota.ok) {
      return jsonResponse(req, {
        error: quota.error ? 'Usage quota is temporarily unavailable' : `Daily request quota reached (${quota.limit}/day)`,
        code: quota.error ? 'QUOTA_UNAVAILABLE' : 'QUOTA_EXCEEDED',
        requestId,
      }, quota.error ? 503 : 429);
    }
    apiKey = process.env.ANTHROPIC_API_KEY;
    keySource = 'server';
  }

  const systemPrompt = buildSystemPrompt(ticker, financialContext);
  const maxTokens = maxOutputTokens(model, keySource);

  let response;
  try {
    response = await CALLERS[provider]({
      apiKey, model, messages, systemPrompt, stream, maxTokens, signal: req.signal,
    });
  } catch (err) {
    return errorResponse(req, {
      status: isTimeoutError(err) ? 504 : 502,
      code: isTimeoutError(err) ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `Could not reach the ${provider} API`,
      requestId, cause: err,
    });
  }

  if (keySource === 'server') {
    // Not awaited: usage logging must never delay or fail the response.
    logUsage({ sub: claims.sub, tier: claims.tier, provider, model, stream, keySource, requestId });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[${requestId}] ${provider} ${response.status} (${keySource} key, model=${model}):`, detail.slice(0, 500));
    const status = response.status;
    const message = status === 401 || status === 403
      ? `The ${provider} API rejected the API key`
      : status === 429
        ? `The ${provider} API is rate limiting requests`
        : status === 400 && keySource === 'user'
          ? `The ${provider} API rejected the request (check the model name)`
          : `The ${provider} API returned an error`;
    return jsonResponse(req, { error: message, code: 'UPSTREAM_ERROR', upstreamStatus: status, requestId },
      [401, 403, 429].includes(status) ? status : 502);
  }

  if (stream) {
    return new Response(response.body, {
      headers: {
        ...corsHeaders(req, ALLOWED_HEADERS),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Provider': provider,
        'X-Request-Id': requestId,
      },
    });
  }

  const data = await response.json().catch(() => null);
  if (!data) {
    return errorResponse(req, { status: 502, code: 'UPSTREAM_INVALID', message: `Unreadable response from ${provider}`, requestId });
  }
  return jsonResponse(req, { message: extractText(provider, data), requestId });
};
