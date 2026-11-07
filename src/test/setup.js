// src/test/setup.js — dom project setup (vitest.config.js → projects.dom.setupFiles): jest-dom matchers,
// Testing Library cleanup, storage reset, the shared MSW server, TanStack Query's notifications made synchronous,
// the shared queryClient (src/lib/queryClient.ts) cleared after every test, and every lazily loaded component loaded
// before a file's first test. Tests import { server } from '../test/setup.js' (same module instance) and add handlers
// with server.use(...).
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { notifyManager } from '@tanstack/react-query';
import { setupServer } from 'msw/node';
import { queryClient } from '../lib/queryClient.js';
import { preloadAll, resetLazies } from '../lib/lazyWithPreload.js';
import { lazyPreloadSkipped } from './lazy.js';

// Testing Library registers neither of these itself when test globals are off.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Handlers target http://localhost:3000/.netlify/functions/… (jsdom's origin under Vitest). */
export const server = setupServer();

// TanStack batches observer notifications through setTimeout(0), but the hook tests assert synchronously right after
// act() (use{MarketData,LiveQuote,TickerContext}.test.jsx: act() around refresh() or a 'data-source-changed'
// dispatch, then `loading` is already true). A synchronous scheduler makes React's store notification land inside act.
beforeAll(() => {
  notifyManager.setScheduler((cb) => cb());
});

// api.js / auth.js fetch relative URLs. Node's fetch rejects them and MSW builds a Request from the input
// before matching, so resolve them here — OUTSIDE the fetch that server.listen() patches.
// A request no handler answers is refused, never sent (setup.test.js). msw 3 calls the option onUnhandledFrame and
// ignores msw 2's onUnhandledRequest, falling back to 'warn', which sends the request on.
let mswFetch;
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  mswFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => mswFetch(
    typeof input === 'string' && input.startsWith('/') ? new URL(input, window.location.origin).href : input,
    init,
  );
});

// A lazy part (src/lib/lazyWithPreload.ts) suspends on its first render until its module is in, and these tests assert
// right after render(). Once loaded, it renders directly, so loading every lazy the test file's imports created (and
// those their modules create) keeps each file as synchronous as when the parts were imported eagerly. This runs after
// the file's imports, before its own hooks. A failure here is an import that cannot load under jsdom: reported as is.
// A file that drives lazies by hand opts out (skipLazyPreload in ./lazy.js): nothing is loaded there, and every lazy
// starts each test unloaded.
beforeAll(async () => {
  if (lazyPreloadSkipped()) return;
  const [failure] = await preloadAll();
  if (failure) throw failure;
});
afterEach(() => {
  cleanup();
  // The client is a module singleton and tests reuse tickers ('AVGO'), so no cached query may outlive its test.
  // After cleanup(): clear() does not detach observers, the unmount does.
  queryClient.clear();
  server.resetHandlers();
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (lazyPreloadSkipped()) resetLazies();
});
afterAll(() => {
  globalThis.fetch = mswFetch; // hand MSW back the fetch it patched, so server.close() restores the original
  server.close();
});
