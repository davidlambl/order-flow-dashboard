// src/lib/queryClient.ts
// The one TanStack Query client behind the data hooks, and their query keys. The hooks pass it to useQuery
// explicitly, so they also run without a provider (their tests render them bare); main.jsx still mounts
// <QueryClientProvider>, which adds the focus/online wiring and a context for later code. src/test/setup.js
// clears it after every dom test. Node-loadable: nothing touches browser globals at import time
// (src/lib/queryClient.node.test.js).

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The hooks own their backoff (useMarketData through lib/retry.js); their tests pin exact request counts.
      retry: false,
      // Shared defaults only: each hook sets its own staleTime. gcTime matches the longest of them (research,
      // 15 min), so an unmounted ticker's payload is never dropped while it is still fresh.
      staleTime: 60_000,
      gcTime: 15 * 60_000,
      // The hooks have never refetched when the tab regains focus or the network comes back.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // Fail fast offline as before ("Network error: …", then demo data); the default 'online' mode would
      // pause the fetch silently while navigator.onLine is false.
      networkMode: 'always',
    },
  },
});

/** One key family per hook with the ticker second, so a data-source change can target a whole family by its prefix. */
export const keys = {
  marketData: (ticker: string) => ['marketData', ticker] as const,
  liveQuote: (ticker: string) => ['liveQuote', ticker] as const,
  tickerContext: (ticker: string) => ['tickerContext', ticker] as const,
};
