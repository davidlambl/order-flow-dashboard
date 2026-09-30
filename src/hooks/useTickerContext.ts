// src/hooks/useTickerContext.ts
// Research context for one ticker (news, earnings, analysts, technicals, fundamentals) from the getTickerContext
// function, kept per ticker for 15 min in the shared TanStack Query client (src/lib/queryClient.ts), so switching back
// to a ticker shows its research at once. A ticker change never shows another ticker's context. An entry already stale
// when its ticker is first shown (or when the hook is re-enabled) stays hidden until its own refetch lands; one that
// expires while shown stays shown (nothing refetches it automatically, as before), and refresh() keeps it shown.
// TC:n = useTickerContext.test.jsx line n.

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QueryFunctionContext } from '@tanstack/react-query';
import { fetchTickerContext } from '../lib/api.js';
import { keys, queryClient } from '../lib/queryClient.js';
import type { TickerContext } from '../../types/market.js';

/** How long a ticker's research is served from the cache before it is fetched again (TC:157). */
const FRESH_MS = 15 * 60_000;

type ContextKey = ReturnType<typeof keys.tickerContext>;

// Module level: the ticker comes from the query key, not from a render's closure. Destructuring `signal` is what lets
// TanStack abort the request when the ticker changes or the hook unmounts (TC:235, TC:257): it only aborts a fetch
// whose signal was read.
async function loadContext({ signal, queryKey }: QueryFunctionContext<ContextKey>): Promise<TickerContext> {
  try {
    return await fetchTickerContext(queryKey[1], signal);
  } catch (err) {
    // api.ts rethrows an abort as a plain "Network error: …", so the signal tells a cancelled request (no warning)
    // from a failure. fetchTickerContext only rejects with Errors, hence the assertion.
    if (!signal.aborted) console.warn('Ticker context fetch failed:', (err as Error).message);
    throw err;
  }
}

/** What useTickerContext returns; while disabled: no context, no error, not loading. */
export interface TickerContextState {
  /**
   * Null until this ticker's research lands. An entry already stale when its ticker is first shown (or when the hook is
   * re-enabled) stays null until its own refetch lands; one that expires while shown stays shown (nothing refetches it
   * automatically), and refresh() keeps it shown.
   */
  context: TickerContext | null;
  /** A request for this ticker is in flight. */
  loading: boolean;
  /** The last failed request's message (the function's error body), or null. */
  error: string | null;
  /** Fetch again now; the current context stays shown meanwhile (TC:209). */
  refresh: () => void;
}

/**
 * @param ticker - the symbol to research; a falsy one fetches nothing
 * @param options.enabled - default true; when false nothing is fetched (the research endpoint needs an access token or
 *   a BYOK Finnhub key)
 */
export function useTickerContext(
  ticker: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): TickerContextState {
  const tk = ticker ?? '';
  // No placeholder: every render reads the current ticker's own cache entry, so no render shows the previous ticker's
  // context and a cached one shows on the first committed render (TC:127). Every field used is read on every render:
  // TanStack re-renders the hook only when a field read during render changes.
  const { data, error, isFetching, isStale, dataUpdatedAt } = useQuery({
    queryKey: keys.tickerContext(tk),
    enabled: !!ticker && enabled,
    staleTime: FRESH_MS,
    queryFn: loadContext,
  }, queryClient);

  // TanStack keeps showing a stale entry while it refetches, but this hook has never shown an entry that had expired
  // before its ticker was shown (TC:172). So note whether the entry was stale (expired, or marked so by a data-source
  // change) when this key was first rendered, and hide it until new data lands (a failed refetch keeps it hidden). The
  // note is taken per key, so an entry that goes stale while shown stays shown; it is re-taken when `enabled` flips,
  // since a disabled query never reports stale. Adjusted during render (React's "adjust state when a prop changes"
  // pattern), so a key's first committed render hides it.
  const k = `${tk}|${enabled}`;
  const [seen, setSeen] = useState(() => ({ k, expired: isStale, dataUpdatedAt }));
  if (seen.k !== k) setSeen({ k, expired: isStale, dataUpdatedAt });
  const hiding = seen.expired && dataUpdatedAt === seen.dataUpdatedAt;

  // A data key saved or cleared in Settings, or an import: mark every ticker's entry stale. That refetches the shown
  // one while its context stays shown (and stays, with the error, if the reload fails: TC:270), hides it from a mount
  // meanwhile (TC:177) and refetches the others on their next visit. Cancelling first aborts a request already sent
  // with the old key, recording no error (TC:287); the refetch alone would replace it only for an entry that has data,
  // and join a first load. Not while disabled (TC:196).
  useEffect(() => {
    if (!enabled) return undefined;
    const onSourceChange = () => {
      queryClient.cancelQueries({ queryKey: ['tickerContext'] });
      queryClient.invalidateQueries({ queryKey: ['tickerContext'] });
    };
    window.addEventListener('data-source-changed', onSourceChange);
    return () => window.removeEventListener('data-source-changed', onSourceChange);
  }, [enabled]);

  // Disabling aborts a request in flight, as the old hook's effect cleanup did (TC:308). When the Finnhub key is
  // cleared and no access token is held, this hook's own data-source listener (still registered during that dispatch)
  // starts a refetch just before App disables the hook; without the cancel it runs keyless, fails on the server, logs
  // a warning and leaves a masked error. Cancelling reverts synchronously and records no error. The exact key, not the
  // family: other tickers' entries are not in flight.
  useEffect(() => {
    if (!enabled) queryClient.cancelQueries({ queryKey: keys.tickerContext(tk), exact: true });
  }, [enabled, tk]);

  // A refetch, not a reset, so the context stays shown while it runs (TC:209); a disabled query is skipped.
  const refresh = useCallback(() => {
    queryClient.refetchQueries({ queryKey: keys.tickerContext(tk), exact: true });
  }, [tk]);

  return {
    context: enabled && !hiding ? (data ?? null) : null,
    loading: enabled && isFetching,
    error: enabled ? (error?.message ?? null) : null,
    refresh,
  };
}
