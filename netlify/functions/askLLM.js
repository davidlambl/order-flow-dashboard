// netlify/functions/askLLM.js
// Proxies chat requests to Anthropic Claude, injecting financial context
// into the system prompt so the LLM can reason about live market data.

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'POST only' }),
    };
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { messages, financialContext, ticker, userApiKey, model } = payload;

  const effectiveApiKey = userApiKey || API_KEY;
  if (!effectiveApiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'No API key available. Please configure ANTHROPIC_API_KEY or provide your own.' }),
    };
  }

  const selectedModel = model || 'claude-sonnet-4-20250514';

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'messages array is required' }),
    };
  }

  const systemPrompt = `You are a senior institutional equity & options analyst embedded in a trading dashboard. Your role is to provide concise, actionable analysis based on the live market data provided below.

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

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': effectiveApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({
          error: `Anthropic API error: ${response.status}`,
          detail: data,
        }),
      };
    }

    const assistantMessage =
      data.content?.[0]?.text || 'No response generated.';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: assistantMessage }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: 'Failed to reach Anthropic API',
        detail: err.message,
      }),
    };
  }
}
