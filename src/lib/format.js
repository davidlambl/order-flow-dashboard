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
