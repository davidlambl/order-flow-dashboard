// netlify/functions/getLiveQuote.ts
//
// Lightweight endpoint for real-time stock quotes with extended-hours support.
// Yahoo Finance is the primary source; Finnhub is the fallback if Yahoo fails.
// Short cache TTL (60 seconds) to ensure fresh price data for gap detection.
//
// Price selection: every price Yahoo reports (the regular, post-market and
// pre-market meta fields, plus the newest pre- and post-market 1-minute candles)
// is a candidate, and the one with the newest timestamp wins. A stale
// post-market print from last night never beats a live regular-session trade.
//
// `current` is always a real traded price, never an estimate. For Nasdaq-100
// members outside the regular session, the NQ futures move is attached as
// `futuresContext` for context only.
//
// Response: { ticker, current, previousClose, changePercent, timestamp (ms of
// the price itself, or null if unknown), source: 'yahoo-regular' | 'yahoo-post'
// | 'yahoo-pre' | 'finnhub', futuresContext? }.
//
// BYOK: accepts the x-finnhub-key header for the Finnhub fallback; the server's
// FINNHUB_API_KEY is used only for access-token holders.

import {
  preflight, jsonResponse, errorResponse, newRequestId,
  fetchWithTimeout, isTimeoutError, clientIp, rateLimit, rateLimitResponse,
} from './lib/http.js';
import { verifyRequestToken } from './lib/auth.js';
import { parseTicker } from './lib/ticker.js';
import { getMarketSession } from '../../shared/marketCalendar.js';
import type { ApiErrorBody, LiveQuote, LiveQuoteSource } from '../../types/market.js';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const ALLOWED_HEADERS = 'x-finnhub-key';
const UPSTREAM_TIMEOUT_MS = 6000;
const RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

/** Candidates stamped more than this far past "now" are bogus (clock skew beyond it is not). */
const MAX_CLOCK_SKEW_SEC = 120;

/** The three Yahoo prices a quote can come from. */
type YahooSource = Exclude<LiveQuoteSource, 'finnhub'>;

/** Tie-break between candidates with the same timestamp: lower rank wins. */
const SOURCE_RANK: Record<YahooSource, number> = { 'yahoo-regular': 0, 'yahoo-post': 1, 'yahoo-pre': 2 };

/** A price Yahoo reported and when (Unix seconds), as read: selectQuoteCandidate checks both before it uses them. */
interface PriceCandidate {
  source: YahooSource;
  price: unknown;
  timestamp: unknown;
}

/** A usable candidate: a finite price above 0 and its finite time in Unix seconds. */
interface QuoteCandidate {
  source: YahooSource;
  price: number;
  timestamp: number;
}

/** fetchYahooQuote's answer: one of Yahoo's three sources, and always the price's own time (ms). */
interface YahooQuote extends LiveQuote {
  source: YahooSource;
  timestamp: number;
}

// res.json() is unknown. Each body is asserted once, where it is parsed, to just the fields this file reads. The
// prices, previous closes and times in Yahoo's meta, the session bounds and Finnhub's fields are unknown: each goes
// through Number() and a finiteness check (isFiniteNum, or Number.isFinite after the conversion), which accept a
// numeric string, so any value is handled as it always was. The candle series are typed as Yahoo sends them, Unix seconds and closes (null for a minute without
// a trade), and the candle loop compares a time only once isFiniteNum has passed it. The reads cope as they always
// have: the optional chains read a missing or null result, quote or close series as none, a missing session window
// as no candle, and a result without meta still throws in the futures lookup, which only drops futuresContext.

/** Yahoo's v8 chart body; `result` is null for a symbol it does not know. */
interface YahooChartBody {
  chart?: { result?: YahooChartResult[] | null };
}

/** One chart result: the quote fields in `meta`, the 1-minute series in `timestamp` and `indicators`. */
interface YahooChartResult {
  meta: YahooMeta;
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
}

interface YahooMeta {
  regularMarketPrice?: unknown;
  regularMarketTime?: unknown;
  postMarketPrice?: unknown;
  postMarketTime?: unknown;
  preMarketPrice?: unknown;
  preMarketTime?: unknown;
  chartPreviousClose?: unknown;
  previousClose?: unknown;
  regularMarketPreviousClose?: unknown;
  currentTradingPeriod?: { pre: YahooPeriod; post: YahooPeriod };
}

