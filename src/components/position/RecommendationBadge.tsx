// src/components/position/RecommendationBadge.tsx
// The engine's call as a badge: the signal and its icon in the signal's colours, the confidence pill beneath it, and,
// once the options snapshot is stale, when the snapshot was taken. Single mode shows one; dual mode shows the
// snapshot's call (with the warning triangle) beside the dashed, smaller call for the live price. SIGNAL_STYLES stays
// module-local: a component file exports only its component (react-refresh).

import { Minus, TrendingDown, TrendingUp, TriangleAlert } from 'lucide-react';
import type { Recommendation, Signal } from '../../lib/recommend.js';

const SIGNAL_STYLES: Record<Signal, { color: string; bg: string; borderMuted: string }> = {
  BUY: {
    color: 'var(--color-bull)',
    bg: 'var(--color-bull-bg)',
    borderMuted: 'var(--color-bull-border-muted)',
  },
  HOLD: {
    color: 'var(--color-warn)',
    bg: 'var(--color-warn-bg)',
    borderMuted: 'var(--color-warn-border-muted)',
  },
  SELL: {
    color: 'var(--color-bear)',
    bg: 'var(--color-bear-bg)',
    borderMuted: 'var(--color-bear-border-muted)',
  },
};

interface RecommendationBadgeProps {
  /** The engine's call; nothing renders without one. */
  rec: Recommendation | null;
  /** The options snapshot is too old to act on (isStaleData): the badge says when it was taken. */
  isStale?: boolean;
  /** data.lastUpdated: the snapshot's ISO time, shown as a time of day, with its weekday once a day old. */
  lastUpdated?: string;
  /** A caption above the badge (dual mode's two panels). */
  label?: string;
  /** Dual mode's call at the live price: a dashed border and a smaller signal, aligned left. */
  isSecondary?: boolean;
  /** The warning triangle before the badge. */
  hasWarning?: boolean;
  /** Epoch ms from the panel's clock (useNow): the snapshot's age is measured from it, never from a clock read. */
  now: number;
}

export default function RecommendationBadge({
  rec, isStale, lastUpdated, label, isSecondary, hasWarning, now,
}: RecommendationBadgeProps) {
  if (!rec) return null;
  const style = SIGNAL_STYLES[rec.signal];

  let timeAgo = '';
  if (isStale && lastUpdated) {
    const d = new Date(lastUpdated);
    const diffMs = now - d.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffHours < 24) {
      timeAgo = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } else {
      timeAgo = d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    }
  }

  return (
    <div className={`flex flex-col gap-1.5 ${isSecondary ? 'items-start' : 'items-end'}`}>
      {label && (
        <span className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
          {label}
        </span>
      )}
      <div className="flex items-center gap-2">
        {hasWarning && (
          <TriangleAlert size={14} className="text-[var(--color-warn)] shrink-0" />
        )}
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${isSecondary ? 'border-dashed' : ''}`}
          style={{
            backgroundColor: style.bg,
            borderColor: style.borderMuted
          }}
        >
          {rec.signal === 'BUY' ? <TrendingUp size={16} style={{ color: style.color }} /> :
           rec.signal === 'SELL' ? <TrendingDown size={16} style={{ color: style.color }} /> :
           <Minus size={16} style={{ color: style.color }} />}
          <span className={`${isSecondary ? 'text-base' : 'text-lg'} font-bold tracking-tight`} style={{ color: style.color }}>
            {rec.signal}
          </span>
        </div>
      </div>
      <span
        className="text-[10px] font-medium px-2 py-0.5 rounded-full border"
        style={{
          color: style.color,
          backgroundColor: style.bg,
          borderColor: style.borderMuted
        }}
      >
        {rec.confidence} confidence
      </span>
      {isStale && timeAgo && (
        <span className="text-[9px] text-[var(--color-text-muted)]">
          Based on {timeAgo} data
        </span>
      )}
    </div>
  );
}
