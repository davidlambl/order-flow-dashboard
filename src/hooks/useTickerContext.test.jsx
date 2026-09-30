// src/hooks/useTickerContext.test.jsx — the research-context hook's observable contract: `enabled` gating, the request
// and its headers, the 15 min per-ticker cache, no committed render with another ticker's context, data-source-changed,
// refresh(), errors and aborts. Phase 5 (b) moved the hook onto TanStack Query: these tests passed unchanged apart from
// the news fixture's ISO datetime (#60) and the data-source-changed test's title, and it added those marked "Pin:" or
// "Regression:". Each test takes fresh tickers (a habit from the old module Map); src/test/setup.js clears the TanStack
// cache after each test. MSW answers getTickerContext and `requests` keeps every Request it saw; a gated reply holds its
// request until release(). Fake timers run with shouldAdvanceTime (waitFor and MSW keep working); setSystemTime ages it.
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { setPreference } from '../lib/store.js';
import { useTickerContext } from './useTickerContext.js';

const FN = 'http://localhost:3000/.netlify/functions';

let n = 0;
const freshTicker = () => `T${n++}`;

/** A getTickerContext body (Finnhub): news, earnings, analysts, technicals, fundamentals. */
function tickerContext(ticker, over = {}) {
  return {
    ticker,
    news: [{ headline: `${ticker} raises guidance`, source: 'Reuters', datetime: '2026-09-21T14:13:20.000Z' }],
    earnings: { date: '2026-10-29', epsEstimate: 1.42 },
    analysts: null,
    technicals: { sma50: 98.2, sma200: 91.7, rsi14: 56 },
    fundamentals: null,
    ...over,
  };
}

let requests;

