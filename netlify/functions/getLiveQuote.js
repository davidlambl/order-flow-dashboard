// netlify/functions/getLiveQuote.js
//
// Lightweight endpoint for fetching real-time stock quotes with extended hours support.
// Uses Yahoo Finance for accurate overnight/pre-market/after-hours pricing.
// Falls back to Finnhub if Yahoo Finance is unavailable.
// Short cache TTL (60 seconds) to ensure fresh price data for gap detection.
//
// BYOK: accepts x-finnhub-key header for Finnhub fallback, falls back to FINNHUB_API_KEY env var.

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
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

/**
 * Fetch live quote from Yahoo Finance (includes extended hours).
 */
async function fetchYahooQuote(ticker) {
  const url = `${YAHOO_BASE}/${ticker}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });
  
  if (!res.ok) {
    throw new Error(`Yahoo Finance: ${res.status}`);
  }
  
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  
  if (!result) {
    throw new Error('Yahoo Finance: No data returned');
  }
  
  const meta = result.meta;
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  
  // Get the most recent non-null price from the time series
  let currentPrice = meta.regularMarketPrice;
  let currentTimestamp = meta.regularMarketTime;
  let source = 'yahoo-regular';
  
  // Look for the most recent valid price in the time series (includes extended hours)
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (closes[i] != null && !isNaN(closes[i])) {
      currentPrice = closes[i];
      currentTimestamp = timestamps[i];
      
      // Check if this is extended hours (outside 9:30 AM - 4:00 PM ET)
      const date = new Date(currentTimestamp * 1000);
      const etHour = date.toLocaleString('en-US', { 
        timeZone: 'America/New_York', 
        hour: 'numeric', 
        minute: 'numeric',
        hour12: false 
      });
      const [hour, minute] = etHour.split(':').map(Number);
      const minutesSinceMidnight = hour * 60 + minute;
      const isExtendedHours = minutesSinceMidnight < 570 || minutesSinceMidnight >= 960; // Before 9:30 AM or after 4:00 PM ET
      
      source = isExtendedHours ? 'yahoo-extended' : 'yahoo-regular';
      break;
    }
  }
  
  // Fallback to meta fields if available
  if (meta.postMarketPrice && meta.postMarketTime) {
    const now = Math.floor(Date.now() / 1000);
    if (now - meta.postMarketTime < 300) { // Within last 5 minutes
      currentPrice = meta.postMarketPrice;
      currentTimestamp = meta.postMarketTime;
      source = 'yahoo-extended';
    }
  } else if (meta.preMarketPrice && meta.preMarketTime) {
    const now = Math.floor(Date.now() / 1000);
    if (now - meta.preMarketTime < 300) { // Within last 5 minutes
      currentPrice = meta.preMarketPrice;
      currentTimestamp = meta.preMarketTime;
      source = 'yahoo-extended';
    }
  }
  
  const previousClose = meta.chartPreviousClose || meta.previousClose;
  
  return {
    ticker,
    current: currentPrice,
    previousClose,
    changePercent: previousClose ? ((currentPrice - previousClose) / previousClose) * 100 : null,
    timestamp: currentTimestamp * 1000,
    source,
  };
}

/**
 * Fetch live quote from Finnhub (fallback, regular hours only).
 */
async function fetchFinnhubQuote(ticker, finnhubKey) {
  const url = new URL(`${FINNHUB_BASE}/quote`);
  url.searchParams.append('symbol', ticker);
  url.searchParams.append('token', finnhubKey);
  
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Finnhub: ${res.status}`);
  
  const q = await res.json();
  
  if (!q || q.c == null) {
    throw new Error('Finnhub: No data returned');
  }
  
  return {
    ticker,
    current: q.c,
    previousClose: q.pc ?? null,
    changePercent: q.pc != null ? ((q.c - q.pc) / q.pc) * 100 : null,
    timestamp: q.t ? q.t * 1000 : Date.now(),
    source: 'finnhub',
  };
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

  try {
    // Try Yahoo Finance first (includes extended hours)
    try {
      const quote = await fetchYahooQuote(ticker);
      return new Response(JSON.stringify(quote), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (yahooErr) {
      console.warn('Yahoo Finance failed, falling back to Finnhub:', yahooErr.message);
      
      // Fallback to Finnhub if available
      if (finnhubKey) {
        const quote = await fetchFinnhubQuote(ticker, finnhubKey);
        return new Response(JSON.stringify(quote), {
          status: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      
      // No fallback available
      throw new Error(`Yahoo Finance failed and no Finnhub key configured: ${yahooErr.message}`);
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
};