/** A session window's bounds in Unix seconds. */
interface YahooPeriod {
  start?: unknown;
  end?: unknown;
}

/** Finnhub's quote: `c` the price, `pc` the previous close, `t` its time in Unix seconds. */
interface FinnhubQuote {
  c?: unknown;
  pc?: unknown;
  t?: unknown;
}

/** NQ's last price, its previous close and the move between them, in percent. */
interface NasdaqFutures {
  current: number;
  previousClose: number;
  changePercent: number;
}

/**
 * Check whether a value is a usable finite number: a finite number or a numeric
 * string. Blank strings, booleans, arrays and null are rejected, where a bare
 * Number() would quietly turn them into 0.
 */
function isFiniteNum(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

/**
 * Curated subset of major Nasdaq-100 components (high correlation with NQ futures).
 * Only these tickers get NQ futures context (`futuresContext`) outside the regular session.
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
let futuresCache: NasdaqFutures | null = null;
let futuresCacheTimestamp = 0;
const FUTURES_CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Fetch Nasdaq-100 futures data to calculate overnight implied prices.
 * Uses in-memory cache to avoid repeated API calls within 60s window.
 */
async function fetchNasdaqFutures(signal: AbortSignal | null = null): Promise<NasdaqFutures> {
  // Check cache first
  const now = Date.now();
  if (futuresCache && (now - futuresCacheTimestamp) < FUTURES_CACHE_TTL) {
    return futuresCache;
  }

  // NQ=F is the Nasdaq-100 futures ticker on Yahoo Finance
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=1m&range=1d';
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, UPSTREAM_TIMEOUT_MS, signal);
  
  if (!res.ok) {
    throw new Error(`Futures fetch failed: ${res.status}`);
  }
  
  const data = await res.json() as YahooChartBody | null;
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
  
  const futuresData: NasdaqFutures = {
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
 * Newest pre- and post-market candles from the 1-minute series (requested with
 * includePrePost=true). Yahoo often leaves meta.preMarketPrice / postMarketPrice
 * unpopulated even when those candles exist.
 *
 * Session windows come from Yahoo's meta.currentTradingPeriod (pre ≈ 4:00–9:30 AM
 * ET, post ≈ 4:00–8:00 PM ET; Yahoo adjusts them on special days). They are
 * half-open [start, end) because they abut the regular session: the candle
 * stamped exactly at pre.end is the 9:30 regular-session candle.
 *
 * No "inside regular hours" guard is needed: selectQuoteCandidate orders every
 * candidate by timestamp, so a live regular-session price outranks these.
 *
 * @param result - Yahoo chart result (`chart.result[0]`)
 * @param nowSec - current Unix time in seconds; later candles are ignored
 * @returns at most one candidate per window (its newest finite candle); timestamp in Unix seconds
 */
function extractExtendedHoursCandles(result: YahooChartResult, nowSec: number): QuoteCandidate[] {
  const periods = result?.meta?.currentTradingPeriod;
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!periods || !timestamps.length || !Array.isArray(closes)) return [];

  const newestIn = (period: YahooPeriod, source: YahooSource): QuoteCandidate | null => {
    if (!isFiniteNum(period?.start) || !isFiniteNum(period?.end)) return null;
    const start = Number(period.start);
    const end = Number(period.end);
    for (let i = timestamps.length - 1; i >= 0; i--) {
      const ts = timestamps[i];
      if (isFiniteNum(ts) && ts >= start && ts < end && ts <= nowSec && isFiniteNum(closes[i])) {
        return { source, price: Number(closes[i]), timestamp: Number(ts) };
      }
    }
    return null;
  };

  // filter(Boolean) drops the nulls, which its typing does not show: asserted behind it.
  return [newestIn(periods.pre, 'yahoo-pre'), newestIn(periods.post, 'yahoo-post')].filter(Boolean) as QuoteCandidate[];
}

/**
 * Pick the price to report from a Yahoo chart result: the candidate with the
 * newest timestamp among the meta regular / post-market / pre-market prices and
 * the newest pre- and post-market candles. A candidate needs a finite price > 0
 * and a finite timestamp no later than nowSec + 120 s (tolerates clock skew,
 * drops bogus future stamps). Ties prefer regular, then post, then pre.
 *
 * @param result - Yahoo chart result (`chart.result[0]`)
 * @param nowSec - current Unix time in seconds
 * @returns timestamp in Unix seconds; null when no candidate is valid
 */
