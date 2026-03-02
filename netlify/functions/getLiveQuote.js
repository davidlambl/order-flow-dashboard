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
 * Nasdaq-100 constituent tickers (high correlation with NQ futures).
 * Only these tickers should use futures-implied pricing.
 * Source: Major Nasdaq-100 components as of 2026.
 */
const NASDAQ_100_CONSTITUENTS = new Set([
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'COST',
  'NFLX', 'AMD', 'ADBE', 'CSCO', 'PEP', 'TMUS', 'CMCSA', 'INTC', 'INTU', 'TXN',
  'QCOM', 'AMGN', 'HON', 'AMAT', 'SBUX', 'ISRG', 'BKNG', 'PANW', 'ADP', 'VRTX',
  'GILD', 'ADI', 'MU', 'LRCX', 'REGN', 'MELI', 'MDLZ', 'KLAC', 'SNPS', 'CDNS',
  'PYPL', 'MAR', 'MRVL', 'ORLY', 'CTAS', 'ADSK', 'ABNB', 'NXPI', 'WDAY', 'FTNT',
  'DASH', 'MNST', 'CPRT', 'AEP', 'PAYX', 'ROST', 'ODFL', 'FAST', 'EA', 'DXCM',
  'VRSK', 'BKR', 'XEL', 'GEHC', 'CTSH', 'KDP', 'IDXX', 'CSGP', 'ANSS', 'DDOG',
  'ON', 'ZS', 'TTWO', 'BIIB', 'ILMN', 'CDW', 'GFS', 'WBD', 'MDB', 'MRNA',
  'CRWD', 'TEAM', 'PCAR', 'DLTR', 'FANG', 'LULU', 'CHTR', 'ENPH', 'ALGN', 'SMCI',
  'CEG', 'ARM', 'CCEP', 'HOOD', 'MSTR', 'COIN', 'APP', 'SNOW', 'TOST', 'PLTR'
]);

/**
 * In-memory cache for futures data to avoid repeated API calls.
 * Futures data is the same for all tickers, so we cache it with a 60s TTL.
 */
let futuresCache = null;
let futuresCacheTimestamp = 0;
const FUTURES_CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Fetch Nasdaq-100 futures data to calculate overnight implied prices.
 * Uses in-memory cache to avoid repeated API calls within 60s window.
 */
async function fetchNasdaqFutures() {
  // Check cache first
  const now = Date.now();
  if (futuresCache && (now - futuresCacheTimestamp) < FUTURES_CACHE_TTL) {
    return futuresCache;
  }

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
  
  const futuresData = {
    current: currentPrice,
    previousClose,
    changePercent: futuresChangePercent,
  };

  // Cache the result
  futuresCache = futuresData;
  futuresCacheTimestamp = now;

  return futuresData;
}

/**
 * Fetch live quote from Yahoo Finance (includes extended hours).
 * Returns both actual quote and optional futures data for context.
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
  
  if (!currentPrice) {
    throw new Error('Yahoo Finance: No valid price found');
  }
  
  const quote = {
    ticker,
    current: currentPrice,
    previousClose,
    changePercent: previousClose ? ((currentPrice - previousClose) / previousClose) * 100 : null,
    timestamp: currentTimestamp * 1000,
    source,
  };
  
  // If only regular price and ticker is Nasdaq-100 constituent, fetch futures for context.
  // Only apply when US equity market is closed to avoid overriding actual traded prices.
  if (source === 'yahoo-regular' && previousClose && NASDAQ_100_CONSTITUENTS.has(ticker)) {
    // Check if US equity market is currently open (9:30 AM - 4:00 PM ET weekdays)
    const isUSMarketOpen = (() => {
      try {
        const now = new Date();
        const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
        const [datePart, timePart] = etStr.split(', ');
        const [h, m] = timePart.split(':').map(Number);
        const mins = h * 60 + m;
        const day = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
        return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
      } catch { return false; }
    })();

    if (!isUSMarketOpen) {
      try {
        const futures = await fetchNasdaqFutures();
        
        // Only include futures if they've moved meaningfully (>0.1%)
        if (Math.abs(futures.changePercent) > 0.1) {
          const impliedPrice = previousClose * (1 + futures.changePercent / 100);
          
          // Add futures context to the response (don't override actual price)
          quote.futuresContext = {
            nqChangePercent: futures.changePercent,
            impliedPrice: impliedPrice,
            nqCurrent: futures.current,
            nqPreviousClose: futures.previousClose,
          };
          
          // Only use implied price if it differs meaningfully
          if (Math.abs(impliedPrice - currentPrice) / currentPrice > 0.001) {
            quote.current = impliedPrice;
            quote.timestamp = Date.now();
            quote.source = 'futures-implied';
            quote.changePercent = ((impliedPrice - previousClose) / previousClose) * 100;
          }
        }
      } catch (futuresErr) {
        // Futures fetch failed, continue with regular price only
        console.warn('Futures fetch failed:', futuresErr.message);
      }
    }
  }
  
  return quote;
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
