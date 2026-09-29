// src/hooks/useMarketData.test.jsx — the market-data hook's observable contract: the payload it maps, the auth and
// BYOK headers, the countdown and its silent refresh, backoff after failed refreshes, demo data only while nothing
// real has loaded for the ticker, aborts, and market hours. Phase 5 moved the hook onto TanStack Query: the Phase 4b
// tests pass unchanged apart from the countdown helper, and the tests marked "Pin:" or "Regression:" were added from
// the Phase 5 (b) reviews. The hook now returns its deadline (nextRefreshAt), and secondsLeft() and view() below turn
// that back into the seconds every assertion expected before.
// MSW (src/test/setup.js) answers getMarketData and `requests` keeps every Request it saw, so headers and
// request.signal.aborted can be asserted; a gated reply holds its request in flight until release().
// Fake timers run with shouldAdvanceTime so waitFor and MSW keep working; the countdown, the 30 s market-hours
// re-check and the refreshes are driven by advance(), which fires them inside act. The clock starts on Friday
// 2026-09-25 at 11:00 ET, in the regular session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { backoffSeconds } from '../lib/retry.js';
import { setPreference } from '../lib/store.js';
import { useMarketData } from './useMarketData.js';

// The real generator is random; the hook only needs something marked provider 'mock'.
const { demoData } = vi.hoisted(() => ({
  demoData: (ticker) => ({ ticker, provider: 'mock', spotPrice: 178.5, kpis: {}, gexByStrike: [], flowHistory: [], expiries: [] }),
}));
vi.mock('../lib/mockData.js', () => ({ generateMockData: demoData }));

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');

/**
 * A trimmed getMarketData body as the CBOE path sends it when the flowHistory lookup failed. It also leaves out
 * lastTradeTime, most kpis and fallbackReason, which the function always sends (null unless a Tradier attempt failed
 * first) and the hook maps to null when missing.
 */
function marketData(ticker, over = {}) {
  return {
    ticker,
    provider: 'cboe',
    delay: '15-min delayed',
    spotPrice: 100,
    priceChange: 1.25,
    priceChangePct: 1.27,
    iv30: 31.4,
    totalOptionsCount: 420,
    expiries: ['2026-09-25', '2026-10-02'],
    kpis: { netPremium: 1_250_000, putCallRatio: 0.82, maxPain: 100 },
    gexByStrike: [{ strike: 95, gex: -2_000_000 }, { strike: 100, gex: 5_000_000 }],
    lastUpdated: '2026-09-25T14:59:30.000Z',
    ...over,
  };
}

let requests;

