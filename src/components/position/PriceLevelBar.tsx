// src/components/position/PriceLevelBar.tsx
// The position's price levels (the basis, spot, max pain and the nearest positive-GEX walls) as ticks on one line,
// padded 8 % beyond the outermost, over a legend in price order. Nothing draws below two levels or when every level
// sits at one price.

import { formatPrice } from '../../lib/format.js';
import type { PriceLevel } from '../../lib/recommend.js';

interface PriceLevelBarProps {
  /** extractPriceLevels' markers, each in its own colour. */
  levels: PriceLevel[];
}

export default function PriceLevelBar({ levels }: PriceLevelBarProps) {
  if (levels.length < 2) return null;

  const prices = levels.map((l) => l.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  if (range === 0) return null;

  const pad = range * 0.08;
  const scaleMin = min - pad;
  const scaleMax = max + pad;
  const scaleRange = scaleMax - scaleMin;
  const toPercent = (price: number) => ((price - scaleMin) / scaleRange) * 100;

  const positioned = levels
    .map((l) => ({ ...l, pct: Math.max(5, Math.min(95, toPercent(l.price))) }))
    .sort((a, b) => a.price - b.price);

  return (
    <div className="mt-3 mb-2 space-y-2">
      {/* Bar with tick marks only */}
      <div className="relative h-6">
        <div className="absolute left-0 right-0 h-px bg-[var(--color-border)]" style={{ top: 12 }} />
        {positioned.map((level) => (
          <div
            key={level.label}
            className="absolute w-0.5 h-4 rounded-full -translate-x-1/2"
            style={{
              left: `${level.pct}%`,
              top: 8,
              backgroundColor: level.color,
            }}
          />
        ))}
      </div>

      {/* Legend grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {positioned.map((level) => (
          <div key={level.label} className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: level.color }}
            />
            <span className="text-[10px] font-semibold whitespace-nowrap" style={{ color: level.color }}>
              {level.label}
            </span>
            <span className="text-[10px] font-mono tabular-nums" style={{ color: level.color }}>
              {formatPrice(level.price)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
