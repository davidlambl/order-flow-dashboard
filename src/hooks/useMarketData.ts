// src/hooks/useMarketData.ts
// Market data for one ticker on TanStack Query (lib/queryClient.ts), refreshed in the background while the options
// market is open. A failed fetch keeps the last good data for the ticker and sets `error`; demo data stands in only
// while nothing real has loaded for it. The background refresh is this hook's own timer, not refetchInterval, whose
// schedule cannot be read or restarted and whose fetch cannot be told apart: the tests pin a countdown that restarts
// when the silent fetch starts, on refresh() and on re-enabling, and `loading` staying false during that fetch.
// After consecutive failures the interval backs off (lib/marketHours.ts over lib/retry.js). The hook returns the
// deadline (`nextRefreshAt`) and the interval (`refreshMs`); Header's countdown leaf derives the seconds, so App does
// not re-render every second (F12). MD:<line> refers to src/hooks/useMarketData.test.jsx.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { QueryFunctionContext, QueryState } from '@tanstack/react-query';
import { fetchMarketData } from '../lib/api.js';
import { getBackoffMs } from '../lib/marketHours.js';
import { generateMockData } from '../lib/mockData.js';
import { keys, queryClient } from '../lib/queryClient.js';
import { useMarketClock } from './useMarketClock.js';
import type { MarketData } from '../../types/market.js';

/**
 * What a failed load rejects with: api.ts's Error plus the consecutive failures so far, which set the backoff while the
 * query has data (in demo mode the hook counts errorUpdateCount instead).
 */
type MarketDataError = Error & { failures?: number };

type MarketDataKey = ReturnType<typeof keys.marketData>;

/** TanStack's per-fetch metadata (the package does not export the type by name). */
type FetchMeta = NonNullable<QueryState['fetchMeta']>;

/**
 * The fetchMeta of the timer's fetch, which marks it silent. Every other start (mount, key switch, refresh(), a
 * data-source change) has none, stored as null. Compared by identity: only this module creates the object, and the
 * library's FetchMeta type has no `silent` to read.
 */
const SILENT: FetchMeta & { silent: true } = { silent: true };

export interface MarketDataState {
  /**
   * The ticker's last good payload; that of the last ticker that had real data (normally the previous one) while a
   * new one loads; demo data (usingMock) for a ticker that failed with nothing of its own, also while it reloads; else
   * null.
   */
  data: MarketData | null;
  /** A foreground load is under way, or there is no ticker (the current contract); never the silent refresh. */
  loading: boolean;
  /**
   * The last failure's message; null after a success, and cleared while a reload runs with nothing loaded (demo mode).
   */
  error: string | null;
  /** `data` is demo data: the ticker failed before anything real loaded for it (also while it reloads). */
  usingMock: boolean;
  /** Consecutive failed loads of the ticker, which set the backoff; 0 after a success, and kept while a reload runs. */
  failures: number;
  /** Reloads in the foreground and restarts the countdown. */
  refresh: () => void;
  autoRefresh: boolean;
  /**
   * When the next silent refresh is due (epoch ms); null while auto-refresh is off, the options market is closed or no
   * real data for the ticker is shown.
   */
  nextRefreshAt: number | null;
  /** The interval in ms: 30 s for Tradier, else 60 s, doubled per consecutive failure up to 300 s. */
  refreshMs: number;
  marketOpen: boolean;
  optionsMarketOpen: boolean;
  toggleAutoRefresh: () => void;
}

/** Milliseconds from now until `at` (epoch ms); 0 once it has passed. */
function msUntil(at: number): number {
  return Math.max(0, at - Date.now());
}

/**
 * The body as normalize() takes it: MarketData, but gexByStrike, expiries and fallbackReason may be missing, the
 * tolerance MD:115 pins (flowHistory is optional in MarketData itself). getMarketData always sends all three.
 */
type MarketDataWire = Omit<MarketData, 'gexByStrike' | 'expiries' | 'fallbackReason'>
  & Partial<Pick<MarketData, 'gexByStrike' | 'expiries' | 'fallbackReason'>>;

/**
 * The response mapped key by key, so unknown server keys never reach `data`: missing arrays become [] and a missing
 * fallbackReason null (MD:115). lastTradeTime is carried as sent (read by nothing in src/).
 */
