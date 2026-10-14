// src/components/research/EarningsCard.tsx
// The ticker's latest earnings: the report date with its countdown in local calendar days, the EPS and revenue
// estimates against their actuals, and the surprise.

import { Calendar } from 'lucide-react';
import LoadingSkeleton from './LoadingSkeleton.js';
import { daysUntil } from '../../lib/format.js';
import type { EarningsInfo } from '../../../types/market.js';

interface EarningsCardProps {
  earnings: EarningsInfo | null;
  loading: boolean;
  /** Epoch ms from the research shell's clock (useNow): the countdown follows it, and render never reads the clock. */
  now: number;
}

export default function EarningsCard({ earnings, loading, now }: EarningsCardProps) {
  if (loading) return <LoadingSkeleton rows={3} />;

  if (!earnings) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] italic">
        No earnings data available.
      </p>
    );
  }

  const daysTo = daysUntil(earnings.date, now);

  const isImminent = daysTo != null && daysTo >= 0 && daysTo <= 7;
  const isPast = daysTo != null && daysTo < 0;

  return (
    <div className="space-y-2">
      <div className={`flex items-center gap-2 p-2.5 rounded-lg border ${
        isImminent
          ? 'bg-[var(--color-warn)]/10 border-[var(--color-warn)]/30'
          : 'bg-[var(--color-surface-2)] border-[var(--color-border-subtle)]'
      }`}>
        <Calendar size={14} className={isImminent ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'} />
        <div>
          <p className="text-xs font-semibold text-[var(--color-text-primary)]">
            {earnings.date || 'TBD'}
          </p>
          <p className={`text-[10px] font-medium ${
            isImminent ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'
          }`}>
            {daysTo === 0
              ? 'Reporting TODAY'
              : daysTo === 1
              ? 'Reporting TOMORROW'
              : daysTo != null && daysTo > 0
              ? `${daysTo} days away`
              : isPast
              ? `Reported ${Math.abs(daysTo)} day${Math.abs(daysTo) !== 1 ? 's' : ''} ago`
              : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {earnings.epsEstimate != null && (
          <div className="p-2 rounded-lg bg-[var(--color-surface-2)]">
            <p className="text-[10px] text-[var(--color-text-muted)]">EPS Est.</p>
            <p className="font-semibold text-[var(--color-text-primary)] tabular-nums">
              ${earnings.epsEstimate.toFixed(2)}
            </p>
            {earnings.epsActual != null && (
              <p className={`text-[10px] font-medium tabular-nums ${
                earnings.epsActual >= earnings.epsEstimate ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'
              }`}>
                Actual: ${earnings.epsActual.toFixed(2)}
              </p>
            )}
          </div>
        )}
        {earnings.revenueEstimate != null && (
          <div className="p-2 rounded-lg bg-[var(--color-surface-2)]">
            <p className="text-[10px] text-[var(--color-text-muted)]">Rev. Est.</p>
            <p className="font-semibold text-[var(--color-text-primary)] tabular-nums">
              ${(earnings.revenueEstimate / 1e9).toFixed(2)}B
            </p>
            {earnings.revenueActual != null && (
              <p className={`text-[10px] font-medium tabular-nums ${
                earnings.revenueActual >= earnings.revenueEstimate ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'
              }`}>
                Actual: ${(earnings.revenueActual / 1e9).toFixed(2)}B
              </p>
            )}
          </div>
        )}
      </div>

      {earnings.surprise != null && (
        <div className={`text-[10px] font-medium px-2 py-1 rounded text-center ${
          earnings.surprise >= 0
            ? 'text-[var(--color-bull)] bg-[var(--color-bull)]/10'
            : 'text-[var(--color-bear)] bg-[var(--color-bear)]/10'
        }`}>
          {earnings.surprise >= 0 ? '+' : '-'}${Math.abs(earnings.surprise).toFixed(2)} {earnings.surprise >= 0 ? 'beat' : 'miss'}
        </div>
      )}
    </div>
  );
}
