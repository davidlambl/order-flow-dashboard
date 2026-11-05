// src/components/position/ReasonList.tsx
// The engine's reasons behind a call, one chevron row each: single mode lays out every reason under a rule, in one to
// three columns by width; a dual-mode panel stacks the first three beneath its badge.

import { ChevronRight } from 'lucide-react';

interface ReasonListProps {
  /** Recommendation.reasons: a line per scored factor, in factor order. */
  reasons: string[];
  /** Single mode's ruled grid of every reason; without it, a dual panel's list of the first three. */
  columns?: boolean;
}

export default function ReasonList({ reasons, columns = false }: ReasonListProps) {
  const rows = (columns ? reasons : reasons.slice(0, 3)).map((reason, i) => (
    <div key={i} className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]">
      <ChevronRight size={10} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
      <span>{reason}</span>
    </div>
  ));

  if (!columns) return <div className="mt-2 space-y-1">{rows}</div>;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--color-border-subtle)]">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
        {rows}
      </div>
    </div>
  );
}
