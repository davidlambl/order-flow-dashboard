// src/hooks/useLiveQuote.test.jsx — the live-quote hook's observable contract: the request and its headers, the 60 s
// per-ticker cache, ticker changes, forced refreshes (refresh(), data-source-changed) that clear the quote, the silent
// 60 s background refresh, errors, a dead token, and aborts. Phase 5 moves the hook onto TanStack Query; these tests
// must pass unchanged.
// The cache is a module Map no test can clear, so every test takes fresh tickers. MSW (src/test/setup.js) answers
// getLiveQuote and `requests` keeps every Request it saw; a gated reply holds its request in flight until release().
// Fake timers run with shouldAdvanceTime so waitFor and MSW keep working; the 60 s refresh is driven by advance(),
// which fires it inside act, and vi.setSystemTime ages the cache without firing timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { setPreference } from '../lib/store.js';
import { useLiveQuote } from './useLiveQuote.js';

const FN = 'http://localhost:3000/.netlify/functions';

let n = 0;
const freshTicker = () => `T${n++}`;

/** A getLiveQuote body as the Yahoo path sends it during the regular session. */
function quote(ticker, over = {}) {
  return {
    ticker, current: 101.5, previousClose: 100, changePercent: 1.5, timestamp: Date.parse('2026-09-25T15:00:00Z'), source: 'yahoo-regular', ...over,
  };
}

let requests;

/** Answer getLiveQuote with reply(request), recording every request; a later serve() takes precedence. */
function serve(reply) {
  server.use(http.get(`${FN}/getLiveQuote`, ({ request }) => {
    requests.push(request);
    return reply(request);
  }));
}

/** A reply held until release(), so the request stays in flight. */
function gated(reply) {
  let release;
  const open = new Promise((resolve) => { release = resolve; });
  return { reply: async (request) => { await open; return reply(request); }, release };
}

const tickerOf = (request) => new URL(request.url).searchParams.get('ticker');
const ok = (request, over) => HttpResponse.json(quote(tickerOf(request), over));

/** Move the fake clock inside act; every timer that fires yields to the real event loop, so fetches can land. */
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** Render the hook for `ticker` and wait until its quote is shown. */
async function renderLoaded(ticker) {
  const hook = renderHook(() => useLiveQuote(ticker));
  await waitFor(() => expect(hook.result.current.quote).not.toBeNull());
  return hook;
}

