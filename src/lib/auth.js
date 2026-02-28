// src/lib/auth.js
// Client-side token management for premium feature gating.

const TOKEN_KEY = 'access_token';
const FUNCTION_BASE = '/.netlify/functions';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
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
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload;
  } catch {
    return null;
  }
}

/**
 * Returns { valid, tier, expiresAt } or { valid: false, error }.
 * Makes a server round-trip to cryptographically verify the token.
 */
export async function validateToken(token) {
  const res = await fetch(`${FUNCTION_BASE}/validateToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { valid: false, error: body?.error || `Server error (${res.status})` };
  }
  return res.json();
}

/**
 * Quick client-side check: is there a stored token that hasn't expired?
 * This does NOT verify the signature -- that happens server-side on each API call.
 */
export function hasValidToken() {
  const token = getToken();
  if (!token) return false;
  const payload = decodeTokenPayload(token);
  if (!payload?.exp) return false;
  return payload.exp * 1000 > Date.now();
}

/**
 * Returns days remaining until expiration, or 0 if expired/invalid.
 */
export function daysRemaining() {
  const token = getToken();
  const payload = decodeTokenPayload(token);
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
