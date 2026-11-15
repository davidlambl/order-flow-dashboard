// src/components/research/ResearchStatus.tsx
// What went wrong with the research, said in one status region, and Retry beside it. The region is rendered with the
// panel's content and stays the same node (empty and sr-only while there is nothing to say), so a screen reader
// announces a line as it arrives; it is a status, not an alert, since research loads on a ticker change rather than
// on a press. It says a failed load or a failed refresh (with the request's own reason), the sources a partial answer
// lacks, named in words, and apart from them the sources the data plan does not include (a 403: a paid Finnhub
// endpoint on a free key, which no retry fixes). Retry shows only where a retry can help. The failure is App's kept
// one (useLastFailure), so it stays said, with Retry, while the next request runs, also for a first load that failed.
// A pressed Retry says how it went (useRetryOutcome): "Retrying..." in place of the lines while its request runs,
// visible; then the lines again (a change, so a failure that comes back the same is spoken), or, visually hidden,
// "Research loaded." once nothing is left to say. A request nobody pressed for says nothing new.

import { useCallback, useEffect, useRef } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';
import { useRetryOutcome } from '../../hooks/useRetryOutcome.js';
import type { ContextErrors, ContextSection } from '../../../types/market.js';

/** Each source getTickerContext can name in `errors`, in the words the line uses, in the order it lists them. */
const SOURCE_WORDS: Record<ContextSection, string> = {
  news: 'company news',
  marketNews: 'market headlines',
  marketQuotes: 'market indices',
  earnings: 'earnings results',
  earningsCalendar: 'the earnings calendar',
  recommendation: 'analyst ratings',
  priceTarget: 'price targets',
  metrics: 'fundamentals',
  candles: 'price history',
};
// The record literal above has exactly the ContextSection keys, which Object.keys types as string[].
const SOURCES = Object.keys(SOURCE_WORDS) as ContextSection[];

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** The text with a full stop at its end, unless it already ends a sentence. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

interface ResearchStatusProps {
  /** The ticker the research is about: a new one forgets a pressed Retry's outcome. */
  subject: string;
  /**
   * The last failed request's message (useTickerContext's, kept by App until a load succeeds, the ticker changes or
   * research is switched off or on), or null.
   */
  error: string | null;
  /** Research is on screen: a failure is then a failed refresh over it, not a failed load. */
  shown: boolean;
  /** The answer's failed sources, {} when every source answered or nothing has arrived. */
  errors: ContextErrors;
  /** A request is in flight: Retry is aria-disabled and ignores a press. */
  loading: boolean;
  onRetry: () => void;
}

interface Line {
  text: string;
  failure: boolean;
}

/**
 * Focus the toggle of the section around `inside`: the button whose aria-controls names the region holding it. Used
 * when Retry leaves while it has the focus (a retry that worked), which would otherwise drop the focus to the page.
 */
function focusSectionToggle(inside: HTMLElement) {
  const region = inside.closest('[role="region"]');
  if (!region || !region.id) return;
  const toggle = Array.from(inside.ownerDocument.querySelectorAll<HTMLElement>('[aria-controls]'))
    .find((el) => el.getAttribute('aria-controls') === region.id);
  toggle?.focus();
}

export default function ResearchStatus({ subject, error, shown, errors, loading, onRetry }: ResearchStatusProps) {
  const failedSources = SOURCES.filter((s) => errors[s] !== undefined);
  const missing = failedSources.filter((s) => errors[s] !== 'HTTP 403');
  const notInPlan = failedSources.filter((s) => errors[s] === 'HTTP 403');

  const lines: Line[] = [];
  if (error !== null) {
    lines.push(shown
      ? { text: `${sentence(`Research could not be refreshed: ${error}`)} Showing the last research loaded.`, failure: true }
      : { text: sentence(`Research could not be loaded: ${error}`), failure: true });
  }
  if (missing.length > 0) {
    lines.push({ text: `Some sources did not answer: ${LIST.format(missing.map((s) => SOURCE_WORDS[s]))}.`, failure: false });
  }
  if (notInPlan.length > 0) {
    lines.push({
      text: `Not available on the current data plan: ${LIST.format(notInPlan.map((s) => SOURCE_WORDS[s]))}.`,
      failure: false,
    });
  }
  const showRetry = error !== null || missing.length > 0;
  const { outcome, begin } = useRetryOutcome(loading, lines.length > 0, subject);

  const statusRef = useRef<HTMLDivElement>(null);
  // Set when Retry leaves the document while it holds the focus. A ref callback's cleanup runs before React removes
  // the node, so the focus is still on it then; the effect below, after the commit, moves it on.
  const handOff = useRef(false);
  const retryRef = useCallback((node: HTMLButtonElement) => () => {
    if (node.ownerDocument.activeElement === node) handOff.current = true;
  }, []);
  useEffect(() => {
    if (!handOff.current) return;
    handOff.current = false;
    const doc = statusRef.current?.ownerDocument;
    // Only when the focus fell to the page: something that took it meanwhile keeps it.
    if (statusRef.current && doc && (doc.activeElement === null || doc.activeElement === doc.body)) {
      focusSectionToggle(statusRef.current);
    }
  });

  const press = () => {
    if (loading) return;
    begin();
    onRetry();
  };

  const visible = outcome === 'retrying' || (outcome === 'none' && lines.length > 0);

  return (
    <div className={visible || showRetry ? 'flex items-start gap-3 mb-3' : undefined}>
      <div ref={statusRef} role="status" className={visible ? 'flex-1 min-w-0 space-y-1' : 'sr-only'}>
        {outcome === 'retrying' ? (
          <p className="text-xs text-[var(--color-text-muted)]">Retrying...</p>
        ) : outcome === 'worked' ? 'Research loaded.' : lines.map((line) => (
          <p
            key={line.text}
            className={line.failure
              ? 'flex items-start gap-1.5 text-xs text-[var(--color-bear-text)]'
              : 'text-xs text-[var(--color-text-secondary)]'}
          >
            {line.failure && <CircleAlert size={12} aria-hidden="true" className="shrink-0 mt-px" />}
            <span>{line.text}</span>
          </p>
        ))}
      </div>
      {showRetry && (
        <button
          type="button"
          ref={retryRef}
          onClick={press}
          aria-disabled={loading ? true : undefined}
          className="shrink-0 inline-flex items-center justify-center gap-1 min-h-6 min-w-6 px-2 py-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-xs font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] aria-disabled:cursor-not-allowed aria-disabled:opacity-60 transition-colors"
        >
          <RotateCw size={12} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
          Retry{' '}<span className="sr-only">research</span>
        </button>
      )}
    </div>
  );
}
