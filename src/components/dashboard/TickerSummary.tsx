// src/components/dashboard/TickerSummary.tsx
// The row above the KPI cards: the ticker, its IV30 when the feed reports one, the DEMO DATA or ERROR badge, and the
// number of contracts the snapshot was computed from; under it, what failed, in words, with Retry. ERROR is for real
// data only: a failed refresh keeps the last good data and sets the error; in demo mode DEMO DATA stands in for it.
// IV30 and the count wait out a foreground load, while the payload shown may still be the previous ticker's.
// The failure line is ONE role="status" region, in the tree from the first render (empty and sr-only while nothing
// failed) and the same node throughout, so a screen reader announces a change in it, and an identical failure arriving
// again (the silent refresh fails every minute) changes nothing and is not spoken again. Retry sits beside it, outside
// the region: shown while something failed, and held through the foreground load that follows a press (a live-quote
// retry clears the quote's error at once), aria-disabled then rather than disabled so it keeps the focus. When it
// leaves with the focus, the focus goes to the row itself rather than falling to the page.

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
  /** useMarketData's error: the last failure's message, null after a success (and while a demo-mode ticker reloads). */
  error: string | null;
  /** useLiveQuote's error: the last failed quote request's message, null after a success and from refresh() on. */
  quoteError: string | null;
  /** useLiveQuote's quote is shown: after a failed background refresh the last live quote stays on screen. */
  liveQuoteShown: boolean;
  /** App's handleRefresh: reloads the market data and the live quote in the foreground, for a failure shown here. */
  onRetry: () => void;
}

/** A failure's message as a clause inside a sentence: trimmed, without a closing full stop of its own. */
const reasonOf = (message: string) => message.trim().replace(/\.+$/, '');

interface Sentence {
  key: string;
  /** What failed and why: the failure itself, in the bear colour. */
  failed: string;
  /** What is shown instead, in the muted colour. */
  shown: string;
}

function failureSentences(
  usingMock: boolean, error: string | null, quoteError: string | null, liveQuoteShown: boolean,
): Sentence[] {
  const sentences: Sentence[] = [];
  if (error) {
    sentences.push(usingMock
      ? { key: 'market', failed: `Options data could not be loaded: ${reasonOf(error)}.`, shown: 'Demo data is shown instead.' }
      : { key: 'market', failed: `Options data could not be refreshed: ${reasonOf(error)}.`, shown: 'The last data loaded is shown.' });
  }
  if (quoteError) {
    sentences.push(liveQuoteShown
      ? { key: 'quote', failed: `The live price could not be refreshed: ${reasonOf(quoteError)}.`, shown: 'The last live price is shown.' }
      : { key: 'quote', failed: `The live price could not be loaded: ${reasonOf(quoteError)}.`, shown: 'Prices come from the options snapshot.' });
  }
  return sentences;
}

interface RetryButtonProps {
  /** A foreground load is under way: the press is ignored and the button says so, keeping the focus. */
  busy: boolean;
  onRetry: () => void;
  /** Moves the focus elsewhere: called when this button leaves the page while it holds the focus. Stable. */
  onLeaveFocused: () => void;
}

function RetryButton({ busy, onRetry, onLeaveFocused }: RetryButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  // A layout cleanup runs before React removes the button, while it still holds the focus it is about to lose.
  useLayoutEffect(() => {
    const button = ref.current;
    return () => {
      if (button !== null && button === document.activeElement) onLeaveFocused();
    };
  }, [onLeaveFocused]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => { if (!busy) onRetry(); }}
      aria-disabled={busy || undefined}
      className="shrink-0 inline-flex items-center gap-1 min-h-6 min-w-6 px-2 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-colors aria-disabled:cursor-progress"
    >
      <RefreshCw size={12} aria-hidden="true" className={busy ? 'animate-spin' : undefined} />
      Retry
    </button>
  );
}

export default function TickerSummary({
  ticker, data, loading, usingMock, error, quoteError, liveQuoteShown, onRetry,
}: TickerSummaryProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Null once the row itself is being removed (React detaches its ref first), when there is nothing to focus.
  const focusRow = useCallback(() => rowRef.current?.focus(), []);
  const sentences = failureSentences(usingMock, error, quoteError, liveQuoteShown);

  // Demo data is a failure too, also while it reloads without its reason. Retry stays through the foreground load that
  // follows it ("adjust state while rendering"), so a press whose failure clears at once keeps its button and focus.
  const failed = usingMock || error != null || quoteError != null;
  const [held, setHeld] = useState(failed);
  const showRetry = failed || (held && loading);
  if (held !== showRetry) setHeld(showRetry);

  const hasLine = sentences.length > 0 || showRetry;

  return (
    <div ref={rowRef} tabIndex={-1}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold font-mono tracking-tight text-[var(--color-text-primary)]">
            {ticker}
          </span>
          {data?.iv30 != null && !loading && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-purple-bg)] text-[var(--color-purple-text)] border border-[var(--color-purple)]/20 tabular-nums">
              IV30: {data.iv30.toFixed(1)}%
            </span>
          )}
          {usingMock && (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-warn-bg)] text-[var(--color-warn)] border border-[var(--color-warn)]/20">
              DEMO DATA
            </span>
          )}
          {error && !usingMock && (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-bear-bg)] text-[var(--color-bear-text)] border border-[var(--color-bear)]/20">
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
      {/* Its own line under the row, so the row's two sides never move; a long reason wraps beside Retry. */}
      <div className={hasLine ? 'mt-1.5 flex items-start gap-3' : undefined}>
        <p
          role="status"
          className={sentences.length > 0 ? 'min-w-0 flex-1 break-words text-xs leading-5' : 'sr-only'}
        >
          {sentences.map((sentence, i) => (
            <span key={sentence.key}>
              {i > 0 && ' '}
              <span className="text-[var(--color-bear-text)]">{sentence.failed}</span>
              {' '}
              <span className="text-[var(--color-text-muted)]">{sentence.shown}</span>
            </span>
          ))}
        </p>
        {showRetry && <RetryButton busy={loading} onRetry={onRetry} onLeaveFocused={focusRow} />}
      </div>
    </div>
  );
}
