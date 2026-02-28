// netlify/functions/getModels.js
// Multi-provider model fetching: Anthropic, OpenAI, Google Gemini.

import jwt from 'jsonwebtoken';

function detectProvider(apiKey) {
  if (!apiKey) return 'anthropic';
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-')) return 'openai';
  return 'gemini';
}

async function fetchAnthropicModels(apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error: ${res.status}`);
  }
  const data = await res.json();
  return (data.data || [])
    .filter((m) => m.type === 'model')
    .map((m) => ({ id: m.id, name: m.display_name || m.id, provider: 'anthropic' }));
}

async function fetchOpenAIModels(apiKey) {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error: ${res.status}`);
  }
  const data = await res.json();
  const chatPrefixes = ['gpt-4', 'gpt-3.5', 'o1', 'o3', 'o4', 'chatgpt'];
  const DISPLAY = {
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
    .map((m) => ({ id: m.id, name: DISPLAY[m.id] || m.id, provider: 'openai' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchGeminiModels(apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API error: ${res.status}`);
  }
  const data = await res.json();
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({
      id: m.name.replace('models/', ''),
      name: m.displayName || m.name,
      provider: 'gemini',
    }));
}

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };
  }

  const tokenSecret = process.env.TOKEN_SECRET;
  if (tokenSecret) {
    const auth = event.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!bearer) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Access token required', code: 'TOKEN_REQUIRED', models: [] }),
      };
    }
    try {
      jwt.verify(bearer, tokenSecret);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid or expired access token', code, models: [] }),
      };
    }
  }

  const params = event.queryStringParameters || {};
  const userApiKey = event.headers['x-api-key'];
  const provider = params.provider || detectProvider(userApiKey);

  const effectiveKey = userApiKey
    || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);

  if (!effectiveKey) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        models: [],
        provider,
        error: `No API key provided for ${provider}. Add your key in Settings.`,
      }),
    };
  }

  try {
    let models;
    switch (provider) {
      case 'openai':
        models = await fetchOpenAIModels(effectiveKey);
        break;
      case 'gemini':
        models = await fetchGeminiModels(effectiveKey);
        break;
      default:
        models = await fetchAnthropicModels(effectiveKey);
        break;
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ models, provider }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message, models: [], provider }),
    };
  }
}
