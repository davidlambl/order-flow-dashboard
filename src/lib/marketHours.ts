// src/lib/marketHours.ts
// The market-data hook's two clocks, as pure functions: the refresh cadence per provider (with the backoff after
// failed refreshes) and which sessions are open at an instant. Kept out of the hooks so the TanStack Query rewrite
// and useMarketClock share one definition and both are unit-tested without React or timers. Pure and Node-loadable
// (src/lib/marketHours.node.test.js scans it): the time is always an argument, relative imports carry their extension.

import { getMarketSession } from '../../shared/marketCalendar.js';
import { backoffSeconds } from './retry.js';
import type { MarketProvider } from '../../types/market.js';

/** Sessions as shared/marketCalendar.js names them; its JS return type widens them to string. */
const MARKET_SESSIONS = ['regular', 'pre', 'post', 'closed'] as const;
export type MarketSession = (typeof MARKET_SESSIONS)[number];

export interface MarketState {
  /** Regular equity session (9:30–16:00 ET, 13:00 on early closes). */
  marketOpen: boolean;
  /** Options session, which runs 15 minutes past the equity close. */
  optionsMarketOpen: boolean;
  session: MarketSession;
}

const TRADIER_REFRESH_MS = 30_000;
const DEFAULT_REFRESH_MS = 60_000;

function isMarketSession(value: unknown): value is MarketSession {
  return (MARKET_SESSIONS as readonly unknown[]).includes(value);
}

/**
 * The auto-refresh interval: real-time Tradier quotes refresh every 30 s; the sandbox and CBOE are delayed and the
 * demo data never changes, so they (and a payload that has not loaded yet) refresh every 60 s.
 */
export function getRefreshMs(provider: MarketProvider | null | undefined): number {
  return provider === 'tradier' ? TRADIER_REFRESH_MS : DEFAULT_REFRESH_MS;
}

/** The wait before the next background refresh after `failures` consecutive failures (doubling, capped at 300 s). */
export function getBackoffMs(provider: MarketProvider | null | undefined, failures: number): number {
  return backoffSeconds(getRefreshMs(provider) / 1000, failures) * 1000;
}

/** Which sessions are open at `now`, in Eastern Time (holidays and early closes included). */
export function readMarketState(now: Date): MarketState {
  const s = getMarketSession(now);
  return {
    marketOpen: s.equityOpen,
    optionsMarketOpen: s.optionsOpen,
    session: isMarketSession(s.session) ? s.session : 'closed',
  };
}
