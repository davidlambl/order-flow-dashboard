// src/lib/api.js
// Centralized API helpers — all calls route through Netlify Functions.

import { getAuthHeaders, clearToken } from './auth';

const FUNCTION_BASE = '/.netlify/functions';

/**
 * Fetch computed market data from our CBOE-backed serverless function.
 * No API key required — uses free public CBOE delayed quotes.
 * @param {string} ticker - Stock symbol
 */
export async function fetchMarketData(ticker) {
  const params = new URLSearchParams({ ticker });
  const url = `${FUNCTION_BASE}/getMarketData?${params}`;

  let res;
  try {
    res = await fetch(url);
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
 * Stream a message to the AI co-pilot with financial context.
 * Calls onChunk(text) for each text delta received via SSE.
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} financialContext - Serialized dashboard state
 * @param {string} ticker
 * @param {string} userApiKey - Optional user-provided API key
 * @param {string} model - Model selection
 * @param {(text: string) => void} onChunk - Called with each text delta
 */
export async function askLLMStream(messages, financialContext, ticker, userApiKey, model, onChunk) {
  const res = await fetch(`${FUNCTION_BASE}/askLLM`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({
      messages, financialContext, ticker, userApiKey, model, stream: true,
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
      if (!jsonStr) continue;

      try {
        const event = JSON.parse(jsonStr);
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          onChunk(event.delta.text);
        }
      } catch { /* skip non-JSON SSE lines like event: types */ }
    }
  }
}

/**
 * Fetch available Anthropic models.
 * @param {string} userApiKey - Optional user-provided API key
 */
export async function fetchModels(userApiKey = null) {
  const headers = { ...getAuthHeaders() };
  if (userApiKey) {
    headers['x-api-key'] = userApiKey;
  }

  const res = await fetch(`${FUNCTION_BASE}/getModels`, { headers });

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

