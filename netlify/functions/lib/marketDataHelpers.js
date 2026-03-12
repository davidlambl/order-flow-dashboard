// netlify/functions/lib/marketDataHelpers.js
// Shared computation functions for options data — used by getMarketData and collectFlowHistory.

const CBOE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';

export async function fetchCBOE(ticker) {
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
    spotPrice: data.current_price ?? 0,
    priceChange: data.price_change || 0,
    priceChangePct: data.price_change_percent || 0,
    iv30: data.iv30 ?? 0,
    volume: data.volume ?? 0,
    lastTradeTime: data.last_trade_time || null,
    options: (data.options || []).map((opt) => ({
      symbol: opt.option,
      bid: opt.bid ?? 0,
      ask: opt.ask ?? 0,
      iv: opt.iv ?? 0,
      openInterest: opt.open_interest ?? 0,
      volume: opt.volume ?? 0,
      delta: opt.delta ?? 0,
      gamma: opt.gamma ?? 0,
      theta: opt.theta ?? 0,
      vega: opt.vega ?? 0,
    })),
  };
}

export async function fetchTradier(ticker, apiKey) {
  const bases = [
    'https://api.tradier.com',
    'https://sandbox.tradier.com',
  ];

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

  const quoteRes = await fetch(
    `${baseUrl}/v1/markets/quotes?symbols=${ticker}&greeks=false`,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    }
  );
  if (!quoteRes.ok) {
    throw new Error(`Tradier quote fetch failed: ${quoteRes.status}`);
  }
  const quoteData = await quoteRes.json();
  const quote = quoteData?.quotes?.quote || {};

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
    spotPrice: quote.last ?? quote.close ?? 0,
    priceChange: quote.change || 0,
    priceChangePct: quote.change_percentage || 0,
    iv30: 0,
    volume: quote.volume || 0,
    lastTradeTime: quote.trade_date || null,
    options: allOptions,
  };
}

export function parseOptionSymbol(sym) {
  const m = sym.match(/^(.+?)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    ticker: m[1],
    expiry: '20' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4) + '-' + m[2].slice(4, 6),
    type: m[3] === 'C' ? 'call' : 'put',
    strike: parseInt(m[4], 10) / 1000,
  };
}

export function computeGEX(options, spotPrice) {
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

export function computeMaxPain(options) {
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

export function computePutCallRatio(options) {
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

export function computeNetPremium(options) {
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

export function estimateDarkPoolPct(stockVolume, iv30) {
  if (!iv30 || !stockVolume) return null;
  const basePct = 37.5;
  const ivMod = (iv30 - 30) * 0.1;
  return Math.max(25, Math.min(55, basePct + ivMod));
}
