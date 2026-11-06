// src/components/dashboard/TickerSummary.tsx
// The row above the KPI cards: the ticker, its IV30 when the feed reports one, the DEMO DATA or ERROR badge, and the
// number of contracts the snapshot was computed from. ERROR is for real data only: a failed refresh keeps the last
// good data and sets the error, whose message is the badge's title; in demo mode DEMO DATA stands in for it. IV30 and
// the count wait out a foreground load, while the payload shown may still be the previous ticker's.

import type { MarketData } from '../../../types/market.js';

interface TickerSummaryProps {
  /** The symbol shown everywhere. */
  ticker: string;
  /** useMarketData's data: the ticker's last good payload, the previous ticker's while this one loads, or demo data. */
  data: MarketData | null;
  /** useMarketData's loading: a foreground load is under way, never the silent refresh. */
  loading: boolean;
  /** useMarketData's usingMock: `data` is demo data. */
  usingMock: boolean;
  /** useMarketData's error: the last failure's message, null after a success. */
  error: string | null;
}

export default function TickerSummary({ ticker, data, loading, usingMock, error }: TickerSummaryProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-lg font-bold font-mono tracking-tight text-[var(--color-text-primary)]">
          {ticker}
        </span>
        {data?.iv30 != null && !loading && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-purple-bg)] text-[var(--color-purple)] border border-[var(--color-purple)]/20 tabular-nums">
            IV30: {data.iv30.toFixed(1)}%
          </span>
        )}
        {usingMock && (
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-warn-bg)] text-[var(--color-warn)] border border-[var(--color-warn)]/20">
            DEMO DATA
          </span>
        )}
        {error && !usingMock && (
          <span title={error} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-bear-bg)] text-[var(--color-bear)] border border-[var(--color-bear)]/20">
            ERROR
          </span>
        )}
      </div>
      {data != null && data.totalOptionsCount > 0 && !loading && (
        <span className="text-xs text-[var(--color-text-muted)] tabular-nums hidden sm:inline">
          {data.totalOptionsCount.toLocaleString()} contracts analyzed
        </span>
      )}
    </div>
  );
}
