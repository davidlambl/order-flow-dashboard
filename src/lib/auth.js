// src/lib/auth.js
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
const DEAD_TOKEN_CODES = new Set(['TOKEN_EXPIRED', 'TOKEN_INVALID', 'TOKEN_REVOKED']);

function notify() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_EVENT));
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (e) {
    console.warn('setToken: localStorage write failed', e);
  }
  notify();
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
  notify();
}

/**
 * Drop the stored token if the server said it is dead. Returns true if cleared.
 */
export function clearTokenIfDead(code) {
  if (!DEAD_TOKEN_CODES.has(code)) return false;
  if (getToken()) clearToken();
  return true;
}

export function getAuthHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Decode the JWT payload without verification (server handles that).
 * Returns null if the token is malformed.
 */
export function decodeTokenPayload(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/**
 * Returns { valid, tier, expiresAt } or { valid: false, error, code }.
 * Makes a server round-trip to cryptographically verify the token.
 */
export async function validateToken(token) {
  const res = await fetch(`${FUNCTION_BASE}/validateToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { valid: false, error: body?.error || `Server error (${res.status})`, code: body?.code || null };
  }
  return body;
}

/**
 * Startup check: verify the stored token with the server and clear it if the
 * server rejects it (expired, revoked, re-signed secret). Network failures keep
 * the token so an offline reload doesn't log the user out.
 * @returns {Promise<'valid'|'cleared'|'none'|'unknown'>}
 */
export async function verifyStoredToken() {
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
export function hasValidToken() {
  const payload = decodeTokenPayload(getToken());
  if (!payload?.exp) return false;
  return payload.exp * 1000 > Date.now();
}

/**
 * Returns days remaining until expiration, or 0 if expired/invalid.
 */
export function daysRemaining() {
  const payload = decodeTokenPayload(getToken());
  if (!payload?.exp) return 0;
  const ms = payload.exp * 1000 - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Returns the tier from the stored token, or null.
 */
export function getTokenTier() {
  const payload = decodeTokenPayload(getToken());
  return payload?.tier || null;
}
