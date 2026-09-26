// src/lib/recommend.node.test.js — the recommendation engine (roadmap F15), the position panel's staleness rule
// (F17) and shared/thresholds.js. All three are pure (no fetch, env or wall clock), so nothing is stubbed: every
// `now` is a fixed instant and every input is built here.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as rec from './recommend.js';
import * as stale from './staleness.js';
import * as th from '../../shared/thresholds.js';

const RECOMMEND_URL = new URL('./recommend.ts', import.meta.url);
const STALENESS_URL = new URL('./staleness.js', import.meta.url);
const THRESHOLDS_URL = new URL('../../shared/thresholds.js', import.meta.url);

const HOST_GLOBALS = /\b(?:console|process|window|document|navigator|globalThis|fetch|require|localStorage|sessionStorage|Buffer|setTimeout|setInterval)\b/g;
// Reading the clock, as opposed to parsing a given instant: these modules take `now` as an argument.
const CLOCK_READS = /\bDate\.now\b|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\b/g;

const EXPECTED_THRESHOLDS = [
  'PUT_CALL', 'DARK_POOL_PCT', 'PNL_PCT', 'MAX_PAIN_PULL_PCT', 'GEX_NEAR_SPOT_PCT', 'GEX_NEAR_SPOT_CHAT_PCT',
  'STALE_AFTER_MIN', 'RECOMMENDATION', 'GAP_DUAL_REC_THRESHOLD_PCT',
];
const LEVEL_COLORS = {
  Basis: 'var(--color-cyan)', Spot: 'var(--color-warn)', 'Max Pain': 'var(--color-purple)',
  'GEX Support': 'var(--color-bull)', 'GEX Resist.': 'var(--color-bear)',
};

/** Source without comments and with quoted strings blanked; template literals are kept (their ${} is code). */
const codeOnly = (src) => src.replace(
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (_, quoted, template) => (quoted ? "''" : template ?? ''),
);

/** A value as it should read in a failure message ('' and undefined stay visible). */
const show = (v) => {
  if (typeof v === 'string') return `'${v}'`;
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return String(v);
};

const sum = (vector) => vector.reduce((acc, s) => acc + (s ?? 0), 0);
const summary = (r) => ({ signal: r.signal, confidence: r.confidence, factorsUsed: r.factorsUsed, threshold: r.threshold, score: r.score });
const byLabel = (levels) => Object.fromEntries(levels.map((l) => [l.label, l.price]));

/** The input for a factor score of -1 / 0 / +1; null = input missing, so the factor is skipped. */
const pick = (score, bear, flat, bull) => (score == null ? null : score < 0 ? bear : score > 0 ? bull : flat);

/**
 * Engine inputs that score exactly [P&L, max pain, GEX, premium, P/C] (the engine's factor order),
 * each -1, 0, +1 or null. Spot is 100 throughout.
 */
function inputsFor([pnl, maxPain, gex, premium, pc]) {
  return {
    // P&L: up 25 % → -1 (take profits); +2 % → 0 (near breakeven); down 9 % → +1 (recovery zone)
    costBasis: pick(pnl, 80, 98, 110),
    shares: 10,
    spotPrice: 100,
    kpis: {
      // spot 11 % above max pain → -1 (pull down); at it → 0 (pin); 9 % below → +1 (push up)
      maxPain: pick(maxPain, 90, 100, 110),
      netPremium: pick(premium, -2e6, 0, 2e6),
      putCallRatio: pick(pc, 1.2, 0.85, 0.5),
    },
    // negative GEX 1 % below spot → -1; positive GEX only above spot → 0; positive wall below, nothing negative near → +1
    gexByStrike: pick(gex, [{ strike: 99, gex: -5e8 }], [{ strike: 105, gex: 5e8 }], [{ strike: 95, gex: 5e8 }]) ?? [],
  };
}

/** Every vector of 5 factor scores drawn from -1, 0, +1 and null (skipped): 4^5 = 1,024. */
function* allVectors(length = 5) {
  if (length === 0) { yield []; return; }
  for (const head of [-1, 0, 1, null]) for (const tail of allVectors(length - 1)) yield [head, ...tail];
}

