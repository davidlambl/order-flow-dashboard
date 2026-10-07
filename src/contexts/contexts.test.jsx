// src/contexts/contexts.test.jsx — the two contexts' hooks: useMarket() and useAuth() throw a named error outside a
// provider (App is the only provider, so a component rendered bare in a test says so at once) and return the provided
// value inside src/test/contexts.jsx's withContexts, whose helpers build complete values from neutral defaults.
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAuth } from './AuthContext.js';
import { useMarket } from './MarketContext.js';
import { authValue, marketValue, withContexts } from '../test/contexts.jsx';

/** renderHook's wrapper: the hook under both providers, with these overrides. */
const inContexts = (overrides) => ({ children }) => withContexts(children, overrides);

/** Render `hook` with no provider above it; React also reports the render error through console.error, silenced here. */
const expectBareRenderToThrow = (hook, message) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(() => renderHook(hook)).toThrow(message);
  } finally {
    error.mockRestore();
  }
};

describe('outside a provider', () => {
  it('useMarket throws a named error', () => {
    expectBareRenderToThrow(() => useMarket(), 'useMarket: no MarketContext above this component (App provides it)');
  });

  it('useAuth throws a named error', () => {
    expectBareRenderToThrow(() => useAuth(), 'useAuth: no AuthContext above this component (App provides it)');
  });
});

describe('inside withContexts', () => {
  it('useMarket returns the complete default market value', () => {
    const { result } = renderHook(() => useMarket(), { wrapper: inContexts() });
    expect(result.current).toStrictEqual({
      ticker: 'AVGO',
      setTicker: expect.any(Function),
      data: null,
      loading: false,
      error: null,
      usingMock: false,
      refresh: expect.any(Function),
      autoRefresh: true,
      toggleAutoRefresh: expect.any(Function),
      nextRefreshAt: null,
      refreshMs: 60_000,
      marketOpen: true,
      optionsMarketOpen: true,
      liveQuote: null,
      tickerContext: null,
      contextLoading: false,
      dataSource: 'cboe',
    });
  });

  it('useAuth returns the complete default auth value, whose signOut resolves', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: inContexts() });
    expect(result.current).toStrictEqual({
      isPremium: false,
      tokenTier: null,
      daysLeft: 0,
      signedIn: false,
      userEmail: undefined,
      signOut: expect.any(Function),
      signIn: undefined,
    });
    await expect(result.current.signOut()).resolves.toBeUndefined();
  });

  it('overrides are merged field by field over the defaults', () => {
    const setTicker = vi.fn();
    const signOut = vi.fn(async () => {});
    const { result } = renderHook(() => ({ market: useMarket(), auth: useAuth() }), {
      wrapper: inContexts({
        market: { ticker: 'NVDA', setTicker, loading: true },
        auth: { isPremium: true, tokenTier: 'pro', daysLeft: 3, signOut },
      }),
    });
    expect(result.current.market).toMatchObject({ ticker: 'NVDA', setTicker, loading: true, data: null, dataSource: 'cboe' });
    expect(result.current.auth).toMatchObject({ isPremium: true, tokenTier: 'pro', daysLeft: 3, signOut, signedIn: false });
  });

  it('a full value passes through unchanged', () => {
    const market = marketValue({ ticker: 'TSLA', usingMock: true, dataSource: 'mock' });
    const auth = authValue({ signedIn: true, userEmail: 'user@example.com', signIn: vi.fn() });
    const { result } = renderHook(() => ({ market: useMarket(), auth: useAuth() }), { wrapper: inContexts({ market, auth }) });
    expect(result.current.market).toStrictEqual(market);
    expect(result.current.auth).toStrictEqual(auth);
  });
});
