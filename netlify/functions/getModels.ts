// netlify/functions/getModels.ts
// Multi-provider model listing: Anthropic, OpenAI, Google Gemini.
// BYOK via x-api-key; the server's Anthropic key is used only for access-token holders.

import {
  preflight, jsonResponse, errorResponse, newRequestId,
  fetchWithTimeout, isTimeoutError, clientIp, rateLimit, rateLimitResponse,
} from './lib/http.js';
import { verifyRequestToken } from './lib/auth.js';
import type { ApiErrorBody, LlmProvider, ModelInfo, ModelList } from '../../types/market.js';

const ALLOWED_HEADERS = 'x-api-key';
const PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openai', 'gemini'];
const KEY_PREFIX: Record<LlmProvider, string> = { anthropic: 'sk-ant-', openai: 'sk-', gemini: 'AIza' };
const UPSTREAM_TIMEOUT_MS = 8000;
const RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };

// res.json() is unknown. Each list is asserted once, where it is parsed, to the fields read, typed as the provider
// documents them (Anthropic's `type` is only compared). The reads cope with a missing list, a missing display name
// and a Gemini model without methods; a value of another type is relayed or filtered as it is, or makes a read
// throw (a null body does, as does a list that is not an array), which the handler answers with a 502.

/** Anthropic's /v1/models page. */
interface AnthropicModelsBody {
  data?: { type?: unknown; id: string; display_name?: string }[];
}

/** OpenAI's /v1/models. */
interface OpenAIModelsBody {
  data?: { id: string }[];
}

/** Gemini's /v1beta/models page; `name` is 'models/' plus the id. */
interface GeminiModelsBody {
  models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
}

async function fetchAnthropicModels(apiKey: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  }, UPSTREAM_TIMEOUT_MS, signal);
  if (!res.ok) throw Object.assign(new Error(`Anthropic models: ${res.status}`), { upstreamStatus: res.status });
  const data = await res.json() as AnthropicModelsBody;
  return (data.data || [])
    .filter((m) => m.type === 'model')
    .map((m): ModelInfo => ({ id: m.id, name: m.display_name || m.id, provider: 'anthropic' }));
}

async function fetchOpenAIModels(apiKey: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetchWithTimeout('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, UPSTREAM_TIMEOUT_MS, signal);
  if (!res.ok) throw Object.assign(new Error(`OpenAI models: ${res.status}`), { upstreamStatus: res.status });
  const data = await res.json() as OpenAIModelsBody;
  const chatPrefixes = ['gpt-4', 'gpt-3.5', 'o1', 'o3', 'o4', 'chatgpt'];
  const DISPLAY: Partial<Record<string, string>> = {
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4-turbo': 'GPT-4 Turbo',
    'gpt-4': 'GPT-4',
    'gpt-3.5-turbo': 'GPT-3.5 Turbo',
    'o1': 'o1',
    'o1-mini': 'o1 Mini',
    'o1-preview': 'o1 Preview',
    'o3-mini': 'o3 Mini',
    'chatgpt-4o-latest': 'ChatGPT-4o Latest',
  };
  return (data.data || [])
    .filter((m) => chatPrefixes.some((p) => m.id.startsWith(p)))
    .map((m): ModelInfo => ({ id: m.id, name: DISPLAY[m.id] || m.id, provider: 'openai' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchGeminiModels(apiKey: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
    headers: { 'x-goog-api-key': apiKey },
  }, UPSTREAM_TIMEOUT_MS, signal);
  if (!res.ok) throw Object.assign(new Error(`Gemini models: ${res.status}`), { upstreamStatus: res.status });
  const data = await res.json() as GeminiModelsBody;
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m): ModelInfo => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name, provider: 'gemini' }));
}

const FETCHERS = { anthropic: fetchAnthropicModels, openai: fetchOpenAIModels, gemini: fetchGeminiModels };

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight(req, ALLOWED_HEADERS);
  if (req.method !== 'GET') return jsonResponse(req, { error: 'GET only', code: 'METHOD_NOT_ALLOWED' } satisfies ApiErrorBody, 405);

  const requestId = newRequestId();
  const rl = rateLimit(`getModels:${clientIp(req)}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(req, rl.retryAfterSec, requestId);

  // A query value is any string. Asserted to a provider where it is read, since the check below refuses every other
  // value before anything else reads it.
  const provider = (new URL(req.url).searchParams.get('provider') as LlmProvider | null) || 'anthropic';
  if (!PROVIDERS.includes(provider)) {
    return jsonResponse(req, { error: 'Unknown provider', code: 'INVALID_PROVIDER', models: [], requestId } satisfies ApiErrorBody, 400);
  }

  const userApiKey = (req.headers.get('x-api-key') || '').trim();
  let apiKey = userApiKey;

  if (userApiKey && !userApiKey.startsWith(KEY_PREFIX[provider])) {
    return jsonResponse(req, {
      error: `The API key does not look like a ${provider} key`, code: 'KEY_PROVIDER_MISMATCH', models: [], provider, requestId,
    } satisfies ApiErrorBody, 400);
  }

  if (!apiKey) {
    if (provider !== 'anthropic' || !process.env.ANTHROPIC_API_KEY) {
      return jsonResponse(req, {
        models: [], provider, requestId,
        error: `No API key provided for ${provider}. Add your key in Settings.`, code: 'KEY_REQUIRED',
      } satisfies ModelList, 200);
    }
    const auth = await verifyRequestToken(req);
    if (!auth.ok) {
      return jsonResponse(req, { error: auth.message, code: auth.code, models: [], provider, requestId } satisfies ApiErrorBody, auth.status);
    }
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  try {
    const models = await FETCHERS[provider](apiKey, req.signal);
    return jsonResponse(req, { models, provider, requestId } satisfies ModelList, 200, { 'Cache-Control': 'private, max-age=300' });
  } catch (err) {
    // What reaches here is in practice an Error: the upstream's status rides on one built above, and fetch and the
    // body reads reject with their own (a TypeError or SyntaxError, or the aborting signal's reason: a TimeoutError or
    // AbortError DOMException by default). So this asserts that instead of narrowing, which would change what any
    // other value does.
    const upstream = (err as Error & { upstreamStatus?: number }).upstreamStatus;
    const message = upstream === 401 || upstream === 403
      ? `The ${provider} API rejected the API key`
      : isTimeoutError(err) ? `The ${provider} API timed out` : `Could not list ${provider} models`;
    return errorResponse(req, {
      status: upstream === 401 || upstream === 403 ? 401 : 502,
      code: upstream === 401 || upstream === 403 ? 'UPSTREAM_KEY_REJECTED' : 'UPSTREAM_ERROR',
      message, requestId, cause: err,
    });
  }
};
