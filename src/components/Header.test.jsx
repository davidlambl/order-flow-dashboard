// src/components/Header.test.jsx — the auto-refresh toggle, whose countdown moved into Header's RefreshCountdown leaf
// so that only the leaf re-renders every second (F12): the seconds to nextRefreshAt, ticking once a second and never
// above the interval, then 'Auto' once the deadline is reached; the tooltip's interval, read from refreshMs so that it
// includes the failure backoff; and 'Auto' without a deadline, 'Paused' while the options market is closed and 'Auto'
// on demo data, each with its tooltip. Header renders alone: App's wiring of the two props is not exercised here.
// Fake timers per test with shouldAdvanceTime, as in src/hooks/useCountdown.test.jsx; no network, so synchronous act.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import Header from './Header.jsx';

/** The props the toggle reads, as App passes them in the options session with real data; tests add nextRefreshAt. */
const props = { autoRefresh: true, optionsMarketOpen: true, usingMock: false, refreshMs: 60_000 };

const toggle = () => screen.getByRole('button', { name: 'Disable auto-refresh' });

/** Move the fake clock inside act, so the leaf's once-a-second tick fires there. */
const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

describe('Header auto-refresh toggle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-25T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down to nextRefreshAt once a second and shows Auto once it is reached', () => {
    render(<Header {...props} nextRefreshAt={Date.now() + 60_000} />);
    expect(toggle().textContent).toBe('60s');
    advance(1_000);
    expect(toggle().textContent).toBe('59s');
    advance(59_000);
    expect(toggle().textContent).toBe('Auto');
  });

  it('never shows more than the interval when a new deadline lands between two ticks', () => {
    const { rerender } = render(<Header {...props} nextRefreshAt={Date.now() + 60_000} />);
    advance(1_500);
    expect(toggle().textContent).toBe('59s');
    // The data just landed and the leaf's clock is 500 ms old: unclamped, this would read ceil(60.5) = 61.
    rerender(<Header {...props} nextRefreshAt={Date.now() + 60_000} />);
    expect(toggle().textContent).toBe('60s');
  });

  it('reads the interval in the tooltip from refreshMs, the failure backoff included', () => {
    const { rerender } = render(<Header {...props} nextRefreshAt={Date.now() + 60_000} />);
    expect(toggle().title).toBe('Auto-refreshing every 60s — click to pause');
    rerender(<Header {...props} nextRefreshAt={Date.now() + 120_000} refreshMs={120_000} />);
    expect(toggle().title).toBe('Auto-refreshing every 120s — click to pause');
    expect(toggle().textContent).toBe('120s');
  });

  // Every row but the first still passes a deadline, so Header's own checks pick the label, not App's null.
  it.each([
    ['Auto', 'without a deadline', { nextRefreshAt: null }, 'Auto-refreshing every 60s — click to pause'],
    ['Paused', 'while the options market is closed', { optionsMarketOpen: false },
      'Options market closed (Mon–Fri 9:30a–4:15p ET) — resumes at open'],
    ['Auto', 'on demo data', { usingMock: true }, 'Auto-refresh disabled for demo data'],
  ])('shows %s %s, with its tooltip', (text, _when, over, title) => {
    render(<Header {...props} nextRefreshAt={Date.now() + 60_000} {...over} />);
    expect(toggle().textContent).toBe(text);
    expect(toggle().title).toBe(title);
  });
});