export function selectQuoteCandidate(result: YahooChartResult, nowSec = Math.floor(Date.now() / 1000)): QuoteCandidate | null {
  const meta = result?.meta ?? {};
  const candidates: PriceCandidate[] = [
    { source: 'yahoo-regular', price: meta.regularMarketPrice, timestamp: meta.regularMarketTime },
    { source: 'yahoo-post', price: meta.postMarketPrice, timestamp: meta.postMarketTime },
    { source: 'yahoo-pre', price: meta.preMarketPrice, timestamp: meta.preMarketTime },
    ...extractExtendedHoursCandles(result, nowSec),
  ];

  let best: QuoteCandidate | null = null;
  for (const c of candidates) {
    if (!isFiniteNum(c.price) || !isFiniteNum(c.timestamp)) continue;
    const price = Number(c.price);
    const timestamp = Number(c.timestamp);
    if (price <= 0 || timestamp > nowSec + MAX_CLOCK_SKEW_SEC) continue;
    const better = !best || timestamp > best.timestamp
      || (timestamp === best.timestamp && SOURCE_RANK[c.source] < SOURCE_RANK[best.source]);
    if (better) best = { source: c.source, price, timestamp };
  }
  return best;
}

/**
 * Fetch a live quote from Yahoo Finance (regular + extended hours).
 *
 * `current` is the newest real price (see selectQuoteCandidate) and is never
 * replaced by an estimate. When that price is the last regular-session trade,
 * the ticker is a Nasdaq-100 member and the equity session is closed (evenings,
 * pre-market, weekends, holidays, after an early close), the NQ futures move since
 * NQ's prior close is attached as `futuresContext` for context only:
 * `impliedPrice` = previousClose × (1 + nqChangePercent / 100), an estimate
 * anchored on the stock's prior close.
 *
 * @param ticker - validated ticker (see lib/ticker.ts)
 * @param signal - the incoming request's signal
 * @param options - injectable clock (defaults to the current time)
 * @returns timestamp in ms
 */
export async function fetchYahooQuote(
  ticker: string,
  signal: AbortSignal | null = null,
  { now = new Date() }: { now?: Date } = {},
): Promise<YahooQuote> {
  // Use query2 endpoint which has more reliable extended hours data
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, UPSTREAM_TIMEOUT_MS, signal);
  
  if (!res.ok) {
    throw new Error(`Yahoo Finance: ${res.status}`);
  }
  
  const data = await res.json() as YahooChartBody | null;
  const result = data?.chart?.result?.[0];
  
  if (!result) {
    throw new Error('Yahoo Finance: No data returned');
  }
  
  const best = selectQuoteCandidate(result, Math.floor(now.getTime() / 1000));
  if (!best) {
    throw new Error('Yahoo Finance: No valid price found');
  }

  const meta = result.meta ?? {};
  const previousClose = Number(
    meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPreviousClose
  );
  const hasPreviousClose = Number.isFinite(previousClose) && previousClose !== 0;
  
  const quote: YahooQuote = {
    ticker,
    current: best.price,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    changePercent: hasPreviousClose
      ? ((best.price - previousClose) / previousClose) * 100
      : null,
    timestamp: best.timestamp * 1000,
    source: best.source,
  };
  
  // NQ futures context for a Nasdaq-100 member whose newest price is the last
  // regular-session trade while the equity session is closed. Context only:
  // current, timestamp, source and changePercent stay the stock's own.
  if (quote.source === 'yahoo-regular' && hasPreviousClose
      && NASDAQ_100_CONSTITUENTS.has(ticker) && !getMarketSession(now).equityOpen) {
    try {
      const futures = await fetchNasdaqFutures(signal);

      // Only include futures if they've moved meaningfully (>0.1%)
      if (Math.abs(futures.changePercent) > 0.1) {
        const impliedPrice = previousClose * (1 + futures.changePercent / 100);

        quote.futuresContext = {
          nqChangePercent: futures.changePercent,
          impliedPrice: impliedPrice,
          nqCurrent: futures.current,
          nqPreviousClose: futures.previousClose,
        };
      }
    } catch (futuresErr) {
      // Futures fetch failed, continue with regular price only. A caught value is unknown; what fetchNasdaqFutures
      // throws is in practice an Error (its own, fetch's TypeError or the aborting signal's reason, a JSON SyntaxError,
      // a TypeError for a result without meta), so this asserts that instead of narrowing, which would change what
      // any other value does: `.message` stays the unguarded read it was.
      console.warn('Futures fetch failed:', (futuresErr as Error).message);
    }
  }
  
  return quote;
}

