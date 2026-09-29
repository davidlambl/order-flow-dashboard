// src/test/setup.js — dom project setup (vitest.config.js → projects.dom.setupFiles): jest-dom matchers,
// Testing Library cleanup, storage reset, the shared MSW server, TanStack Query's notifications made synchronous
// and the shared queryClient (src/lib/queryClient.ts) cleared after every test. Tests import { server } from
// '../test/setup.js' (same module instance) and add handlers with server.use(...).
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { notifyManager } from '@tanstack/react-query';
import { setupServer } from 'msw/node';
import { queryClient } from '../lib/queryClient.js';

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
let mswFetch;
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  mswFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => mswFetch(
    typeof input === 'string' && input.startsWith('/') ? new URL(input, window.location.origin).href : input,
    init,
  );
});
afterEach(() => {
  cleanup();
  // The client is a module singleton and tests reuse tickers ('AVGO'), so no cached query may outlive its test.
  // After cleanup(): clear() does not detach observers, the unmount does.
  queryClient.clear();
  server.resetHandlers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => {
  globalThis.fetch = mswFetch; // hand MSW back the fetch it patched, so server.close() restores the original
  server.close();
});
