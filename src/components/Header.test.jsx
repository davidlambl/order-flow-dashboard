// src/components/Header.test.jsx — Header rendered alone, under the two app contexts: what App passed as twenty props
// now comes from MarketContext and AuthContext, so each test renders Header through src/test/contexts.jsx's
// withContexts with the market and auth values it needs (App's own wiring is not exercised here). First the
// auto-refresh toggle, whose countdown moved into Header's RefreshCountdown leaf so that only the leaf re-renders
// every second (F12): the seconds to nextRefreshAt, ticking once a second and never above the interval, then 'Auto'
// once the deadline is reached; the tooltip's interval, read from refreshMs so that it includes the failure backoff;
// and 'Auto' without a deadline, 'Paused' while the options market is closed and 'Auto' on demo data, each with its
// tooltip. Fake timers per test with shouldAdvanceTime, as in src/hooks/useCountdown.test.jsx; no network, so
// synchronous act. Then two pins (green on the Header that took props too): the status area's badge and sign-out
// button from AuthContext, and the ticker search, keyed on the ticker, submitting upper-cased only when it differs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Header from './Header.jsx';
import { withContexts } from '../test/contexts.jsx';

/** The market fields the toggle reads, as App provides them in the options session with real data; tests add nextRefreshAt. */
const market = { autoRefresh: true, optionsMarketOpen: true, usingMock: false, refreshMs: 60_000 };

/** Header under both providers: `over` is layered on `market`, `auth` on the free, signed-out defaults. */
const header = (over, auth) => withContexts(<Header onOpenSettings={() => {}} />, { market: { ...market, ...over }, auth });

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
    render(header({ nextRefreshAt: Date.now() + 60_000 }));
    expect(toggle().textContent).toBe('60s');
    advance(1_000);
    expect(toggle().textContent).toBe('59s');
    advance(59_000);
    expect(toggle().textContent).toBe('Auto');
  });

  it('never shows more than the interval when a new deadline lands between two ticks', () => {
    const { rerender } = render(header({ nextRefreshAt: Date.now() + 60_000 }));
    advance(1_500);
    expect(toggle().textContent).toBe('59s');
    // The data just landed and the leaf's clock is 500 ms old: unclamped, this would read ceil(60.5) = 61.
    rerender(header({ nextRefreshAt: Date.now() + 60_000 }));
    expect(toggle().textContent).toBe('60s');
  });

  it('reads the interval in the tooltip from refreshMs, the failure backoff included', () => {
    const { rerender } = render(header({ nextRefreshAt: Date.now() + 60_000 }));
    expect(toggle().title).toBe('Auto-refreshing every 60s — click to pause');
    rerender(header({ nextRefreshAt: Date.now() + 120_000, refreshMs: 120_000 }));
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
    render(header({ nextRefreshAt: Date.now() + 60_000, ...over }));
    expect(toggle().textContent).toBe(text);
    expect(toggle().title).toBe(title);
  });
});

// Both pins are green on the Header that took these values as props: they fix what Header reads from the two
// contexts, not a behaviour that changed. No deadline here, so no countdown and no timer.
describe('Header from the contexts', () => {
  const signOutButton = () => screen.queryByRole('button', { name: 'Sign out' });

  it('Pin: shows the badge and the sign-out button from AuthContext', () => {
    const signOut = vi.fn(async () => {});
    const { rerender } = render(header({}, { isPremium: true, tokenTier: 'pro', daysLeft: 30, signedIn: true, signOut }));
    expect(screen.getByText('PRO')).toBeInTheDocument();
    fireEvent.click(signOutButton());
    expect(signOut).toHaveBeenCalledTimes(1);

    rerender(header({}, { isPremium: true, tokenTier: 'trial', daysLeft: 9 }));
    expect(screen.getByText('TRIAL · 9d')).toBeInTheDocument();
    expect(signOutButton()).not.toBeInTheDocument();

    rerender(header());
    expect(screen.queryByText('PRO')).not.toBeInTheDocument();
    expect(screen.queryByText(/TRIAL/)).not.toBeInTheDocument();
    expect(signOutButton()).not.toBeInTheDocument();
  });

  it('Pin: the search submits the typed ticker upper-cased when it differs and follows the ticker it is keyed on', () => {
    const setTicker = vi.fn();
    // Re-queried after every rerender: a new ticker mounts a new field.
    const field = () => screen.getByLabelText('Stock ticker symbol');
    const { rerender } = render(header({ ticker: 'AVGO', setTicker }));
    expect(field()).toHaveValue('AVGO');
    fireEvent.submit(field().closest('form'));
    expect(setTicker).not.toHaveBeenCalled();

    fireEvent.change(field(), { target: { value: 'nvda' } });
    fireEvent.submit(field().closest('form'));
    expect(setTicker).toHaveBeenCalledTimes(1);
    expect(setTicker).toHaveBeenCalledWith('NVDA');

    // App took the submit: the field shows the new ticker, and submitting it unchanged is a no-op.
    rerender(header({ ticker: 'NVDA', setTicker }));
    expect(field()).toHaveValue('NVDA');
    fireEvent.submit(field().closest('form'));
    expect(setTicker).toHaveBeenCalledTimes(1);

    // A ticker changed elsewhere replaces a draft, as the effect it stood in for did.
    fireEvent.change(field(), { target: { value: 'ms' } });
    expect(field()).toHaveValue('MS');
    rerender(header({ ticker: 'AMD', setTicker }));
    expect(field()).toHaveValue('AMD');
  });
});
