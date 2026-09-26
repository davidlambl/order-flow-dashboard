// src/lib/auth.ts
// Client-side token management for premium feature gating.
//
// The stored token is only *decoded* here (to show tier / days left). Whether it
// is actually valid is decided by the server: at startup via verifyStoredToken()
// and on every API call. Any change to the stored token dispatches AUTH_EVENT so
// UI state can follow.

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

/**
 * Quick client-side check: is there a stored token that hasn't expired?
 * This does NOT verify the signature -- that happens server-side on each API call.
 */
export function hasValidToken(): boolean {
  const payload = decodeTokenPayload(getToken());
  if (!payload?.exp) return false;
  return payload.exp * 1000 > Date.now();
}

/**
 * Returns days remaining until expiration, or 0 if expired/invalid.
 */
export function daysRemaining(): number {
  const payload = decodeTokenPayload(getToken());
  if (!payload?.exp) return 0;
  const ms = payload.exp * 1000 - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Returns the tier from the stored token, or null.
 */
export function getTokenTier(): string | null {
  const payload = decodeTokenPayload(getToken());
  return payload?.tier || null;
}
