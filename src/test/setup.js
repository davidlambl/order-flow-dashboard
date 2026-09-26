// src/test/setup.js — dom project setup (vitest.config.js → projects.dom.setupFiles): jest-dom matchers,
// Testing Library cleanup, storage reset and the shared MSW server. Tests import { server } from
// '../test/setup.js' (same module instance) and add handlers with server.use(...).
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';

// Testing Library registers neither of these itself when test globals are off.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Handlers target http://localhost:3000/.netlify/functions/… (jsdom's origin under Vitest). */
export const server = setupServer();

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
  server.resetHandlers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => {
  globalThis.fetch = mswFetch; // hand MSW back the fetch it patched, so server.close() restores the original
  server.close();
});