function normalize(result: MarketDataWire): MarketData {
  return {
    ticker: result.ticker,
    provider: result.provider,
    delay: result.delay,
    spotPrice: result.spotPrice,
    priceChange: result.priceChange,
    priceChangePct: result.priceChangePct,
    iv30: result.iv30,
    kpis: result.kpis,
    gexByStrike: result.gexByStrike || [],
    flowHistory: result.flowHistory || [],
    lastUpdated: result.lastUpdated,
    lastTradeTime: result.lastTradeTime,
    totalOptionsCount: result.totalOptionsCount,
    fallbackReason: result.fallbackReason ?? null,
    expiries: result.expiries || [],
  };
}

/**
 * The queryFn. Reading `signal` lets TanStack abort the request when the key changes or the hook unmounts (MD:374,
 * MD:396). The client never retries (one request per failed load, MD:247), so the failure count rides on the error.
 */
async function loadMarketData(
  { signal, queryKey, client }: QueryFunctionContext<MarketDataKey>,
): Promise<MarketData> {
  const ticker = queryKey[1];
  try {
    return normalize(await fetchMarketData(ticker, signal));
  } catch (err) {
    // A cancelled fetch is no failure and logs nothing (MD:514, MD:529): TanStack reverts or drops it. api.ts wraps
    // the abort as 'Network error: …', so the signal, not the error, says which this was.
    if (signal.aborted) throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    const prev = client.getQueryState<MarketData, MarketDataError>(queryKey);
    if (prev?.data === undefined) console.warn('No data loaded for', ticker, '— showing demo data:', error.message);
    else console.warn('Market data refresh failed; keeping last good data:', error.message);
    throw Object.assign(error, { failures: (prev?.error?.failures ?? 0) + 1 });
  }
}

