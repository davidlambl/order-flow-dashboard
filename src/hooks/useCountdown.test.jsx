// src/hooks/useCountdown.test.jsx — the Header countdown's arithmetic: whole seconds left until a deadline, rounded
// up, ticking once a second, 0 without a deadline or past it, and never above the interval it counts down (the
// clock is up to one tick old when the deadline moves).
// Fake timers run with shouldAdvanceTime; advance() moves the clock inside act so useNow's interval fires there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCountdown } from './useCountdown.js';

const START = new Date('2026-09-25T15:00:00Z');

/** Move the fake clock inside act, firing every timer due on the way. */
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down one second at a time', async () => {
    const target = Date.now() + 60_000;
    const { result } = renderHook(() => useCountdown(target, 60));
    expect(result.current).toBe(60);
    await advance(1_000);
    expect(result.current).toBe(59);
    await advance(10_000);
    expect(result.current).toBe(49);
  });

  it('reads 0 without a deadline and stays there', async () => {
    const { result } = renderHook(() => useCountdown(null, 60));
    expect(result.current).toBe(0);
    await advance(5_000);
    expect(result.current).toBe(0);
  });

  it('reads 0 once the deadline has passed', async () => {
    const past = renderHook(() => useCountdown(Date.now() - 5_000, 60));
    expect(past.result.current).toBe(0);

    const target = Date.now() + 2_000;
    const { result } = renderHook(() => useCountdown(target, 60));
    expect(result.current).toBe(2);
    await advance(3_000);
    expect(result.current).toBe(0);
  });

  it('never reads more than maxSecs', () => {
    const { result } = renderHook(() => useCountdown(Date.now() + 61_000, 60));
    expect(result.current).toBe(60);
  });

  it('follows a new deadline, clamped to maxSecs while the clock is one tick old', async () => {
    const { result, rerender } = renderHook(({ target }) => useCountdown(target, 60), {
      initialProps: { target: Date.now() + 60_000 },
    });
    await advance(1_500);
    expect(result.current).toBe(59);

    // The last tick was 500 ms ago: unclamped this would read ceil(60.5) = 61.
    rerender({ target: Date.now() + 60_000 });
    expect(result.current).toBe(60);
    await advance(500);
    expect(result.current).toBe(60);
    await advance(1_000);
    expect(result.current).toBe(59);

    rerender({ target: null });
    expect(result.current).toBe(0);
  });

  it('rounds up a remainder of less than half a second', () => {
    // 59.3 s left: Math.round and Math.floor would both read 59, a second short.
    const { result } = renderHook(() => useCountdown(Date.now() + 59_300, 60));
    expect(result.current).toBe(60);
  });
});
