// netlify/functions/getMarketData.js
//
// TIERED DATA PROVIDER — automatically selects the best available source:
//
//   Tier 1 (Real-time):  Tradier API     — set TRADIER_API_KEY env var
//                                           Free sandbox: sandbox.tradier.com
//                                           Real-time: $10/mo brokerage account
//
//   Tier 2 (Delayed):    CBOE public     — no key needed, 15-min delayed
//                                           Always available as fallback
//
// All providers feed into the same computation pipeline (GEX, Max Pain, P/C, Net Premium).
// The frontend doesn't know or care which provider is active.

import {
  fetchCBOE,
  fetchTradier,
  computeGEX,
  computeMaxPain,
  computePutCallRatio,
  computeNetPremium,
  estimateDarkPoolPct,
} from './lib/marketDataHelpers.js';

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-tradier-key',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const ticker = (params.ticker || 'AVGO').toUpperCase();

  const tradierKey = event.headers['x-tradier-key'] || process.env.TRADIER_API_KEY;

  try {
    // ── Tier Selection ──
    let rawData;

    if (tradierKey) {
      try {
        rawData = await fetchTradier(ticker, tradierKey);
      } catch (tradierErr) {
        console.warn(`Tradier failed, falling back to CBOE: ${tradierErr.message}`);
        rawData = await fetchCBOE(ticker);
      }
    } else {
      rawData = await fetchCBOE(ticker);
    }

    const { options, spotPrice: rawSpotPrice, provider, delay } = rawData;
    const spotPrice = Number(rawSpotPrice);

    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `No valid spot price for ${ticker} from ${provider || 'unknown'} provider` }),
      };
    }

    if (!options || options.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: `No options data found for ${ticker}` }),
      };
    }

    // ── Compute Metrics ──
    const gexByStrike = computeGEX(options, spotPrice);
    const maxPain = computeMaxPain(options);
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
      spotPrice,
      priceChange: rawData.priceChange,
      priceChangePct: rawData.priceChangePct,
      iv30: rawData.iv30,
      lastTradeTime: rawData.lastTradeTime,
      totalOptionsCount: options.length,

      kpis: {
        netPremium: premium.netPremium,
        callPremium: premium.callPremium,
        putPremium: premium.putPremium,
        darkPoolPct,
        maxPain,
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

    // ── Attach Flow History (if Supabase is configured) ──
    try {
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const { getSupabaseAdmin } = await import('./lib/supabaseAdmin.js');
        const supabase = getSupabaseAdmin();

        const cutoff = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
        const { data: rows } = await supabase
          .from('flow_history')
          .select('date, net_premium, cum_premium, call_volume, put_volume')
          .eq('ticker', ticker)
          .gte('date', cutoff)
          .order('date', { ascending: false })
          .limit(30);

        if (rows?.length > 0) {
          // Rows come newest-first from the query; reverse for chronological order
          result.flowHistory = rows.reverse().map((r) => ({
            date: r.date,
            netPremium: r.net_premium,
            cumPremium: r.cum_premium,
            callVolume: r.call_volume,
            putVolume: r.put_volume,
          }));
        }
      }
    } catch (err) {
      console.warn('Flow history fetch failed (non-fatal):', err.message);
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: `Failed to fetch data for ${ticker}`,
        detail: err.message,
      }),
    };
  }
}
