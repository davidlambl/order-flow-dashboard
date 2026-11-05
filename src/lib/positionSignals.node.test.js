// src/lib/positionSignals.node.test.js — the position panel's derivation (src/lib/positionSignals.ts) over the cases
// PositionAnalysis distinguishes: dual mode once the live price is GAP_DUAL_REC_THRESHOLD_PCT or more from the options
// snapshot while the options market is closed, the recommendation each mode shows, the price levels, the staleness
// flag and the two unrealised P&Ls. Every case asserts every field; the engine's own output stands for rec, dualRec
// and levels (src/lib/recommend.node.test.js tests the engine). `now` is a fixed instant, and a source scan keeps the
// module from reading the clock.
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { derivePositionSignals } from './positionSignals.js';
import { computeDualRecommendation, computeRecommendation, extractPriceLevels } from './recommend.js';
import { GAP_DUAL_REC_THRESHOLD_PCT } from '../../shared/thresholds.js';

// The engine never returns nothing for an input past dual mode's guards (they are its own), so that case is staged:
// computeDualRecommendation is the real one unless a test queues a null.
vi.mock('./recommend.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, computeDualRecommendation: vi.fn(actual.computeDualRecommendation) };
});

// The node project does not rewrite import.meta.url, so this is the file on disk.
const SOURCE_URL = new URL('./positionSignals.ts', import.meta.url);

const HOST_GLOBALS = /\b(?:console|process|window|document|navigator|globalThis|fetch|require|localStorage|sessionStorage|Buffer|setTimeout|setInterval)\b/g;
// Reading the clock, as opposed to parsing a given instant: the module takes `now` as an argument.
const CLOCK_READS = /\bDate\.now\b|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\b/g;

/** Source without comments and with quoted strings blanked; template literals are kept (their ${} is code). */
const codeOnly = (src) => src.replace(
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (_, quoted, template) => (quoted ? "''" : template ?? ''),
);

/** A value as it should read in a failure message ('' and undefined stay visible). */
const show = (v) => (typeof v === 'string' ? `'${v}'` : String(v));

// Fri 2026-09-25, 5:00 PM ET: after the options close (4:15 PM).
const NOW = Date.parse('2026-09-25T21:00:00Z');
const SPOT = 100;
const KPIS = { maxPain: 100, netPremium: 2e6, putCallRatio: 0.85 };
const GEX = [{ strike: 95, gex: 5e8 }];

/** The snapshot's time `min` minutes before NOW, an ISO string as getMarketData stamps it. */
const minutesAgo = (min) => new Date(NOW - min * 60_000).toISOString();

/** A live quote at `current`: an after-hours print, two minutes old. */
const quote = (current) => ({
  ticker: 'AVGO', current, previousClose: 99, changePercent: 1, timestamp: NOW - 120_000, source: 'yahoo-post',
});

/** 10 shares at 80 against the 100 snapshot, an hour-old snapshot, both sessions closed, no live quote yet. */
const BASE = {
  costBasis: 80, shares: 10, spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX, liveQuote: null,
  optionsMarketOpen: false, marketOpen: false, lastUpdated: minutesAgo(60), now: NOW,
};
const at = (over) => ({ ...BASE, ...over });

/** The engine at the snapshot price for BASE's position, with these overrides: the single recommendation. */
const engineAt = (over) => computeRecommendation({
  costBasis: 80, shares: 10, spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX, ...over,
});
/** The engine's dual result for BASE's position at `livePrice`, the options market closed. */
const dualAt = (livePrice, over) => computeDualRecommendation({
  costBasis: 80, shares: 10, optionsSnapshotPrice: SPOT, livePrice, kpis: KPIS, gexByStrike: GEX,
  optionsMarketOpen: false, ...over,
});
/** The engine's price levels for BASE's position, with these overrides. */
const levelsAt = (over) => extractPriceLevels({
  costBasis: 80, spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX, ...over,
});

/** The P&L percent as the panel defines it: (price − basis) ÷ basis × 100. */
const pctOf = (price, basis) => ((price - basis) / basis) * 100;

const NO_PNL = { pct: null, dollars: null, up: null };

/** Nothing to show; each case lists the fields it has on top of this. */
const NOTHING = {
  costBasisNum: NaN, spotNum: NaN, liveNum: NaN, hasBasis: false, hasShares: false, hasSpotPrice: false,
  hasLiveQuote: false, showDual: false, dualRec: null, rec: null, levels: [], isStale: false, pnl: NO_PNL,
  livePnl: NO_PNL,
};
const FIELDS = Object.keys(NOTHING).sort();

/** BASE: single mode at +25 % on 10 shares, with no live price. */
const SINGLE = {
  costBasisNum: 80, spotNum: SPOT, hasBasis: true, hasShares: true, hasSpotPrice: true, rec: engineAt(),
  levels: levelsAt(), pnl: { pct: 25, dollars: 200, up: true },
};

