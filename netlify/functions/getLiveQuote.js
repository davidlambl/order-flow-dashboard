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
 * Fetch Nasdaq-100 futures data to calculate overnight implied prices.
 */
async function fetchNasdaqFutures() {
  // NQ=F is the Nasdaq-100 futures ticker on Yahoo Finance
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/NQ=F?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });
  
  if (!res.ok) {
    throw new Error(`Futures fetch failed: ${res.status}`);
  }
  
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  
  if (!result) {
    throw new Error('No futures data returned');
  }
  
  const meta = result.meta;
  
  // Get current futures price (trades nearly 24/7)
  let currentPrice = meta.regularMarketPrice;
  
  // Check for the most recent price in time series
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (closes[i] != null && !isNaN(closes[i])) {
      currentPrice = closes[i];
      break;
    }
  }
  
  // Previous close (typically Friday 4 PM ET close for weekend gaps)
  const previousClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPreviousClose;
  
  if (!currentPrice || !previousClose) {
    throw new Error('Futures data incomplete');
  }
  
  // Calculate futures change percentage
  const futuresChangePercent = ((currentPrice - previousClose) / previousClose) * 100;
  
  return {
    current: currentPrice,
    previousClose,
    changePercent: futuresChangePercent,
  };
}

/**
 * Fetch live quote from Yahoo Finance (includes extended hours).
 */
async function fetchYahooQuote(ticker) {
  // Use query2 endpoint which has more reliable extended hours data
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d&includePrePost=true`;
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
  
  // Try to get current price from multiple sources in order of preference
  let currentPrice = null;
  let currentTimestamp = null;
  let source = 'yahoo-regular';
  
  // 1. Check for post-market (after-hours) price
  if (meta.postMarketPrice && meta.postMarketTime) {
    currentPrice = meta.postMarketPrice;
    currentTimestamp = meta.postMarketTime;
    source = 'yahoo-extended';
  }
  // 2. Check for pre-market price
  else if (meta.preMarketPrice && meta.preMarketTime) {
    currentPrice = meta.preMarketPrice;
    currentTimestamp = meta.preMarketTime;
    source = 'yahoo-extended';
  }
  // 3. Fall back to regular market price
  else if (meta.regularMarketPrice && meta.regularMarketTime) {
    currentPrice = meta.regularMarketPrice;
    currentTimestamp = meta.regularMarketTime;
    source = 'yahoo-regular';
  }
  
  const previousClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPreviousClose;
  
  // If we only have regular market price, check if we should use futures-implied pricing
  if (source === 'yahoo-regular' && previousClose) {
    try {
      // Fetch Nasdaq-100 futures to calculate implied overnight price
      const futures = await fetchNasdaqFutures();
      
      // Check if futures have moved significantly (>0.1%) - indicates active trading
      if (Math.abs(futures.changePercent) > 0.1) {
        // Calculate implied stock price based on futures movement
        const impliedPrice = previousClose * (1 + futures.changePercent / 100);
        
        // Use implied price if it differs meaningfully from close
        if (Math.abs(impliedPrice - currentPrice) / currentPrice > 0.001) { // 0.1% threshold
          currentPrice = impliedPrice;
          currentTimestamp = Math.floor(Date.now() / 1000);
          source = 'futures-implied';
        }
      }
    } catch (futuresErr) {
      // Futures fetch failed, continue with regular price
      console.warn('Futures fetch failed:', futuresErr.message);
    }
  }
  
  if (!currentPrice) {
    throw new Error('Yahoo Finance: No valid price found');
  }
  
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
