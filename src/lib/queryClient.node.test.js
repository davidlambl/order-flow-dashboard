// src/lib/queryClient.node.test.js — the one TanStack Query client behind the data hooks (src/lib/queryClient.ts):
// it loads with no DOM, its query defaults (no retries, no focus or reconnect refetch, fail fast offline) reach every
// query while a hook's own staleTime wins, and each hook's key family is selectable by its prefix, as the hooks'
// data-source-changed listeners select it. Queries a test adds to the shared client are cleared in a finally.
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { keys, queryClient } from './queryClient.js';
import { withGlobals } from '../../test/helpers/globals.js';

const DEFAULTS = {
  retry: false,
  staleTime: 60_000,
  gcTime: 15 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  networkMode: 'always',
};

describe('queryClient', () => {
  it('Node-loadable: queryClient.js imports with no DOM (no window, document or localStorage) and builds a QueryClient', async () => {
    await withGlobals({ window: undefined, document: undefined, localStorage: undefined }, async () => {
      vi.resetModules();
      const { QueryClient } = await import('@tanstack/react-query');
      const fresh = await import('./queryClient.js'); // fresh instance, loaded without the globals
      assert.notEqual(fresh.queryClient, queryClient, 'the module was evaluated again');
      assert.ok(fresh.queryClient instanceof QueryClient);
      assert.deepEqual(Object.keys(fresh.keys), ['marketData', 'liveQuote', 'tickerContext']);
    });
  });

  it('pins the query defaults and sets none for mutations', () => {
    assert.deepEqual(queryClient.getDefaultOptions(), { queries: DEFAULTS });
  });

  it("a query built on the client inherits every default, and a hook's own staleTime wins", () => {
    const options = queryClient.defaultQueryOptions({ queryKey: keys.marketData('AVGO'), staleTime: 0 });
    const inherited = Object.fromEntries(Object.keys(DEFAULTS).map((name) => [name, options[name]]));
    assert.deepEqual(inherited, { ...DEFAULTS, staleTime: 0 });
  });

  it('keys: one family per hook with the ticker second, so a family prefix selects only that hook\'s queries', () => {
    assert.deepEqual(keys.marketData('AVGO'), ['marketData', 'AVGO']);
    assert.deepEqual(keys.liveQuote('AVGO'), ['liveQuote', 'AVGO']);
    assert.deepEqual(keys.tickerContext('AVGO'), ['tickerContext', 'AVGO']);
    try {
      for (const key of Object.values(keys)) {
        for (const ticker of ['AVGO', 'NVDA']) queryClient.setQueryData(key(ticker), { ticker });
      }
      for (const [family, key] of Object.entries(keys)) {
        const selected = queryClient.getQueryCache().findAll({ queryKey: [family] }).map((query) => query.queryKey);
        assert.deepEqual(selected, [key('AVGO'), key('NVDA')], `the ['${family}'] prefix`);
      }
    } finally {
      queryClient.clear();
    }
  });
});
