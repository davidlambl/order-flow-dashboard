// test/helpers/fetch.js — a recording stand-in for globalThis.fetch: the code under test "calls the network",
// the test decides what comes back, and every request is kept for assertions. The verify runner's fetch stub
// (scripts/verify-functions.mjs) as a function; test/helpers/functions.js wires it into the function tests.
// No Vitest import, so anything running under Node can install it.

/**
 * @typedef {(url: string|URL|Request, init?: RequestInit) => Promise<Response>} FetchImpl
 */

/**
 * Replace `globalThis.fetch` with a recorder: each call pushes `{ url: String(url), init }` into `calls`, then
 * returns what the current implementation returns. Implementations should be async like the real fetch:
 * callers chain on the result (lib/http.js's fetchWithTimeout calls `.finally()` on it).
 * @param {object} [options]
 * @param {FetchImpl} [options.defaultResponse] answers until setFetch() and again after resetFetch(); by
 *   default every request gets `{}` with status 200
 * @returns {{
 *   calls: Array<{ url: string, init: RequestInit|undefined }>,
 *   setFetch: (fn: FetchImpl) => void,
 *   resetFetch: () => void,
 *   uninstall: () => void,
 * }} `calls` is live (empty it with `calls.length = 0`); `setFetch(fn)` answers later requests with fn;
 *   `resetFetch()` goes back to `defaultResponse`; `uninstall()` restores the fetch that was installed before.
 */
export function installFetchRecorder({ defaultResponse = async () => new Response('{}', { status: 200 }) } = {}) {
  const previous = globalThis.fetch;
  const calls = [];
  let fetchImpl = defaultResponse;
  globalThis.fetch = (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(url, init); };
  return {
    calls,
    setFetch: (fn) => { fetchImpl = fn; },
    resetFetch: () => { fetchImpl = defaultResponse; },
    uninstall: () => { globalThis.fetch = previous; },
  };
}
