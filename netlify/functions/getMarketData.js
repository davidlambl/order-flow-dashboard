// netlify/functions/getMarketData.js
//
// TIERED DATA PROVIDER — automatically selects the best available source:
//
//   Tier 1 (Real-time):  Tradier API     — BYOK via x-tradier-key, or the server's
//                                           TRADIER_API_KEY for access-token holders
//   Tier 2 (Delayed):    CBOE public     — no key needed, 15-min delayed
//                                           Always available as fallback; what anonymous callers get
//
// A provider's answer is validated before it is accepted: it needs a positive spot
// price and at least one contract in the expiry window. When Tradier throws, times
// out or answers with unusable data, the request falls back to CBOE and the payload's
// `fallbackReason` says why (the Header shows it on the provider badge):
//   null | 'tradier-timeout' | 'tradier-error' | 'tradier-no-spot' | 'tradier-no-options'
//
// Every provider's chain goes through normalizeChain (expiries already past in ET are
// dropped, the EXPIRY_WINDOW nearest are kept), so GEX, Max Pain, P/C and Net Premium
// are measured on the same expiries whichever provider served them. The payload's
// `expiries` lists that window; `kpis.maxPainExpiry` is the expiry max pain used.

import {
  preflight, jsonResponse, errorResponse, newRequestId,
  isTimeoutError, clientIp, rateLimit, rateLimitResponse,
} from './lib/http.js';
import { verifyRequestToken } from './lib/auth.js';
import { parseTicker } from './lib/ticker.js';
import {
  fetchCBOE,
  fetchTradier,
  normalizeChain,
  computeGEX,
  computeMaxPain,
  computePutCallRatio,
  computeNetPremium,
  estimateDarkPoolPct,
} from './lib/marketDataHelpers.js';

const ALLOWED_HEADERS = 'x-tradier-key';
const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const HISTORY_DAYS = 45;
const HISTORY_ROWS = 30;

