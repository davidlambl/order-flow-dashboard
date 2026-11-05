// src/lib/positionSignals.ts
// What the position panel shows besides its inputs: dual mode (the live price has moved away from the options snapshot
// while the options market is closed) with its two recommendations, the single recommendation, the price levels, the
// staleness flag and the unrealised P&L at the snapshot and at the live price. PositionAnalysis derived them in five
// memos and its render; they are one pure function here, so every branch is tested under Node without React
// (src/lib/positionSignals.node.test.js), and usePositionSignals derives them in one memo. Node-loadable: the clock is
// the caller's `now`, and relative imports carry their extension.

import {
  computeDualRecommendation, computeRecommendation, extractPriceLevels, GAP_DUAL_REC_THRESHOLD_PCT,
} from './recommend.js';
import type { DualRecommendation, PriceLevel, Recommendation } from './recommend.js';
import { isStaleData } from './staleness.js';
import type { LiveQuote, MarketData } from '../../types/market.js';

/** derivePositionSignals's input: the position draft, the market data's fields, the two sessions and the clock. */
export interface PositionSignalsInput {
  /** The average cost as the panel takes it, a number or a numeric string; it counts once finite and > 0. */
  costBasis: number | string | null | undefined;
  /** The share count: the P&L dollars need it > 0. */
  shares: number | null | undefined;
  /** data?.spotPrice, the options snapshot's price; it counts once finite and > 0. */
  spotPrice: MarketData['spotPrice'] | undefined;
  /** data?.kpis: without them there is no recommendation and no dual mode. */
  kpis: MarketData['kpis'] | undefined;
  /** data?.gexByStrike: the recommendation's GEX factor and the price levels' walls. */
  gexByStrike: MarketData['gexByStrike'] | undefined;
  /** The live quote, null until one lands: its price drives dual mode and the live P&L. */
  liveQuote: LiveQuote | null;
  /** The options session is open: no dual mode whatever the gap, and the open session's staleness bar. */
  optionsMarketOpen: boolean;
  /** The equity session is open: the open session's staleness bar. */
  marketOpen: boolean;
  /** data?.lastUpdated, the snapshot's time: an unknown age is never stale. */
  lastUpdated: MarketData['lastUpdated'] | undefined;
  /** The clock in epoch ms (useNow's in the panel): the snapshot's age is measured against it. */
  now: number;
}

/** One unrealised P&L, at the snapshot's price or at the live price. */
export interface PositionPnl {
  /** (price − basis) ÷ basis × 100; null without a basis or a price. */
  pct: number | null;
  /** (price − basis) × shares; null without a basis, shares or a price. */
  dollars: number | null;
  /** pct ≥ 0, breakeven included; null while pct is. */
  up: boolean | null;
}

/** derivePositionSignals's result. */
export interface PositionSignals {
  /** Number(costBasis), NaN included: every guard and the P&L read this. */
  costBasisNum: number;
  /** Number(spotPrice). */
  spotNum: number;
  /** Number(liveQuote?.current): NaN without a live quote. */
  liveNum: number;
  /** costBasisNum is finite and > 0. */
  hasBasis: boolean;
  /** shares is set and > 0. */
  hasShares: boolean;
  /** spotNum is finite and > 0. */
  hasSpotPrice: boolean;
  /** liveNum is finite and > 0. */
  hasLiveQuote: boolean;
  /**
   * Dual mode: a basis, a spot, a live price and kpis, the options market closed, and the live price at least
   * GAP_DUAL_REC_THRESHOLD_PCT away from the snapshot, up or down.
   */
  showDual: boolean;
  /** The engine at the snapshot price and at the live price; null outside dual mode. */
  dualRec: DualRecommendation | null;
  /** The engine at the snapshot price: null once the dual result exists, and without a basis, a spot or kpis. */
  rec: Recommendation | null;
  /** The price-level bar's markers, ascending; [] without a basis or a spot. */
  levels: PriceLevel[];
  /** The snapshot is older than its session's bar, the tighter one while either session is open. */
  isStale: boolean;
  /** At the options snapshot's price. */
  pnl: PositionPnl;
  /** At the live price. */
  livePnl: PositionPnl;
}

/** The input with its three prices read through Number(): what the four derivations below take. */
type Priced = PositionSignalsInput & Pick<PositionSignals, 'costBasisNum' | 'spotNum' | 'liveNum'>;

