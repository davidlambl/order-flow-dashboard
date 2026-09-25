// netlify/functions/getTickerContext.js
//
// Fetches enriched ticker context from Finnhub + Alpha Vantage in parallel:
//   - Company news (last 7 days)
//   - General market news (top headlines)
//   - Market index quotes (SPY, QQQ, VIX, USO, GLD)
//   - Earnings (Alpha Vantage, cached in Supabase)
//   - Analyst recommendation trends
//   - Price target consensus
//   - Basic financials (key metrics)
//   - Daily candles (1 year, for computing 50/200 MA + Wilder RSI-14)
//
// BYOK: accepts x-finnhub-key header, falls back to FINNHUB_API_KEY env var.
// Partial success: individual sections can fail without blocking others. Each
// failed section is named in the `errors` map ({ candles: 'HTTP 403', ... }) and,
// unless it is a 403 (a paid endpoint on a free key, which a retry cannot fix),
// shortens the cache to 60 s. When every call failed the response is 401
// FINNHUB_KEY_REJECTED (the caller's own key answered 401 everywhere) or 502
// CONTEXT_UNAVAILABLE (including a rejected server key), never cached.

import { getSupabaseAdmin } from './lib/supabaseAdmin.js';
import {
  preflight, jsonResponse, newRequestId,
  fetchWithTimeout, isTimeoutError, clientIp, rateLimit, rateLimitResponse,
} from './lib/http.js';
import { verifyRequestToken } from './lib/auth.js';
import { parseTicker } from './lib/ticker.js';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const ALLOWED_HEADERS = 'x-finnhub-key';
const UPSTREAM_TIMEOUT_MS = 8000;
const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };
const DAY_MS = 24 * 60 * 60 * 1000;

// Once a cached row's estimated next report date has passed, Alpha Vantage is
// asked again at most this often per ticker (see earningsCacheState).
export const EARNINGS_REFETCH_FLOOR_MS = 12 * 60 * 60 * 1000;

// Finnhub may date a report a day or two away from Alpha Vantage (after-close
// reports); anything further apart is a different quarter.
const REVENUE_MATCH_WINDOW_MS = 3 * DAY_MS;

// fetchEarnings reasons that mean the earnings section failed. 'no-key' and
// 'no-data' are not failures: an ETF simply has no earnings.
const EARNINGS_ERROR_RE = /^(rate-limited|timeout|error|HTTP \d{3})$/;

// Order of the non-quote entries in the handler's Promise.allSettled.
const SECTIONS = ['news', 'earningsCalendar', 'recommendation', 'priceTarget', 'metrics', 'candles', 'marketNews'];

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Wilder's RSI. The average gain/loss is seeded with the simple mean of the
 * first `period` changes, then every later change is folded in with Wilder's
 * smoothing, avg = (avg * (period - 1) + change) / period, over the whole series.
 * @returns {number|null} null with fewer than period + 1 closes or a flat series
 */
export function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? null : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