async function fetchFlowHistory(ticker) {
  let client = null;
  try {
    const { getSupabasePublic } = await import('./lib/supabasePublic.js');
    client = getSupabasePublic();
  } catch { /* fall through */ }
  if (!client && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // No anon key available server-side; fall back to the admin client for this public read.
    const { getSupabaseAdmin } = await import('./lib/supabaseAdmin.js');
    client = getSupabaseAdmin();
  }
  if (!client) return null;

  const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const { data: rows, error } = await client
    .from('flow_history')
    .select('date, net_premium, cum_premium, call_volume, put_volume')
    .eq('ticker', ticker)
    .gte('date', cutoff)
    .order('date', { ascending: false })
    .limit(HISTORY_ROWS);
  if (error) throw new Error(error.message);
  if (!rows?.length) return null;
  // Rows come newest-first; reverse for chronological order.
  return rows.reverse().map((r) => ({
    date: r.date,
    netPremium: r.net_premium,
    cumPremium: r.cum_premium,
    callVolume: r.call_volume,
    putVolume: r.put_volume,
  }));
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight(req, ALLOWED_HEADERS);
  if (req.method !== 'GET') return jsonResponse(req, { error: 'GET only', code: 'METHOD_NOT_ALLOWED' }, 405);

  const requestId = newRequestId();
  const rl = rateLimit(`getMarketData:${clientIp(req)}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(req, rl.retryAfterSec, requestId);

  const rawTicker = new URL(req.url).searchParams.get('ticker') || 'AVGO';
  const ticker = parseTicker(rawTicker);
  if (!ticker) {
    return jsonResponse(req, { error: 'Invalid ticker format', code: 'INVALID_TICKER', requestId }, 400);
  }

  // ── Key selection: BYOK always; server Tradier key only for token holders; else CBOE ──
  const userTradierKey = (req.headers.get('x-tradier-key') || '').trim();
  let tradierKey = userTradierKey || null;
  let keySource = userTradierKey ? 'user' : 'none';
  if (!tradierKey && process.env.TRADIER_API_KEY) {
    const auth = await verifyRequestToken(req);
    if (auth.ok) {
      tradierKey = process.env.TRADIER_API_KEY;
      keySource = 'server';
    }
  }

  try {
    // ── Provider selection: validate each answer BEFORE accepting it ──
    const now = new Date();
    const cboeAttempt = { name: 'cboe', run: () => fetchCBOE(ticker, req.signal) };
    const attempts = tradierKey
      ? [{ name: 'tradier', run: () => fetchTradier(ticker, tradierKey, req.signal) }, cboeAttempt]
      : [cboeAttempt];

    let rawData = null;
    let chain = null;
    let fallbackReason = null;
    for (const attempt of attempts) {
      try {
        const candidate = await attempt.run();
        const spot = Number(candidate.spotPrice);
        const normalized = Number.isFinite(spot) && spot > 0 ? normalizeChain(candidate.options, { now }) : null;
        const problem = !normalized ? 'no-spot' : normalized.options.length === 0 ? 'no-options' : null;
        if (!problem) {
          rawData = candidate;
          chain = normalized;
          break;
        }
        if (attempt.name === 'tradier') {
          fallbackReason = `tradier-${problem}`;
          console.warn(`[${requestId}] Tradier (${keySource} key) ${problem}, falling back to CBOE`);
          continue;
        }
        // CBOE is the last resort: report its unusable answer, plus why Tradier was skipped.
        return problem === 'no-spot'
          ? jsonResponse(req, { error: `No valid spot price for ${ticker}`, code: 'NO_SPOT_PRICE', provider: candidate.provider, fallbackReason, requestId }, 502)
          : jsonResponse(req, { error: `No options data found for ${ticker}`, code: 'NO_OPTIONS', provider: candidate.provider, fallbackReason, requestId }, 404);
      } catch (err) {
        if (attempt.name !== 'tradier') throw err; // CBOE failed too → outer catch (504 / 502)
        fallbackReason = isTimeoutError(err) ? 'tradier-timeout' : 'tradier-error';
        console.warn(`[${requestId}] Tradier (${keySource} key) failed, falling back to CBOE:`, err.message);
      }
    }

    const { provider, delay } = rawData;
    const spotPrice = Number(rawData.spotPrice);
    // Metrics are computed on the normalized expiry window only (identical for every provider).
    const { options, expiries } = chain;

    const gexByStrike = computeGEX(options, spotPrice);
    const maxPain = computeMaxPain(options, { now });
    const pcRatio = computePutCallRatio(options);
    const premium = computeNetPremium(options);
    const darkPoolPct = estimateDarkPoolPct(rawData.volume, rawData.iv30);

    // Trim GEX to strikes near the money (±20%)
    const gexFiltered = gexByStrike.filter(
      (s) => s.strike >= spotPrice * 0.80 && s.strike <= spotPrice * 1.20
    );

    const result = {
      ticker,
      provider,
      delay,
      fallbackReason,
      spotPrice,
      priceChange: rawData.priceChange,
      priceChangePct: rawData.priceChangePct,
      iv30: rawData.iv30,
      lastTradeTime: rawData.lastTradeTime,
      totalOptionsCount: options.length,
      expiries,
      kpis: {
        netPremium: premium.netPremium,
        callPremium: premium.callPremium,
        putPremium: premium.putPremium,
        darkPoolPct,
        maxPain: maxPain?.strike ?? null,
        maxPainExpiry: maxPain?.expiry ?? null,
        putCallRatio: pcRatio.volumeRatio,
        putCallOIRatio: pcRatio.oiRatio,
        callVolume: pcRatio.callVolume,
        putVolume: pcRatio.putVolume,
        callOI: pcRatio.callOI,
        putOI: pcRatio.putOI,
      },
      gexByStrike: gexFiltered,
      lastUpdated: new Date().toISOString(),
    };

    try {
      const flowHistory = await fetchFlowHistory(ticker);
      if (flowHistory) result.flowHistory = flowHistory;
    } catch (err) {
      console.warn(`[${requestId}] Flow history fetch failed (non-fatal):`, err.message);
    }

    return jsonResponse(req, result, 200, {
      // Responses depend on the caller's key/token; never let a shared cache serve them.
      'Cache-Control': 'private, max-age=60',
      'Vary': 'Origin, x-tradier-key, Authorization',
    });
  } catch (err) {
    return errorResponse(req, {
      status: isTimeoutError(err) ? 504 : 502,
      code: isTimeoutError(err) ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      message: `Failed to fetch market data for ${ticker}`,
      requestId, cause: err,
    });
  }
};
