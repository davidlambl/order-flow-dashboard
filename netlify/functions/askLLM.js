// netlify/functions/askLLM.js
// Proxies chat requests to Anthropic Claude with optional SSE streaming.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405);
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { messages, financialContext, ticker, userApiKey, model, stream: useStream } = payload;

  const effectiveApiKey = userApiKey || API_KEY;
  if (!effectiveApiKey) {
    return jsonResponse({
      error: 'No API key available. Please configure ANTHROPIC_API_KEY or provide your own.',
    }, 500);
  }

  const selectedModel = model || 'claude-sonnet-4-20250514';

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'messages array is required' }, 400);
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

  const anthropicBody = {
    model: selectedModel,
    max_tokens: 1024,
    system: systemPrompt,
    stream: Boolean(useStream),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': effectiveApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      let detail;
      try { detail = JSON.parse(errText); } catch { detail = errText; }
      return jsonResponse({
        error: `Anthropic API error: ${response.status}`,
        detail,
      }, response.status);
    }

    if (useStream) {
      return new Response(response.body, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const data = await response.json();
    const assistantMessage = data.content?.[0]?.text || 'No response generated.';
    return jsonResponse({ message: assistantMessage });
  } catch (err) {
    return jsonResponse({
      error: 'Failed to reach Anthropic API',
      detail: err.message,
    }, 502);
  }
};
