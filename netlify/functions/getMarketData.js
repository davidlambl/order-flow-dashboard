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

// ─── Provider: CBOE (Free, 15-min delayed) ───────────────────────────────────

const CBOE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';

async function fetchCBOE(ticker) {
  const res = await fetch(`${CBOE_BASE}/${ticker}.json`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) throw new Error(`CBOE returned ${res.status} for ${ticker}`);

  const raw = await res.json();
  const data = raw.data || raw;

  return {
    provider: 'cboe',
    delay: '15-min delayed',
    spotPrice: data.current_price || 0,
    priceChange: data.price_change || 0,
    priceChangePct: data.price_change_percent || 0,
    iv30: data.iv30 || 0,
    volume: data.volume || 0,
    lastTradeTime: data.last_trade_time || null,
    options: (data.options || []).map((opt) => ({
      symbol: opt.option,
      bid: opt.bid || 0,
      ask: opt.ask || 0,
      iv: opt.iv || 0,
      openInterest: opt.open_interest || 0,
      volume: opt.volume || 0,
      delta: opt.delta || 0,
      gamma: opt.gamma || 0,
      theta: opt.theta || 0,
      vega: opt.vega || 0,
    })),
  };
}

// ─── Provider: Tradier (Real-time or Sandbox) ────────────────────────────────

