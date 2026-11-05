// src/components/position/DualRecommendationView.tsx
// Dual mode: the options market has closed and the live price has moved at least GAP_DUAL_REC_THRESHOLD_PCT from the
// options snapshot, so the panel weighs the position at both prices. A warning names the move; the P&L at the
// snapshot sits beside the live P&L; the engine's call at the snapshot (with its age once stale) sits beside the
// dashed call if the live price holds, whose options positioning is still the snapshot's until the market reopens.

import { TriangleAlert } from 'lucide-react';
import PnLStat from './PnLStat.js';
import type { PnL } from './PnLStat.js';
import ReasonList from './ReasonList.js';
import RecommendationBadge from './RecommendationBadge.js';
import type { DualRecommendation } from '../../lib/recommend.js';

interface DualRecommendationViewProps {
  /** computeDualRecommendation's result with the options market closed. */
  dualRec: DualRecommendation;
  /** The P&L at the options snapshot's spot. */
  pnl: PnL;
  /** The P&L at the live price. */
  livePnl: PnL;
  /** A cost basis is set: the two P&L panels show their figures under their titles. */
  hasBasis: boolean;
  /** The options snapshot is too old to act on: the snapshot's call says when it was taken. */
  isStale: boolean;
  /** data.lastUpdated: the snapshot's ISO time. */
  lastUpdated: string | undefined;
  /** Epoch ms from the panel's clock (useNow). */
  now: number;
}

export default function DualRecommendationView({
  dualRec, pnl, livePnl, hasBasis, isStale, lastUpdated, now,
}: DualRecommendationViewProps) {
  return (
    <div className="mt-4 space-y-4">
      {/* Market Status Warning */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-warn-bg)] border border-[var(--color-warn)]/20">
        <TriangleAlert size={14} className="text-[var(--color-warn)] shrink-0" />
        <span className="text-xs text-[var(--color-warn)] font-medium">
          Options market closed — price has moved {dualRec.gapPercent > 0 ? 'up' : 'down'} {Math.abs(dualRec.gapPercent).toFixed(1)}% since the options snapshot
        </span>
      </div>

      {/* P&L Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Options Snapshot P&L */}
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--color-border)]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              P&L at options snapshot
            </span>
          </div>
          {hasBasis && <PnLStat pnl={pnl} layout="row" />}
        </div>

        {/* Live P&L */}
        <div className="flex flex-col gap-2 p-3 rounded-lg border-2 border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-primary)] uppercase tracking-wider">
              P&L (Live)
            </span>
          </div>
          {hasBasis && <PnLStat pnl={livePnl} layout="row" />}
        </div>
      </div>

      {/* Dual Recommendations */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Primary: Based on Options Data */}
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--color-border)]">
          <RecommendationBadge
            rec={dualRec.primary}
            isStale={isStale}
            lastUpdated={lastUpdated}
            label="Options Snapshot (delayed)"
            hasWarning={true}
            now={now}
          />
          <ReasonList reasons={dualRec.primary.reasons} />
        </div>

        {/* Secondary: If Live Price Holds */}
        {dualRec.secondary && (
          <div className="flex flex-col gap-2 p-3 rounded-lg border border-dashed border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5">
            <RecommendationBadge
              rec={dualRec.secondary}
              label="If Live Price Holds"
              isSecondary={true}
              now={now}
            />
            <ReasonList reasons={dualRec.secondary.reasons} />
            <div className="mt-2 text-[10px] text-[var(--color-text-muted)] italic">
              Options positioning unknown until market reopens
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
