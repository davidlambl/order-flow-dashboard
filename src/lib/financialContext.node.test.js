// src/lib/financialContext.node.test.js — the chat's model context (src/lib/financialContext.ts): golden snapshots of
// the whole block over one complete fixture and its variants, each under UTC and New York (the snapshot times, the
// news dates and the days to earnings move with the zone); then the lines that read the clock, a threshold or the
// locale, and the two exported helpers. The clock is always the `now` argument, never the wall clock. The fixture
// keeps every count the builder groups below 1,000: a bare toLocaleString() groups by the process's default locale,
// which a test cannot set (de-DE writes 4.200). The snapshots are committed and CI never writes one; after an intended
// change to the block, rewrite them with `npx vitest run -u src/lib/financialContext.node.test.js` and review the diff.
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildFinancialContext, buildFlowTrend, gexCharacter } from './financialContext.js';

// The node project does not rewrite import.meta.url, so this is the file on disk.
const SOURCE_URL = new URL('./financialContext.ts', import.meta.url);

// Reading the clock, as opposed to parsing a given instant: the module takes `now` as an argument.
const CLOCK_READS = /\bDate\.now\b|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\b/g;

/** Source without comments and with quoted strings blanked; template literals are kept (their ${} is code). */
const codeOnly = (src) => src.replace(
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (_, quoted, template) => (quoted ? "''" : template ?? ''),
);

/** Runs fn with the process in time zone `tz` (Node applies a TZ assignment at once), restoring it afterwards. */
function inZone(tz, fn) {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = tz;
    return fn();
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
}

// 11:00 ET on Friday 2026-09-25, 30 s after the fixture's snapshot.
const NOW = Date.parse('2026-09-25T15:00:00Z');
const ZONES = ['UTC', 'America/New_York'];

// A complete getMarketData payload (types/market.ts's MarketData). The counts the builder groups with a bare
// toLocaleString() (totalOptionsCount, the flow volumes) stay below 1,000.
const DATA = {
  ticker: 'AVGO',
  provider: 'cboe',
  delay: '15-min delayed',
  spotPrice: 100,
  priceChange: 1.25,
  priceChangePct: 1.27,
  kpis: {
    netPremium: 1_250_000,
    callPremium: 3_500_000,
    putPremium: 2_250_000,
    darkPoolPct: 38.5,
    maxPain: 98,
    putCallRatio: 0.82,
    maxPainExpiry: '2026-09-25',
    putCallOIRatio: 0.91,
    callVolume: 50_000,
    putVolume: 41_000,
    callOI: 250_000,
    putOI: 227_500,
  },
  gexByStrike: [
    { strike: 95, callGex: 1_000_000, putGex: -3_000_000, gex: -2_000_000 },
    { strike: 100, callGex: 6_000_000, putGex: -1_000_000, gex: 5_000_000 },
    { strike: 105, callGex: 4_000_000, putGex: -500_000, gex: 3_500_000 },
  ],
  lastUpdated: '2026-09-25T14:59:30.000Z',
  flowHistory: [
    { date: '2026-09-24', netPremium: 800_000, cumPremium: 800_000, callVolume: 450, putVolume: 380 },
    { date: '2026-09-25', netPremium: 1_250_000, cumPremium: 2_050_000, callVolume: 500, putVolume: 410 },
  ],
  fallbackReason: null,
  iv30: 31.4,
  lastTradeTime: '2026-09-25T10:59:30',
  totalOptionsCount: 420,
  expiries: ['2026-09-25', '2026-10-02'],
};

