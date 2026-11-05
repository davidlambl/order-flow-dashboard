// src/hooks/usePositionSignals.test.jsx — the position panel's hook: derivePositionSignals (tested under Node in
// src/lib/positionSignals.node.test.js) over the panel's props and App's market context, in one memo, with the context
// fields the panel's leaves render passed through as they are, and useNow's minute tick re-ageing the snapshot while
// nothing else moves. Rendered under StrictMode, as main.jsx renders App, inside src/test/contexts.jsx's withContexts.
// Date and the interval are faked (the component test fakes Date alone; the tick is a 60 s interval); React keeps its
// real timers.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePositionSignals } from './usePositionSignals.js';
import { derivePositionSignals } from '../lib/positionSignals.js';
import { withContexts } from '../test/contexts.jsx';

// Fri 2026-09-25, 5:00 PM ET: after the options close (4:15 PM).
const NOW = Date.parse('2026-09-25T21:00:00Z');
const KPIS = { maxPain: 100, netPremium: 2e6, putCallRatio: 0.85 };
const GEX = [{ strike: 95, gex: 5e8 }];

/** The snapshot's time `min` minutes before NOW, an ISO string as getMarketData stamps it. */
const minutesAgo = (min) => new Date(NOW - min * 60_000).toISOString();

/** The fields of a getMarketData payload the panel reads. */
const DATA = {
  ticker: 'AVGO', provider: 'cboe', spotPrice: 100, kpis: KPIS, gexByStrike: GEX, lastUpdated: minutesAgo(60),
};

/** A live quote at `current`: an after-hours print, two minutes old. */
const quote = (current) => ({
  ticker: 'AVGO', current, previousClose: 99, changePercent: 1, timestamp: NOW - 120_000, source: 'yahoo-post',
});

