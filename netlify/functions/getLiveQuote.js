// netlify/functions/getLiveQuote.js
//
// Lightweight endpoint for fetching real-time stock quotes from Finnhub.
// Short cache TTL (60 seconds) to ensure fresh price data for gap detection.
//
// BYOK: accepts x-finnhub-key header, falls back to FINNHUB_API_KEY env var.

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// Allowed ticker format: 1-10 uppercase letters/digits, optional dot/hyphen
const TICKER_REGEX = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-finnhub-key, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'private, max-age=60',
  'Vary': 'x-finnhub-key',
};

async function finnhubGet(path, params, token) {
  const url = new URL(`${FINNHUB_BASE}${path}`);
  
  // Add query params
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }
  }
  
  // Add token
  url.searchParams.append('token', token);
  
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Finnhub ${path}: ${res.status}`);
  return res.json();
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase().trim();
  
  if (!ticker) {
    return new Response(JSON.stringify({ error: 'Missing ticker' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  
  // Validate ticker format to prevent injection attacks
  if (!TICKER_REGEX.test(ticker)) {
    return new Response(JSON.stringify({ error: 'Invalid ticker format' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const finnhubKey = req.headers.get('x-finnhub-key') || process.env.FINNHUB_API_KEY || '';
  if (!finnhubKey) {
    return new Response(
      JSON.stringify({ error: 'No Finnhub API key configured. Add one in Settings or set FINNHUB_API_KEY env var.' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const q = await finnhubGet('/quote', { symbol: ticker }, finnhubKey);
    
    let liveQuote = null;
    if (q && q.c != null) {
      liveQuote = {
        ticker,
        current: q.c,
        previousClose: q.pc ?? null,
        changePercent: q.pc != null ? ((q.c - q.pc) / q.pc) * 100 : null,
        timestamp: q.t ? q.t * 1000 : Date.now(),
      };
    }

    return new Response(JSON.stringify(liveQuote), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
};
