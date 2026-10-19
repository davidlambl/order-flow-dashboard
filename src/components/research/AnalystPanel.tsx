// src/components/research/AnalystPanel.tsx
// The analysts' view of the ticker: the ratings bar, then the price target (the median, else the mean) with its upside
// from spot, and markers for spot and the target on the low-high range.

import LoadingSkeleton from './LoadingSkeleton.js';
import RatingBar from './RatingBar.js';
import type { AnalystInfo, PriceTarget } from '../../../types/market.js';

interface AnalystPanelProps {
  analysts: AnalystInfo | null;
  /** The market data's spot price; undefined until some has loaded, which shows no upside and no spot marker. */
  spotPrice: number | undefined;
  loading: boolean;
}

export default function AnalystPanel({ analysts, spotPrice, loading }: AnalystPanelProps) {
  if (loading) return <LoadingSkeleton rows={3} />;

  if (!analysts) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] italic">
        No analyst data available.
      </p>
    );
  }

  const pt: Partial<PriceTarget> = analysts.priceTarget || {};
  const displayPrice = pt.median ?? pt.mean;
  const hasAnyTarget = pt.mean != null || pt.median != null || pt.high != null || pt.low != null;
  const upside = displayPrice && spotPrice
    ? ((displayPrice - spotPrice) / spotPrice * 100).toFixed(1)
    : null;
  // Markers need a range to sit in: when high === low there is no position (x / 0 is NaN%).
  const span = pt.high != null && pt.low != null ? pt.high - pt.low : Number.NaN;
  const hasSpan = Number.isFinite(span) && span > 0;
  const markerPrice = pt.mean ?? pt.median;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
          Ratings
        </div>
        <RatingBar consensus={analysts.consensus} />
      </div>

      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
          Price targets
        </div>
        {hasAnyTarget ? (
          <>
            {displayPrice != null && (
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {pt.median != null ? 'Median' : 'Mean'}
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-bold text-[var(--color-text-primary)] tabular-nums">
                    ${displayPrice.toFixed(2)}
                  </span>
                  {upside != null && spotPrice && (
                    <span className={`text-[10px] font-semibold tabular-nums ${
                      Number(upside) >= 0 ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'
                    }`}>
                      {Number(upside) > 0 ? '+' : ''}{upside}%
                    </span>
                  )}
                </div>
              </div>
            )}
            {pt.mean != null && pt.median != null && (
              <div className="text-[10px] text-[var(--color-text-muted)]">
                Mean: ${pt.mean.toFixed(2)}
              </div>
            )}

            {pt.low != null && pt.high != null && (
              <div className="relative h-2 rounded-full bg-[var(--color-surface-2)]">
                {hasSpan && spotPrice != null && spotPrice > 0 && (
                  <div
                    className="absolute top-0 h-full w-0.5 bg-[var(--color-warn)] rounded"
                    style={{
                      left: `${Math.max(0, Math.min(100, ((spotPrice - pt.low) / span) * 100))}%`,
                    }}
                    title={`Spot: $${spotPrice.toFixed(2)}`}
                  />
                )}
                {hasSpan && markerPrice != null && (
                  <div
                    className="absolute top-0 h-full w-1 bg-[var(--color-accent)] rounded"
                    style={{
                      left: `${Math.max(0, Math.min(100, ((markerPrice - pt.low) / span) * 100))}%`,
                    }}
                    title={`${pt.mean != null ? `Mean: $${pt.mean.toFixed(2)}` : ''}${pt.mean != null && pt.median != null ? ' ' : ''}${pt.median != null ? `Median: $${pt.median.toFixed(2)}` : ''}`}
                  />
                )}
              </div>
            )}

            <div className="flex justify-between text-[10px] text-[var(--color-text-muted)] tabular-nums">
              <span>Low: ${pt.low?.toFixed(2) ?? '—'}</span>
              <span>High: ${pt.high?.toFixed(2) ?? '—'}</span>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-[var(--color-text-muted)] italic">
            No price target data for this symbol.
          </p>
        )}
      </div>
    </div>
  );
}