/** Assert every field of derivePositionSignals(input): `has` laid over NOTHING. */
function assertSignals(label, input, has) {
  const want = { ...NOTHING, ...has };
  const got = derivePositionSignals(input);
  assert.deepEqual(Object.keys(got).sort(), FIELDS, `${label}: the fields`);
  for (const field of FIELDS) assert.deepEqual(got[field], want[field], `${label}: ${field}`);
}

describe('derivePositionSignals', () => {
  it('single mode: a basis, shares and a spot, no live quote; below the basis in the red; breakeven reads as up', () => {
    assertSignals('BASE', BASE, SINGLE);
    assertSignals('basis 125', at({ costBasis: 125 }), {
      ...SINGLE, costBasisNum: 125, rec: engineAt({ costBasis: 125 }), levels: levelsAt({ costBasis: 125 }),
      pnl: { pct: -20, dollars: -250, up: false },
    });
    assertSignals('basis at the spot', at({ costBasis: SPOT }), {
      ...SINGLE, costBasisNum: SPOT, rec: engineAt({ costBasis: SPOT }), levels: levelsAt({ costBasis: SPOT }),
      pnl: { pct: 0, dollars: 0, up: true },
    });
  });

  it('a basis without shares (missing, zero or negative): the P&L percents without their dollars, in both modes', () => {
    for (const shares of [null, undefined, 0, -3]) {
      assertSignals(`shares ${show(shares)}`, at({ shares }), {
        ...SINGLE, hasShares: false, rec: engineAt({ shares }), pnl: { pct: 25, dollars: null, up: true },
      });
      assertSignals(`shares ${show(shares)}, live 102`, at({ shares, liveQuote: quote(102) }), {
        ...SINGLE, hasShares: false, liveNum: 102, hasLiveQuote: true, showDual: true, dualRec: dualAt(102, { shares }),
        rec: null, pnl: { pct: 25, dollars: null, up: true }, livePnl: { pct: pctOf(102, 80), dollars: null, up: true },
      });
    }
  });

  it('a numeric-string basis is the number it reads as', () => {
    assertSignals("basis '80'", at({ costBasis: '80' }), SINGLE);
    assert.deepEqual(
      derivePositionSignals(at({ costBasis: '80', liveQuote: quote(102) })),
      derivePositionSignals(at({ liveQuote: quote(102) })),
      "basis '80' in dual mode",
    );
  });

  it('no basis (missing, blank, not a number, zero, negative or infinite): no P&L, recommendation, levels or dual mode', () => {
    for (const [costBasis, costBasisNum] of [
      [null, 0], [undefined, NaN], ['', 0], ['abc', NaN], [0, 0], [-5, -5], [NaN, NaN], [Infinity, Infinity],
    ]) {
      assertSignals(`basis ${show(costBasis)}, live 102`, at({ costBasis, liveQuote: quote(102) }), {
        costBasisNum, spotNum: SPOT, liveNum: 102, hasShares: true, hasSpotPrice: true, hasLiveQuote: true,
      });
    }
  });

  it('no spot (missing, NaN, zero or negative): no snapshot P&L, recommendation, levels or dual mode; the live P&L stays', () => {
    for (const [spotPrice, spotNum] of [[undefined, NaN], [NaN, NaN], [0, 0], [-100, -100]]) {
      assertSignals(`spot ${show(spotPrice)}, live 102`, at({ spotPrice, liveQuote: quote(102) }), {
        costBasisNum: 80, spotNum, liveNum: 102, hasBasis: true, hasShares: true, hasLiveQuote: true,
        livePnl: { pct: pctOf(102, 80), dollars: 220, up: true },
      });
    }
  });

  it('no kpis: no recommendation and no dual mode whatever the gap; the levels and both P&Ls stay', () => {
    assert.deepEqual(levelsAt({ kpis: undefined }).map((l) => l.label), ['Basis', 'GEX Support', 'Spot']);
    assertSignals('kpis undefined, live 102', at({ kpis: undefined, liveQuote: quote(102) }), {
      ...SINGLE, rec: null, levels: levelsAt({ kpis: undefined }), liveNum: 102, hasLiveQuote: true,
      livePnl: { pct: pctOf(102, 80), dollars: 220, up: true },
    });
  });

  it('no usable live price (no quote; a quote at 0, below 0 or without a price): no live P&L and no dual mode', () => {
    for (const [label, liveQuote, liveNum] of [
      ['no quote', null, NaN], ['a quote at 0', quote(0), 0], ['a quote at -1', quote(-1), -1],
      ['a quote without a price', { ...quote(102), current: undefined }, NaN],
    ]) {
      assertSignals(label, at({ liveQuote }), { ...SINGLE, liveNum });
    }
  });

  it('the options market open: single mode whatever the gap, the live P&L beside it', () => {
    assertSignals('options open, live 102', at({ optionsMarketOpen: true, marketOpen: true, liveQuote: quote(102) }), {
      ...SINGLE, liveNum: 102, hasLiveQuote: true, livePnl: { pct: pctOf(102, 80), dollars: 220, up: true },
    });
  });

  it('the gap: dual mode from GAP_DUAL_REC_THRESHOLD_PCT itself, up or down, the single recommendation stepping aside', () => {
    const threshold = (SPOT * GAP_DUAL_REC_THRESHOLD_PCT) / 100; // in dollars at the 100 snapshot
    const gapPct = (live) => Math.abs(((live - SPOT) / SPOT) * 100);
    for (const [label, live, dollars, dual] of [
      ['above, up', 102, 220, true],
      ['at, up', SPOT + threshold, 205, true],
      ['below, up', SPOT + threshold / 2, 202.5, false],
      ['above, down', 98, 180, true],
      ['at, down', SPOT - threshold, 195, true],
      ['below, down', SPOT - threshold / 2, 197.5, false],
    ]) {
      if (label.startsWith('at')) assert.equal(gapPct(live), GAP_DUAL_REC_THRESHOLD_PCT, `${label}: the fixture's gap`);
      const withLive = {
        ...SINGLE, liveNum: live, hasLiveQuote: true, livePnl: { pct: pctOf(live, 80), dollars, up: true },
      };
      assertSignals(`live ${live} (${label})`, at({ liveQuote: quote(live) }),
        dual ? { ...withLive, showDual: true, dualRec: dualAt(live), rec: null } : withLive);
    }
  });

  it('dual mode under water: both P&Ls in the red', () => {
    assertSignals('basis 101, live 98', at({ costBasis: 101, liveQuote: quote(98) }), {
      ...SINGLE, costBasisNum: 101, liveNum: 98, hasLiveQuote: true, showDual: true,
      dualRec: dualAt(98, { costBasis: 101 }), rec: null, levels: levelsAt({ costBasis: 101 }),
      pnl: { pct: pctOf(SPOT, 101), dollars: -10, up: false }, livePnl: { pct: pctOf(98, 101), dollars: -30, up: false },
    });
  });

  it('dual mode with no dual result: the single recommendation stands in', () => {
    const dual = vi.mocked(computeDualRecommendation);
    dual.mockReturnValueOnce(null);
    assertSignals('live 102, no dual result', at({ liveQuote: quote(102) }), {
      ...SINGLE, liveNum: 102, hasLiveQuote: true, showDual: true, dualRec: null,
      livePnl: { pct: pctOf(102, 80), dollars: 220, up: true },
    });
    assert.equal(dual.mock.results.at(-1).value, null, 'the staged null went to the derivation');
  });

  it('staleness: past 60 minutes while either session is open, past 240 with both closed; no snapshot time is never stale', () => {
    // [optionsMarketOpen, marketOpen]; the equity flag never stands alone in the app, but the bar reads either flag
    const SESSIONS = {
      'both closed': [false, false], 'options only': [true, false], 'the equity flag alone': [false, true],
      'both open': [true, true],
    };
    for (const [age, session, isStale] of [
      [60, 'both closed', false], [61, 'both closed', false], [240, 'both closed', false], [241, 'both closed', true],
      [60, 'options only', false], [61, 'options only', true], [61, 'the equity flag alone', true],
      [60, 'both open', false], [61, 'both open', true],
    ]) {
      const [optionsMarketOpen, marketOpen] = SESSIONS[session];
      assertSignals(`${age} min old, ${session}`, at({ lastUpdated: minutesAgo(age), optionsMarketOpen, marketOpen }), {
        ...SINGLE, isStale,
      });
    }
    for (const [session, [optionsMarketOpen, marketOpen]] of Object.entries(SESSIONS)) {
      assertSignals(`no snapshot time, ${session}`, at({ lastUpdated: undefined, optionsMarketOpen, marketOpen }), SINGLE);
    }
  });

  it('the age is measured against `now`: the same snapshot turns stale three hours later', () => {
    assertSignals('now + 181 min', at({ now: NOW + 181 * 60_000 }), { ...SINGLE, isStale: true });
  });

  it('purity: positionSignals.ts reads no host globals and never reads the clock', async () => {
    const code = codeOnly(await readFile(SOURCE_URL, 'utf8'));
    assert.deepEqual(code.match(HOST_GLOBALS), null, 'src/lib/positionSignals.ts must stay pure');
    assert.deepEqual(code.match(CLOCK_READS), null, 'src/lib/positionSignals.ts must take the time as an argument, not read the clock');
  });
});

// The live P&L's sign has its own comparison: at breakeven it reads as up, as the snapshot P&L does.
describe('derivePositionSignals: the live P&L at breakeven', () => {
  it('reads as up with a zero percent and zero dollars when the live price sits on the cost basis', () => {
    const got = derivePositionSignals(at({ costBasis: 102, liveQuote: quote(102) })); // 2 % above the snapshot: dual mode
    assert.equal(got.showDual, true);
    assert.deepEqual(got.livePnl, { pct: 0, dollars: 0, up: true });
    assert.deepEqual(got.pnl, { pct: ((SPOT - 102) / 102) * 100, dollars: (SPOT - 102) * 10, up: false });
  });
});

