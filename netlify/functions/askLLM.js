// netlify/functions/askLLM.js
// Multi-provider chat proxy with SSE streaming: Anthropic, OpenAI, Google Gemini.

import jwt from 'jsonwebtoken';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function detectProvider(apiKey, model) {
  if (/^(gpt-|o1|o3|o4|chatgpt)/.test(model)) return 'openai';
  if (/^gemini/.test(model)) return 'gemini';
  if (apiKey?.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey?.startsWith('sk-')) return 'openai';
  return 'anthropic';
}

function buildSystemPrompt(ticker, financialContext) {
  return `You are a senior institutional equity & options analyst embedded in a trading dashboard. Your role is to provide concise, actionable analysis based on the live market data provided below.

CURRENT TICKER: ${ticker || 'UNKNOWN'}
TIMESTAMP: ${new Date().toISOString()}

=== LIVE DASHBOARD DATA ===
${financialContext || 'No data available yet.'}
=== END DATA ===

ANALYSIS GUIDELINES:
- Reference the exact numbers from the data above. Never make up values.
- When discussing Net Premium, specify if it's bullish (positive) or bearish (negative) and the magnitude.
- For GEX/Gamma Exposure, identify the "pin" strikes where dealers will hedge.
- For Dark Pool data, note if off-exchange volume is unusually high (>40%) or low (<30%).
- For Max Pain, explain how far the current price is from max pain and what that implies for expiration.
- For Put/Call Ratio, contextualize: <0.7 is bullish, 0.7-1.0 neutral, >1.0 bearish.
- Be direct. Use short paragraphs. Bold key numbers and levels.
- If the data is unavailable or stale, say so rather than speculating.
- Sign off observations with a confidence level: HIGH / MEDIUM / LOW.`;
}

// ─── Provider-specific request builders ──────────────────────────────────────

async function callAnthropic(apiKey, model, messages, systemPrompt, stream) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      stream: Boolean(stream),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
}

async function callOpenAI(apiKey, model, messages, systemPrompt, stream) {
  const isReasoning = /^(o1|o3|o4)/.test(model);
  const allMessages = [
    { role: isReasoning ? 'developer' : 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      stream: Boolean(stream),
      ...(isReasoning ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
      messages: allMessages,
    }),
  });
}

async function callGemini(apiKey, model, messages, systemPrompt, stream) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  const sseParam = stream ? '&alt=sse' : '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:${endpoint}?key=${apiKey}${sseParam}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });
}

// ─── Extract non-streaming text from each provider ───────────────────────────

function extractAnthropicText(data) {
  return data.content?.[0]?.text || 'No response generated.';
}

function extractOpenAIText(data) {
  return data.choices?.[0]?.message?.content || 'No response generated.';
}

function extractGeminiText(data) {
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || 'No response generated.';
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405);
  }

  const tokenSecret = process.env.TOKEN_SECRET;
  if (tokenSecret) {
    const auth = req.headers.get('authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!bearer) {
      return jsonResponse({ error: 'Access token required', code: 'TOKEN_REQUIRED' }, 401);
    }
    try {
      jwt.verify(bearer, tokenSecret);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      return jsonResponse({ error: 'Invalid or expired access token', code }, 401);
    }
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const {
    messages, financialContext, ticker, userApiKey, model,
    provider: requestedProvider, stream: useStream,
  } = payload;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'messages array is required' }, 400);
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  const effectiveProvider = requestedProvider || detectProvider(userApiKey || API_KEY, model);

  let effectiveKey;
  switch (effectiveProvider) {
    case 'openai':
    case 'gemini':
      effectiveKey = userApiKey;
      break;
    default:
      effectiveKey = userApiKey || API_KEY;
      break;
  }

  if (!effectiveKey) {
    return jsonResponse({
      error: `No API key for ${effectiveProvider}. Add your key in Settings.`,
    }, 400);
  }

  const systemPrompt = buildSystemPrompt(ticker, financialContext);

  try {
    let response;
    switch (effectiveProvider) {
      case 'openai':
        response = await callOpenAI(effectiveKey, model, messages, systemPrompt, useStream);
        break;
      case 'gemini':
        response = await callGemini(effectiveKey, model, messages, systemPrompt, useStream);
        break;
      default:
        response = await callAnthropic(effectiveKey, model, messages, systemPrompt, useStream);
        break;
    }

    if (!response.ok) {
      const errText = await response.text();
      let detail;
      try { detail = JSON.parse(errText); } catch { detail = errText; }
      return jsonResponse({
        error: `${effectiveProvider} API error: ${response.status}`,
        detail,
      }, response.status);
    }

    if (useStream) {
      return new Response(response.body, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Provider': effectiveProvider,
        },
      });
    }

    const data = await response.json();
    let text;
    switch (effectiveProvider) {
      case 'openai': text = extractOpenAIText(data); break;
      case 'gemini': text = extractGeminiText(data); break;
      default: text = extractAnthropicText(data); break;
    }
    return jsonResponse({ message: text });
  } catch (err) {
    return jsonResponse({
      error: `Failed to reach ${effectiveProvider} API`,
      detail: err.message,
    }, 502);
  }
};
