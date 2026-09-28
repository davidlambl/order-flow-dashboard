// src/lib/recommend.ts
// Algorithmic position recommendation engine.
// Scores up to 5 market factors (P&L vs basis, max-pain pull, GEX positioning, premium traded,
// put/call ratio) and aggregates them into a BUY / HOLD / SELL signal. A factor whose input is
// missing or invalid is skipped rather than scored neutral, and the bar for a directional call
// scales with the number of factors actually scored (RECOMMENDATION in shared/thresholds.js).
// Pure and Node-loadable (src/lib/recommend.node.test.js imports it), so relative imports carry
// their extension.

import {
  PUT_CALL, PNL_PCT, MAX_PAIN_PULL_PCT, GEX_NEAR_SPOT_PCT, RECOMMENDATION, GAP_DUAL_REC_THRESHOLD_PCT,
} from '../../shared/thresholds.js';
import type { GexRow, MarketKpis } from '../../types/market.js';

// Minimum live-vs-snapshot gap (percent) that triggers dual recommendation mode. Re-exported
// because PositionAnalysis and ChatBot import it from here.
export { GAP_DUAL_REC_THRESHOLD_PCT };

/** A number or a numeric string, which the engine coerces; null and undefined count as missing. */
type NumericInput = number | string | null | undefined;

/** The MarketKpis fields the engine reads, numeric strings coerced; a missing or invalid value skips its factor. */
export type RecommendationKpis = { [K in 'maxPain' | 'netPremium' | 'putCallRatio']?: MarketKpis[K] | string | null };

/** A gexByStrike row as the engine reads it: GexRow's strike and gex, numeric strings coerced. */
export type GexRowInput = { [K in 'strike' | 'gex']?: GexRow[K] | string | null };

/**
 * gexByStrike as the engine reads it. The engine also survives a non-array (no rows) and rows that are not objects
 * (skipped), which the tests pin, but a type admitting those would make every row `any`. The array type is mutable
 * on purpose: Array.isArray narrows a readonly array type to any[], which would do the same.
 */
type GexRowsInput = (GexRowInput | null | undefined)[] | null | undefined;

/**
 * computeRecommendation's input. spotPrice and kpis are required keys so a caller cannot forget them; a missing
 * value still gives a null result.
 */
export interface RecommendationInput {
  costBasis?: NumericInput;
  shares?: NumericInput;
  spotPrice: NumericInput;
  kpis: RecommendationKpis | null | undefined;
  gexByStrike?: GexRowsInput;
}

/** extractPriceLevels's input: the engine's without shares, every field optional. */
export type PriceLevelsInput = Partial<Pick<RecommendationInput, 'costBasis' | 'spotPrice' | 'kpis' | 'gexByStrike'>>;

/**
 * computeDualRecommendation's input: the engine's, with the snapshot and live prices in place of spotPrice.
 * shares and gexByStrike are passed on to the engine as they are.
 */
export interface DualRecommendationInput {
  costBasis: NumericInput;
  shares?: NumericInput;
  optionsSnapshotPrice: NumericInput;
  livePrice: NumericInput;
  kpis: RecommendationKpis | null | undefined;
  gexByStrike?: GexRowsInput;
  optionsMarketOpen: boolean;
}

/** The engine's call. */
export type Signal = 'BUY' | 'HOLD' | 'SELL';

/** Scored factors dissenting from the call: none → HIGH, one → MEDIUM, two or more → LOW; LOW when too few were scored. */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** The position at the scored spot price. */
export interface RecommendationPnl {
  dollars: number | null;
  percent: number | null;
  /** spot × shares */
  marketValue: number;
}

/** computeRecommendation's result. */
export interface Recommendation {
  signal: Signal;
  confidence: Confidence;
  /** One line per scored factor, in factor order, then a note when too few were scored. */
  reasons: string[];
  pnl: RecommendationPnl;
  /** Factors scored, out of 5; the others lacked a valid input. */
  factorsUsed: number;
  threshold: number | null;
  score: number;
}

/** The levels extractPriceLevels can mark. */
export type PriceLevelLabel = 'Basis' | 'Spot' | 'Max Pain' | 'GEX Support' | 'GEX Resist.';

/** One marker on the position's price-level bar. */
export interface PriceLevel {
  price: number;
  label: PriceLevelLabel;
  /** A CSS colour: a theme variable such as 'var(--color-cyan)'. */
  color: string;
}

/** computeDualRecommendation's result. */
export interface DualRecommendation {
  /** The engine at the options snapshot price; at the live price while the options market is open. */
  primary: Recommendation;
  /** The engine at the live price while the options market is closed; null while it is open. */
  secondary: Recommendation | null;
  optionsSnapshotPrice: number;
  livePrice: number;
  /** (live − snapshot) ÷ snapshot × 100 */
  gapPercent: number;
  optionsMarketOpen: boolean;
}

