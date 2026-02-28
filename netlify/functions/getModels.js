// netlify/functions/getModels.js
// Fetches available Anthropic models dynamically

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'GET only' }),
    };
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  const userApiKey = event.headers['x-api-key'];
  const effectiveApiKey = userApiKey || API_KEY;

  if (!effectiveApiKey) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        models: [],
        error: 'No API key available to fetch models'
      }),
    };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      method: 'GET',
      headers: {
        'x-api-key': effectiveApiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({
          error: `Anthropic API error: ${response.status}`,
          detail: data,
          models: [],
        }),
      };
    }

    const models = (data.data || [])
      .filter((m) => m.type === 'model')
      .map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
      }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ models }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: 'Failed to fetch models',
        detail: err.message,
        models: [],
      }),
    };
  }
}
