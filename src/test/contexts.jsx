// src/test/contexts.jsx — the two app contexts for component tests that used to pass App's props. marketValue() and
// authValue() build complete MarketValue / AuthValue objects with neutral defaults (nothing loaded, nothing loading,
// no error, no quote, no research, the free tier, not signed in, vi.fn() for every callback), shallow-merged with the
// overrides a test passes (a full value passes through), and withContexts(ui, { market, auth }) wraps ui in both
// providers: render(withContexts(<Header onOpenSettings={fn} />, { market: { ticker: 'NVDA' } })) stands where
// render(<Header ticker="NVDA" … />) stood, and rerender(withContexts(…)) moves it on. Each call mints fresh vi.fn()s,
// so a test that asserts on a callback passes its own in the overrides. Only tests import this module.
import { vi } from 'vitest';
import { AuthContext } from '../contexts/AuthContext.js';
import { MarketContext } from '../contexts/MarketContext.js';

/** A complete MarketValue: a dashboard with nothing loaded yet, overridden field by field. */
export function marketValue(overrides = {}) {
  return {
    ticker: 'AVGO',
    setTicker: vi.fn(),
    data: null,
    loading: false,
    error: null,
    usingMock: false,
    refresh: vi.fn(),
    autoRefresh: true,
    toggleAutoRefresh: vi.fn(),
    nextRefreshAt: null,
    refreshMs: 60_000,
    marketOpen: true,
    optionsMarketOpen: true,
    liveQuote: null,
    tickerContext: null,
    contextLoading: false,
    dataSource: 'cboe',
    ...overrides,
  };
}

/** A complete AuthValue: the free tier, not signed in, no cloud sign-in; overridden field by field. */
export function authValue(overrides = {}) {
  return {
    isPremium: false,
    tokenTier: null,
    daysLeft: 0,
    signedIn: false,
    userEmail: undefined,
    signOut: vi.fn(async () => {}),
    signIn: undefined,
    ...overrides,
  };
}

/** `ui` under both providers; `market` and `auth` are overrides (or full values) for marketValue / authValue. */
export function withContexts(ui, { market, auth } = {}) {
  return (
    <AuthContext value={authValue(auth)}>
      <MarketContext value={marketValue(market)}>{ui}</MarketContext>
    </AuthContext>
  );
}