// A complete getTickerContext payload: dated and undated news, earnings two days out, every research section.
const TICKER_CONTEXT = {
  ticker: 'AVGO',
  news: [
    {
      headline: 'Broadcom extends its AI deal', summary: '', source: 'Reuters', url: 'https://example.com/n1',
      datetime: '2026-09-25T13:30:00.000Z', sentiment: 0.4,
    },
    {
      headline: 'Chip stocks slip', summary: '', source: 'Bloomberg', url: 'https://example.com/n2',
      datetime: '2026-09-24T03:30:00.000Z', sentiment: -0.2,
    },
    {
      headline: 'No-date item', summary: '', source: 'AP', url: 'https://example.com/n3', datetime: null,
      sentiment: null,
    },
  ],
  earnings: {
    date: '2026-09-27', epsEstimate: 1.5, epsActual: 1.6, revenueEstimate: 12_300_000_000,
    revenueActual: 12_100_000_000, quarter: null, year: null, surprise: 0.1,
  },
  analysts: {
    consensus: { strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0, period: '2026-09-01' },
    priceTarget: { mean: 120, median: 125, high: 150, low: 90 },
  },
  technicals: { sma50: 95, sma200: 85, rsi14: 72.3, currentPrice: 100, fiftyTwoWeekHigh: 110, fiftyTwoWeekLow: 70 },
  fundamentals: {
    marketCap: 650_000, peRatio: 35.2, forwardPE: 28.1, dividendYield: 1.2, beta: 1.1, revenueGrowthQuarterly: 20.5,
    epsGrowthQuarterly: 15, grossMargin: 75.3, operatingMargin: 45.1, roeTTM: 30.2, debtToEquity: 1,
    freeCashFlowTTM: 1, revenuePerShareTTM: 1,
  },
  marketNews: [
    {
      headline: 'Stocks rally', source: 'Reuters', url: 'https://example.com/m1', datetime: '2026-09-25T02:00:00.000Z',
    },
    { headline: 'No date', source: 'AP', url: 'https://example.com/m2', datetime: null },
  ],
  marketQuotes: {
    SPY: { label: 'S&P 500', price: 520.1, change: 2.3, changePct: 0.45, previousClose: 517.8 },
    VIX: { label: 'VIX', price: 18.25, change: -0.5, changePct: -2.67, previousClose: 18.75 },
  },
  errors: {},
};

// Research that loaded with every section empty; a variant puts back the one section it is about.
const NO_SECTIONS = {
  ticker: 'AVGO', news: [], earnings: null, analysts: null, technicals: null, fundamentals: null, marketNews: [],
  marketQuotes: null, errors: {},
};

// 1.5 % above the snapshot's spot, past GAP_DUAL_REC_THRESHOLD_PCT (0.5 %).
const LIVE_QUOTE = {
  ticker: 'AVGO', current: 101.5, previousClose: 100, changePercent: 1.5, timestamp: Date.parse('2026-09-25T15:00:00Z'),
  source: 'yahoo-regular',
};

// What the chat passes, but for `now`: no position, no research, no strategic context, both sessions open.
const BASE = {
  data: DATA, costBasis: null, shares: null, tickerContext: null, strategicContext: '', marketOpen: true,
  optionsMarketOpen: true, liveQuote: null,
};
const POSITION = { costBasis: 90, shares: 100 };
const CLOSED = { marketOpen: false, optionsMarketOpen: false };

const VARIANTS = {
  'no data at all': { ...BASE, data: null },
  'no position, no research': BASE,
  'no position, full research': { ...BASE, tickerContext: TICKER_CONTEXT },
  'a position, no research': { ...BASE, ...POSITION },
  'a position, full research': { ...BASE, ...POSITION, tickerContext: TICKER_CONTEXT },
  'the dual recommendation': { ...BASE, ...POSITION, ...CLOSED, liveQuote: LIVE_QUOTE },
  'a live quote below the gap': { ...BASE, ...POSITION, ...CLOSED, liveQuote: { ...LIVE_QUOTE, current: 100.4 } },
  // 600 min old at NOW, past the closed-session bar of 240 min.
  'stale data under closed sessions': {
    ...BASE, ...POSITION, ...CLOSED, data: { ...DATA, lastUpdated: '2026-09-25T05:00:00.000Z' },
  },
  'thin data': {
    ...BASE,
    data: {
      ...DATA, kpis: { ...DATA.kpis, darkPoolPct: null, maxPain: null, putCallRatio: null, netPremium: null },
      gexByStrike: [], flowHistory: undefined, iv30: null, totalOptionsCount: 0, expiries: [], priceChange: null,
    },
  },
  'a strategic context': { ...BASE, strategicContext: '  Thesis: hold through earnings.  ' },
  'an unparsable earnings date': {
    ...BASE, tickerContext: { ...NO_SECTIONS, earnings: { ...TICKER_CONTEXT.earnings, date: 'garbage' } },
  },
  'news items without a datetime': {
    ...BASE,
    tickerContext: { ...NO_SECTIONS, news: [TICKER_CONTEXT.news[2]], marketNews: [TICKER_CONTEXT.marketNews[1]] },
  },
};

/** The block for `input` at `now`, built in `tz`: New York unless a test is about the zone. */
const build = (input, now = NOW, tz = 'America/New_York') => inZone(tz, () => buildFinancialContext({ ...input, now }));

/** The first line of `text` that `pattern` matches, or undefined. */
const lineOf = (text, pattern) => text.split('\n').find((line) => pattern.test(line));