/** Answer getMarketData with reply(request), recording every request; a later serve() takes precedence. */
function serve(reply) {
  server.use(http.get(`${FN}/getMarketData`, ({ request }) => {
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
const ok = (request, over) => HttpResponse.json(marketData(tickerOf(request), over));
const boom = () => HttpResponse.json({ error: 'boom', code: 'UPSTREAM_ERROR' }, { status: 502 });

/** Move the fake clock inside act; every timer that fires yields to the real event loop, so fetches can land. */
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** F12: the hook exposes nextRefreshAt (epoch ms) + refreshMs; Header derives the seconds. Same numbers as before. */
const secondsLeft = (s) => (s.nextRefreshAt == null ? 0 : Math.max(0, Math.ceil((s.nextRefreshAt - Date.now()) / 1000)));
const view = (s) => ({ ...s, secondsLeft: secondsLeft(s) });

/** Render the hook for `ticker` and wait for the first load to settle. */
async function renderLoaded(ticker = 'AVGO') {
  const hook = renderHook(() => useMarketData(ticker));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe('useMarketData', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loading', () => {
    it('starts loading with no data, then shows the mapped payload with the countdown at 60', async () => {
      serve(ok);
      const { result } = renderHook(() => useMarketData('AVGO'));
      expect(view(result.current)).toMatchObject({ data: null, loading: true, error: null, usingMock: false, failures: 0, secondsLeft: 0 });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data).toEqual({ ...marketData('AVGO'), flowHistory: [], fallbackReason: null });
      expect(view(result.current)).toMatchObject({
        error: null, usingMock: false, failures: 0, autoRefresh: true, secondsLeft: 60, marketOpen: true, optionsMarketOpen: true,
      });
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0].url).pathname).toBe('/.netlify/functions/getMarketData');
      expect(tickerOf(requests[0])).toBe('AVGO');
    });

    it('defaults missing arrays to [] and fallbackReason to null, and passes a fallbackReason through', async () => {
      serve(() => HttpResponse.json({ ticker: 'AVGO', provider: 'cboe', spotPrice: 100 }));
      const { result, unmount } = await renderLoaded();
      expect(result.current.data).toEqual({
        ticker: 'AVGO', provider: 'cboe', spotPrice: 100, gexByStrike: [], flowHistory: [], expiries: [], fallbackReason: null,
      });
      unmount();

      serve(() => HttpResponse.json({ ticker: 'AVGO', provider: 'cboe', spotPrice: 100, fallbackReason: 'tradier-timeout' }));
      const second = await renderLoaded();
      expect(second.result.current.data.fallbackReason).toBe('tradier-timeout');
    });

    it('sends the stored access token and the BYOK Tradier key', async () => {
      localStorage.setItem('access_token', 'tok-123');
      setPreference('data_tradier_key', 'trd-abc');
      serve(ok);
      await renderLoaded();
      expect(requests[0].headers.get('authorization')).toBe('Bearer tok-123');
      expect(requests[0].headers.get('x-tradier-key')).toBe('trd-abc');
    });

    it('sends neither header when nothing is stored', async () => {
      serve(ok);
      await renderLoaded();
      expect(requests[0].headers.has('authorization')).toBe(false);
      expect(requests[0].headers.has('x-tradier-key')).toBe(false);
    });

    it('a failed first load shows demo data that never auto-refreshes; refresh() replaces it with real data', async () => {
      serve(boom);
      const { result } = await renderLoaded();
      expect(result.current.data).toEqual(demoData('AVGO'));
      expect(view(result.current)).toMatchObject({ usingMock: true, error: 'boom', failures: 1, secondsLeft: 0 });

      await advance(5 * 60_000);
      expect(requests).toHaveLength(1);

      serve(ok);
      act(() => { result.current.refresh(); });
      expect(result.current.loading).toBe(true);
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data.provider).toBe('cboe');
      expect(view(result.current)).toMatchObject({ usingMock: false, error: null, failures: 0, secondsLeft: 60 });
      expect(requests).toHaveLength(2);
    });

    it.each(['', null, undefined])('a falsy ticker (%j) never fetches, and loading stays true (current contract)', async (ticker) => {
      serve(ok);
      const { result } = renderHook(() => useMarketData(ticker));
      await advance(5 * 60_000);
      act(() => {
        result.current.refresh();
        window.dispatchEvent(new Event('data-source-changed'));
      });
      await advance(1_000);
      expect(requests).toHaveLength(0);
      expect(view(result.current)).toMatchObject({ data: null, loading: true, error: null, usingMock: false, secondsLeft: 0 });
    });

    // Regression: review minor 2, failures read 1, 1, 1 in demo mode, and 0 while a reload ran.
    it('failures keep counting in demo mode, also while a reload runs', async () => {
      const reload = gated(boom);
      serve((request) => (requests.length === 2 ? reload.reply(request) : boom()));
      const { result } = await renderLoaded();
      expect(result.current).toMatchObject({ usingMock: true, failures: 1 });

      act(() => { result.current.refresh(); });
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(result.current).toMatchObject({ loading: true, usingMock: true, failures: 1 });
      reload.release();
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.failures).toBe(2);

      act(() => { result.current.refresh(); });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toMatchObject({ usingMock: true, error: 'boom', failures: 3 });
      expect(requests).toHaveLength(3);
    });
  });

  describe('auto-refresh', () => {
    it('counts down one second at a time', async () => {
      serve(ok);
      const { result } = await renderLoaded();
      expect(secondsLeft(result.current)).toBe(60);
      await advance(1_000);
      expect(secondsLeft(result.current)).toBe(59);
      await advance(10_000);
      expect(secondsLeft(result.current)).toBe(49);
      expect(requests).toHaveLength(1);
    });

    it('refetches silently at 0: loading stays false and the previous data stays until the new data lands', async () => {
      const second = gated((request) => ok(request, { spotPrice: 101 }));
      serve((request) => (requests.length === 1 ? ok(request) : second.reply(request)));
      const loadingSeen = [];
      const { result } = renderHook(() => {
        const state = useMarketData('AVGO');
        loadingSeen.push(state.loading);
        return state;
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      const first = result.current.data;
      const rendersBefore = loadingSeen.length;

      await advance(59_000);
      expect(secondsLeft(result.current)).toBe(1);
      expect(requests).toHaveLength(1);

      await advance(1_000);
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(secondsLeft(result.current)).toBe(60);
      expect(result.current.data).toBe(first);

      second.release();
      await waitFor(() => expect(result.current.data.spotPrice).toBe(101));
      expect(result.current.error).toBeNull();
      expect(loadingSeen.slice(rendersBefore)).not.toContain(true);
    });

    it('a Tradier payload refreshes every 30 s', async () => {
      serve((request) => ok(request, { provider: 'tradier', delay: 'real-time' }));
      const { result } = await renderLoaded();
      expect(secondsLeft(result.current)).toBe(30);
      await advance(29_000);
      expect(requests).toHaveLength(1);
      await advance(1_000);
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(secondsLeft(result.current)).toBe(30);
    });

    it('a failed silent refresh keeps the data, sets error and failures, and backs off until one succeeds', async () => {
      serve(ok);
      const { result } = await renderLoaded();
      const shown = result.current.data;

      serve(boom);
      await advance(60_000);
      await waitFor(() => expect(result.current.failures).toBe(1));
      expect(result.current.data).toBe(shown);
      expect(view(result.current)).toMatchObject({ error: 'boom', loading: false, usingMock: false, secondsLeft: backoffSeconds(60, 1) });

      await advance(backoffSeconds(60, 1) * 1000 - 1000);
      expect(requests).toHaveLength(2);
      await advance(1_000);
      await waitFor(() => expect(result.current.failures).toBe(2));
      expect(result.current.data).toBe(shown);
      expect(secondsLeft(result.current)).toBe(backoffSeconds(60, 2));

      serve((request) => ok(request, { spotPrice: 102 }));
      await advance(backoffSeconds(60, 2) * 1000);
      await waitFor(() => expect(result.current.failures).toBe(0));
      expect(result.current.data.spotPrice).toBe(102);
      expect(view(result.current)).toMatchObject({ error: null, secondsLeft: 60 });
      expect(requests).toHaveLength(4);
    });

    it('refresh() refetches with loading and restarts the countdown at 60', async () => {
      serve((request) => ok(request, { spotPrice: 100 + requests.length }));
      const { result } = await renderLoaded();
      await advance(10_000);
      expect(secondsLeft(result.current)).toBe(50);

      act(() => { result.current.refresh(); });
      expect(result.current.loading).toBe(true);
      expect(secondsLeft(result.current)).toBe(60);
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data.spotPrice).toBe(102);

      // The next silent refresh is a full interval after the manual one.
      await advance(59_000);
      expect(requests).toHaveLength(2);
      await advance(1_000);
      await waitFor(() => expect(requests).toHaveLength(3));
    });

    it('toggleAutoRefresh stops the countdown (secondsLeft 0) and starts it again at 60', async () => {
      serve(ok);
      const { result } = await renderLoaded();

      act(() => { result.current.toggleAutoRefresh(); });
      expect(view(result.current)).toMatchObject({ autoRefresh: false, secondsLeft: 0 });
      await advance(5 * 60_000);
      expect(requests).toHaveLength(1);

      act(() => { result.current.toggleAutoRefresh(); });
      expect(view(result.current)).toMatchObject({ autoRefresh: true, secondsLeft: 60 });
    });

    it('data-source-changed refetches with loading', async () => {
      serve((request) => ok(request, { spotPrice: 100 + requests.length }));
      const { result } = await renderLoaded();

      act(() => { window.dispatchEvent(new Event('data-source-changed')); });
      expect(result.current.loading).toBe(true);
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(requests).toHaveLength(2);
      expect(result.current.data.spotPrice).toBe(102);
    });

    // Regression: review minor 1, the countdown jumped back up by the request's duration when a silent refresh landed.
    it('a slow silent refresh does not move the countdown when it lands', async () => {
      const silent = gated((request) => ok(request, { spotPrice: 101 }));
      serve((request) => (requests.length === 1 ? ok(request) : silent.reply(request)));
      const { result } = await renderLoaded();

      await advance(60_000);
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(secondsLeft(result.current)).toBe(60);
      await advance(3_000);
      silent.release();
      await waitFor(() => expect(result.current.data.spotPrice).toBe(101));
      expect(secondsLeft(result.current)).toBe(57);
    });

    // Pin: a silent refresh still running at the next tick must not stall the tick-anchored countdown (minor 1's fix).
    it('a silent refresh that outlasts the interval does not stop the auto-refresh', async () => {
      const slow = gated((request) => ok(request, { spotPrice: 102 }));
      serve((request) => (requests.length === 2 ? slow.reply(request) : ok(request, { spotPrice: 100 + requests.length })));
      const { result } = await renderLoaded();

      await advance(60_000);
      await waitFor(() => expect(requests).toHaveLength(2));
      await advance(60_000);
      slow.release();
      await waitFor(() => expect(result.current.data.spotPrice).toBeGreaterThan(101));
      const sent = requests.length;
      await advance(60_000);
      await waitFor(() => expect(requests).toHaveLength(sent + 1));
      expect(result.current.loading).toBe(false);
    });
  });

  describe('ticker changes and aborts', () => {
    it('a ticker change refetches; until the new payload lands, data still holds the previous ticker\'s (current contract)', async () => {
      serve((request) => ok(request, { spotPrice: tickerOf(request) === 'AVGO' ? 100 : 180 }));
      const { result, rerender } = renderHook(({ ticker }) => useMarketData(ticker), { initialProps: { ticker: 'AVGO' } });
      await waitFor(() => expect(result.current.loading).toBe(false));

      rerender({ ticker: 'NVDA' });
      expect(result.current.loading).toBe(true);
      expect(result.current.data.ticker).toBe('AVGO');
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data).toMatchObject({ ticker: 'NVDA', spotPrice: 180 });
      expect(requests.map(tickerOf)).toEqual(['AVGO', 'NVDA']);
    });

    it('a failed first load for a new ticker shows demo data for it, never the previous ticker\'s payload', async () => {
      serve((request) => (tickerOf(request) === 'AVGO' ? ok(request) : boom()));
      const { result, rerender } = renderHook(({ ticker }) => useMarketData(ticker), { initialProps: { ticker: 'AVGO' } });
      await waitFor(() => expect(result.current.loading).toBe(false));

      rerender({ ticker: 'NVDA' });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data).toEqual(demoData('NVDA'));
      expect(view(result.current)).toMatchObject({ usingMock: true, error: 'boom', secondsLeft: 0 });
    });

    it('a ticker change aborts the in-flight request; the aborted one is no failure, keeps loading and never lands', async () => {
      const avgo = gated(ok);
      const nvda = gated((request) => ok(request, { spotPrice: 180 }));
      serve((request) => (tickerOf(request) === 'AVGO' ? avgo.reply(request) : nvda.reply(request)));
      const { result, rerender } = renderHook(({ ticker }) => useMarketData(ticker), { initialProps: { ticker: 'AVGO' } });
      await waitFor(() => expect(requests).toHaveLength(1));

      rerender({ ticker: 'NVDA' });
      expect(requests[0].signal.aborted).toBe(true);
      await waitFor(() => expect(requests).toHaveLength(2));
      await advance(0);
      expect(result.current).toMatchObject({ data: null, loading: true, error: null, failures: 0 });

      nvda.release();
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data).toMatchObject({ ticker: 'NVDA', spotPrice: 180 });
      avgo.release();
      await advance(1_000);
      expect(result.current.data).toMatchObject({ ticker: 'NVDA', spotPrice: 180 });
      expect(result.current).toMatchObject({ loading: false, error: null, failures: 0 });
    });

    it('unmount aborts the in-flight request', async () => {
      const gate = gated(ok);
      serve(gate.reply);
      const { unmount } = renderHook(() => useMarketData('AVGO'));
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0].signal.aborted).toBe(false);

      unmount();
      expect(requests[0].signal.aborted).toBe(true);
      gate.release();
    });

    // Regression: review F1, a reload in demo mode showed the last ticker that had data, without the Demo badge.
    it('a ticker in demo mode reloads with its own demo data, never the previous ticker\'s payload', async () => {
      const reloads = [gated(boom), gated(boom)];
      serve((request) => {
        if (tickerOf(request) === 'AVGO') return ok(request);
        return requests.length === 2 ? boom() : reloads[requests.length - 3].reply(request);
      });
      const { result, rerender } = renderHook(({ ticker }) => useMarketData(ticker), { initialProps: { ticker: 'AVGO' } });
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ ticker: 'NVDA' });
      await waitFor(() => expect(result.current.usingMock).toBe(true));

      act(() => { result.current.refresh(); });
      await waitFor(() => expect(requests).toHaveLength(3));
      expect(result.current.data).toEqual(demoData('NVDA'));
      expect(result.current).toMatchObject({ usingMock: true, loading: true });
      reloads[0].release();
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => { window.dispatchEvent(new Event('data-source-changed')); });
      await waitFor(() => expect(requests).toHaveLength(4));
      expect(result.current.data).toEqual(demoData('NVDA'));
      expect(result.current).toMatchObject({ usingMock: true, loading: true });
      reloads[1].release();
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data).toEqual(demoData('NVDA'));
      expect(result.current).toMatchObject({ usingMock: true, error: 'boom' });
    });

    // Regression: review F2, a key saved during the first load was never sent (the reload joined that load).
    it('data-source-changed during a first load aborts it and refetches with the new key', async () => {
      const first = gated(ok);
      serve((request) => (requests.length === 1 ? first.reply(request) : ok(request, { spotPrice: 101 })));
      const { result } = renderHook(() => useMarketData('AVGO'));
      await waitFor(() => expect(requests).toHaveLength(1));

      setPreference('data_tradier_key', 'trd-new');
      act(() => { window.dispatchEvent(new Event('data-source-changed')); });
      expect(requests[0].signal.aborted).toBe(true);
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1].headers.get('x-tradier-key')).toBe('trd-new');
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data.spotPrice).toBe(101);

      first.release();
      await advance(1_000);
      expect(result.current).toMatchObject({ loading: false, error: null, failures: 0 });
      expect(result.current.data.spotPrice).toBe(101);
    });
  });

  describe('market hours', () => {
    it('the 30 s re-check stops the countdown at the 16:15 ET options close', async () => {
      vi.setSystemTime(new Date('2026-09-25T20:14:30Z')); // 16:14:30 ET: equities closed, options open until 16:15
      serve(ok);
      const { result } = await renderLoaded();
      expect(view(result.current)).toMatchObject({ marketOpen: false, optionsMarketOpen: true, secondsLeft: 60 });

      await advance(30_000);
      expect(view(result.current)).toMatchObject({ marketOpen: false, optionsMarketOpen: false, secondsLeft: 0 });
      await advance(5 * 60_000);
      expect(requests).toHaveLength(1);
    });

    it('on a Saturday data loads once and the countdown never starts', async () => {
      vi.setSystemTime(new Date('2026-09-26T15:00:00Z')); // Saturday 11:00 ET
      serve(ok);
      const { result } = await renderLoaded();
      expect(result.current.data.ticker).toBe('AVGO');
      expect(view(result.current)).toMatchObject({ marketOpen: false, optionsMarketOpen: false, secondsLeft: 0 });

      await advance(5 * 60_000);
      expect(requests).toHaveLength(1);
      expect(secondsLeft(result.current)).toBe(0);
    });
  });

  // From the PR #64 review, placed last so that no line the hook cites (MD:n) moves.
  describe('aborted requests', () => {
    // Pin: refresh() during the timer's fetch aborts it and reloads in the foreground (review finding 2). Joining that
    // fetch instead (cancelRefetch false) sent nothing and kept `loading` false until the silent reply landed.
    it('refresh() during a silent refresh cancels it and reloads in the foreground', async () => {
      const silent = gated((request) => ok(request, { spotPrice: 101 }));
      serve((request) => {
        if (requests.length === 1) return ok(request);
        return requests.length === 2 ? silent.reply(request) : ok(request, { spotPrice: 102 });
      });
      const { result } = await renderLoaded();
      await advance(60_000);
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(result.current.loading).toBe(false);

      act(() => { result.current.refresh(); });
      expect(result.current.loading).toBe(true);
      expect(requests[1].signal.aborted).toBe(true);
      await waitFor(() => expect(requests).toHaveLength(3));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data.spotPrice).toBe(102);

      silent.release();
      await advance(1_000);
      expect(result.current.data.spotPrice).toBe(102);
    });

    // Pin: an aborted request is no failure, so it logs no warning (review finding 10). api.ts rethrows the abort as a
    // plain Error ('Network error: …'): only the signal tells it apart, and an err.name check would warn in both tests.
    it('a ticker change mid-load aborts the request without a failure warning', async () => {
      const avgo = gated(ok);
      serve((request) => (tickerOf(request) === 'AVGO' ? avgo.reply(request) : ok(request, { spotPrice: 180 })));
      const { result, rerender } = renderHook(({ ticker }) => useMarketData(ticker), { initialProps: { ticker: 'AVGO' } });
      await waitFor(() => expect(requests).toHaveLength(1));

      rerender({ ticker: 'NVDA' });
      expect(requests[0].signal.aborted).toBe(true);
      await waitFor(() => expect(result.current.loading).toBe(false));
      avgo.release();
      await advance(1_000);
      expect(result.current.data).toMatchObject({ ticker: 'NVDA', spotPrice: 180 });
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('an unmount mid-load aborts the request without a failure warning', async () => {
      const gate = gated(ok);
      serve(gate.reply);
      const { unmount } = renderHook(() => useMarketData('AVGO'));
      await waitFor(() => expect(requests).toHaveLength(1));

      unmount();
      expect(requests[0].signal.aborted).toBe(true);
      gate.release();
      await advance(1_000);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });
});