/**
 * Fetch live quote from Finnhub (fallback, regular hours only).
 * Finnhub answers an unknown symbol with 200 `{ c: 0, pc: 0, t: 0 }`, so a
 * missing, non-numeric or non-positive `c` means "no data", not a price of 0.
 */
async function fetchFinnhubQuote(ticker: string, finnhubKey: string, signal: AbortSignal | null = null): Promise<LiveQuote> {
  const url = new URL(`${FINNHUB_BASE}/quote`);
  url.searchParams.append('symbol', ticker);
  url.searchParams.append('token', finnhubKey);
  
  const res = await fetchWithTimeout(url, {}, UPSTREAM_TIMEOUT_MS, signal);
  if (!res.ok) throw new Error(`Finnhub: ${res.status}`);
  
  const q = await res.json() as FinnhubQuote | null;
  
  if (!q || !isFiniteNum(q.c) || Number(q.c) <= 0) {
    throw new Error('Finnhub: No data returned');
  }

  const current = Number(q.c);
  const previousClose = isFiniteNum(q.pc) ? Number(q.pc) : null;
  
  return {
    ticker,
    current,
    previousClose,
    changePercent: previousClose != null && previousClose !== 0
      ? ((current - previousClose) / previousClose) * 100
      : null,
    // q.t is Unix seconds. Without it the time is unknown (null), never "now".
    timestamp: isFiniteNum(q.t) && Number(q.t) > 0 ? Number(q.t) * 1000 : null,
    source: 'finnhub',
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight(req, ALLOWED_HEADERS);
  if (req.method !== 'GET') return jsonResponse(req, { error: 'GET only', code: 'METHOD_NOT_ALLOWED' } satisfies ApiErrorBody, 405);

  const requestId = newRequestId();
  const rl = rateLimit(`getLiveQuote:${clientIp(req)}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(req, rl.retryAfterSec, requestId);

  const ticker = parseTicker(new URL(req.url).searchParams.get('ticker') || '');
  if (!ticker) {
    return jsonResponse(req, { error: 'Invalid or missing ticker', code: 'INVALID_TICKER', requestId } satisfies ApiErrorBody, 400);
  }

  const okHeaders = {
    'Cache-Control': 'private, max-age=60',
    'Vary': 'Origin, x-finnhub-key, Authorization',
  };

  // Yahoo Finance needs no key and is available to everyone.
  let yahooError: unknown;
  try {
    const quote = await fetchYahooQuote(ticker, req.signal);
    return jsonResponse(req, quote, 200, okHeaders);
  } catch (err) {
    yahooError = err;
    // Asserted as in fetchYahooQuote: what it throws is in practice an Error (its own, fetch's, a JSON SyntaxError).
    console.warn(`[${requestId}] Yahoo Finance failed, trying Finnhub:`, (err as Error).message);
  }

  // Finnhub fallback: BYOK for anyone; the server key only for access-token holders.
  let finnhubKey = (req.headers.get('x-finnhub-key') || '').trim();
  if (!finnhubKey && process.env.FINNHUB_API_KEY) {
    const auth = await verifyRequestToken(req);
    if (auth.ok) finnhubKey = process.env.FINNHUB_API_KEY;
  }
  if (!finnhubKey) {
    return errorResponse(req, {
      status: isTimeoutError(yahooError) ? 504 : 502,
      code: 'QUOTE_UNAVAILABLE',
      message: `Live quote unavailable for ${ticker}`,
      requestId, cause: yahooError,
    });
  }

  try {
    const quote = await fetchFinnhubQuote(ticker, finnhubKey, req.signal);
    return jsonResponse(req, quote, 200, okHeaders);
  } catch (err) {
    return errorResponse(req, {
      status: isTimeoutError(err) ? 504 : 502,
      code: 'QUOTE_UNAVAILABLE',
      message: `Live quote unavailable for ${ticker}`,
      requestId, cause: err,
    });
  }
};
