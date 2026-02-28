// src/lib/api.js
// Centralized API helpers — all calls route through Netlify Functions.

import { getAuthHeaders, clearToken } from './auth';

const FUNCTION_BASE = '/.netlify/functions';

/**
 * Fetch computed market data from our serverless function.
 * Supports BYOK Tradier for real-time data; falls back to free CBOE delayed quotes.
 * @param {string} ticker - Stock symbol
 */
export async function fetchMarketData(ticker) {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getMarketData?${params}`;

  const headers = {};
  const tradierKey = sessionStorage.getItem('data_tradier_key');
  if (tradierKey) headers['x-tradier-key'] = tradierKey;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (networkErr) {
    throw new Error(`Network error: ${networkErr.message}`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error: ${res.status}`);
  }
  return res.json();
}

/**
 * Extract text from an SSE data line based on the provider's format.
 */
function parseSSELine(jsonStr, provider) {
  try {
    const event = JSON.parse(jsonStr);
    switch (provider) {
      case 'openai':
        return event.choices?.[0]?.delta?.content || null;
      case 'gemini': {
        const parts = event.candidates?.[0]?.content?.parts || [];
        return parts.map((p) => p.text || '').join('') || null;
      }
      default:
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          return event.delta.text;
        }
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Stream a message to the AI co-pilot with financial context.
 * Supports Anthropic, OpenAI, and Gemini streaming formats.
 */
export async function askLLMStream({ messages, financialContext, ticker, userApiKey, model, provider }, onChunk) {
  const res = await fetch(`${FUNCTION_BASE}/askLLM`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({
      messages, financialContext, ticker, userApiKey, model, provider, stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401) {
      clearToken();
      throw new Error(err.code === 'TOKEN_EXPIRED' ? 'Access token expired' : 'Access token required');
    }
    throw new Error(err.error || `LLM error: ${res.status}`);
  }

  const effectiveProvider = res.headers.get('X-Provider') || provider || 'anthropic';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      const text = parseSSELine(jsonStr, effectiveProvider);
      if (text) onChunk(text);
    }
  }
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
    if (res.status === 401) {
      clearToken();
      throw new Error(err.code === 'TOKEN_EXPIRED' ? 'Access token expired' : 'Access token required');
    }
    throw new Error(err.error || `Models API error: ${res.status}`);
  }
  return res.json();
}