async function fetchTradier(ticker, apiKey) {
  // Determine if this is a sandbox key (sandbox keys work on sandbox.tradier.com)
  // Production keys use api.tradier.com
  // We try production first; if it fails, we try sandbox.
  const bases = [
    'https://api.tradier.com',
    'https://sandbox.tradier.com',
  ];

  // Step 1: Get expiration dates
  let expirations = [];
  let baseUrl = bases[0];

  for (const base of bases) {
    try {
      const expRes = await fetch(
        `${base}/v1/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
          },
        }
      );
      if (expRes.ok) {
        const expData = await expRes.json();
        const dates = expData?.expirations?.date;
        if (dates && (Array.isArray(dates) ? dates.length > 0 : true)) {
          expirations = Array.isArray(dates) ? dates : [dates];
          baseUrl = base;
          break;
        }
      }
    } catch { /* try next base */ }
  }

  if (expirations.length === 0) {
    throw new Error('Tradier: no expiration dates found');
  }

  // Step 2: Get stock quote
  const quoteRes = await fetch(
    `${baseUrl}/v1/markets/quotes?symbols=${ticker}&greeks=false`,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    }
  );
  const quoteData = await quoteRes.json();
  const quote = quoteData?.quotes?.quote || {};

  // Step 3: Fetch chains for the nearest 6 expirations (parallel)
  const nearbyExpiries = expirations.slice(0, 6);
  const chainPromises = nearbyExpiries.map((exp) =>
    fetch(
      `${baseUrl}/v1/markets/options/chains?symbol=${ticker}&expiration=${exp}&greeks=true`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
      }
    ).then((r) => r.json()).catch(() => null)
  );

  const chainResults = await Promise.all(chainPromises);

  // Flatten all options
  const allOptions = [];
  for (const result of chainResults) {
    const opts = result?.options?.option;
    if (!opts) continue;
    const arr = Array.isArray(opts) ? opts : [opts];
    for (const opt of arr) {
      allOptions.push({
        symbol: opt.symbol,
        bid: opt.bid || 0,
        ask: opt.ask || 0,
        iv: opt.greeks?.mid_iv || opt.greeks?.ask_iv || 0,
        openInterest: opt.open_interest || 0,
        volume: opt.volume || 0,
        delta: opt.greeks?.delta || 0,
        gamma: opt.greeks?.gamma || 0,
        theta: opt.greeks?.theta || 0,
        vega: opt.greeks?.vega || 0,
      });
    }
  }

  const isSandbox = baseUrl.includes('sandbox');

  return {
    provider: isSandbox ? 'tradier-sandbox' : 'tradier',
    delay: isSandbox ? 'sandbox (delayed)' : 'real-time',
    spotPrice: quote.last || quote.close || 0,
    priceChange: quote.change || 0,
    priceChangePct: quote.change_percentage || 0,
    iv30: 0, // Tradier doesn't provide a single IV30 metric
    volume: quote.volume || 0,
    lastTradeTime: quote.trade_date || null,
    options: allOptions,
  };
}

// ─── Shared Computation Engine ───────────────────────────────────────────────

function parseOptionSymbol(sym) {
  // OCC format: AVGO260228C00320000
  const m = sym.match(/^(.+?)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    ticker: m[1],
    expiry: '20' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4) + '-' + m[2].slice(4, 6),
    type: m[3] === 'C' ? 'call' : 'put',
    strike: parseInt(m[4], 10) / 1000,
  };
}

function computeGEX(options, spotPrice) {
  const gexByStrike = {};

  for (const opt of options) {
    const parsed = parseOptionSymbol(opt.symbol);
    if (!parsed) continue;

    const gamma = opt.gamma || 0;
    const oi = opt.openInterest || 0;
    if (gamma === 0 || oi === 0) continue;

    const contractGex = spotPrice * gamma * oi * 100 * spotPrice * 0.01;
    const strike = parsed.strike;

    if (!gexByStrike[strike]) {
      gexByStrike[strike] = { strike, callGex: 0, putGex: 0 };
    }

    if (parsed.type === 'call') {
      gexByStrike[strike].callGex += contractGex;
    } else {
      gexByStrike[strike].putGex -= contractGex;
    }
  }

  return Object.values(gexByStrike)
    .map((s) => ({ ...s, gex: s.callGex + s.putGex }))
    .filter((s) => Math.abs(s.gex) > 0)
    .sort((a, b) => a.strike - b.strike);
}

function computeMaxPain(options) {
  // Use nearest expiration only
  const expiries = new Set();
  for (const opt of options) {
    const parsed = parseOptionSymbol(opt.symbol);
    if (parsed) expiries.add(parsed.expiry);
  }
  const nearest = [...expiries].sort()[0];
  if (!nearest) return 0;

  const strikeOI = {};
  for (const opt of options) {
    const parsed = parseOptionSymbol(opt.symbol);
    if (!parsed || parsed.expiry !== nearest) continue;
    const oi = opt.openInterest || 0;
    if (oi === 0) continue;

    const s = parsed.strike;
    if (!strikeOI[s]) strikeOI[s] = { callOI: 0, putOI: 0 };
    if (parsed.type === 'call') strikeOI[s].callOI += oi;
    else strikeOI[s].putOI += oi;
  }

  const strikes = Object.keys(strikeOI).map(Number).sort((a, b) => a - b);
  if (strikes.length === 0) return 0;

  let minPain = Infinity;
  let maxPainStrike = 0;

  for (const testStrike of strikes) {
    let totalPain = 0;
    for (const s of strikes) {
      const { callOI, putOI } = strikeOI[s];
      if (testStrike > s) totalPain += (testStrike - s) * callOI * 100;
      if (testStrike < s) totalPain += (s - testStrike) * putOI * 100;
    }
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testStrike;
    }
  }

  return maxPainStrike;
}

function computePutCallRatio(options) {
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;

  for (const opt of options) {
    const parsed = parseOptionSymbol(opt.symbol);
    if (!parsed) continue;

    if (parsed.type === 'call') {
      callVol += opt.volume || 0;
      callOI += opt.openInterest || 0;
    } else {
      putVol += opt.volume || 0;
      putOI += opt.openInterest || 0;
    }
  }

  return {
    volumeRatio: callVol > 0 ? putVol / callVol : 0,
    oiRatio: callOI > 0 ? putOI / callOI : 0,
    callVolume: callVol,
    putVolume: putVol,
    callOI,
    putOI,
  };
}

function computeNetPremium(options) {
  let callPremium = 0, putPremium = 0;

  for (const opt of options) {
    const parsed = parseOptionSymbol(opt.symbol);
    if (!parsed) continue;

    const vol = opt.volume || 0;
    if (vol === 0) continue;

    const mid = ((opt.bid || 0) + (opt.ask || 0)) / 2;
    const premium = vol * mid * 100;

    if (parsed.type === 'call') callPremium += premium;
    else putPremium += premium;
  }

  return {
    callPremium,
    putPremium,
    netPremium: callPremium - putPremium,
  };
}

function estimateDarkPoolPct(stockVolume, iv30) {
  // Statistical estimate — no free real-time dark pool source exists.
  // Higher IV and higher volume typically correlate with more off-exchange activity.
  const basePct = 37.5;
  const ivMod = ((iv30 || 30) - 30) * 0.1;
  return Math.max(25, Math.min(55, basePct + ivMod));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const ticker = (params.ticker || 'AVGO').toUpperCase();

  const tradierKey = process.env.TRADIER_API_KEY;

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

    const { options, spotPrice, provider, delay } = rawData;

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
