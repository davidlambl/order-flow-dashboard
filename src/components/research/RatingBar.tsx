// src/components/research/RatingBar.tsx
// The analysts' ratings as one bar, a segment per non-zero rating sized by its share, with the counts beneath.

import type { AnalystConsensus } from '../../../types/market.js';

interface RatingBarProps {
  /** A missing consensus, or a missing count, reads as 0; with no ratings at all there is no bar. */
  consensus: AnalystConsensus | null | undefined;
}

export default function RatingBar({ consensus }: RatingBarProps) {
  const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 }: Partial<AnalystConsensus> = consensus || {};
  const total = strongBuy + buy + hold + sell + strongSell;
  if (total === 0) return null;

  const segments = [
    { count: strongBuy, color: 'var(--color-bull)', label: 'Strong Buy' },
    { count: buy, color: 'var(--color-bull)', label: 'Buy', opacity: 0.6 },
    { count: hold, color: 'var(--color-warn)', label: 'Hold' },
    { count: sell, color: 'var(--color-bear)', label: 'Sell', opacity: 0.6 },
    { count: strongSell, color: 'var(--color-bear)', label: 'Strong Sell' },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded-full overflow-hidden">
        {segments.map((s, i) => (
          <div
            key={i}
            className="transition-all duration-300"
            style={{
              width: `${(s.count / total) * 100}%`,
              backgroundColor: s.color,
              opacity: s.opacity || 1,
            }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--color-text-muted)]">
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <span
              className="w-1.5 h-1.5 rounded-sm"
              style={{ backgroundColor: s.color, opacity: s.opacity || 1 }}
            />
            {s.count}
          </span>
        ))}
      </div>
    </div>
  );
}
