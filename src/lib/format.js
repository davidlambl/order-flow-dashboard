// src/lib/format.js
// Number formatting utilities for financial data.

/**
 * Format a dollar value compactly: $1.2M, -$345K, $12.5B
 */
export function formatDollar(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format a dollar value with full precision and commas.
 */
export function formatDollarFull(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Format a percentage with one decimal.
 */
export function formatPct(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

/**
 * Format a ratio to two decimals.
 */
export function formatRatio(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

/**
 * Format a price.
 */
export function formatPrice(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/**
 * Format large numbers compactly: 1.2M, 345K, etc.
 */
export function formatCompact(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

/**
 * Short chart label for a calendar date: `'2026-03-12'` → `'3/12'` (no leading zeros).
 * Read from the digits, never through `Date`: `new Date('YYYY-MM-DD')` is UTC midnight,
 * which local getters show as the previous day anywhere west of Greenwich.
 *
 * @param {string|null|undefined} isoDate - `'YYYY-MM-DD'`, optionally followed by a time
 *   (`'2026-09-25T20:00:00Z'` → `'9/25'`, the date as written)
 * @returns {string} `'M/D'`; `''` for null/undefined; any other value is returned as-is
 */
export function formatShortDate(isoDate) {
  if (isoDate == null) return '';
  const match = typeof isoDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate) : null;
  if (!match) return isoDate;
  return `${Number(match[2])}/${Number(match[3])}`;
}

/**
 * The viewer's local calendar date as `'YYYY-MM-DD'`. Unlike `date.toISOString()`, which
 * gives the UTC date (a day off near midnight in far time zones), this matches `getDay()`.
 *
 * @param {Date} date
 * @returns {string} zero-padded `'YYYY-MM-DD'`; `''` for an invalid date or a non-Date
 */
export function toLocalISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const pad = (n, width) => String(n).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}
