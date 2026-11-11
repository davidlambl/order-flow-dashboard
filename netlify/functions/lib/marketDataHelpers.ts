// netlify/functions/lib/marketDataHelpers.ts
// Shared computation functions for options data — used by getMarketData and collectFlowHistory.

import { fetchWithTimeout, isTimeoutError } from './http.js';
import { parseTicker } from './ticker.js';
import { etDateString, isExpiryClosed } from '../../../shared/marketCalendar.js';
import type { GexRow, MarketDelay, MarketKpis, MarketProvider } from '../../../types/market.js';

/** Number of nearest expiries every provider is measured on (see normalizeChain). */
export const EXPIRY_WINDOW = 6;

const CBOE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const CBOE_TIMEOUT_MS = 8000;
const TRADIER_TIMEOUT_MS = 6000;

/** One contract, under the same names from both providers; `symbol` is its OCC symbol (see parseOptionSymbol). */
export interface OptionContract {
  symbol: string;
  bid: number;
  ask: number;
  iv: number;
  openInterest: number;
  volume: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** What fetchCBOE and fetchTradier resolve to: the stock's quote and its raw chain. */
export interface ProviderAnswer {
  provider: Exclude<MarketProvider, 'mock'>;
  delay: Exclude<MarketDelay, 'simulated'>;
  spotPrice: number;
  priceChange: number;
  priceChangePct: number;
  iv30: number | null;
  volume: number;
  lastTradeTime: string | number | null;
  options: OptionContract[];
}

/** fetchCBOE's answer: the last trade's time is CBOE's date-time string. */
export interface CboeAnswer extends ProviderAnswer {
  provider: 'cboe';
  delay: '15-min delayed';
  lastTradeTime: string | null;
}

/** fetchTradier's answer: no IV30, and the last trade's time in epoch milliseconds. */
export interface TradierAnswer extends ProviderAnswer {
  provider: 'tradier' | 'tradier-sandbox';
  delay: 'real-time' | 'sandbox (delayed)';
  iv30: null;
  lastTradeTime: number | null;
}

// res.json() is unknown. Each body is asserted once, where it is parsed, to just the fields this file reads, typed as
// the provider sends them; validating it instead would change what a malformed answer does. The reads cope as they
// always have: a missing field falls back (`?? 0`, `|| null`, `|| []`), Tradier's optional chains read a null body as
// an empty one, normalizeChain drops a contract without a string symbol, and getMarketData accepts an answer only with
// a positive spot price and a contract in the window; a null CBOE body still throws, and a field of another type still
// passes through.

/** CBOE's delayed quote, which arrives wrapped in `data` (an unwrapped body is read the same way). */
interface CboeQuote {
  current_price?: number;
  price_change?: number;
  price_change_percent?: number;
  iv30?: number;
  volume?: number;
  last_trade_time?: string;
  options?: CboeOption[];
}

interface CboeOption {
  option: string;
  bid?: number;
  ask?: number;
  iv?: number;
  open_interest?: number;
  volume?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

interface CboeBody extends CboeQuote {
  data?: CboeQuote;
}

/** Tradier sends one expiry as a string, several as an array, and none as `expirations: null`. */
interface TradierExpirationsBody {
  expirations?: { date?: string | string[] } | null;
}

/** Tradier's quote for the one symbol asked for; there is no `quote` when it does not know the symbol. */
interface TradierQuotesBody {
  quotes?: { quote?: TradierQuote };
}

interface TradierQuote {
  last?: number | null;
  close?: number | null;
  change?: number | null;
  change_percentage?: number | null;
  volume?: number;
  trade_date?: number;
}

/** One expiry's chain: one contract as an object, several as an array, none as `options: null`. */
interface TradierChainBody {
  options?: { option?: TradierOption | TradierOption[] } | null;
}

interface TradierOption {
  symbol: string;
  bid?: number;
  ask?: number;
  open_interest?: number;
  volume?: number;
  greeks?: { mid_iv?: number; ask_iv?: number; delta?: number; gamma?: number; theta?: number; vega?: number } | null;
}

function assertTicker(ticker: unknown): string {
  const t = parseTicker(ticker);
  if (!t) throw new Error(`Invalid ticker: ${String(ticker).slice(0, 20)}`);
  return t;
}

function tradierUrl(base: string, path: string, params: Record<string, string>): URL {
  const url = new URL(`${base}/v1/markets/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url;
}

export async function fetchCBOE(rawTicker: string, signal: AbortSignal | null = null): Promise<CboeAnswer> {
  const ticker = assertTicker(rawTicker);
  const res = await fetchWithTimeout(`${CBOE_BASE}/${encodeURIComponent(ticker)}.json`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  }, CBOE_TIMEOUT_MS, signal);

  if (!res.ok) throw new Error(`CBOE returned ${res.status} for ${ticker}`);

  const raw = await res.json() as CboeBody;
  const data = raw.data || raw;

  return {
    provider: 'cboe',
    delay: '15-min delayed',
    spotPrice: data.current_price ?? 0,
    priceChange: data.price_change ?? 0,
    priceChangePct: data.price_change_percent ?? 0,
    iv30: data.iv30 ?? null,
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

export async function fetchTradier(
  rawTicker: string,
  apiKey: string,
  signal: AbortSignal | null = null,
): Promise<TradierAnswer> {
  const ticker = assertTicker(rawTicker);
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' };
  const bases = [
    'https://api.tradier.com',
    'https://sandbox.tradier.com',
  ];

  let expirations: string[] = [];
  let baseUrl = bases[0];
  let baseTimeout: unknown = null;

  for (const base of bases) {
    try {
      const expRes = await fetchWithTimeout(
        tradierUrl(base, 'options/expirations', { symbol: ticker, includeAllRoots: 'true' }),
        { headers },
        TRADIER_TIMEOUT_MS, signal,
      );
      if (expRes.ok) {
        const expData = await expRes.json() as TradierExpirationsBody | null;
        const dates = expData?.expirations?.date;
        if (dates && (Array.isArray(dates) ? dates.length > 0 : true)) {
          expirations = Array.isArray(dates) ? dates : [dates];
          baseUrl = base;
          break;
        }
      }
    } catch (err) {
      // Try the next base; remember a timeout so it is reported as one if no base answers.
      if (isTimeoutError(err)) baseTimeout = err;
    }
  }

  if (expirations.length === 0) {
    if (baseTimeout) throw baseTimeout;
    throw new Error('Tradier: no expiration dates found');
  }

  const quoteRes = await fetchWithTimeout(
    tradierUrl(baseUrl, 'quotes', { symbols: ticker, greeks: 'false' }),
    { headers },
    TRADIER_TIMEOUT_MS, signal,
  );
  if (!quoteRes.ok) {
    throw new Error(`Tradier quote fetch failed: ${quoteRes.status}`);
  }
  const quoteData = await quoteRes.json() as TradierQuotesBody | null;
  const quote: TradierQuote = quoteData?.quotes?.quote || {};

  const nearbyExpiries = expirations.slice(0, EXPIRY_WINDOW);
  const chainPromises = nearbyExpiries.map((exp) =>
    fetchWithTimeout(
      tradierUrl(baseUrl, 'options/chains', { symbol: ticker, expiration: exp, greeks: 'true' }),
      { headers },
      TRADIER_TIMEOUT_MS, signal,
    ).then((r) => (r.ok ? r.json() as Promise<TradierChainBody | null> : null)).catch(() => null)
  );

  // null = that chain fetch failed (non-OK status, network error, timeout or bad JSON).
  const chainResults = await Promise.all(chainPromises);
  const failedChains = chainResults.filter((r) => r == null).length;
  if (failedChains === chainResults.length) {
    // Nothing usable: throw so the handler falls back to CBOE instead of serving an empty chain.
    throw new Error('Tradier: all chain fetches failed');
  }
  if (failedChains > 0) {
    console.warn(`Tradier: ${failedChains} of ${chainResults.length} chain fetches failed for ${ticker}; using the rest`);
  }

  const allOptions: OptionContract[] = [];
  for (const result of chainResults) {
    const opts = result?.options?.option;
    if (!opts) continue;
    const arr = Array.isArray(opts) ? opts : [opts];
    for (const opt of arr) {
      allOptions.push({
        symbol: opt.symbol,
        bid: opt.bid ?? 0,
        ask: opt.ask ?? 0,
        iv: opt.greeks?.mid_iv ?? opt.greeks?.ask_iv ?? 0,
        openInterest: opt.open_interest ?? 0,
        volume: opt.volume ?? 0,
        delta: opt.greeks?.delta ?? 0,
        gamma: opt.greeks?.gamma ?? 0,
        theta: opt.greeks?.theta ?? 0,
        vega: opt.greeks?.vega ?? 0,
      });
    }
  }

  const isSandbox = baseUrl.includes('sandbox');

  return {
    provider: isSandbox ? 'tradier-sandbox' : 'tradier',
    delay: isSandbox ? 'sandbox (delayed)' : 'real-time',
    spotPrice: quote.last ?? quote.close ?? 0,
    priceChange: quote.change ?? 0,
    priceChangePct: quote.change_percentage ?? 0,
    iv30: null, // Tradier quotes carry no IV30; null renders as "—", never "0.0%"
    volume: quote.volume ?? 0,
    lastTradeTime: quote.trade_date || null,
    options: allOptions,
  };
}

/** normalizeChain's result: the window's contracts, grouped in ascending expiry order, and the window itself. */
export interface NormalizedChain {
  options: OptionContract[];
  /** 'YYYY-MM-DD', ascending. */
  expiries: string[];
}

/**
 * Normalize a raw chain to the expiry window every provider is measured on: drop
 * contracts whose expiry is already in the past (Eastern Time) and keep only the
 * `window` nearest expiries, so CBOE (which serves every expiry) and Tradier (which
 * we fetch for the nearest few) feed identical inputs to the metric computations.
 * Contracts come back grouped in ascending expiry order.
 */
export function normalizeChain(
  options: readonly OptionContract[] | null | undefined,
  { now = new Date(), window = EXPIRY_WINDOW }: { now?: Date; window?: number } = {},
): NormalizedChain {
  const today = etDateString(now);
  const byExpiry = new Map<string, OptionContract[]>();
  for (const opt of options || []) {
    const parsed = typeof opt?.symbol === 'string' ? parseOptionSymbol(opt.symbol) : null;
    if (!parsed) continue;
    if (today && parsed.expiry < today) continue;
    let bucket = byExpiry.get(parsed.expiry);
    if (!bucket) {
      bucket = [];
      byExpiry.set(parsed.expiry, bucket);
    }
    bucket.push(opt);
  }
  const expiries = [...byExpiry.keys()].sort().slice(0, window);
  // Every expiry here is a key of byExpiry, so get() is never undefined and the `?? []` never applies.
  return { options: expiries.flatMap((e) => byExpiry.get(e) ?? []), expiries };
}

/** An OCC symbol's parts: the root, the expiry as 'YYYY-MM-DD', the side and the strike. */
export interface ParsedOptionSymbol {
  ticker: string;
  expiry: string;
  type: 'call' | 'put';
  strike: number;
}

export function parseOptionSymbol(sym: string): ParsedOptionSymbol | null {
  const m = sym.match(/^(.+?)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    ticker: m[1],
    expiry: '20' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4) + '-' + m[2].slice(4, 6),
    type: m[3] === 'C' ? 'call' : 'put',
    strike: parseInt(m[4], 10) / 1000,
  };
}

export function computeGEX(options: readonly OptionContract[], spotPrice: number): GexRow[] {
  const gexByStrike: Record<number, Omit<GexRow, 'gex'>> = {};

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

/**
 * Max pain for the nearest expiry that can still trade. Expiries are tried in
 * ascending order, skipping any already closed at `now` (Eastern Time — e.g. a
 * 0DTE after the 4:15 PM options close) and any with no open interest.
 *
 * @returns null when no open expiry has OI
 */
export function computeMaxPain(
  options: readonly OptionContract[] | null | undefined,
  { now = new Date() }: { now?: Date } = {},
): { strike: number; expiry: string } | null {
  const byExpiry = new Map<string, { opt: OptionContract; parsed: ParsedOptionSymbol }[]>();
  for (const opt of options || []) {
    const parsed = typeof opt?.symbol === 'string' ? parseOptionSymbol(opt.symbol) : null;
    if (!parsed) continue;
    let bucket = byExpiry.get(parsed.expiry);
    if (!bucket) {
      bucket = [];
      byExpiry.set(parsed.expiry, bucket);
    }
    bucket.push({ opt, parsed });
  }

  for (const expiry of [...byExpiry.keys()].sort()) {
    if (isExpiryClosed(expiry, now)) continue;

    const strikeOI: Record<number, { callOI: number; putOI: number }> = {};
    // `expiry` is a key of byExpiry, so get() is never undefined and the `?? []` never applies.
    for (const { opt, parsed } of byExpiry.get(expiry) ?? []) {
      const oi = opt.openInterest || 0;
      if (oi === 0) continue;

      const s = parsed.strike;
      if (!strikeOI[s]) strikeOI[s] = { callOI: 0, putOI: 0 };
      if (parsed.type === 'call') strikeOI[s].callOI += oi;
      else strikeOI[s].putOI += oi;
    }

    const strikes = Object.keys(strikeOI).map(Number).sort((a, b) => a - b);
    if (strikes.length === 0) continue; // no open interest on this expiry: try the next

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

    return { strike: maxPainStrike, expiry };
  }

  return null;
}

/** computePutCallRatio's result: the two ratios, null without calls, and the four sums they come from. */
export interface PutCallRatio extends Pick<MarketKpis, 'callVolume' | 'putVolume' | 'callOI' | 'putOI'> {
  volumeRatio: number | null;
  oiRatio: number | null;
}

export function computePutCallRatio(options: readonly OptionContract[]): PutCallRatio {
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

  // No call volume / OI means the ratio is undefined, not 0 (which would read as very bullish).
  return {
    volumeRatio: callVol > 0 ? putVol / callVol : null,
    oiRatio: callOI > 0 ? putOI / callOI : null,
    callVolume: callVol,
    putVolume: putVol,
    callOI,
    putOI,
  };
}

export function computeNetPremium(
  options: readonly OptionContract[],
): Pick<MarketKpis, 'callPremium' | 'putPremium' | 'netPremium'> {
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

/** Takes any values: both go through Number(), and null comes back unless both are finite and positive. */
export function estimateDarkPoolPct(stockVolume: unknown, iv30: unknown): number | null {
  const vol = Number(stockVolume);
  const iv = Number(iv30);
  if (!Number.isFinite(vol) || vol <= 0 || !Number.isFinite(iv) || iv <= 0) return null;
  const basePct = 37.5;
  const ivMod = (iv - 30) * 0.1;
  return Math.max(25, Math.min(55, basePct + ivMod));
}
