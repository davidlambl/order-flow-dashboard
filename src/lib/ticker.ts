// src/lib/ticker.ts
// The client's copy of the ticker rule every function applies (netlify/functions/lib/ticker.ts), so the header refuses
// on submit what the server would refuse with INVALID_TICKER. It is a copy because src/ never imports netlify/: the
// pin in ticker.node.test.js imports the server module and fails when the two patterns or the two parseTickers differ.
// Pure and import-free, so the node test project loads it.

/** 1 to 10 characters: uppercase letters and digits, with '.' or '-' allowed after the first (BRK.B, RDS-A). */
export const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

/** The trimmed, uppercased ticker, or null when it is not one. Any value is accepted: a non-string is invalid. */
export function parseTicker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ticker = raw.trim().toUpperCase();
  return TICKER_RE.test(ticker) ? ticker : null;
}
