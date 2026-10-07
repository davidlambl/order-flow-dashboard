// src/hooks/usePremiumStatus.test.jsx — the premium state follows the stored access token through the auth-changed
// event (roadmap F11): the status on mount, free the moment the token is cleared, the new status when one is set, an
// expired token as free with its tier, one status object per token, and the window listener gone on unmount. Tokens
// are minted as in src/lib/auth.test.js (base64url payload; nothing client-side checks the signature), and the clock
// is pinned so daysLeft is exact. src/test/setup.js clears localStorage after each test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AUTH_EVENT, clearToken, setToken } from '../lib/auth.js';
import { usePremiumStatus } from './usePremiumStatus.js';

/** base64url without padding, as JWT segments are written. */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A header.payload.signature token; nothing client-side checks the signature. */
const jwt = (payload) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;

const NOW = Date.parse('2026-09-26T12:00:00Z');
const nowSec = NOW / 1000;
const DAY = 86_400;
const FREE = { isPremium: false, tokenTier: null, daysLeft: 0 };

describe('usePremiumStatus', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the stored pro token on mount', () => {
    localStorage.setItem('access_token', jwt({ sub: 'user-1', tier: 'pro', exp: nowSec + 9 * DAY + 1 }));
    const { result } = renderHook(() => usePremiumStatus());
    expect(result.current).toEqual({ isPremium: true, tokenTier: 'pro', daysLeft: 10 });
  });

  it('is free without a token', () => {
    const { result } = renderHook(() => usePremiumStatus());
    expect(result.current).toEqual(FREE);
  });

  it('drops to free the moment the token is cleared, and follows a new token', () => {
    localStorage.setItem('access_token', jwt({ tier: 'pro', exp: nowSec + 9 * DAY + 1 }));
    const { result } = renderHook(() => usePremiumStatus());
    expect(result.current.isPremium).toBe(true);

    act(() => clearToken());
    expect(result.current).toEqual(FREE);

    act(() => setToken(jwt({ tier: 'trial', exp: nowSec + 3 * DAY })));
    expect(result.current).toEqual({ isPremium: true, tokenTier: 'trial', daysLeft: 3 });
  });

  it('an expired token is free, with its tier and 0 days', () => {
    localStorage.setItem('access_token', jwt({ tier: 'pro', exp: nowSec - 1 }));
    const { result } = renderHook(() => usePremiumStatus());
    expect(result.current).toEqual({ isPremium: false, tokenTier: 'pro', daysLeft: 0 });
  });

  it('keeps one status object per token, so a consumer can depend on it', () => {
    localStorage.setItem('access_token', jwt({ tier: 'pro', exp: nowSec + DAY }));
    const { result, rerender } = renderHook(() => usePremiumStatus());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => window.dispatchEvent(new CustomEvent(AUTH_EVENT))); // an event that left the token as it was
    expect(result.current).toBe(first);

    act(() => setToken(jwt({ tier: 'pro', exp: nowSec + 2 * DAY })));
    expect(result.current).not.toBe(first);
    expect(result.current.daysLeft).toBe(2);
  });

  it('removes its auth-changed listener on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => usePremiumStatus());
    const added = add.mock.calls.filter(([type]) => type === AUTH_EVENT);
    expect(added).toHaveLength(1);

    unmount();
    const removed = remove.mock.calls.filter(([type, listener]) => type === AUTH_EVENT && listener === added[0][1]);
    expect(removed).toHaveLength(1);
  });
});
