// netlify/functions/getLiveQuote.js
//
// Lightweight endpoint for fetching real-time stock quotes with extended hours support.
// Uses Yahoo Finance for accurate overnight/pre-market/after-hours pricing.
// Falls back to Finnhub if Yahoo Finance is unavailable.
// Short cache TTL (60 seconds) to ensure fresh price data for gap detection.
//
// BYOK: accepts x-finnhub-key header for Finnhub fallback, falls back to FINNHUB_API_KEY env var.

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
 * Check whether a value is a usable finite number.
 * Normalizes to Number first, then checks Number.isFinite.
 */
function isFiniteNum(v) {
  return v != null && Number.isFinite(Number(v));
}

/**
 * Curated subset of major Nasdaq-100 components (high correlation with NQ futures).
 * Only these tickers should use futures-implied pricing.
 * Not exhaustive — update periodically as the index rebalances.
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
  let currentPrice = Number(meta.regularMarketPrice);
  
  // Check for the most recent price in time series
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (isFiniteNum(closes[i])) {
      currentPrice = Number(closes[i]);
      break;
    }
  }
  
  // Previous close (typically Friday 4 PM ET close for weekend gaps)
  const previousClose = Number(
    meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPreviousClose
  );
  
  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousClose) || previousClose === 0) {
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
 * Get current Eastern-Time hour, minute, and weekday from Intl.DateTimeFormat.
 * Shared by isPreMarketWindow / isUSMarketOpen to avoid duplicating the
 * Intl.DateTimeFormat ceremony in two IIFEs.
 *
 * Returns { h, m, mins, weekday } where weekday is en-US short form ('Mon' … 'Sun')
 * and mins is h*60+m, or null when the formatter throws.
 */
function getETTimeParts() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(new Date());
    const partMap = {};
    for (const p of parts) {
      if (p.type === 'hour' || p.type === 'minute' || p.type === 'weekday') {
        partMap[p.type] = p.value;
      }
    }
    const h = Number(partMap.hour);
    const m = Number(partMap.minute);
    if (Number.isNaN(h) || Number.isNaN(m) || !partMap.weekday) return null;
    return { h, m, mins: h * 60 + m, weekday: partMap.weekday };
  } catch {
    return null;
  }
}

/**
 * Extract the latest extended-hours price from Yahoo chart time series candles.
 * When meta.postMarketPrice / meta.preMarketPrice are not populated (common),
 * the actual after-hours or pre-market candles still appear in the 1-minute
 * time series if includePrePost=true was requested.
 *
 * Skips extraction when `now` falls inside the regular trading session to avoid
 * returning a stale pre-market candle during market hours.
 *
 * @param {object} result  Yahoo chart result object
 * @param {boolean} preferPre  When true, scan pre-market candles before post-market
 *
 * Returns { price, timestamp, session } or null if no extended-hours candle is found.
 *   session: 'post' | 'pre'
 */
