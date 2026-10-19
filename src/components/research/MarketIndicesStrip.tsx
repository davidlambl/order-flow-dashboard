// src/components/research/MarketIndicesStrip.tsx
// A chip per index proxy that answered: its price (VIX, a level, without the dollar sign) and the day's change.

import type { TickerContext } from '../../../types/market.js';

interface MarketIndicesStripProps {
  quotes: TickerContext['marketQuotes'];
}

export default function MarketIndicesStrip({ quotes }: MarketIndicesStripProps) {
  if (!quotes || Object.keys(quotes).length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(quotes).map(([sym, q]) => {
        // The record is Partial, so the type admits an undefined entry; a JSON body never carries one.
        if (!q) return null;
        const positive = (q.change || 0) >= 0;
        return (
          <div
            key={sym}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]"
          >
            <span className="text-[10px] font-semibold text-[var(--color-text-secondary)]">{sym}</span>
            <span className="text-[10px] font-medium tabular-nums text-[var(--color-text-primary)]">
              {q.price != null ? (sym === 'VIX' ? q.price.toFixed(2) : `$${q.price.toFixed(2)}`) : '—'}
            </span>
            <span className={`text-[9px] font-medium tabular-nums ${positive ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'}`}>
              {positive ? '+' : ''}{(q.changePct || 0).toFixed(2)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
