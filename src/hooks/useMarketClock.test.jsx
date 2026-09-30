// src/hooks/useMarketClock.test.jsx — the 30 s market clock behind useMarketData's auto-refresh: it reads the session
// on the first render, flips within one 30 s re-check of a session boundary (useMarketData.test.jsx's 16:15 ET case
// depends on exactly this timing), re-renders only when a flag changed, and clears its interval on unmount.
// The session rules themselves are unit-tested in src/lib/marketHours.node.test.js.
// Fake timers per test with shouldAdvanceTime, as in useMarketData.test.jsx; no network, so synchronous act.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMarketClock } from './useMarketClock.js';

const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');
const FRIDAY_16_14_30_ET = new Date('2026-09-25T20:14:30Z');
const SATURDAY_11_ET = new Date('2026-09-26T15:00:00Z');

const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

/** Start the fake clock at `now` and render the hook, counting its renders. */
function renderClock(now) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(now);
  const renders = { count: 0 };
  const hook = renderHook(() => {
    renders.count += 1;
    return useMarketClock();
  });
  return { ...hook, renders };
}

describe('useMarketClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the session on the first render and flips to options closed within one 30 s re-check of 16:15 ET', () => {
    const { result, renders } = renderClock(FRIDAY_16_14_30_ET);
    expect(result.current).toEqual({ marketOpen: false, optionsMarketOpen: true, session: 'post' });

    advance(20_000); // 16:14:50 ET: no re-check has run yet
    expect(result.current).toMatchObject({ optionsMarketOpen: true });

    advance(10_000); // the first re-check, at 16:15:00 ET
    expect(result.current).toEqual({ marketOpen: false, optionsMarketOpen: false, session: 'post' });
    expect(renders.count).toBe(2);
  });

  it('stays closed across several re-checks on a Saturday without re-rendering', () => {
    const { result, renders } = renderClock(SATURDAY_11_ET);
    const first = result.current;
    expect(first).toEqual({ marketOpen: false, optionsMarketOpen: false, session: 'closed' });

    advance(5 * 30_000);
    expect(result.current).toBe(first);
    expect(renders.count).toBe(1);
  });

  it('keeps the same state object, and does not re-render, when a re-check changes nothing', () => {
    const { result, renders } = renderClock(FRIDAY_11_ET);
    const first = result.current;
    expect(first).toEqual({ marketOpen: true, optionsMarketOpen: true, session: 'regular' });

    advance(4 * 30_000);
    expect(result.current).toBe(first);
    expect(renders.count).toBe(1);
  });

  it('clears its interval on unmount', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    const before = vi.getTimerCount();
    const { unmount } = renderHook(() => useMarketClock());
    expect(vi.getTimerCount()).toBe(before + 1);

    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });
});