describe('recommend', () => {
  it('modules: recommend.ts, staleness.js and shared/thresholds.js load; gap threshold re-exported; no host globals or clock reads', async () => {
    for (const name of ['computeRecommendation', 'extractPriceLevels', 'computeDualRecommendation']) {
      assert.equal(typeof rec[name], 'function', `recommend.js export ${name}`);
    }
    assert.equal(typeof stale.isStaleData, 'function', 'staleness.js export isStaleData');
    assert.equal(rec.GAP_DUAL_REC_THRESHOLD_PCT, th.GAP_DUAL_REC_THRESHOLD_PCT, 'recommend.js re-exports the shared gap threshold');
    for (const url of [RECOMMEND_URL, STALENESS_URL]) {
      const file = url.pathname.split('/').slice(-3).join('/');
      const code = codeOnly(await readFile(url, 'utf8'));
      assert.deepEqual(code.match(HOST_GLOBALS), null, `${file} must stay pure`);
      assert.deepEqual(code.match(CLOCK_READS), null, `${file} must take the time as an argument, not read the clock`);
    }
  });

  it('guards: no or invalid cost basis still scores (P&L skipped, pnl null, market value kept); string basis coerced; bad spot or kpis → null', async () => {
    const kpis = { maxPain: 100, netPremium: 2e6, putCallRatio: 0.85 };
    for (const costBasis of [0, null, undefined, 'abc', '', -5, Number.NaN]) {
      const r = rec.computeRecommendation({ costBasis, shares: 10, spotPrice: 100, kpis, gexByStrike: [] });
      const label = `costBasis ${show(costBasis)}`;
      assert.ok(r, `${label}: still a recommendation`);
      assert.equal(r.pnl.percent, null, label);
      assert.equal(r.pnl.dollars, null, label);
      assert.equal(r.pnl.marketValue, 1000, `${label}: market value = spot × shares`);
      assert.equal(r.factorsUsed, 3, `${label}: P&L factor skipped, the other three scored`);
    }
    const coerced = rec.computeRecommendation({ costBasis: '95', shares: 10, spotPrice: '100', kpis, gexByStrike: [] });
    assert.ok(Math.abs(coerced.pnl.percent - 500 / 95) < 1e-9, `pnl.percent ${coerced.pnl.percent} ≈ 5.26`);
    assert.ok(Math.abs(coerced.pnl.dollars - 50) < 1e-9, `pnl.dollars ${coerced.pnl.dollars}`);
    assert.equal(coerced.factorsUsed, 4);
    for (const spotPrice of [0, 'abc', null, undefined, '', -100, Number.NaN, Infinity]) {
      assert.equal(rec.computeRecommendation({ costBasis: 95, shares: 10, spotPrice, kpis, gexByStrike: [] }), null, `spot ${show(spotPrice)}`);
    }
    assert.equal(rec.computeRecommendation({ costBasis: 95, shares: 10, spotPrice: 100, kpis: null, gexByStrike: [] }), null, 'kpis null');
  });

  it('guards: missing or junk factor inputs are skipped, not scored (max pain 0/null/x, P/C null/NaN, premium null, junk GEX rows)', async () => {
    // Cost basis 98 at spot 100 scores only the P&L factor (0, near breakeven).
    const scoreWith = (kpis, gexByStrike = []) => rec.computeRecommendation({ costBasis: 98, shares: 10, spotPrice: 100, kpis, gexByStrike });
    for (const maxPain of [0, null, 'x', undefined, '', -110]) {
      const r = scoreWith({ maxPain });
      assert.equal(r.factorsUsed, 1, `maxPain ${show(maxPain)} must be skipped`);
      assert.ok(!r.reasons.some((x) => /max pain/i.test(x)), `maxPain ${show(maxPain)}: ${r.reasons.join(' | ')}`);
    }
    assert.match(scoreWith({ maxPain: '110' }).reasons.join(' | '), /below max pain \(\$110\)/, 'numeric-string max pain is coerced');
    for (const putCallRatio of [null, Number.NaN, undefined, '', 'x']) {
      const r = scoreWith({ putCallRatio });
      assert.equal(r.factorsUsed, 1, `putCallRatio ${show(putCallRatio)} must be skipped, not read as bullish`);
      assert.ok(!r.reasons.some((x) => x.startsWith('P/C')), r.reasons.join(' | '));
    }
    for (const netPremium of [null, undefined, Number.NaN, '']) {
      const r = scoreWith({ netPremium });
      assert.equal(r.factorsUsed, 1, `netPremium ${show(netPremium)} must be skipped, not scored as balanced`);
      assert.ok(!r.reasons.some((x) => x.startsWith('Premium traded')), r.reasons.join(' | '));
    }
    const junk = [
      { strike: 'x', gex: 5e8 }, { gex: null }, null, undefined, { strike: 97, gex: null }, { strike: null, gex: 5e8 },
      { strike: 0, gex: 5e8 }, 42, 'row',
    ];
    for (const gexByStrike of [junk, null, {}, 'x']) {
      let r = null;
      assert.doesNotThrow(() => { r = scoreWith({}, gexByStrike); }, `gexByStrike ${show(gexByStrike)}`);
      assert.equal(r.factorsUsed, 1, `gexByStrike ${show(gexByStrike)}: no usable rows, so the GEX factor is skipped`);
      assert.doesNotThrow(() => rec.extractPriceLevels({ costBasis: 98, spotPrice: 100, kpis: {}, gexByStrike }), `levels, gexByStrike ${show(gexByStrike)}`);
    }
    const wall = [{ strike: 95, gex: 5e8 }];
    assert.deepEqual(scoreWith({}, [...junk, ...wall]), scoreWith({}, wall), 'junk rows beside a real wall change nothing');
    assert.deepEqual(
      rec.extractPriceLevels({ spotPrice: 100, kpis: {}, gexByStrike: [...junk, ...wall] }),
      rec.extractPriceLevels({ spotPrice: 100, kpis: {}, gexByStrike: wall }),
      'junk rows never become levels',
    );
  });

  it('confidence is symmetric: all 1,024 score vectors (incl. skipped factors) mirror to the opposite signal at equal confidence', async () => {
    // The fixtures score as intended, one factor at a time.
    for (let i = 0; i < 5; i++) {
      for (const s of [-1, 0, 1]) {
        const v = [null, null, null, null, null];
        v[i] = s;
        const r = rec.computeRecommendation(inputsFor(v));
        assert.equal(r.factorsUsed, 1, `factor ${i} alone`);
        assert.equal(r.score, s, `factor ${i} fixture for ${s}: ${r.reasons[0]}`);
      }
    }
    const MIRROR = { BUY: 'SELL', SELL: 'BUY', HOLD: 'HOLD' };
    let vectors = 0;
    for (const v of allVectors()) {
      const a = rec.computeRecommendation(inputsFor(v));
      const b = rec.computeRecommendation(inputsFor(v.map((s) => (s == null ? null : -s))));
      const label = JSON.stringify(v);
      assert.equal(a.factorsUsed, v.filter((s) => s != null).length, `${label}: factorsUsed`);
      assert.equal(a.score, sum(v), `${label}: score`);
      assert.equal(a.score + b.score, 0, `${label}: mirrored score`);
      assert.equal(b.signal, MIRROR[a.signal], `${label}: ${a.signal} mirrored to ${b.signal}`);
      assert.equal(b.confidence, a.confidence, `${label}: confidence ${a.confidence}, mirrored ${b.confidence}`);
      vectors++;
    }
    assert.equal(vectors, 1024);
  });

  it('confidence: all neutral → HOLD/HIGH; 2 vs 2 split → HOLD/LOW; 2 vs 1 → HOLD/MEDIUM; dissent against a call lowers it', async () => {
    for (const [v, signal, confidence] of [
      [[0, 0, 0, 0, 0], 'HOLD', 'HIGH'],
      [[1, 1, -1, -1, 0], 'HOLD', 'LOW'],
      [[1, 1, -1, 0, 0], 'HOLD', 'MEDIUM'],
      [[-1, -1, 1, 0, 0], 'HOLD', 'MEDIUM'],
      [[1, 1, 0, 0, 0], 'BUY', 'HIGH'],
      [[1, 1, 1, -1, 0], 'BUY', 'MEDIUM'],
      [[-1, -1, -1, 1, 1], 'HOLD', 'LOW'],
      [[-1, -1, -1, -1, 1], 'SELL', 'MEDIUM'],
    ]) {
      const r = rec.computeRecommendation(inputsFor(v));
      assert.deepEqual([r.signal, r.confidence], [signal, confidence], JSON.stringify(v));
    }
  });

  it('threshold scales with factors: < 3 scored → HOLD/LOW "Only n of 5" (threshold null); 3 factors +1,+1,0 → BUY at 2; 5 factors: sum 2 → BUY, sum 1 → HOLD', async () => {
    const two = rec.computeRecommendation(inputsFor([null, null, null, 1, 1])); // bullish premium + P/C only
    assert.deepEqual(summary(two), { signal: 'HOLD', confidence: 'LOW', factorsUsed: 2, threshold: null, score: 2 });
    assert.ok(two.reasons.some((x) => x.includes('Only 2 of 5')), two.reasons.join(' | '));
    const none = rec.computeRecommendation({ spotPrice: 100, kpis: {} });
    assert.deepEqual(summary(none), { signal: 'HOLD', confidence: 'LOW', factorsUsed: 0, threshold: null, score: 0 });
    assert.deepEqual(none.reasons, ['Only 0 of 5 factors available — not enough for a directional call']);
    const three = rec.computeRecommendation(inputsFor([1, 1, 0, null, null]));
    assert.deepEqual(summary(three), { signal: 'BUY', confidence: 'HIGH', factorsUsed: 3, threshold: 2, score: 2 });
    assert.ok(!three.reasons.some((x) => x.startsWith('Only')), 'no not-enough note once 3 factors are scored');
    for (const [v, signal] of [
      [[1, 1, 0, 0, 0], 'BUY'], [[1, 1, 1, -1, 0], 'BUY'], [[-1, -1, 0, 0, 0], 'SELL'],
      [[1, 0, 0, 0, 0], 'HOLD'], [[1, 1, -1, 0, 0], 'HOLD'], [[0, -1, 0, 0, 0], 'HOLD'],
    ]) {
      const r = rec.computeRecommendation(inputsFor(v));
      const label = JSON.stringify(v);
      assert.equal(r.factorsUsed, 5, label);
      assert.equal(r.threshold, 2, label);
      assert.equal(r.score, sum(v), label);
      assert.equal(r.signal, signal, label);
    }
  });

  it('price levels: nearest positive-GEX walls either side of spot (95 / 105, not the largest 90 / 120); basis or max pain ≤ 0 dropped; strings coerced; ascending', async () => {
    const gexByStrike = [
      { strike: 90, gex: 9e8 }, { strike: 95, gex: 5e8 }, { strike: 105, gex: 6e8 }, { strike: 120, gex: 8e8 }, { strike: 100, gex: -7e8 },
    ];
    const levels = rec.extractPriceLevels({ costBasis: 98, spotPrice: 101, kpis: { maxPain: 110 }, gexByStrike });
    assert.deepEqual(byLabel(levels), { Basis: 98, Spot: 101, 'Max Pain': 110, 'GEX Support': 95, 'GEX Resist.': 105 });
    assert.deepEqual(levels.map((l) => l.price), [95, 98, 101, 105, 110], 'ascending by price');
    for (const l of levels) assert.equal(l.color, LEVEL_COLORS[l.label], `${l.label} colour`);

    assert.deepEqual(byLabel(rec.extractPriceLevels({ spotPrice: 105, kpis: {}, gexByStrike })),
      { Spot: 105, 'GEX Support': 105, 'GEX Resist.': 120 }, 'a wall exactly at spot is support');
    // Only the 8 largest |GEX| strikes are candidates: a small wall just below spot loses to them.
    const big = [60, 65, 70, 75, 130, 135, 140, 145].map((strike) => ({ strike, gex: 9e8 }));
    assert.deepEqual(byLabel(rec.extractPriceLevels({ spotPrice: 100, kpis: {}, gexByStrike: [...big, { strike: 99, gex: 1e6 }] })),
      { Spot: 100, 'GEX Support': 75, 'GEX Resist.': 130 });

    const zero = rec.extractPriceLevels({ costBasis: 0, spotPrice: 101, kpis: { maxPain: 0 }, gexByStrike });
    assert.deepEqual(zero.map((l) => l.label), ['GEX Support', 'Spot', 'GEX Resist.'], 'basis 0 / max pain 0 are not levels');
    for (const bad of [null, undefined, 'abc', '', -98]) {
      const l = rec.extractPriceLevels({ costBasis: bad, spotPrice: 101, kpis: { maxPain: bad }, gexByStrike });
      assert.ok(!l.some((x) => x.label === 'Basis' || x.label === 'Max Pain'), `basis / max pain ${show(bad)}`);
    }
    const strings = rec.extractPriceLevels({
      costBasis: '98', spotPrice: '101', kpis: { maxPain: '110' },
      gexByStrike: gexByStrike.map(({ strike, gex }) => ({ strike: String(strike), gex: String(gex) })),
    });
    assert.deepEqual(strings, levels, 'numeric strings give the same levels');
    for (const spotPrice of [null, undefined, 0, 'abc']) {
      const l = rec.extractPriceLevels({ costBasis: 98, spotPrice, kpis: { maxPain: 110 }, gexByStrike });
      assert.deepEqual(l.map((x) => x.label), ['Basis', 'Max Pain'], `spot ${show(spotPrice)}: no GEX walls without a spot`);
    }
    assert.deepEqual(rec.extractPriceLevels({ kpis: null }), []);
  });

  it('put/call bands come from PUT_CALL: 0.69 bullish, 0.70 and 1.00 neutral (bounds inclusive), 1.01 bearish', async () => {
    const pcOnly = (putCallRatio) => rec.computeRecommendation({ spotPrice: 100, kpis: { putCallRatio } });
    for (const [pc, score, reason] of [
      [0.69, 1, 'P/C ratio 0.69 — bullish sentiment'],
      [0.7, 0, 'P/C ratio 0.70 — neutral'],
      [1.0, 0, 'P/C ratio 1.00 — neutral'],
      [1.01, -1, 'P/C ratio 1.01 — bearish sentiment'],
      ['0.5', 1, 'P/C ratio 0.50 — bullish sentiment'],
    ]) {
      const r = pcOnly(pc);
      assert.equal(r.factorsUsed, 1, `P/C ${show(pc)}`);
      assert.equal(r.score, score, `P/C ${show(pc)}`);
      assert.equal(r.reasons[0], reason);
    }
    // The engine's cut-offs are the shared constants themselves (the KPI card uses the same ones).
    const { bullishBelow, bearishAbove } = th.PUT_CALL;
    assert.deepEqual([bullishBelow, bearishAbove], [0.7, 1.0], 'the literals above are the PUT_CALL values');
    assert.equal(pcOnly(bullishBelow).score, 0, 'PUT_CALL.bullishBelow itself is neutral');
    assert.equal(pcOnly(bearishAbove).score, 0, 'PUT_CALL.bearishAbove itself is neutral');
    assert.equal(pcOnly(bullishBelow - 1e-9).score, 1, 'just under PUT_CALL.bullishBelow is bullish');
    assert.equal(pcOnly(bearishAbove + 1e-9).score, -1, 'just over PUT_CALL.bearishAbove is bearish');
  });

  it('shared/thresholds.js: constants only (no imports, host globals or clock); every exported object deep-frozen; bands ordered', async () => {
    const code = codeOnly(await readFile(THRESHOLDS_URL, 'utf8'));
    assert.doesNotMatch(code, /\bimport\b/, 'shared/thresholds.js must not import anything');
    assert.deepEqual(code.match(HOST_GLOBALS), null, 'no host globals');
    assert.deepEqual(code.match(/\b(?:Date|Math|Intl|performance)\b/g), null, 'constants only: nothing computed or clock-dependent');
    for (const name of EXPECTED_THRESHOLDS) assert.ok(name in th, `export ${name}`);
    const assertConstant = (value, path) => {
      assert.notEqual(typeof value, 'function', `${path}: constants only`);
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is a finite number`);
      if (value === null || typeof value !== 'object') return;
      assert.ok(Object.isFrozen(value), `${path} must be frozen`);
      for (const [key, inner] of Object.entries(value)) assertConstant(inner, `${path}.${key}`);
    };
    for (const [name, value] of Object.entries(th)) assertConstant(value, name);
    const { PUT_CALL, DARK_POOL_PCT, PNL_PCT, STALE_AFTER_MIN, GEX_NEAR_SPOT_PCT, GEX_NEAR_SPOT_CHAT_PCT } = th;
    assert.ok(PUT_CALL.bullishBelow < PUT_CALL.bearishAbove, 'P/C: the bullish cut-off sits below the bearish one');
    assert.ok(DARK_POOL_PCT.lowBelow < DARK_POOL_PCT.elevatedAbove, 'dark pool: low below elevated');
    assert.ok(
      PNL_PCT.takeProfitAbove > PNL_PCT.moderateGainAbove && PNL_PCT.moderateGainAbove > -PNL_PCT.breakevenBand
        && -PNL_PCT.breakevenBand > PNL_PCT.recoveryZoneAbove,
      'P&L bands descend: take profit > moderate gain > breakeven floor > recovery floor',
    );
    assert.ok(STALE_AFTER_MIN.sessionOpen < STALE_AFTER_MIN.sessionClosed, 'staleness: tighter bar while open');
    assert.ok(GEX_NEAR_SPOT_CHAT_PCT <= GEX_NEAR_SPOT_PCT, 'chat GEX band is the tighter one');
  });

  it('isStaleData: stale after 60 min while a session is open, 240 min closed; ISO / epoch / Date agree; missing or invalid instants never stale', async () => {
    const NOW = Date.parse('2026-09-25T18:00:00Z');
    const minsAgo = (min) => NOW - min * 60_000;
    for (const [min, open, want] of [
      [59, true, false], [60, true, false], [61, true, true],
      [239, false, false], [240, false, false], [241, false, true],
      [61, false, false], [-5, true, false],
    ]) {
      const ms = minsAgo(min);
      for (const [kind, value] of [['epoch ms', ms], ['ISO', new Date(ms).toISOString()], ['Date', new Date(ms)]]) {
        assert.equal(stale.isStaleData(value, NOW, open), want, `${min} min old (${kind}), session ${open ? 'open' : 'closed'}`);
      }
    }
    for (const bad of [null, undefined, '', 'nope', Number.NaN, new Date(Number.NaN), {}, true]) {
      assert.equal(stale.isStaleData(bad, NOW, true), false, `lastUpdated ${show(bad)}`);
    }
    for (const badNow of [Number.NaN, undefined, 'x']) {
      assert.equal(stale.isStaleData(minsAgo(500), badNow, true), false, `now ${show(badNow)}`);
    }
  });

  it('computeDualRecommendation: options closed → snapshot + live scenarios (gap ≈ 3 %); open → live only; basis ≤ 0 → null; strings coerced', async () => {
    const kpis = { maxPain: 100, netPremium: 2e6, putCallRatio: 0.85 };
    const gexByStrike = [{ strike: 95, gex: 5e8 }];
    const args = { costBasis: 90, shares: 10, optionsSnapshotPrice: 100, livePrice: 103, kpis, gexByStrike, optionsMarketOpen: false };
    const single = (spotPrice) => rec.computeRecommendation({ costBasis: 90, shares: 10, spotPrice, kpis, gexByStrike });
    const closed = rec.computeDualRecommendation(args);
    assert.ok(closed?.primary && closed.secondary, 'both scenarios present');
    assert.ok(Math.abs(closed.gapPercent - 3) < 1e-9, `gapPercent ${closed.gapPercent}`);
    assert.deepEqual([closed.optionsSnapshotPrice, closed.livePrice, closed.optionsMarketOpen], [100, 103, false]);
    assert.deepEqual(closed.primary, single(100), 'primary = the engine at the snapshot price');
    assert.deepEqual(closed.secondary, single(103), 'secondary = the engine at the live price');
    for (const costBasis of [0, null, 'abc', -90]) {
      assert.equal(rec.computeDualRecommendation({ ...args, costBasis }), null, `costBasis ${show(costBasis)}`);
    }
    assert.equal(rec.computeDualRecommendation({ ...args, kpis: null }), null, 'kpis null');
    assert.equal(rec.computeDualRecommendation({ ...args, livePrice: 0 }), null, 'no live price');
    assert.deepEqual(rec.computeDualRecommendation({ ...args, costBasis: '90', optionsSnapshotPrice: '100', livePrice: '103' }), closed,
      'numeric strings coerced');
    const open = rec.computeDualRecommendation({ ...args, optionsMarketOpen: true });
    assert.equal(open.secondary, null, 'options open: no second scenario');
    assert.deepEqual(open.primary, single(103), 'options open: one recommendation at the live price');
    assert.equal(open.optionsMarketOpen, true);
  });
});