/** Answer getTickerContext with reply(request), recording every request; a later serve() takes precedence. */
function serve(reply) {
  server.use(http.get(`${FN}/getTickerContext`, ({ request }) => {
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
const ok = (request, over) => HttpResponse.json(tickerContext(tickerOf(request), over));

/** Move the fake clock inside act, yielding to the real event loop so fetches can land. */
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** Render with `ticker` / `enabled` as props, so a rerender can change either. */
const renderContext = (ticker, enabled = true) => renderHook(
  (props) => useTickerContext(props.ticker, { enabled: props.enabled }),
  { initialProps: { ticker, enabled } },
);

/** Render the hook for `ticker` and wait until its context is shown. */
async function renderLoaded(ticker) {
  const hook = renderContext(ticker);
  await waitFor(() => expect(hook.result.current.context).not.toBeNull());
  return hook;
}

describe('useTickerContext', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the context with the stored access token and BYOK Finnhub key', async () => {
    localStorage.setItem('access_token', 'tok-123');
    setPreference('data_finnhub_key', 'fh-abc');
    serve(ok);
    const t = freshTicker();
    const { result } = renderContext(t);
    expect(result.current).toMatchObject({ context: null, loading: true, error: null });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context).toEqual(tickerContext(t));
    expect(result.current.error).toBeNull();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe('/.netlify/functions/getTickerContext');
    expect(tickerOf(requests[0])).toBe(t);
    expect(requests[0].headers.get('authorization')).toBe('Bearer tok-123');
    expect(requests[0].headers.get('x-finnhub-key')).toBe('fh-abc');
  });

  it('enabled: false fetches nothing and reports no context, error or loading; enabling fetches', async () => {
    serve(ok);
    const t = freshTicker();
    const { result, rerender } = renderContext(t, false);
    await advance(1_000);
    expect(requests).toHaveLength(0);
    expect(result.current).toMatchObject({ context: null, loading: false, error: null });

    rerender({ ticker: t, enabled: true });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context).toEqual(tickerContext(t));
    expect(requests).toHaveLength(1);
  });

  it('disabling hides a loaded context; enabling again shows it from the cache without a request', async () => {
    serve(ok);
    const t = freshTicker();
    const { result, rerender } = await renderLoaded(t);

    rerender({ ticker: t, enabled: false });
    expect(result.current).toMatchObject({ context: null, loading: false, error: null });
    rerender({ ticker: t, enabled: true });
    expect(result.current).toMatchObject({ context: tickerContext(t), loading: false });
    await advance(0);
    expect(requests).toHaveLength(1);
  });

  it('a ticker change never shows the previous ticker\'s context, and a cached one shows at once', async () => {
    const [t1, t2] = [freshTicker(), freshTicker()];
    const slow = gated(ok);
    serve((request) => (tickerOf(request) === t2 ? slow.reply(request) : ok(request)));
    // Record what each committed render shows: the render React throws away when state is reset during render is
    // never on screen, so it is not recorded.
    const shown = [];
    const { result, rerender } = renderHook(({ ticker }) => {
      const state = useTickerContext(ticker);
      useLayoutEffect(() => { shown.push({ ticker, context: state.context }); });
      return state;
    }, { initialProps: { ticker: t1 } });
    await waitFor(() => expect(result.current.context).toEqual(tickerContext(t1)));

    rerender({ ticker: t2 });
    expect(result.current).toMatchObject({ context: null, loading: true });
    const forT2 = shown.filter((entry) => entry.ticker === t2);
    expect(forT2.length).toBeGreaterThan(0);
    expect(forT2.every((entry) => entry.context === null)).toBe(true);
    slow.release();
    await waitFor(() => expect(result.current.context).toEqual(tickerContext(t2)));

    const from = shown.length;
    rerender({ ticker: t1 });
    expect(shown[from]).toEqual({ ticker: t1, context: tickerContext(t1) });
    expect(result.current).toMatchObject({ context: tickerContext(t1), loading: false, error: null });
    await advance(0);
    expect(requests.map(tickerOf)).toEqual([t1, t2]);
  });

  it('the cache serves a context for 15 min; an older one is fetched again', async () => {
    serve(ok);
    const t = freshTicker();
    (await renderLoaded(t)).unmount();
    const written = Date.now(); // a few ms after the cache write at most

    vi.setSystemTime(written + 14 * 60_000);
    const fresh = renderContext(t);
    expect(fresh.result.current.context).toEqual(tickerContext(t));
    fresh.unmount();
    await advance(0);
    expect(requests).toHaveLength(1);

    vi.setSystemTime(written + 16 * 60_000);
    const { result } = renderContext(t);
    expect(result.current).toMatchObject({ context: null, loading: true });
    await waitFor(() => expect(result.current.context).not.toBeNull());
    expect(requests).toHaveLength(2);
  });

  it('data-source-changed refetches with loading and hides the stale context from a new mount', async () => {
    const t = freshTicker();
    const later = gated((request) => ok(request, { technicals: { sma50: 99 } }));
    serve((request) => (requests.length === 1 ? ok(request) : later.reply(request)));
    const { result } = await renderLoaded(t);

    act(() => { window.dispatchEvent(new Event('data-source-changed')); });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(requests).toHaveLength(2));
    // The entry is marked stale at once: a mount meanwhile finds nothing to show until the refetch lands.
    const other = renderContext(t);
    expect(other.result.current.context).toBeNull();

    later.release();
    await waitFor(() => expect(result.current.context?.technicals.sma50).toBe(99));
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(other.result.current.context?.technicals.sma50).toBe(99));
  });

  it('data-source-changed fetches nothing while disabled', async () => {
    serve(ok);
    const t = freshTicker();
    const { result, rerender } = renderContext(t, false);
    act(() => { window.dispatchEvent(new Event('data-source-changed')); });
    await advance(1_000);
    expect(requests).toHaveLength(0);

    rerender({ ticker: t, enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requests).toHaveLength(1);
  });

  it('refresh() refetches with loading while the current context stays shown', async () => {
    const t = freshTicker();
    const later = gated((request) => ok(request, { technicals: { sma50: 99 } }));
    serve((request) => (requests.length === 1 ? ok(request) : later.reply(request)));
    const { result } = await renderLoaded(t);

    act(() => { result.current.refresh(); });
    expect(result.current).toMatchObject({ context: tickerContext(t), loading: true, error: null });
    await waitFor(() => expect(requests).toHaveLength(2));

    later.release();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context.technicals.sma50).toBe(99);
  });

  it('a failed fetch sets error from the response body; a Finnhub key rejection keeps the access token', async () => {
    localStorage.setItem('access_token', 'tok-123');
    serve(() => HttpResponse.json({ error: 'Finnhub rejected the API key', code: 'FINNHUB_KEY_REJECTED' }, { status: 401 }));
    const t = freshTicker();
    const { result } = renderContext(t);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ context: null, error: 'Finnhub rejected the API key' });
    expect(localStorage.getItem('access_token')).toBe('tok-123');
    expect(requests).toHaveLength(1);
  });

  it('a ticker change aborts the in-flight request; the aborted one neither ends loading nor lands late', async () => {
    const [t1, t2] = [freshTicker(), freshTicker()];
    const first = gated(ok);
    const second = gated(ok);
    serve((request) => (tickerOf(request) === t1 ? first.reply(request) : second.reply(request)));
    const { result, rerender } = renderContext(t1);
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender({ ticker: t2, enabled: true });
    expect(requests[0].signal.aborted).toBe(true);
    await waitFor(() => expect(requests).toHaveLength(2));
    await advance(0);
    expect(result.current).toMatchObject({ context: null, loading: true, error: null });

    second.release();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context).toEqual(tickerContext(t2));
    first.release();
    await advance(1_000);
    expect(result.current).toMatchObject({ context: tickerContext(t2), loading: false, error: null });
  });

  it('unmount aborts the in-flight request', async () => {
    const gate = gated(ok);
    serve(gate.reply);
    const { unmount } = renderContext(freshTicker());
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].signal.aborted).toBe(false);

    unmount();
    expect(requests[0].signal.aborted).toBe(true);
    gate.release();
  });

  // Regression (review major): resetQueries blanked the shown research while it reloaded, and for good if that failed.
  it('data-source-changed keeps the shown context through a failed reload', async () => {
    const t = freshTicker();
    const unavailable = { error: `Ticker context unavailable for ${t}`, code: 'CONTEXT_UNAVAILABLE' };
    const reload = gated(() => HttpResponse.json(unavailable, { status: 502 }));
    serve((request) => (requests.length === 1 ? ok(request) : reload.reply(request)));
    const { result } = await renderLoaded(t);

    act(() => { window.dispatchEvent(new Event('data-source-changed')); });
    expect(result.current).toMatchObject({ context: tickerContext(t), loading: true });
    await waitFor(() => expect(requests).toHaveLength(2));

    reload.release();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ context: tickerContext(t), error: unavailable.error });
  });

  // Pin: the listener's cancel; invalidateQueries alone would join a first load already sent with the old key.
  it('data-source-changed during a first load aborts it and refetches with the new key', async () => {
    setPreference('data_finnhub_key', 'fh-old');
    const t = freshTicker();
    const first = gated(ok);
    serve((request) => (requests.length === 1 ? first.reply(request) : ok(request)));
    const { result } = renderContext(t);
    await waitFor(() => expect(requests).toHaveLength(1));

    setPreference('data_finnhub_key', 'fh-new');
    act(() => { window.dispatchEvent(new Event('data-source-changed')); });
    expect(requests[0].signal.aborted).toBe(true);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((request) => request.headers.get('x-finnhub-key'))).toEqual(['fh-old', 'fh-new']);

    await waitFor(() => expect(result.current.loading).toBe(false));
    first.release();
    await advance(1_000);
    expect(result.current).toMatchObject({ context: tickerContext(t), loading: false, error: null });
  });

  // Regression: disabling left the request in flight to land in the cache; the old hook's effect cleanup aborted it.
  it('disabling aborts a request in flight', async () => {
    const t = freshTicker();
    const first = gated(ok);
    serve((request) => (requests.length === 1 ? first.reply(request) : ok(request)));
    const { result, rerender } = renderContext(t);
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender({ ticker: t, enabled: false });
    expect(requests[0].signal.aborted).toBe(true);
    first.release();
    await advance(1_000);
    expect(result.current).toMatchObject({ context: null, loading: false, error: null });
    expect(console.warn).not.toHaveBeenCalledWith('Ticker context fetch failed:', expect.anything());

    // The aborted reply never landed: enabling again fetches afresh.
    rerender({ ticker: t, enabled: true });
    expect(result.current).toMatchObject({ context: null, loading: true });
    await waitFor(() => expect(result.current.context).toEqual(tickerContext(t)));
    expect(requests).toHaveLength(2);
  });

  // Pin: an entry already expired when first shown stays hidden until dataUpdatedAt moves, so a failed refetch keeps
  // it hidden; the rejected `seen.expired && !isFetchedAfterMount` would count the failure and show it with the error.
  it('a context older than 15 min whose refetch fails stays hidden, with the error', async () => {
    const t = freshTicker();
    const unavailable = { error: `Ticker context unavailable for ${t}`, code: 'CONTEXT_UNAVAILABLE' };
    serve((request) => (requests.length === 1 ? ok(request) : HttpResponse.json(unavailable, { status: 502 })));
    (await renderLoaded(t)).unmount();
    vi.setSystemTime(Date.now() + 16 * 60_000);

    const { result } = renderContext(t);
    expect(result.current).toMatchObject({ context: null, loading: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requests).toHaveLength(2);
    expect(result.current).toMatchObject({ context: null, error: unavailable.error });
  });
});
