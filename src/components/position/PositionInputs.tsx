// src/components/position/PositionInputs.tsx
// The position being analysed: the average cost and the share count, two number inputs that show the draft App holds
// and hand each edit back on its own, as a number or as null for a cleared field. The shell pairs it with the other
// field when it calls onUpdate. Text that parses to no number sends nothing; a number input never reports any (the
// browser drops the letters), so that guard only matters if the field stops being one.

import type { ChangeEvent } from 'react';
import { DollarSign, Hash } from 'lucide-react';

interface PositionInputsProps {
  /** The draft's average cost per share; null shows an empty field. */
  costBasis: number | null;
  /** The draft's share count; null shows an empty field. */
  shares: number | null;
  /** The average cost as typed, or null once the field is cleared. */
  onCostChange: (costBasis: number | null) => void;
  /** The shares as typed, or null once the field is cleared. */
  onSharesChange: (shares: number | null) => void;
}

export default function PositionInputs({ costBasis, shares, onCostChange, onSharesChange }: PositionInputsProps) {
  const handleCostChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value === '' ? null : parseFloat(e.target.value);
    if (val !== null && isNaN(val)) return;
    onCostChange(val);
  };

  const handleSharesChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value === '' ? null : parseFloat(e.target.value);
    if (val !== null && isNaN(val)) return;
    onSharesChange(val);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]">
          <DollarSign size={12} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            type="number"
            value={costBasis ?? ''}
            onChange={handleCostChange}
            placeholder="Avg cost"
            step="0.01"
            min="0"
            className="w-24 bg-transparent text-sm font-mono tabular-nums text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]">
          <Hash size={12} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            type="number"
            value={shares ?? ''}
            onChange={handleSharesChange}
            placeholder="Shares"
            step="any"
            min="0"
            className="w-20 bg-transparent text-sm font-mono tabular-nums text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
          />
        </div>
      </div>
    </div>
  );
}