/** One factor's score: +1 bullish, 0 neutral, -1 bearish. */
type FactorScore = -1 | 0 | 1;

/** A usable gexByStrike row: a positive finite strike and a finite gex, coerced. */
type GexPoint = Pick<GexRow, 'strike' | 'gex'>;

/** Factors the engine can score; fewer are scored when inputs are missing. */
const FACTOR_COUNT = 5;

/** How many of the largest-|GEX| strikes the GEX factor looks at. */
const GEX_FACTOR_STRIKES = 5;

/** How many of the largest-|GEX| strikes the price-level bar picks its walls from. */
const GEX_LEVEL_STRIKES = 8;

/**
 * Number(v) for numbers and numeric strings; NaN for null, undefined, '' and anything else.
 * (Number(null) and Number('') are 0, which would score a missing input as a real one: a null
 * put/call ratio would read as bullish.)
 */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/** Rows of gexByStrike with a positive finite strike and a finite gex, coerced; junk rows are dropped. */
function finiteGexRows(gexByStrike: GexRowsInput): GexPoint[] {
  if (!Array.isArray(gexByStrike)) return [];
  const rows: GexPoint[] = [];
  for (const row of gexByStrike) {
    const strike = toNumber(row?.strike);
    const gex = toNumber(row?.gex);
    if (isPositive(strike) && Number.isFinite(gex)) rows.push({ strike, gex });
  }
  return rows;
}

/** The `count` rows with the largest |gex|, largest first. */
function largestByAbsGex(rows: readonly GexPoint[], count: number): GexPoint[] {
  return [...rows].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, count);
}

/**
 * Score a stock position against the current options positioning.
 *
 * Factors, each +1 (bullish), 0 (neutral) or -1 (bearish), skipped when its input is missing or invalid:
 *   1. P&L vs cost basis in PNL_PCT bands (only with a positive cost basis)
 *   2. Max-pain pull: spot more than MAX_PAIN_PULL_PCT away from a positive max pain
 *   3. GEX positioning of the largest-|GEX| strikes (negative GEX within GEX_NEAR_SPOT_PCT of spot)
 *   4. Premium traded, calls − puts by volume × mid (which side traded more, not aggressor-signed)
 *   5. Put/call ratio in PUT_CALL bands
 *
 * Aggregation: with fewer than RECOMMENDATION.minFactors scored factors the result is HOLD / LOW
 * with `threshold: null`. Otherwise the net score must reach
 * `max(minDirectionalScore, ceil(directionalFraction × factorsUsed))` for BUY, or its negative for
 * SELL. Confidence counts the factors dissenting from the call (for HOLD, the smaller of the
 * bullish and bearish camps): 0 → HIGH, 1 → MEDIUM, 2+ → LOW, so mirrored inputs give the mirrored
 * signal with the same confidence.
 *
 * @param params  numeric strings are coerced
 * @returns null unless spot is a positive number and kpis is present. `pnl.dollars` and
 *   `pnl.percent` are null without a positive cost basis; `threshold` is the net score a BUY needs
 *   (null when too few factors were scored); `score` is the net score.
 */
