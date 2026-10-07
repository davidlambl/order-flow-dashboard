// src/lib/auth.ts
// Client-side token management for premium feature gating.
//
// The stored token is only *decoded* here (to show tier / days left). Whether it
// is actually valid is decided by the server: at startup via verifyStoredToken()
// and on every API call. Any change to the stored token dispatches AUTH_EVENT so
// UI state can follow: subscribeAuth() is how a hook follows it (usePremiumStatus,
// through useSyncExternalStore), and describeToken() is the status it derives.
// No window is touched at module load, so Node can import this: without one,
// notify() is silent and subscribeAuth() subscribes nothing.

const TOKEN_KEY = 'access_token';
const FUNCTION_BASE = '/.netlify/functions';

export const AUTH_EVENT = 'auth-changed';

/** Server codes that mean the stored token is no longer usable. */
const DEAD_TOKEN_CODES: ReadonlySet<string | null | undefined> = new Set(['TOKEN_EXPIRED', 'TOKEN_INVALID', 'TOKEN_REVOKED']);

function notify() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_EVENT));
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (e) {
    console.warn('setToken: localStorage write failed', e);
  }
  notify();
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
  notify();
}

/**
 * Drop the stored token if the server said it is dead. Returns true if cleared.
 */
export function clearTokenIfDead(code: string | null | undefined): boolean {
  if (!DEAD_TOKEN_CODES.has(code)) return false;
  if (getToken()) clearToken();
  return true;
}

export function getAuthHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** A JWT payload, decoded but not verified (the server verifies); the client only reads `exp` (epoch seconds) and `tier`. */
export interface TokenPayload {
  exp?: number;
  tier?: string;
  [claim: string]: unknown;
}

/**
 * Decode the JWT payload without verification (server handles that).
 * Returns null if the token is malformed.
 */
export function decodeTokenPayload(token: string | null | undefined): TokenPayload | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** validateToken.js's 200 body as-is, or the failure built here from any other status. */
export type ValidateTokenResult =
  | { valid: true; tier: string; sub: string; expiresAt: string; requestId: string }
  | { valid: false; error: string; code: string | null };

/** validateToken.js's JSON answer: the success body on a 200, else `{ valid: false, error, code, requestId }` (no `valid` on a 429). */
interface ValidateTokenBody {
  valid?: boolean;
  tier?: string;
  sub?: string;
  expiresAt?: string;
  error?: string;
  code?: string;
  requestId?: string;
}

/**
 * Returns { valid, tier, expiresAt } or { valid: false, error, code }.
 * Makes a server round-trip to cryptographically verify the token.
 */
export async function validateToken(token: string): Promise<ValidateTokenResult> {
  const res = await fetch(`${FUNCTION_BASE}/validateToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body: ValidateTokenBody | null = await res.json().catch(() => null);
  if (!res.ok) {
    return { valid: false, error: body?.error || `Server error (${res.status})`, code: body?.code || null };
  }
  // A 2xx is the success body; a 200 that is not JSON returns null (pinned in auth.test.js; callers read .valid in a try).
  return body as ValidateTokenResult;
}

/** 'none': no stored token; 'cleared': the server rejected it and it was removed; 'unknown': no verdict, the token stays. */
export type VerifyOutcome = 'valid' | 'cleared' | 'none' | 'unknown';

/**
 * Startup check: verify the stored token with the server and clear it if the
 * server rejects it (expired, revoked, re-signed secret). Network failures keep
 * the token so an offline reload doesn't log the user out.
 */
export async function verifyStoredToken(): Promise<VerifyOutcome> {
  const token = getToken();
  if (!token) return 'none';
  try {
    const result = await validateToken(token);
    if (result.valid) return 'valid';
    if (DEAD_TOKEN_CODES.has(result.code) || result.code === 'AUTH_NOT_CONFIGURED') {
      clearToken();
      return 'cleared';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** What the UI shows for a token: the PRO / TRIAL badge, the gates and the days-left count. */
export interface TokenStatus {
  /** A token whose `exp` is still ahead of the client clock; the signature is the server's to check. */
  isPremium: boolean;
  /** The token's `tier` claim, read whether or not it has expired; null without one. */
  tokenTier: string | null;
  /** Whole days until `exp`, rounded up; 0 once expired, and for a token without `exp`. */
  daysLeft: number;
}

/**
 * The status of one token string (the stored one, or null) against the client clock: decoded, not verified.
 * The clock is read once, so the three fields agree with each other.
 */
export function describeToken(token: string | null): TokenStatus {
  const payload = decodeTokenPayload(token);
  const tokenTier = payload?.tier || null;
  if (!payload?.exp) return { isPremium: false, tokenTier, daysLeft: 0 };
  const msLeft = payload.exp * 1000 - Date.now();
  return { isPremium: msLeft > 0, tokenTier, daysLeft: Math.max(0, Math.ceil(msLeft / 86_400_000)) };
}

/**
 * Quick client-side check: is there a stored token that hasn't expired?
 * This does NOT verify the signature -- that happens server-side on each API call.
 */
export function hasValidToken(): boolean {
  return describeToken(getToken()).isPremium;
}

/**
 * Returns days remaining until expiration, or 0 if expired/invalid.
 */
export function daysRemaining(): number {
  return describeToken(getToken()).daysLeft;
}

/**
 * Returns the tier from the stored token, or null.
 */
export function getTokenTier(): string | null {
  return describeToken(getToken()).tokenTier;
}

/**
 * Follow the stored token: `listener` runs after every setToken and clearToken (clearTokenIfDead and
 * verifyStoredToken included), in the shape useSyncExternalStore's subscribe takes. Returns the unsubscribe.
 * Without a window nothing is subscribed and the returned function does nothing.
 */
export function subscribeAuth(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(AUTH_EVENT, listener);
  return () => window.removeEventListener(AUTH_EVENT, listener);
}