async function finnhubGet(path, params, token, signal) {
  const url = new URL(`${FINNHUB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('token', token);
  const res = await fetchWithTimeout(url, {}, UPSTREAM_TIMEOUT_MS, signal);
  if (!res.ok) {
    const err = new Error(`Finnhub ${path}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Client-safe summary of a failed upstream call. Never err.message: it can
// carry the request URL, and with it the API key.
function reasonOf(err) {
  return isTimeoutError(err) ? 'timeout' : err?.status ? `HTTP ${err.status}` : 'error';
}

// The Finnhub calendar entry for the quarter Alpha Vantage reported: the same
// date, else the closest within REVENUE_MATCH_WINDOW_MS. Never another quarter's
// entry (the next quarter's estimate must not be paired with the last one's EPS).
function matchEarningsCalendar(calendar, date) {
  if (!date || !Array.isArray(calendar)) return null;
  const exact = calendar.find((e) => e?.date === date);
  if (exact) return exact;
  const target = Date.parse(`${date}T00:00:00Z`);
  let best = null;
  let bestGap = Infinity;
  for (const e of calendar) {
    const gap = typeof e?.date === 'string' ? Math.abs(Date.parse(`${e.date}T00:00:00Z`) - target) : NaN;
    if (gap <= REVENUE_MATCH_WINDOW_MS && gap < bestGap) {
      best = e;
      bestGap = gap;
    }
  }
  return best;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Whether a cached earnings_cache row can be served without calling Alpha
 * Vantage. Fresh while its estimated next report date is ahead. Once that date
 * has passed AV can keep returning the same quarter for days, so the row is then
 * fresh for EARNINGS_REFETCH_FLOOR_MS after each fetch (or touch) rather than
 * every request spending one of the free tier's 25 daily calls.
 * @param {{ cached: { data, next_report_date, fetched_at }|null, now?: Date }} args
 * @returns {'fresh'|'refetch'}
 */
export function earningsCacheState({ cached, now = new Date() } = {}) {
  if (!cached?.data) return 'refetch';
  const nowMs = Number(now);
  if (cached.next_report_date) {
    const next = Date.parse(`${String(cached.next_report_date).slice(0, 10)}T00:00:00Z`);
    if (next > nowMs) return 'fresh';
  }
  if (cached.fetched_at) {
    const age = nowMs - Date.parse(cached.fetched_at);
    if (age >= 0 && age < EARNINGS_REFETCH_FLOOR_MS) return 'fresh';
  }
  return 'refetch';
}

let noCacheLogged = false;

// The Supabase client, or null when it is not configured (no cache: every
// token-holder request asks Alpha Vantage).
function earningsCacheClient(getClient) {
  try {
    return getClient() || null;
  } catch (err) {
    if (!noCacheLogged) {
      noCacheLogged = true;
      console.debug('Earnings cache disabled:', err?.message || err);
    }
    return null;
  }
}

async function readEarningsCache(sb, ticker) {
  try {
    const { data, error } = await sb
      .from('earnings_cache')
      .select('data, next_report_date, fetched_at')
      .eq('ticker', ticker)
      .single();
    if (!error) return data ?? null;
    // PGRST116: single() found no row, i.e. a plain cache miss.
    if (error.code !== 'PGRST116') console.warn('Earnings cache read error:', error.message || error);
    return null;
  } catch (err) {
    console.warn('Earnings cache read failed:', err?.message || err);
    return null;
  }
}

// Restart the refetch floor on a row Alpha Vantage could not refresh.
async function touchEarningsCache(sb, ticker, now) {
  try {
    const { error } = await sb
      .from('earnings_cache')
      .update({ fetched_at: now().toISOString() })
      .eq('ticker', ticker);
    if (error) console.warn('Earnings cache touch error:', error.message || error);
  } catch (err) {
    console.warn('Earnings cache touch failed:', err?.message || err);
  }
}

/**
 * Latest reported quarter's EPS from Alpha Vantage, cached in Supabase
 * (earnings_cache). Never throws.
 * @param {string} ticker
 * @param {AbortSignal} [signal]
 * @param {{ getClient?: () => object, now?: () => Date }} [deps] injectable for tests
 * @returns {Promise<{ data: object|null, reason: string|null }>} reason is null
 *   when data is current; otherwise 'no-key' | 'rate-limited' | 'no-data' |
 *   'HTTP nnn' | 'timeout' | 'error', with data = the stale cached row, if any.
 */
export async function fetchEarnings(ticker, signal, { getClient = getSupabaseAdmin, now = () => new Date() } = {}) {
  const avKey = process.env.ALPHA_VANTAGE_KEY;
  if (!avKey) return { data: null, reason: 'no-key' };

  const sb = earningsCacheClient(getClient);
  const cached = sb ? await readEarningsCache(sb, ticker) : null;
  if (earningsCacheState({ cached, now: now() }) === 'fresh') return { data: cached.data, reason: null };
  const stale = cached?.data ?? null;

  // Alpha Vantage had nothing usable: serve the stale row, and touch it so the
  // refetch floor holds off the next requests (a throttled AV keeps saying no).
  const giveUp = async (reason) => {
    if (stale) await touchEarningsCache(sb, ticker, now);
    return { data: stale, reason };
  };

  const avUrl = new URL('https://www.alphavantage.co/query');
  avUrl.searchParams.set('function', 'EARNINGS');
  avUrl.searchParams.set('symbol', ticker);
  avUrl.searchParams.set('apikey', avKey);
  let res;
  let body;
  try {
    res = await fetchWithTimeout(avUrl, {}, UPSTREAM_TIMEOUT_MS, signal);
    if (res.ok) body = await res.json();
  } catch (err) {
    const reason = reasonOf(err);
    console.warn(`Alpha Vantage earnings ${ticker}: ${reason}`, err?.cause?.code || err?.name || '');
    return giveUp(reason);
  }
  if (!res.ok) {
    console.warn(`Alpha Vantage earnings ${ticker}: HTTP ${res.status}`);
    return giveUp(`HTTP ${res.status}`);
  }

  const quarters = body?.quarterlyEarnings;
  if (!Array.isArray(quarters) && (body?.Note || body?.Information)) {
    // AV throttles with HTTP 200: { Note } per minute, { Information } per day.
    console.warn(`Alpha Vantage earnings ${ticker}: rate-limited`);
    return giveUp('rate-limited');
  }
  const q = Array.isArray(quarters) ? quarters[0] : null; // most recent quarter
  if (!q || typeof q !== 'object') return giveUp('no-data');

  const earnings = {
    date: q.reportedDate || null,
    epsEstimate: toNumberOrNull(q.estimatedEPS),
    epsActual: toNumberOrNull(q.reportedEPS),
    revenueEstimate: null,
    revenueActual: null,
    quarter: null,
    year: null,
    surprise: toNumberOrNull(q.surprise),
  };

  // Estimate next report date: last reported + 95 days (quarterly cadence + buffer)
  let nextReportDate = null;
  const reported = q.reportedDate ? new Date(`${q.reportedDate}T00:00:00Z`) : null;
  if (reported && Number.isFinite(reported.getTime())) {
    reported.setUTCDate(reported.getUTCDate() + 95);
    nextReportDate = reported.toISOString().slice(0, 10);
  }

  // Upsert (refreshes fetched_at). A cache write failure must not break the response.
  if (sb) {
    try {
      const { error: upsertError } = await sb.from('earnings_cache').upsert(
        { ticker, data: earnings, next_report_date: nextReportDate, fetched_at: now().toISOString() },
        { onConflict: 'ticker' }
      );
      if (upsertError) console.warn('Earnings cache upsert error:', upsertError.message || upsertError);
    } catch (cacheErr) {
      console.warn('Earnings cache write failed:', cacheErr?.message || cacheErr);
    }
  }

  return { data: earnings, reason: null };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight(req, ALLOWED_HEADERS);
  if (req.method !== 'GET') return jsonResponse(req, { error: 'GET only', code: 'METHOD_NOT_ALLOWED' }, 405);

  const requestId = newRequestId();
  const rl = rateLimit(`getTickerContext:${clientIp(req)}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(req, rl.retryAfterSec, requestId);

  const ticker = parseTicker(new URL(req.url).searchParams.get('ticker') || '');
  if (!ticker) {
    return jsonResponse(req, { error: 'Invalid or missing ticker', code: 'INVALID_TICKER', requestId }, 400);
  }

  // Finnhub: BYOK for anyone; the server key (and the server-only Alpha Vantage
  // earnings cache) only for access-token holders.
  let finnhubKey = (req.headers.get('x-finnhub-key') || '').trim();
  const byok = Boolean(finnhubKey);
  let tokenHolder = false;
  if (process.env.FINNHUB_API_KEY || process.env.ALPHA_VANTAGE_KEY) {
    const auth = await verifyRequestToken(req);
    tokenHolder = auth.ok;
    if (!finnhubKey && tokenHolder && process.env.FINNHUB_API_KEY) finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey && !auth.ok && auth.code !== 'TOKEN_REQUIRED' && auth.code !== 'AUTH_NOT_CONFIGURED') {
      // A token was presented but is invalid/expired/revoked: say so.
      return jsonResponse(req, { error: auth.message, code: auth.code, requestId }, auth.status);
    }
  }
  if (!finnhubKey) {
    return jsonResponse(req, {
      error: 'A Finnhub API key is required. Add one in Settings, or activate an access token.',
      code: 'KEY_REQUIRED', requestId,
    }, 401);
  }
  const signal = req.signal;

  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 7);
  const toDate = now.toISOString().slice(0, 10);
  const fromStr = fromDate.toISOString().slice(0, 10);

  const oneYearAgo = Math.floor(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).getTime() / 1000);
  const nowUnix = Math.floor(now.getTime() / 1000);

  const earningsFrom = new Date(now);
  earningsFrom.setDate(earningsFrom.getDate() - 90);
  const earningsTo = new Date(now);
  earningsTo.setDate(earningsTo.getDate() + 60);

  const MARKET_SYMBOLS = ['SPY', 'QQQ', 'VIX', 'USO', 'GLD'];
  const MARKET_LABELS = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', VIX: 'VIX', USO: 'Oil (USO)', GLD: 'Gold (GLD)' };

  // Fetch Alpha Vantage earnings (EPS, cached) in parallel with Finnhub calls (revenue + everything else)
  const [earningsResult, settled] = await Promise.all([
    tokenHolder
      ? fetchEarnings(ticker, signal).catch((err) => ({ data: null, reason: reasonOf(err) }))
      : Promise.resolve({ data: null, reason: null }),
    Promise.allSettled([
      finnhubGet('/company-news', { symbol: ticker, from: fromStr, to: toDate }, finnhubKey, signal),
      finnhubGet('/calendar/earnings', { symbol: ticker, from: earningsFrom.toISOString().slice(0, 10), to: earningsTo.toISOString().slice(0, 10) }, finnhubKey, signal),
      finnhubGet('/stock/recommendation', { symbol: ticker }, finnhubKey, signal),
      finnhubGet('/stock/price-target', { symbol: ticker }, finnhubKey, signal),
      finnhubGet('/stock/metric', { symbol: ticker, metric: 'all' }, finnhubKey, signal),
      finnhubGet('/stock/candle', { symbol: ticker, resolution: 'D', from: oneYearAgo, to: nowUnix }, finnhubKey, signal),
      finnhubGet('/news', { category: 'general' }, finnhubKey, signal),
      ...MARKET_SYMBOLS.map((sym) => finnhubGet('/quote', { symbol: sym }, finnhubKey, signal)),
    ]),
  ]);
  const [newsRes, earningsRevRes, recRes, ptRes, metricsRes, candleRes, generalNewsRes, ...quoteResults] = settled;
  const { data: earningsData, reason: earningsReason } = earningsResult;

  // Per-section failures, as client-safe reasons ('HTTP 403', 'timeout', ...).
  const errors = {};
  SECTIONS.forEach((section, i) => {
    if (settled[i].status === 'rejected') errors[section] = reasonOf(settled[i].reason);
  });
  if (quoteResults.every((r) => r.status === 'rejected')) errors.marketQuotes = reasonOf(quoteResults[0].reason);
  if (!earningsData && EARNINGS_ERROR_RE.test(earningsReason || '')) errors.earnings = earningsReason;

  if (!earningsData && settled.every((r) => r.status === 'rejected')) {
    const allUnauthorized = settled.every((r) => reasonOf(r.reason) === 'HTTP 401');
    if (allUnauthorized && byok) {
      // The caller's own key was refused: say so, so the UI can ask for a working one.
      return jsonResponse(req, { error: 'Finnhub rejected the API key', code: 'FINNHUB_KEY_REJECTED', errors, requestId }, 401);
    }
    if (allUnauthorized) {
      // The server's FINNHUB_API_KEY was refused: a deployment problem, not the caller's.
      console.error(`[${requestId}] Finnhub answered 401 to the server FINNHUB_API_KEY; check the deploy environment`);
    } else {
      console.warn(`[${requestId}] CONTEXT_UNAVAILABLE: ${ticker}`, JSON.stringify(errors));
    }
    return jsonResponse(req, { error: `Ticker context unavailable for ${ticker}`, code: 'CONTEXT_UNAVAILABLE', errors, requestId }, 502);
  }

  const news = newsRes.status === 'fulfilled'
    ? (newsRes.value || []).slice(0, 7).map((n) => ({
        headline: n.headline,
        summary: n.summary,
        source: n.source,
        url: n.url,
        datetime: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
        sentiment: n.sentiment ?? null,
      }))
    : [];

  // EPS from Alpha Vantage (accurate), revenue from Finnhub's entry for the same quarter
  const earnings = earningsData ? { ...earningsData } : null;
  if (earnings && earningsRevRes.status === 'fulfilled') {
    const match = matchEarningsCalendar(earningsRevRes.value?.earningsCalendar, earnings.date);
    earnings.revenueEstimate = match?.revenueEstimate ?? null;
    earnings.revenueActual = match?.revenueActual ?? null;
  }

  let analysts = null;
  if (recRes.status === 'fulfilled' && ptRes.status === 'fulfilled') {
    const recs = recRes.value || [];
    const latest = recs[0] || {};
    const pt = ptRes.value || {};
    analysts = {
      consensus: {
        buy: latest.buy ?? 0,
        hold: latest.hold ?? 0,
        sell: latest.sell ?? 0,
        strongBuy: latest.strongBuy ?? 0,
        strongSell: latest.strongSell ?? 0,
        period: latest.period ?? null,
      },
      priceTarget: {
        mean: pt.targetMean ?? pt.target_mean ?? null,
        median: pt.targetMedian ?? pt.target_median ?? null,
        high: pt.targetHigh ?? pt.target_high ?? null,
        low: pt.targetLow ?? pt.target_low ?? null,
      },
    };
  } else if (recRes.status === 'fulfilled') {
    const latest = (recRes.value || [])[0] || {};
    analysts = {
      consensus: {
        buy: latest.buy ?? 0,
        hold: latest.hold ?? 0,
        sell: latest.sell ?? 0,
        strongBuy: latest.strongBuy ?? 0,
        strongSell: latest.strongSell ?? 0,
        period: latest.period ?? null,
      },
      priceTarget: { mean: null, median: null, high: null, low: null },
    };
  }

  let technicals = null;
  if (candleRes.status === 'fulfilled' && candleRes.value?.s === 'ok') {
    const candle = candleRes.value;
    const closes = candle.c || [];
    const highs = candle.h || [];
    const lows = candle.l || [];
    technicals = {
      sma50: computeSMA(closes, 50),
      sma200: computeSMA(closes, 200),
      rsi14: computeRSI(closes, 14),
      currentPrice: closes.length > 0 ? closes[closes.length - 1] : null,
      fiftyTwoWeekHigh: highs.length > 0 ? Math.max(...highs) : null,
      fiftyTwoWeekLow: lows.length > 0 ? Math.min(...lows) : null,
    };
  }

  let fundamentals = null;
  if (metricsRes.status === 'fulfilled') {
    const m = metricsRes.value?.metric || {};
    fundamentals = {
      marketCap: m.marketCapitalization ?? null,
      peRatio: m.peBasicExclExtraTTM ?? null,
      forwardPE: m.forwardPE ?? null,
      dividendYield: m.dividendYieldIndicatedAnnual ?? null,
      beta: m.beta ?? null,
      revenueGrowthQuarterly: m.revenueGrowthQuarterlyYoy ?? null,
      epsGrowthQuarterly: m.epsGrowthQuarterlyYoy ?? null,
      grossMargin: m.grossMarginTTM ?? null,
      operatingMargin: m.operatingMarginTTM ?? null,
      roeTTM: m.roeTTM ?? null,
      debtToEquity: m.totalDebtToEquityQuarterly ?? null,
      freeCashFlowTTM: m.freeCashFlowTTM ?? null,
      revenuePerShareTTM: m.revenuePerShareTTM ?? null,
    };
  }

  const marketNews = generalNewsRes.status === 'fulfilled'
    ? (generalNewsRes.value || []).slice(0, 5).map((n) => ({
        headline: n.headline,
        source: n.source,
        url: n.url,
        datetime: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
      }))
    : [];

  const marketQuotes = {};
  MARKET_SYMBOLS.forEach((sym, i) => {
    const r = quoteResults[i];
    if (r.status === 'fulfilled' && r.value && r.value.c) {
      marketQuotes[sym] = {
        label: MARKET_LABELS[sym],
        price: r.value.c,
        change: r.value.d ?? null,
        changePct: r.value.dp ?? null,
        previousClose: r.value.pc ?? null,
      };
    }
  });

  const body = {
    ticker, news, earnings, analysts, technicals, fundamentals,
    marketNews,
    marketQuotes: Object.keys(marketQuotes).length > 0 ? marketQuotes : null,
    errors,
  };

  // A partial answer is cached briefly so the failed sections are retried soon,
  // unless every failure is a 403: a paid endpoint on a free key (the candles on
  // every free Finnhub plan) stays forbidden, so retrying sooner buys nothing.
  const retrySoon = Object.values(errors).some((reason) => reason !== 'HTTP 403');
  return jsonResponse(req, body, 200, {
    'Cache-Control': `private, max-age=${retrySoon ? 60 : 900}`,
    'Vary': 'Origin, x-finnhub-key, Authorization',
  });
};