describe('financialContext', () => {
  describe('snapshots: every variant under UTC and New York', () => {
    describe.each(Object.keys(VARIANTS))('%s', (name) => {
      it.each(ZONES)('%s', (tz) => {
        expect(build(VARIANTS[name], NOW, tz)).toMatchSnapshot();
      });
    });
  });

  it('TICKER and TIMESTAMP open the block, stamped with now in UTC in any zone; no data reads as not loaded', () => {
    const newYearsEve = Date.parse('2026-12-31T23:59:59.999Z');
    for (const tz of ZONES) {
      const [ticker, stamp] = build(BASE, NOW, tz).split('\n');
      expect(ticker).toBe('TICKER: AVGO');
      expect(stamp).toBe('TIMESTAMP: 2026-09-25T15:00:00.000Z');
      expect(build(BASE, newYearsEve, tz).split('\n')[1]).toBe('TIMESTAMP: 2026-12-31T23:59:59.999Z');
    }
    expect(build({ ...BASE, data: null })).toBe('Dashboard data not yet loaded.');
  });

  it("the data's age: '~N min old', lastUpdated to now rounded; none under half a minute or before lastUpdated", () => {
    const updated = Date.parse(DATA.lastUpdated);
    const ageLine = (now, data = DATA) => build({ ...BASE, data }, now).split('\n')[2];
    expect(ageLine(updated + 90 * 60_000)).toBe('DATA LAST UPDATED: 2026-09-25T14:59:30.000Z (data is ~90 min old)');
    expect(ageLine(updated + 30_000)).toBe('DATA LAST UPDATED: 2026-09-25T14:59:30.000Z (data is ~1 min old)');
    expect(ageLine(updated + 29_000)).toBe('DATA LAST UPDATED: 2026-09-25T14:59:30.000Z');
    expect(ageLine(updated - 5 * 60_000)).toBe('DATA LAST UPDATED: 2026-09-25T14:59:30.000Z');
    expect(ageLine(NOW, { ...DATA, lastUpdated: undefined })).toBe('DATA LAST UPDATED: unknown');
  });

  it('the stale note: of the variants only stale data under closed sessions; bars of 240 min closed, 60 open', () => {
    const NOTE = /^ {2}Note: This recommendation is based on options data from (.+)\. It does not reflect overnight/;
    const noted = Object.keys(VARIANTS).filter((name) => lineOf(build(VARIANTS[name]), NOTE));
    expect(noted).toEqual(['stale data under closed sessions']);
    const stale = VARIANTS['stale data under closed sessions'];
    expect(NOTE.exec(lineOf(build(stale), NOTE))?.[1]).toBe('Fri, Sep 25, 1:00 AM');
    expect(NOTE.exec(lineOf(build(stale, NOW, 'UTC'), NOTE))?.[1]).toBe('Fri, Sep 25, 5:00 AM');
    // 120 min old: past the bar only while a session is open, and the options session alone counts (until 16:15 ET).
    const aged = { ...stale, data: { ...DATA, lastUpdated: '2026-09-25T13:00:00.000Z' } };
    expect(lineOf(build(aged), NOTE)).toBeUndefined();
    expect(lineOf(build({ ...aged, optionsMarketOpen: true }), NOTE)).toBeDefined();
    expect(lineOf(build({ ...aged, marketOpen: true }), NOTE)).toBeDefined();
    // The dual block carries its own snapshot note instead.
    expect(lineOf(build({ ...stale, liveQuote: LIVE_QUOTE }), NOTE)).toBeUndefined();
  });

  it('the dual block: the gap line, its arrow and two signals; one signal under the gap or with options open', () => {
    const GAP = /^ {2}Live Price \(Overnight\): /;
    const withQuote = (current, sessions = CLOSED) => build({
      ...BASE, ...POSITION, ...sessions, liveQuote: { ...LIVE_QUOTE, current },
    });
    expect(lineOf(withQuote(101.5), GAP)).toBe('  Live Price (Overnight): $101.50 (↑ +1.5% gap)');
    expect(lineOf(withQuote(98.5), GAP)).toBe('  Live Price (Overnight): $98.50 (↓ 1.5% gap)');
    const dual = withQuote(101.5);
    expect(dual).toContain('\n  Recommendation #1 (Options Snapshot): ');
    expect(dual).toContain('\n  Scenario #2 (If Live Price Holds): ');
    expect(dual).toContain('(snapshot as of Fri, Sep 25, 10:59 AM, may be delayed)');
    // A 0.4 % gap is under GAP_DUAL_REC_THRESHOLD_PCT; while the options session is open the snapshot is current.
    for (const single of [withQuote(100.4), withQuote(101.5, { marketOpen: false, optionsMarketOpen: true })]) {
      expect(lineOf(single, GAP)).toBeUndefined();
      expect(single).toContain('\n  Current Spot: $100.00\n');
      expect(single).toContain('\n  Recommendation: ');
      expect(single).not.toContain('Scenario #2');
    }
  });

  it('CONTRACTS ANALYZED groups by the default locale, so 4,200 is formatted here; 0 contracts, no line', () => {
    const contracts = (totalOptionsCount) => build({ ...BASE, data: { ...DATA, totalOptionsCount } });
    expect(contracts(4200)).toContain(`\nCONTRACTS ANALYZED: ${(4200).toLocaleString()}\n`);
    expect(contracts(0)).not.toContain('CONTRACTS ANALYZED');
  });

  it("the days to earnings count from now's local date: away, TODAY, ago; an unparsable date shows none", () => {
    const dateLine = (date, now, tz) => lineOf(
      build({ ...BASE, tickerContext: { ...NO_SECTIONS, earnings: { ...TICKER_CONTEXT.earnings, date } } }, now, tz),
      /^ {2}Date: /,
    );
    expect(dateLine('2026-09-27')).toBe('  Date: 2026-09-27 (2 days away)');
    expect(dateLine('2026-09-26')).toBe('  Date: 2026-09-26 (1 day away)');
    expect(dateLine('2026-09-25')).toBe('  Date: 2026-09-25 (TODAY)');
    expect(dateLine('2026-09-24')).toBe('  Date: 2026-09-24 (1 day ago)');
    expect(dateLine('2026-09-22')).toBe('  Date: 2026-09-22 (3 days ago)');
    // One instant, two local dates: 23:59:59 on the 24th in New York is already the 25th in UTC.
    const lateEvening = Date.parse('2026-09-25T03:59:59Z');
    expect(dateLine('2026-09-25', lateEvening, 'America/New_York')).toBe('  Date: 2026-09-25 (1 day away)');
    expect(dateLine('2026-09-25', lateEvening, 'UTC')).toBe('  Date: 2026-09-25 (TODAY)');
    // ChatBot's inline count read these two as '(NaN days ago)'; daysUntil gives no count.
    expect(dateLine('garbage')).toBe('  Date: garbage');
    expect(dateLine('2026-09-26T12:00:00Z')).toBe('  Date: 2026-09-26T12:00:00Z');
    expect(dateLine(null)).toBe('  Date: unknown');
  });

  it('gexCharacter: the GEX sign and the 2 % band around spot (GEX_NEAR_SPOT_CHAT_PCT) give four readings', () => {
    expect(gexCharacter(5_000_000, 101, 100)).toBe('Positive gamma — dealer dampener near spot');
    expect(gexCharacter(5_000_000, 105, 100)).toBe('Positive gamma — magnet/pin');
    expect(gexCharacter(-2_000_000, 99, 100)).toBe('Negative gamma — volatility amplifier near spot');
    expect(gexCharacter(-2_000_000, 95, 100)).toBe('Negative gamma — accelerates moves');
    // The band excludes its edge, zero GEX reads negative, and without a spot price no strike is near.
    expect(gexCharacter(5_000_000, 102, 100)).toBe('Positive gamma — magnet/pin');
    expect(gexCharacter(0, 100, 100)).toBe('Negative gamma — volatility amplifier near spot');
    expect(gexCharacter(-2_000_000, 100, 0)).toBe('Negative gamma — accelerates moves');
  });

  it("buildFlowTrend: the run the last five sessions end on (0 counts positive) and their net; '' without", () => {
    const row = (date, netPremium, cumPremium) => ({ date, netPremium, cumPremium, callVolume: 450, putVolume: 380 });
    const week = [
      row('2026-09-21', 200_000, 200_000), row('2026-09-22', -100_000, 100_000), row('2026-09-23', 300_000, 400_000),
      row('2026-09-24', 0, 400_000), row('2026-09-25', 500_000, 900_000),
    ];
    expect(buildFlowTrend(week))
      .toBe('\n5-SESSION TREND: 3 consecutive positive sessions. Cumulative delta over window: $900.0K.');
    // Only the last five count.
    const earlier = [row('2026-09-17', -400_000, -400_000), row('2026-09-18', -100_000, -500_000)];
    expect(buildFlowTrend([...earlier, ...week])).toBe(buildFlowTrend(week));
    expect(buildFlowTrend([row('2026-09-25', -50_000, -50_000)]))
      .toBe('\n5-SESSION TREND: 1 consecutive negative session. Cumulative delta over window: -$50.0K.');
    expect(buildFlowTrend([])).toBe('');
    expect(buildFlowTrend(undefined)).toBe('');
  });

  it('purity: financialContext.ts never reads the clock', async () => {
    const code = codeOnly(await readFile(SOURCE_URL, 'utf8'));
    expect(code.match(CLOCK_READS)).toBeNull();
  });
});
