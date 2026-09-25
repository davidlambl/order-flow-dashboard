// netlify/functions/lib/ticker.js
// One ticker validator shared by every function that interpolates a symbol
// into an upstream URL or uses it as a database key.

// 1–10 chars: uppercase letters/digits, with optional '.' or '-' after the first
// (BRK.B, RDS-A). Anything else is rejected before it reaches a provider.
export const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

/**
 * Normalize and validate a raw ticker string.
 * @returns {string|null} the uppercased ticker, or null if invalid/missing
 */
export function parseTicker(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}