export function computeRecommendation({ costBasis, shares, spotPrice, kpis, gexByStrike }: RecommendationInput): Recommendation | null {
  const spot = toNumber(spotPrice);
  if (!isPositive(spot) || !kpis) return null;

  const k = kpis;
  const basis = toNumber(costBasis);
  const hasBasis = isPositive(basis);
  const numShares = Math.max(0, Number(shares) || 0);
  const pnl = {
    dollars: hasBasis ? (spot - basis) * numShares : null,
    percent: hasBasis ? ((spot - basis) / basis) * 100 : null,
    marketValue: spot * numShares,
  };

  const scores: number[] = [];
  const reasons: string[] = [];
  const add = (score: FactorScore, reason: string): void => {
    scores.push(score);
    reasons.push(reason);
  };

  // Factor 1: P&L position (needs a cost basis: pnl.percent is null without one)
  if (pnl.percent !== null) {
    const pct = pnl.percent;
    if (pct > PNL_PCT.takeProfitAbove) {
      add(-1, `Up ${pct.toFixed(1)}% — consider taking profits`);
    } else if (pct > PNL_PCT.moderateGainAbove) {
      add(0, `Up ${pct.toFixed(1)}% — moderate gain`);
    } else if (pct > -PNL_PCT.breakevenBand) {
      add(0, `Near breakeven (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`);
    } else if (pct > PNL_PCT.recoveryZoneAbove) {
      add(1, `Down ${Math.abs(pct).toFixed(1)}% — potential recovery zone`);
    } else {
      add(-1, `Down ${Math.abs(pct).toFixed(1)}% — significant loss, reassess thesis`);
    }
  }

  // Factor 2: Max pain magnet (a max pain of 0 means "unknown", not a $0 strike)
  const maxPain = toNumber(k.maxPain);
  if (isPositive(maxPain)) {
    const distToMaxPain = ((spot - maxPain) / maxPain) * 100;
    if (distToMaxPain > MAX_PAIN_PULL_PCT) {
      add(-1, `Spot is ${distToMaxPain.toFixed(1)}% above max pain ($${maxPain}) — likely pull toward it`);
    } else if (distToMaxPain < -MAX_PAIN_PULL_PCT) {
      add(1, `Spot is ${Math.abs(distToMaxPain).toFixed(1)}% below max pain ($${maxPain}) — likely push toward it`);
    } else {
      add(0, `Spot near max pain ($${maxPain}) — pinning expected`);
    }
  }

  // Factor 3: GEX positioning of the largest strikes
  const gexRows = finiteGexRows(gexByStrike);
  if (gexRows.length > 0) {
    const biggestStrikes = largestByAbsGex(gexRows, GEX_FACTOR_STRIKES);
    const nearSpot = GEX_NEAR_SPOT_PCT / 100;
    const positiveGexAbove = biggestStrikes.some((s) => s.gex > 0 && s.strike > spot);
    const positiveGexBelow = biggestStrikes.some((s) => s.gex > 0 && s.strike < spot);
    const negativeGexNearby = biggestStrikes.some(
      (s) => s.gex < 0 && Math.abs(s.strike - spot) / spot < nearSpot
    );

    if (positiveGexBelow && !negativeGexNearby) {
      add(1, 'Positive GEX below spot — dealer hedging provides support');
    } else if (negativeGexNearby) {
      add(-1, 'Negative GEX near spot — volatile, dealers amplify moves');
    } else if (positiveGexAbove) {
      add(0, 'Positive GEX above spot — resistance zone overhead');
    } else {
      add(0, 'GEX positioning neutral');
    }
  }

  // Factor 4: Premium traded. Calls − puts by volume × mid says which side traded more premium,
  // not who initiated the trades, so it is a tilt rather than signed "institutional buying".
  const netPremium = toNumber(k.netPremium);
  if (Number.isFinite(netPremium)) {
    if (netPremium > 0) {
      add(1, 'Premium traded is call-heavy (calls − puts by volume × mid, not aggressor-signed)');
    } else if (netPremium < 0) {
      add(-1, 'Premium traded is put-heavy (calls − puts by volume × mid, not aggressor-signed)');
    } else {
      add(0, 'Premium traded is balanced between calls and puts');
    }
  }

  // Factor 5: Put/call ratio (null when there was no call volume: skipped, never read as bullish)
  const pc = toNumber(k.putCallRatio);
  if (Number.isFinite(pc)) {
    if (pc < PUT_CALL.bullishBelow) {
      add(1, `P/C ratio ${pc.toFixed(2)} — bullish sentiment`);
    } else if (pc > PUT_CALL.bearishAbove) {
      add(-1, `P/C ratio ${pc.toFixed(2)} — bearish sentiment`);
    } else {
      add(0, `P/C ratio ${pc.toFixed(2)} — neutral`);
    }
  }

  // Aggregate: the bar for a directional call scales with the number of factors scored.
  const n = scores.length;
  const sum = scores.reduce((a, b) => a + b, 0);
  if (n < RECOMMENDATION.minFactors) {
    reasons.push(`Only ${n} of ${FACTOR_COUNT} factors available — not enough for a directional call`);
    return { signal: 'HOLD', confidence: 'LOW', reasons, pnl, factorsUsed: n, threshold: null, score: sum };
  }

  const threshold = Math.max(
    RECOMMENDATION.minDirectionalScore,
    Math.ceil(RECOMMENDATION.directionalFraction * n)
  );
  const signal = sum >= threshold ? 'BUY' : sum <= -threshold ? 'SELL' : 'HOLD';
  // Dissent = factors against the call; for HOLD, the smaller camp (an even split is low confidence).
  const bulls = scores.filter((s) => s > 0).length;
  const bears = scores.filter((s) => s < 0).length;
  const dissent = signal === 'BUY' ? bears : signal === 'SELL' ? bulls : Math.min(bulls, bears);
  const confidence = dissent === 0 ? 'HIGH' : dissent === 1 ? 'MEDIUM' : 'LOW';

  return { signal, confidence, reasons, pnl, factorsUsed: n, threshold, score: sum };
}