export function useMarketData(ticker: string | null | undefined): MarketDataState {
  const [autoRefresh, setAutoRefresh] = useState(true);
  // When refresh(), the toggle or the timer last restarted the countdown (epoch ms). Set only in handlers and the
  // timer callback; a later fetch that is not the timer's restarts it from its own time when it settles.
  const [restartedAt, setRestartedAt] = useState(0);
  const { marketOpen, optionsMarketOpen } = useMarketClock();

  const key = keys.marketData(ticker ?? '');
  // Destructured in full on every render: the result is a tracked proxy, and TanStack re-renders the hook only when
  // a field that was read changes.
  const {
    data: payload, error: lastError, errorUpdateCount, dataUpdatedAt, errorUpdatedAt,
    isPending, isFetching, isPlaceholderData,
  } = useQuery<MarketData, MarketDataError, MarketData, MarketDataKey>({
    queryKey: key,
    queryFn: loadMarketData,
    // No ticker: never fetches and stays pending, so `loading` stays true (MD:162, the current contract).
    enabled: !!ticker,
    // A remount refetches with `loading` (MD:115); only the timer below refreshes silently.
    staleTime: 0,
    // A new ticker shows the data of the last ticker that had real data (normally the previous one), with `loading`,
    // until its own lands (MD:350). A failure ends the placeholder, so a new ticker that fails shows its own demo data
    // (MD:363); usingMock below keeps the placeholder hidden while a ticker that failed reloads.
    placeholderData: keepPreviousData,
  }, queryClient);

  // Whether the fetch in flight, or the latest one (the countdown's anchor below), is the timer's. The live query state
  // is what this render's result was computed from; isFetching (read above) changes when a fetch starts or settles,
  // which re-renders the hook to re-read it.
  const state = queryClient.getQueryState(key);
  const silentInFlight = state?.fetchStatus === 'fetching' && state.fetchMeta === SILENT;

  // Demo mode: the ticker has failed and has nothing of its own, and never shows another ticker's payload (MD:363).
  // A reload of it (refresh(), a data-source change, switching back to it) makes the query pending again, and
  // keepPreviousData then offers the last ticker that ever had data (MD:409); errorUpdateCount survives the reload, and
  // a query with data of its own never shows a placeholder.
  const usingMock = errorUpdateCount > 0 && (payload === undefined || isPlaceholderData);
  // Drawn only in demo mode, once per ticker entering it, and shown as generateMockData returns it (MD:147).
  const mock = useMemo(() => (usingMock && ticker ? generateMockData(ticker) : null), [usingMock, ticker]);
  const data = usingMock ? mock : (payload ?? null);
  const error = lastError?.message ?? null;
  // In demo mode nothing has ever loaded for the key, so every error it recorded is consecutive: errorUpdateCount
  // counts them and keeps its value while a reload runs (MD:176). The count the queryFn attaches would restart at 1
  // there, because TanStack clears a data-less query's error when a fetch starts; it counts for a query with data.
  const failures = usingMock ? errorUpdateCount : (lastError?.failures ?? 0);
  const loading = isPending || isPlaceholderData || (isFetching && !silentInFlight);

  // While the timer's fetch is the query's latest (fetchMeta stays SILENT after it settles, until another fetch
  // starts), the next silent refresh is one interval after the last restart (the tick that started that fetch, a later
  // tick, or the toggle), however long the fetch took and whatever it returned, so the countdown runs on through a slow
  // silent refresh as today (MD:317). After any other fetch (a mount, a key switch, refresh(), a data-source reload)
  // it is one interval after the later of that fetch settling and the last restart (refresh(), the toggle or a tick).
  const refreshMs = getBackoffMs(payload?.provider, failures);
  const settledAt = Math.max(dataUpdatedAt, errorUpdatedAt);
  const active = autoRefresh && optionsMarketOpen && !usingMock && !!ticker
    && payload !== undefined && !isPlaceholderData;
  const base = state?.fetchMeta === SILENT ? restartedAt : Math.max(settledAt, restartedAt);
  const nextRefreshAt = active ? base + refreshMs : null;

  useEffect(() => {
    if (nextRefreshAt == null) return undefined;
    const id = setTimeout(() => {
      const query = queryClient.getQueryCache().find({ queryKey: keys.marketData(ticker ?? ''), exact: true });
      if (!query) return;
      if (query.state.fetchStatus === 'fetching') {
        // A foreground load: when it settles the deadline moves and this effect re-arms. The timer's own fetch
        // outlasting the interval: the deadline is anchored on the ticks and would never move again once that fetch
        // landed, so this tick restarts the countdown without sending a second request (MD:332).
        if (query.state.fetchMeta === SILENT) setRestartedAt(Date.now());
        return;
      }
      setRestartedAt(Date.now()); // the countdown restarts as the silent fetch starts (MD:227)
      query.fetch(undefined, { cancelRefetch: false, meta: SILENT }).catch(() => {});
    }, msUntil(nextRefreshAt));
    return () => clearTimeout(id);
  }, [nextRefreshAt, ticker]);

  // Foreground: refetchQueries cancels a silent fetch in flight (cancelRefetch defaults to true) and starts its own
  // without meta, so `loading` rises (MD:489); a disabled query (no ticker) is skipped. The stamp restarts the
  // countdown (MD:281) and re-renders the hook, which a silent-to-foreground switch alone would not: it changes only
  // fetchMeta, which no tracked field reflects.
  const refresh = useCallback(() => {
    setRestartedAt(Date.now());
    queryClient.refetchQueries({ queryKey: keys.marketData(ticker ?? ''), exact: true });
  }, [ticker]);

  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((on) => !on);
    setRestartedAt(Date.now()); // re-enabling starts a full interval (MD:302)
  }, []);

  // A saved or imported data-source key (AppSettings, store.ts importAll) reloads market data in the foreground
  // (MD:305). A fetch in flight was sent with the old key, so it is cancelled first: cancelRefetch replaces a running
  // fetch only when the query has data, and a first load or a reload in demo mode would otherwise be joined, not
  // repeated (MD:438). The cancel reverts synchronously, so isFetching drops before the refetch raises it again: the
  // hook re-renders (and `loading` rises) even when a silent fetch is replaced. Neither promise rejects. The countdown
  // restarts when the reload lands.
  useEffect(() => {
    const onDataSourceChanged = () => {
      queryClient.cancelQueries({ queryKey: ['marketData'] });
      queryClient.invalidateQueries({ queryKey: ['marketData'] });
    };
    window.addEventListener('data-source-changed', onDataSourceChanged);
    return () => window.removeEventListener('data-source-changed', onDataSourceChanged);
  }, []);

  return {
    data, loading, error, usingMock, failures, refresh,
    autoRefresh, nextRefreshAt, refreshMs, marketOpen, optionsMarketOpen, toggleAutoRefresh,
  };
}
