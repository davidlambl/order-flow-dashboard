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
//   - Daily candles (1 year, for computing 50/200 MA + RSI-14)
//
// BYOK: accepts x-finnhub-key header, falls back to FINNHUB_API_KEY env var.
// Partial success: individual sections can fail without blocking others.

import { getSupabaseAdmin } from './lib/supabaseAdmin.js';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-finnhub-key, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'private, max-age=900',
  'Vary': 'x-finnhub-key',
};

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function finnhubGet(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${FINNHUB_BASE}${path}${sep}token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${path}: ${res.status}`);
  return res.json();
}

// Fetch earnings from Alpha Vantage with Supabase caching.
// Returns the earnings object or null on failure.
async function fetchEarnings(ticker) {
  const avKey = process.env.ALPHA_VANTAGE_KEY;
  if (!avKey) return null;

  // Check Supabase cache first
  let staleData = null;
  try {
    const sb = getSupabaseAdmin();
    const { data: cached } = await sb
      .from('earnings_cache')
      .select('data, next_report_date, fetched_at')
      .eq('ticker', ticker)
      .single();

    if (cached?.data) {
      const now = new Date();
      // Fresh if next_report_date is in the future
      if (cached.next_report_date) {
        const nextDate = new Date(cached.next_report_date + 'T00:00:00Z');
        if (nextDate > now) return cached.data;
      }
      // TTL fallback: treat cache as fresh for 24h when next_report_date is missing
      if (!cached.next_report_date && cached.fetched_at) {
        const age = now - new Date(cached.fetched_at);
        if (age >= 0 && age <= 24 * 60 * 60 * 1000) return cached.data;
      }
      // Cache exists but is stale — keep as fallback in case AV fails
      staleData = cached.data;
    }
  } catch {
    // No cache or Supabase unavailable — fall through to API call
  }

  // Call Alpha Vantage
  try {
    const avUrl = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(ticker)}&apikey=${avKey}`;
    const res = await fetch(avUrl);
    if (!res.ok) return staleData;
    const json = await res.json();

    const quarters = json.quarterlyEarnings;
    if (!Array.isArray(quarters) || quarters.length === 0) return staleData;

    const q = quarters[0]; // most recent quarter

    const toNumberOrNull = (value) => {
      if (value === null || value === undefined) return null;
      const num = typeof value === 'number' ? value : parseFloat(value);
      return Number.isFinite(num) ? num : null;
    };

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
    if (q.reportedDate) {
      const d = new Date(q.reportedDate + 'T00:00:00Z');
      d.setDate(d.getDate() + 95);
      nextReportDate = d.toISOString().slice(0, 10);
    }

    // Upsert into cache (non-blocking — don't let cache write failures break the response)
    try {
      const sb = getSupabaseAdmin();
      const { error: upsertError } = await sb.from('earnings_cache').upsert(
        { ticker, data: earnings, next_report_date: nextReportDate, fetched_at: new Date().toISOString() },
        { onConflict: 'ticker' }
      );
      if (upsertError) {
        console.warn('Earnings cache upsert error:', upsertError.message || upsertError);
      }
    } catch (cacheErr) {
      console.warn('Earnings cache write failed:', cacheErr.message);
    }

    return earnings;
  } catch (err) {
    console.warn('Alpha Vantage earnings fetch failed:', err.message);
    return staleData; // return stale cache rather than nothing
  }
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const ticker = (url.searchParams.get('ticker') || '').toUpperCase();
  if (!ticker) {
    return new Response(JSON.stringify({ error: 'Missing ticker' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const finnhubKey = req.headers.get('x-finnhub-key') || process.env.FINNHUB_API_KEY || '';
  if (!finnhubKey) {
    return new Response(
      JSON.stringify({ error: 'No Finnhub API key configured. Add one in Settings or set FINNHUB_API_KEY env var.' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

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
  const [
    earningsResult,
    [newsRes, earningsRevRes, recRes, ptRes, metricsRes, candleRes, generalNewsRes, ...quoteResults],
  ] = await Promise.all([
    fetchEarnings(ticker),
    Promise.allSettled([
      finnhubGet(`/company-news?symbol=${ticker}&from=${fromStr}&to=${toDate}`, finnhubKey),
      finnhubGet(`/calendar/earnings?symbol=${ticker}&from=${earningsFrom.toISOString().slice(0, 10)}&to=${earningsTo.toISOString().slice(0, 10)}`, finnhubKey),
      finnhubGet(`/stock/recommendation?symbol=${ticker}`, finnhubKey),
      finnhubGet(`/stock/price-target?symbol=${ticker}`, finnhubKey),
      finnhubGet(`/stock/metric?symbol=${ticker}&metric=all`, finnhubKey),
      finnhubGet(`/stock/candle?symbol=${ticker}&resolution=D&from=${oneYearAgo}&to=${nowUnix}`, finnhubKey),
      finnhubGet('/news?category=general', finnhubKey),
      ...MARKET_SYMBOLS.map((sym) => finnhubGet(`/quote?symbol=${sym}`, finnhubKey)),
    ]),
  ]);

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

  // EPS from Alpha Vantage (accurate), revenue from Finnhub
  const earnings = earningsResult;
  if (earnings && earningsRevRes.status === 'fulfilled') {
    const cal = earningsRevRes.value?.earningsCalendar || [];
    const match = cal.find((e) => e.date === earnings.date) || cal[0];
    if (match) {
      earnings.revenueEstimate = match.revenueEstimate ?? null;
      earnings.revenueActual = match.revenueActual ?? null;
    }
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
      forwardPE: m.peTTM ?? null,
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
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
};