/**
 * Key price levels for the position bar: basis, spot, max pain, and the nearest positive-GEX walls
 * on either side of spot among the GEX_LEVEL_STRIKES largest-|GEX| strikes (support = the highest
 * such strike at or below spot, resistance = the lowest above it). A level is included only when
 * its price is a positive number (numeric strings are coerced); the GEX walls also need a spot.
 * @returns ascending by price
 */
export function extractPriceLevels({ costBasis, spotPrice, kpis, gexByStrike }: PriceLevelsInput): PriceLevel[] {
  const levels: PriceLevel[] = [];
  const basis = toNumber(costBasis);
  const spot = toNumber(spotPrice);
  const maxPain = toNumber(kpis?.maxPain);

  if (isPositive(basis)) levels.push({ price: basis, label: 'Basis', color: 'var(--color-cyan)' });
  if (isPositive(spot)) levels.push({ price: spot, label: 'Spot', color: 'var(--color-warn)' });
  if (isPositive(maxPain)) levels.push({ price: maxPain, label: 'Max Pain', color: 'var(--color-purple)' });

  if (isPositive(spot)) {
    let support: GexPoint | null = null;
    let resistance: GexPoint | null = null;
    for (const row of largestByAbsGex(finiteGexRows(gexByStrike), GEX_LEVEL_STRIKES)) {
      if (row.gex <= 0) continue;
      if (row.strike <= spot) {
        if (!support || row.strike > support.strike) support = row;
      } else if (!resistance || row.strike < resistance.strike) {
        resistance = row;
      }
    }
    if (support) levels.push({ price: support.strike, label: 'GEX Support', color: 'var(--color-bull)' });
    if (resistance) levels.push({ price: resistance.strike, label: 'GEX Resist.', color: 'var(--color-bear)' });
  }

  return levels.sort((a, b) => a.price - b.price);
}

/**
 * Compute dual recommendations for when options market is closed and spot price has diverged.
 * @param params
 *   - costBasis: Entry price per share (number or numeric string; coerced internally; must be > 0)
 *   - optionsSnapshotPrice: Spot from the options feed at the snapshot (CBOE ~15-min delayed, or Tradier; coerced internally)
 *   - livePrice: Real-time price from Yahoo/Finnhub (regular, pre- or post-market session; coerced internally)
 * @returns
 *   Returned `optionsSnapshotPrice` and `livePrice` are normalized to numbers regardless of input type.
 */
export function computeDualRecommendation({
  costBasis, shares,
  optionsSnapshotPrice, livePrice,
  kpis, gexByStrike,
  optionsMarketOpen
}: DualRecommendationInput): DualRecommendation | null {
  // Coerce to numbers so string-typed prices (e.g. from API responses) are handled correctly
  const costBasisNum = Number(costBasis);
  const snapshotPriceNum = Number(optionsSnapshotPrice);
  const livePriceNum = Number(livePrice);

  if (
    !Number.isFinite(costBasisNum) || costBasisNum <= 0 ||
    !Number.isFinite(snapshotPriceNum) || snapshotPriceNum <= 0 ||
    !Number.isFinite(livePriceNum) || livePriceNum <= 0 ||
    !kpis
  ) {
    return null;
  }

  const gapPercent = ((livePriceNum - snapshotPriceNum) / snapshotPriceNum) * 100;

  // If options market is open, only compute live recommendation (no dual mode needed)
  if (optionsMarketOpen) {
    const liveRec = computeRecommendation({
      costBasis: costBasisNum,
      shares,
      spotPrice: livePriceNum,
      kpis,
      gexByStrike,
    });

    if (!liveRec) {
      return null;
    }

    return {
      primary: liveRec,
      secondary: null,
      optionsSnapshotPrice: snapshotPriceNum,
      livePrice: livePriceNum,
      gapPercent,
      optionsMarketOpen,
    };
  }

  // Options market closed - compute both recommendations for dual mode
  const optionsCloseRec = computeRecommendation({
    costBasis: costBasisNum,
    shares,
    spotPrice: snapshotPriceNum,
    kpis,
    gexByStrike,
  });

  const liveRec = computeRecommendation({
    costBasis: costBasisNum,
    shares,
    spotPrice: livePriceNum,
    kpis,
    gexByStrike,
  });

  if (!optionsCloseRec || !liveRec) {
    return null;
  }

  return {
    primary: optionsCloseRec,
    secondary: liveRec,
    optionsSnapshotPrice: snapshotPriceNum,
    livePrice: livePriceNum,
    gapPercent,
    optionsMarketOpen,
  };
}
