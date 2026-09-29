// src/hooks/useLiveQuote.ts
// Fetches real-time stock quotes via fetchLiveQuote (Yahoo Finance primary, Finnhub fallback).
// Extended-hours support and the source field (yahoo-regular | yahoo-post | yahoo-pre | finnhub) depend on
// the underlying data provider; Nasdaq-100 constituents also get `futuresContext` outside the regular session.
// Each ticker's quote is one query in the shared TanStack Query client (src/lib/queryClient.ts): fresh for 60 s, so a
// mount within that window shows it at once without a request, and refetched silently every 60 s while mounted.
// src/hooks/useLiveQuote.test.jsx pins the behaviour; LQ:n below are its line numbers.

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QueryFunctionContext } from '@tanstack/react-query';
import { fetchLiveQuote } from '../lib/api.js';
import { keys, queryClient } from '../lib/queryClient.js';
import type { LiveQuote } from '../../types/market.js';

/**
 * How long a quote counts as fresh, and the silent refresh period. The refresh falls due 60 s after the mount, the
 * ticker change or the last landing, whichever came last, so a shown quote can be older than this: one served from
 * the cache is up to 60 s old at the mount, and a failed refresh keeps the old one shown (LQ:274).
 */
const QUOTE_TTL_MS = 60_000;

type LiveQuoteKey = ReturnType<typeof keys.liveQuote>;

export interface LiveQuoteState {
  /**
   * The quote to show, or null: without a ticker; after refresh() or a data-source change until a new quote lands;
   * after a mount or a ticker change until one lands, unless a fresh (< 60 s) cached quote exists (an expired one is
   * never shown).
   */
  quote: LiveQuote | null;
  /** A fetch runs for a quote that is not shown yet; the silent refresh of a shown quote never sets it. */
  loading: boolean;
  /**
   * The last failed fetch's message, or null. While the query holds a quote, shown or hidden, it is kept through the
   * next refetch; it is cleared when a fetch succeeds, when a fetch starts with no quote cached, and by refresh() or a
   * data-source change.
   */
  error: string | null;
  /** Drops the cached quote and fetches it again, with loading. */
  refresh: () => void;
}

// The queryFn, at module level: the ticker comes from the key, so every render passes the same function.
async function fetchQuote({ queryKey, signal }: QueryFunctionContext<LiveQuoteKey>): Promise<LiveQuote> {
  try {
    // Reading the signal is what makes TanStack cancel the fetch when its last observer leaves (a ticker change, an
    // unmount; otherwise it lets the fetch run on), and passing it on aborts the request itself (LQ:155, LQ:305).
    return await fetchLiveQuote(queryKey[1], signal);
  } catch (err) {
    // api.ts wraps an abort as "Network error: …", so only the signal tells a cancellation from a failure, and only a
    // failure is logged (LQ:373, LQ:389). A catch binding is unknown and fetchLiveQuote rejects with Errors only, so
    // this asserts, as api.ts does.
    if (!signal.aborted) console.warn('Live quote fetch failed:', (err as Error).message);
    throw err;
  }
}

/**
 * @param ticker - the symbol to quote; a falsy one never fetches and never shows loading (LQ:311)
 */
export function useLiveQuote(ticker: string | null | undefined): LiveQuoteState {
  const tk = ticker ?? '';
  // Destructured up front: the result is a tracked proxy, and React re-renders only when a field read during a
  // render changes, so every field derived from below is read on every render.
  const { data, error, isPending, isFetching, isStale, dataUpdatedAt } = useQuery({
    queryKey: keys.liveQuote(tk),
    queryFn: fetchQuote,
    enabled: !!ticker,
    staleTime: QUOTE_TTL_MS,
    refetchInterval: QUOTE_TTL_MS,
    // The quote kept refreshing in a hidden tab before; without this, TanStack's interval skips its fetch while the
    // page is hidden (LQ:355).
    refetchIntervalInBackground: true,
  }, queryClient);

  // A cached quote that was already expired on this ticker's first render is never shown (null + loading, LQ:127):
  // it stays hidden until its own refetch lands, even if that refetch fails (LQ:335). The snapshot is taken per
  // ticker, during render (React's "adjust state when a prop changes"). A ticker without data starts expired at
  // dataUpdatedAt 0, so its first landing ends the hiding and the silent refresh never hides the quote (LQ:232). Any
  // landing moves dataUpdatedAt off the snapshot, so a later refresh() shows its quote as soon as it lands (LQ:350).
  // isFetchedAfterMount would show the expired quote once its refetch fails and hide the one a refresh() loads: it
  // counts failed fetches too, and a reset zeroes the counts it compares.
  const [seen, setSeen] = useState(() => ({ ticker: tk, expired: isStale, dataUpdatedAt }));
  if (seen.ticker !== tk) setSeen({ ticker: tk, expired: isStale, dataUpdatedAt });
  const hiding = seen.expired && dataUpdatedAt === seen.dataUpdatedAt;

  // A data-source change (a data key saved or cleared in Settings, an import) makes every cached quote suspect. The
  // quotes no mounted hook observes are removed: their next mount fetches anyway, and a reset would clear their GC
  // timer (Query.reset() -> destroy()) with nothing to schedule it again, keeping them, emptied, until the ticker
  // mounts again (LQ:405). Removal goes by observer count, not type: 'inactive', which would also match a mounted
  // query with a falsy ticker. The rest are reset, which clears the quote shown and refetches it with loading
  // (LQ:253); a disabled query is not refetched.
  useEffect(() => {
    const onDataSourceChanged = () => {
      queryClient.removeQueries({ queryKey: ['liveQuote'], predicate: (query) => query.getObserversCount() === 0 });
      queryClient.resetQueries({ queryKey: ['liveQuote'] });
    };
    window.addEventListener('data-source-changed', onDataSourceChanged);
    return () => window.removeEventListener('data-source-changed', onDataSourceChanged);
  }, []);

  // A reset, not a refetch: the quote clears at once and a mount meanwhile finds nothing cached, then joins the
  // running request (LQ:192). A silent refresh that falls due meanwhile joins it too instead of aborting it (LQ:236).
  const refresh = useCallback(() => {
    queryClient.resetQueries({ queryKey: keys.liveQuote(tk), exact: true });
  }, [tk]);

  return {
    quote: hiding ? null : (data ?? null),
    loading: isFetching && (isPending || hiding),
    error: error?.message ?? null,
    refresh,
  };
}