function extractExtendedHoursPrice(result, preferPre = false) {
  const meta = result.meta;
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  if (!timestamps.length || !closes.length) return null;

  const tradingPeriods = meta.currentTradingPeriod;
  if (!tradingPeriods) return null;

  const now = Math.floor(Date.now() / 1000);

  // Regular session boundaries — skip extraction if we're inside regular hours
  const regStart = tradingPeriods.regular?.start;
  const regEnd   = tradingPeriods.regular?.end;
  if (regStart && regEnd && now >= regStart && now < regEnd) {
    return null;
  }

  // Post-market session, as defined by Yahoo's meta.currentTradingPeriod.post
  // (typically ~4:00 PM – 8:00 PM ET for US equities, but may vary on special days).
  const postStart = tradingPeriods.post?.start;
  const postEnd   = tradingPeriods.post?.end;

  // Pre-market session, as defined by Yahoo's meta.currentTradingPeriod.pre
  // (typically ~4:00 AM – 9:30 AM ET for US equities, but may vary on special days).
  const preStart  = tradingPeriods.pre?.start;
  const preEnd    = tradingPeriods.pre?.end;

  // Helper: scan a single session window for the latest candle.
  const scanSession = (start, end, label) => {
    if (!start || !end) return null;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      const ts = timestamps[i];
      if (ts >= start && ts <= end && ts <= now && isFiniteNum(closes[i])) {
        return { price: Number(closes[i]), timestamp: ts, session: label };
      }
    }
    return null;
  };

  // During pre-market, scan pre candles first so we don't return a stale
  // post-market candle from the previous evening.
  const first  = preferPre ? ['pre', preStart, preEnd] : ['post', postStart, postEnd];
  const second = preferPre ? ['post', postStart, postEnd] : ['pre', preStart, preEnd];

  return scanSession(first[1], first[2], first[0])
      || scanSession(second[1], second[2], second[0]);
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
  
  // Determine which extended-hours session to prioritize based on current ET time.
  // During pre-market (4:00-9:30 AM ET on weekdays), prefer preMarketPrice over
  // stale postMarketPrice.  Uses shared helper to avoid duplicating DateTimeFormat logic.
  const etParts = getETTimeParts();
  const isPreMarketWindow = etParts != null
    && etParts.weekday !== 'Sat' && etParts.weekday !== 'Sun'
    && etParts.mins >= 240 && etParts.mins < 570; // 4:00 AM - 9:30 AM ET, weekdays only

  // 1. During pre-market window, check pre-market first
  if (isPreMarketWindow && isFiniteNum(meta.preMarketPrice) && isFiniteNum(meta.preMarketTime)) {
    currentPrice = Number(meta.preMarketPrice);
    currentTimestamp = Number(meta.preMarketTime);
    source = 'yahoo-pre';
  }
  // 2. Check for post-market (after-hours) price
  else if (isFiniteNum(meta.postMarketPrice) && isFiniteNum(meta.postMarketTime)) {
    currentPrice = Number(meta.postMarketPrice);
    currentTimestamp = Number(meta.postMarketTime);
    source = 'yahoo-post';
  }
  // 3. Check for pre-market price (outside pre-market window, as fallback)
  else if (isFiniteNum(meta.preMarketPrice) && isFiniteNum(meta.preMarketTime)) {
    currentPrice = Number(meta.preMarketPrice);
    currentTimestamp = Number(meta.preMarketTime);
    source = 'yahoo-pre';
  }
  // 4. Extract extended-hours price from time series candles
  //    (meta fields are often unpopulated even when candles exist)
  else {
    const extHours = extractExtendedHoursPrice(result, isPreMarketWindow);
    if (extHours) {
      currentPrice = extHours.price;
      currentTimestamp = extHours.timestamp;
      source = extHours.session === 'pre' ? 'yahoo-pre' : 'yahoo-post';
    }
  }
  // 5. Fall back to regular market price
  if (!isFiniteNum(currentPrice) && isFiniteNum(meta.regularMarketPrice) && isFiniteNum(meta.regularMarketTime)) {
    currentPrice = Number(meta.regularMarketPrice);
    currentTimestamp = Number(meta.regularMarketTime);
    source = 'yahoo-regular';
  }
  
  const previousClose = Number(
    meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPreviousClose
  );
  
  if (!Number.isFinite(currentPrice)) {
    throw new Error('Yahoo Finance: No valid price found');
  }
  
  const quote = {
    ticker,
    current: currentPrice,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    changePercent: Number.isFinite(previousClose) && previousClose !== 0
      ? ((currentPrice - previousClose) / previousClose) * 100
      : null,
    timestamp: currentTimestamp != null ? currentTimestamp * 1000 : null,
    source,
  };
  
  // If only regular price and ticker is Nasdaq-100 constituent, fetch futures for context.
  // Only apply when US equity market is closed to avoid overriding actual traded prices.
  if (source === 'yahoo-regular' && Number.isFinite(previousClose) && previousClose !== 0 && NASDAQ_100_CONSTITUENTS.has(ticker)) {
    // Check if US equity market is currently open (9:30 AM - 4:00 PM ET weekdays)
    // Reuses etParts computed earlier to avoid a second Intl.DateTimeFormat call.
    const isUSMarketOpen = etParts != null
      && etParts.weekday !== 'Sat' && etParts.weekday !== 'Sun'
      && etParts.mins >= 570 && etParts.mins < 960;

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
    changePercent: q.pc != null && Number.isFinite(q.pc) && q.pc !== 0 ? ((q.c - q.pc) / q.pc) * 100 : null,
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