describe('useLiveQuote', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the quote with the stored access token and BYOK Finnhub key', async () => {
    localStorage.setItem('access_token', 'tok-123');
    setPreference('data_finnhub_key', 'fh-abc');
    serve(ok);
    const t = freshTicker();
    const { result } = renderHook(() => useLiveQuote(t));
    expect(result.current).toMatchObject({ quote: null, loading: true, error: null });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quote).toEqual(quote(t));
    expect(result.current.error).toBeNull();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe('/.netlify/functions/getLiveQuote');
    expect(tickerOf(requests[0])).toBe(t);
    expect(requests[0].headers.get('authorization')).toBe('Bearer tok-123');
    expect(requests[0].headers.get('x-finnhub-key')).toBe('fh-abc');
  });

  it('sends neither header when nothing is stored', async () => {
    serve(ok);
    await renderLoaded(freshTicker());
    expect(requests[0].headers.has('authorization')).toBe(false);
    expect(requests[0].headers.has('x-finnhub-key')).toBe(false);
  });

  it('a cached quote shows on the first render of a new mount, without a request', async () => {
    serve(ok);
    const t = freshTicker();
    (await renderLoaded(t)).unmount();

    const renders = [];
    const { result } = renderHook(() => {
      const state = useLiveQuote(t);
      renders.push(state);
      return state;
    });
    expect(renders[0]).toMatchObject({ quote: quote(t), loading: false, error: null });
    await advance(1_000);
    expect(result.current).toMatchObject({ quote: quote(t), loading: false });
    expect(requests).toHaveLength(1);
  });

  it('the cache serves a quote for 60 s; an older one is fetched again', async () => {
    serve(ok);
    const t = freshTicker();
    (await renderLoaded(t)).unmount();
    const written = Date.now(); // a few ms after the cache write at most

    vi.setSystemTime(written + 59_000);
    const fresh = renderHook(() => useLiveQuote(t));
    expect(fresh.result.current.quote).toEqual(quote(t));
    fresh.unmount();
    await advance(0);
    expect(requests).toHaveLength(1);

    vi.setSystemTime(written + 61_000);
    const { result } = renderHook(() => useLiveQuote(t));
    expect(result.current).toMatchObject({ quote: null, loading: true });
    await waitFor(() => expect(result.current.quote).not.toBeNull());
    expect(requests).toHaveLength(2);
  });

  it('a ticker change clears the quote and shows loading', async () => {
    const [t1, t2] = [freshTicker(), freshTicker()];
    const slow = gated(ok);
    serve((request) => (tickerOf(request) === t2 ? slow.reply(request) : ok(request)));
    const { result, rerender } = renderHook(({ ticker }) => useLiveQuote(ticker), { initialProps: { ticker: t1 } });
    await waitFor(() => expect(result.current.quote?.ticker).toBe(t1));

    rerender({ ticker: t2 });
    expect(result.current).toMatchObject({ quote: null, loading: true, error: null });
    slow.release();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quote).toEqual(quote(t2));
  });

  it('a ticker change aborts the in-flight request; the aborted one neither ends loading nor lands late', async () => {
    const [t1, t2] = [freshTicker(), freshTicker()];
    const first = gated(ok);
    const second = gated(ok);
    serve((request) => (tickerOf(request) === t1 ? first.reply(request) : second.reply(request)));
    const { result, rerender } = renderHook(({ ticker }) => useLiveQuote(ticker), { initialProps: { ticker: t1 } });
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender({ ticker: t2 });
    expect(requests[0].signal.aborted).toBe(true);
    await waitFor(() => expect(requests).toHaveLength(2));
    await advance(0);
    expect(result.current).toMatchObject({ quote: null, loading: true, error: null });

    second.release();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quote).toEqual(quote(t2));
    first.release();
    await advance(1_000);
    expect(result.current).toMatchObject({ quote: quote(t2), loading: false, error: null });
  });

  it('refresh() drops the cached quote, clears it, shows loading and fetches again', async () => {
    const t = freshTicker();
    const later = gated((request) => ok(request, { current: 102 }));
    serve((request) => (requests.length === 1 ? ok(request) : later.reply(request)));
    const { result } = await renderLoaded(t);

    act(() => { result.current.refresh(); });
    expect(result.current).toMatchObject({ quote: null, loading: true, error: null });
    await waitFor(() => expect(requests).toHaveLength(2));
    // The cache entry is gone at once: a mount meanwhile finds nothing to show.
    const other = renderHook(() => useLiveQuote(t));
    expect(other.result.current.quote).toBeNull();

    later.release();
    await waitFor(() => expect(result.current.quote?.current).toBe(102));
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(other.result.current.quote?.current).toBe(102));
  });

  it('refreshes silently every 60 s: the quote stays shown and loading stays false', async () => {
    const t = freshTicker();
    const later = gated((request) => ok(request, { current: 102 }));
    serve((request) => (requests.length === 1 ? ok(request) : later.reply(request)));
    const seen = [];
    const { result } = renderHook(() => {
      const state = useLiveQuote(t);
      seen.push(state);
      return state;
    });
    await waitFor(() => expect(result.current.quote).not.toBeNull());
    const from = seen.length;

    await advance(59_000);
    expect(requests).toHaveLength(1);
    await advance(1_000);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(result.current.quote).toEqual(quote(t));

    later.release();
    await waitFor(() => expect(result.current.quote.current).toBe(102));
    expect(seen.slice(from).map((state) => state.quote)).not.toContain(null);
    expect(seen.slice(from).map((state) => state.loading)).not.toContain(true);
  });

  it('skips the background refresh while a forced refresh is still in flight', async () => {
    const t = freshTicker();
    const forced = gated((request) => ok(request, { current: 102 }));
    serve((request) => (requests.length === 1 ? ok(request) : forced.reply(request)));
    const { result } = await renderLoaded(t);

    act(() => { result.current.refresh(); });
    await waitFor(() => expect(requests).toHaveLength(2));
    await advance(60_000);
    expect(requests).toHaveLength(2);
    expect(requests[1].signal.aborted).toBe(false);

    forced.release();
    await waitFor(() => expect(result.current.quote?.current).toBe(102));
    expect(result.current.loading).toBe(false);
  });

  it('data-source-changed drops the cached quote and refetches with loading', async () => {
    const t = freshTicker();
    serve((request) => ok(request, { current: 100 + requests.length }));
    const { result } = await renderLoaded(t);

    act(() => { window.dispatchEvent(new Event('data-source-changed')); });
    expect(result.current).toMatchObject({ quote: null, loading: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quote.current).toBe(102);
    expect(requests).toHaveLength(2);
  });

  it('a failed fetch sets error from the response body and shows no quote', async () => {
    serve(() => HttpResponse.json({ error: 'Quote unavailable', code: 'QUOTE_UNAVAILABLE' }, { status: 502 }));
    const t = freshTicker();
    const { result } = renderHook(() => useLiveQuote(t));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ quote: null, error: 'Quote unavailable' });
    expect(requests).toHaveLength(1);
  });

  it('a failed background refresh keeps the quote and sets error', async () => {
    const t = freshTicker();
    serve(ok);
    const { result } = await renderLoaded(t);

    serve(() => HttpResponse.json({ error: 'Quote unavailable', code: 'QUOTE_UNAVAILABLE' }, { status: 502 }));
    await advance(60_000);
    await waitFor(() => expect(result.current.error).toBe('Quote unavailable'));
    expect(result.current).toMatchObject({ quote: quote(t), loading: false });
  });

  it('a 401 TOKEN_EXPIRED removes the stored access token', async () => {
    localStorage.setItem('access_token', 'tok-old');
    serve(() => HttpResponse.json({ error: 'Access token has expired', code: 'TOKEN_EXPIRED' }, { status: 401 }));
    const t = freshTicker();
    const { result } = renderHook(() => useLiveQuote(t));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Access token has expired');
    expect(requests[0].headers.get('authorization')).toBe('Bearer tok-old');
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('unmount aborts the in-flight request and stops the background refresh', async () => {
    const gate = gated(ok);
    serve(gate.reply);
    const t = freshTicker();
    const { unmount } = renderHook(() => useLiveQuote(t));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].signal.aborted).toBe(false);

    unmount();
    expect(requests[0].signal.aborted).toBe(true);
    gate.release();
    await advance(5 * 60_000);
    expect(requests).toHaveLength(1);
  });

  it.each(['', null, undefined])('a falsy ticker (%j) never fetches and never shows loading', async (ticker) => {
    serve(ok);
    const { result } = renderHook(() => useLiveQuote(ticker));
    act(() => {
      result.current.refresh();
      window.dispatchEvent(new Event('data-source-changed'));
    });
    await advance(5 * 60_000);
    expect(requests).toHaveLength(0);
    expect(result.current).toMatchObject({ quote: null, loading: false, error: null });
  });
});