/** The market context after the close: the data loaded, both sessions closed, no live quote yet. */
const MARKET = { data: DATA, loading: false, optionsMarketOpen: false, marketOpen: false, liveQuote: null };
const POSITION = { costBasis: 80, shares: 10 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Render the hook under StrictMode and the contexts; update(props, market) re-renders it with new props and, when one
 * is given, a new market value. withContexts builds a fresh value object on every render, as App's memo does when any
 * of its fields changes.
 */
function renderSignals(props, market) {
  let current = market;
  const wrapper = ({ children }) => <StrictMode>{withContexts(children, { market: current })}</StrictMode>;
  const hook = renderHook((p) => usePositionSignals(p), { initialProps: props, wrapper });
  const update = (nextProps, nextMarket = current) => {
    current = nextMarket;
    hook.rerender(nextProps);
  };
  return { ...hook, update };
}

/** The derivation the hook should return for these props over this market value, at `now`. */
const derived = ({ costBasis, shares }, { data, liveQuote, optionsMarketOpen, marketOpen }, now = NOW) =>
  derivePositionSignals({
    costBasis, shares, spotPrice: data?.spotPrice, kpis: data?.kpis, gexByStrike: data?.gexByStrike, liveQuote,
    optionsMarketOpen, marketOpen, lastUpdated: data?.lastUpdated, now,
  });

describe('usePositionSignals', () => {
  it('derives the signals from the props and the market context, and passes the fields the leaves render through', () => {
    const { result } = renderSignals(POSITION, MARKET);
    expect(result.current).toStrictEqual({
      signals: derived(POSITION, MARKET),
      loading: false,
      spotPrice: 100,
      liveQuote: null,
      optionsMarketOpen: false,
      dataProvider: 'cboe',
      lastUpdated: minutesAgo(60),
      now: NOW,
    });
    expect(result.current.signals).toMatchObject({
      showDual: false, dualRec: null, isStale: false, pnl: { pct: 25, dollars: 200, up: true },
    });
    expect(result.current.signals.rec).not.toBeNull();
  });

  it('follows the props: the cost basis and the shares', () => {
    const { result, update } = renderSignals(POSITION, MARKET);

    update({ costBasis: 125, shares: 10 });
    expect(result.current.signals).toStrictEqual(derived({ costBasis: 125, shares: 10 }, MARKET));
    expect(result.current.signals.pnl).toEqual({ pct: -20, dollars: -250, up: false });

    update({ costBasis: '125', shares: null });
    expect(result.current.signals).toStrictEqual(derived({ costBasis: '125', shares: null }, MARKET));
    expect(result.current.signals.pnl).toEqual({ pct: -20, dollars: null, up: false });

    update({ costBasis: null, shares: null });
    expect(result.current.signals).toMatchObject({ hasBasis: false, rec: null, levels: [] });
  });

  it('follows the market context: the live quote, both sessions and each field of the data, passed through as they are', () => {
    const { result, update } = renderSignals(POSITION, MARKET);
    const expectFollowing = (market) => {
      update(POSITION, market);
      expect(result.current.signals).toStrictEqual(derived(POSITION, market));
    };

    const live = { ...MARKET, liveQuote: quote(102) };
    expectFollowing(live);
    expect(result.current.signals).toMatchObject({ showDual: true, rec: null, hasLiveQuote: true });
    expect(result.current.signals.dualRec).not.toBeNull();
    expect(result.current.liveQuote).toBe(live.liveQuote);

    const optionsOpen = { ...live, optionsMarketOpen: true };
    expectFollowing(optionsOpen);
    expect(result.current.signals.showDual).toBe(false);
    expect(result.current.optionsMarketOpen).toBe(true);

    // An hour and a minute old: stale under either open flag, fresh with both closed
    const old = { ...MARKET, data: { ...DATA, lastUpdated: minutesAgo(61) } };
    expectFollowing(old);
    expect(result.current.signals.isStale).toBe(false);
    expectFollowing({ ...old, marketOpen: true });
    expect(result.current.signals.isStale).toBe(true);
    expectFollowing({ ...old, optionsMarketOpen: true });
    expect(result.current.signals.isStale).toBe(true);
    expect(result.current.lastUpdated).toBe(minutesAgo(61));

    expectFollowing({ ...MARKET, data: { ...DATA, spotPrice: 125 } });
    expect(result.current.signals.pnl).toEqual({ pct: 56.25, dollars: 450, up: true });
    expect(result.current.spotPrice).toBe(125);

    expectFollowing({ ...MARKET, data: { ...DATA, kpis: undefined } });
    expect(result.current.signals.rec).toBeNull();

    expectFollowing({ ...MARKET, data: { ...DATA, gexByStrike: [] } });
    expect(result.current.signals.levels.map((l) => l.label)).toEqual(['Basis', 'Spot', 'Max Pain']);

    expectFollowing({ ...MARKET, data: { ...DATA, provider: 'tradier' } });
    expect(result.current.dataProvider).toBe('tradier');

    expectFollowing({ ...MARKET, data: null, loading: true });
    expect(result.current).toMatchObject({
      loading: true, spotPrice: undefined, dataProvider: undefined, lastUpdated: undefined,
    });
    expect(result.current.signals).toMatchObject({ hasSpotPrice: false, rec: null, levels: [] });
  });

  it('ticks once a minute: isStale and now move with the clock while nothing else changes', () => {
    // The open session's 60-minute bar, reached exactly: one more minute makes the snapshot stale.
    const market = { ...MARKET, optionsMarketOpen: true };
    const { result } = renderSignals(POSITION, market);
    const first = result.current.signals;
    expect(first.isStale).toBe(false);
    expect(result.current.now).toBe(NOW);

    act(() => { vi.advanceTimersByTime(59_999); });
    expect(result.current.now).toBe(NOW);
    expect(result.current.signals).toBe(first);

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.now).toBe(NOW + 60_000);
    expect(result.current.signals.isStale).toBe(true);
    expect(result.current.signals).toStrictEqual(derived(POSITION, market, NOW + 60_000));
  });

  it('one memo: a re-render with the same inputs returns the same signals object, whatever else in the context changed', () => {
    const { result, update } = renderSignals(POSITION, MARKET);
    const first = result.current.signals;

    update({ ...POSITION });
    expect(result.current.signals).toBe(first);

    update(POSITION, {
      ...MARKET, ticker: 'NVDA', loading: true, nextRefreshAt: NOW + 60_000, contextLoading: true, dataSource: 'tradier',
    });
    expect(result.current.signals).toBe(first);
    expect(result.current.loading).toBe(true);

    update({ costBasis: 81, shares: 10 });
    expect(result.current.signals).not.toBe(first);
    expect(result.current.signals).toStrictEqual(derived({ costBasis: 81, shares: 10 }, MARKET));
  });
});

// The memo's dependency list, one input at a time: each step changes a single input from the step before, so a
// dependency dropped from the list leaves the old object in place and fails its step (the clock's is the tick test's).
describe('usePositionSignals: each input alone', () => {
  it('recomputes the signals when any one of the nine inputs changes, and only then', () => {
    let props = POSITION;
    let market = { ...MARKET, liveQuote: quote(102) };
    const { result, update } = renderSignals(props, market);
    const step = (label, nextProps, nextMarket) => {
      const before = result.current.signals;
      props = nextProps;
      market = nextMarket;
      update(props, market);
      expect(result.current.signals, label).not.toBe(before);
      expect(result.current.signals, label).toStrictEqual(derived(props, market));
    };
    const withData = (over) => ({ ...market, data: { ...market.data, ...over } });

    step('costBasis', { ...props, costBasis: 90 }, market);
    step('shares', { ...props, shares: 25 }, market);
    step('spotPrice', props, withData({ spotPrice: 101 }));
    step('kpis', props, withData({ kpis: { ...KPIS, maxPain: 97 } }));
    step('gexByStrike', props, withData({ gexByStrike: [{ strike: 105, gex: -4e8 }] }));
    step('lastUpdated', props, withData({ lastUpdated: minutesAgo(300) }));
    step('liveQuote', props, { ...market, liveQuote: quote(103) });
    step('marketOpen', props, { ...market, marketOpen: true });
    step('optionsMarketOpen', props, { ...market, optionsMarketOpen: true });

    const settled = result.current.signals;
    update(props, { ...market, loading: true }); // a context field the derivation does not read
    expect(result.current.signals).toBe(settled);
  });
});