function dualMode({ liveQuote, kpis, optionsMarketOpen, costBasisNum, spotNum, liveNum }: Priced): boolean {
  if (!liveQuote || !kpis) return false;
  if (optionsMarketOpen) return false;
  if (!Number.isFinite(costBasisNum) || costBasisNum <= 0) return false;
  if (!Number.isFinite(spotNum) || spotNum <= 0) return false;
  if (!Number.isFinite(liveNum) || liveNum <= 0) return false;
  // A fall splits the panel as a rise does, from the threshold itself
  const gapPct = Math.abs(((liveNum - spotNum) / spotNum) * 100);
  return gapPct >= GAP_DUAL_REC_THRESHOLD_PCT;
}

function dualRecommendation(
  { costBasisNum, shares, spotNum, liveNum, kpis, gexByStrike, optionsMarketOpen }: Priced,
  showDual: boolean,
): DualRecommendation | null {
  if (!showDual) return null;
  return computeDualRecommendation({
    costBasis: costBasisNum,
    shares,
    optionsSnapshotPrice: spotNum,
    livePrice: liveNum,
    kpis,
    gexByStrike,
    optionsMarketOpen: optionsMarketOpen || false,
  });
}

function singleRecommendation(
  { costBasisNum, shares, spotNum, kpis, gexByStrike }: Priced,
  showDual: boolean,
  dualRec: DualRecommendation | null,
): Recommendation | null {
  // Dual mode without a dual result falls back to the single recommendation
  if (showDual && dualRec) return null;
  if (!Number.isFinite(costBasisNum) || costBasisNum <= 0 || !Number.isFinite(spotNum) || spotNum <= 0) return null;
  return computeRecommendation({ costBasis: costBasisNum, shares, spotPrice: spotNum, kpis, gexByStrike });
}

function priceLevels({ costBasisNum, spotNum, kpis, gexByStrike }: Priced): PriceLevel[] {
  if (!Number.isFinite(costBasisNum) || costBasisNum <= 0 || !Number.isFinite(spotNum) || spotNum <= 0) return [];
  return extractPriceLevels({ costBasis: costBasisNum, spotPrice: spotNum, kpis, gexByStrike });
}

/**
 * The position panel's signals for one position and one market snapshot. It never reads the clock: `now` ages the
 * snapshot, so a test fixes the time by passing it. Each call runs the engine afresh and returns new objects, so a
 * caller that renders from it memoises it on these inputs.
 */
export function derivePositionSignals(input: PositionSignalsInput): PositionSignals {
  const { costBasis, shares, spotPrice, liveQuote, optionsMarketOpen, marketOpen, lastUpdated, now } = input;
  // Normalize inputs once so all downstream logic (showDual, hasBasis, P&L) uses consistent numeric values
  const costBasisNum = Number(costBasis);
  const spotNum = Number(spotPrice);
  const liveNum = Number(liveQuote?.current);
  const priced = { ...input, costBasisNum, spotNum, liveNum };

  const showDual = dualMode(priced);
  const dualRec = dualRecommendation(priced, showDual);
  const rec = singleRecommendation(priced, showDual, dualRec);
  const levels = priceLevels(priced);
  // The tighter bar applies while either session is open (options data updates until 4:15 PM ET).
  const isStale = isStaleData(lastUpdated, now, optionsMarketOpen || marketOpen);

  const hasBasis = Number.isFinite(costBasisNum) && costBasisNum > 0;
  const hasShares = shares != null && shares > 0;
  const hasSpotPrice = Number.isFinite(spotNum) && spotNum > 0;
  const hasLiveQuote = Number.isFinite(liveNum) && liveNum > 0;

  const pnlPct = hasBasis && hasSpotPrice ? ((spotNum - costBasisNum) / costBasisNum) * 100 : null;
  const pnlDollars = hasBasis && hasShares && hasSpotPrice ? (spotNum - costBasisNum) * shares : null;
  const pnlUp = pnlPct != null ? pnlPct >= 0 : null;

  const livePnlPct = hasBasis && hasLiveQuote ? ((liveNum - costBasisNum) / costBasisNum) * 100 : null;
  const livePnlDollars = hasBasis && hasShares && hasLiveQuote ? (liveNum - costBasisNum) * shares : null;
  const livePnlUp = livePnlPct != null ? livePnlPct >= 0 : null;

  return {
    costBasisNum, spotNum, liveNum, hasBasis, hasShares, hasSpotPrice, hasLiveQuote, showDual, dualRec, rec, levels,
    isStale,
    pnl: { pct: pnlPct, dollars: pnlDollars, up: pnlUp },
    livePnl: { pct: livePnlPct, dollars: livePnlDollars, up: livePnlUp },
  };
}
