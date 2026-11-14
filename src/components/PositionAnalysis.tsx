// src/components/PositionAnalysis.tsx
// The position panel: the price line, the average-cost and shares inputs, then single mode (the unrealised P&L, the
// engine's call, the price levels and the call's reasons) or dual mode (the options market is closed and the live
// price has moved away from the options snapshot: the P&L and the call at both prices). A shell over the pure leaves
// in components/position/: usePositionSignals derives what they show from the position and App's market context, and
// the shell picks the mode's leaves and pairs each field's edit with the other field for App's onUpdate.
// One tree, loading or not: during a foreground load (the first, a ticker switch, a manual Refresh) the inputs stay
// where they are, the same DOM nodes, so focus, the caret and a value being typed survive the load; everything read
// from the market data gives way to a skeleton block in its place, since the context may still hold the previous
// ticker's or load's numbers. The blocks are aria-hidden decoration: the section's header says what is loading.

import { usePositionSignals } from '../hooks/usePositionSignals.js';
import type { Position } from '../lib/store.js';
import PriceDisplay from './position/PriceDisplay.js';
import PositionInputs from './position/PositionInputs.js';
import PnLStat from './position/PnLStat.js';
import RecommendationBadge from './position/RecommendationBadge.js';
import DualRecommendationView from './position/DualRecommendationView.js';
import PriceLevelBar from './position/PriceLevelBar.js';
import ReasonList from './position/ReasonList.js';

interface PositionAnalysisProps {
  /** The draft's average cost (usePositionDraft): the edit while one is being typed, else the ticker's stored position. */
  costBasis: Position['costBasis'];
  /** The draft's share count, from the same place. */
  shares: Position['shares'];
  /** usePositionDraft's update: the whole draft after an edit to either field (the hook debounces the save). */
  onUpdate: (costBasis: number | null, shares: number | null) => void;
}

export default function PositionAnalysis({ costBasis, shares, onUpdate }: PositionAnalysisProps) {
  // Market data from App's context, through the hook; the position draft stays props (App's usePositionDraft holds the edit
  // and its debounced save).
  const { signals, loading, spotPrice, liveQuote, optionsMarketOpen, dataProvider, lastUpdated, now } =
    usePositionSignals({ costBasis, shares });
  const { costBasisNum, hasBasis, hasSpotPrice, showDual, dualRec, rec, levels, isStale, pnl, livePnl } = signals;
  // What a shares edit sends beside it: the basis as a number, or null while there is none. Number() alone reads an
  // empty basis as 0 and a missing one as NaN, which saved a cost basis of 0 for shares typed first (issue #57).
  const savedBasis =
    costBasis == null || String(costBasis).trim() === '' || !Number.isFinite(costBasisNum) ? null : costBasisNum;

  return (
    <div>
      {/* Price Display */}
      {loading ? (
        <div aria-hidden="true" className="skeleton h-8 w-48" />
      ) : (
        <PriceDisplay
          spotPrice={spotPrice}
          liveQuote={liveQuote}
          optionsMarketOpen={optionsMarketOpen}
          dataProvider={dataProvider}
          now={now}
        />
      )}

      {/* Header row: inputs + P&L + recommendation */}
      <div className="flex flex-wrap items-start justify-between gap-4 mt-4">
        {/* Left: Inputs */}
        <PositionInputs
          costBasis={costBasis}
          shares={shares}
          onCostChange={(value) => onUpdate(value, shares)}
          onSharesChange={(value) => onUpdate(savedBasis, value)}
        />

        {/* Right while loading: the recommendation's place */}
        {loading && <div aria-hidden="true" className="skeleton h-16 w-36" />}

        {/* Center: P&L (single mode) */}
        {!loading && hasBasis && hasSpotPrice && !showDual && <PnLStat pnl={pnl} layout="block" />}

        {/* Right: Recommendation (single) */}
        {!loading && !showDual && (
          <RecommendationBadge rec={rec} isStale={isStale} lastUpdated={lastUpdated} hasWarning={isStale} now={now} />
        )}
      </div>

      {/* Below while loading: the price levels' and the reasons' place */}
      {loading && <div aria-hidden="true" className="skeleton h-16 w-full mt-3" />}

      {/* Dual mode: options market closed and the live price at least the gap threshold from the snapshot */}
      {!loading && showDual && dualRec && (
        <DualRecommendationView
          dualRec={dualRec}
          pnl={pnl}
          livePnl={livePnl}
          hasBasis={hasBasis}
          isStale={isStale}
          lastUpdated={lastUpdated}
          now={now}
        />
      )}

      {/* Price levels chart */}
      {!loading && !showDual && levels.length >= 2 && <PriceLevelBar levels={levels} />}

      {/* Reasons (single mode only) */}
      {!loading && !showDual && rec && <ReasonList reasons={rec.reasons} columns />}
    </div>
  );
}
