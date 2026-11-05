// src/components/position/PnLStat.tsx
// The position's unrealised P&L at one price: the percent and, with a share count, the dollars, both in the bull
// colour with a plus sign at or above the cost basis and in the bear colour below it. Two layouts: single mode's
// centred block under its 'Unrealized P&L' caption, and a dual-mode panel's row, the caption on the left and the
// figures stacked on the right.

import { formatDollar } from '../../lib/format.js';

/** The P&L at one price; a figure is null without its inputs (a cost basis and the price, and shares for dollars). */
export interface PnL {
  pct: number | null;
  dollars: number | null;
  /** pct >= 0; null without a percent, which shows in the muted colour. */
  up: boolean | null;
}

interface PnLStatProps {
  pnl: PnL;
  /** 'block' is single mode's, which shows nothing without a percent; 'row' is a dual panel's, '—' without one. */
  layout: 'block' | 'row';
}

export default function PnLStat({ pnl, layout }: PnLStatProps) {
  const { pct, dollars, up } = pnl;
  const color = up === null ? 'var(--color-text-muted)' : up ? 'var(--color-bull)' : 'var(--color-bear)';

  if (layout === 'block') {
    // Single mode shows the block only with a cost basis and a spot price, so the percent is a number wherever it
    // renders; the guard is for the type.
    if (pct == null) return null;
    return (
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
          Unrealized P&L
        </span>
        <span className="text-xl font-bold tabular-nums font-mono" style={{ color }}>
          {up ? '+' : ''}{pct.toFixed(2)}%
        </span>
        {dollars != null && (
          <span className="text-xs tabular-nums font-mono" style={{ color }}>
            {up ? '+' : ''}{formatDollar(dollars)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-[var(--color-text-muted)]">
        Unrealized P&L
      </span>
      <div className="flex flex-col items-end">
        <span className="text-base font-bold tabular-nums font-mono" style={{ color }}>
          {pct != null ? `${up ? '+' : ''}${pct.toFixed(2)}%` : '—'}
        </span>
        {dollars != null && (
          <span className="text-xs tabular-nums font-mono" style={{ color }}>
            {up ? '+' : ''}{formatDollar(dollars)}
          </span>
        )}
      </div>
    </div>
  );
}
