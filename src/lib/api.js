// src/lib/api.js
// Centralized API helpers — all calls route through Netlify Functions.

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
 * Send a message to the AI co-pilot with financial context.
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} financialContext - Serialized dashboard state
 * @param {string} ticker
 * @param {string} userApiKey - Optional user-provided API key
 * @param {string} model - Model selection
 */
export async function askLLM(messages, financialContext, ticker, userApiKey = null, model = null) {
  const res = await fetch(`${FUNCTION_BASE}/askLLM`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      messages, 
      financialContext, 
      ticker,
      userApiKey,
      model
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `LLM error: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch available Anthropic models.
 * @param {string} userApiKey - Optional user-provided API key
 */
export async function fetchModels(userApiKey = null) {
  const headers = {};
  if (userApiKey) {
    headers['x-api-key'] = userApiKey;
  }

  const res = await fetch(`${FUNCTION_BASE}/getModels`, { headers });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Models API error: ${res.status}`);
  }
  return res.json();
}

