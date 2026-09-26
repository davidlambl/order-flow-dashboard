// src/lib/format.test.js — the number and date formatters behind the KPI cards, tables and chart labels.
import { describe, expect, it } from 'vitest';
import {
  formatCompact, formatDollar, formatDollarFull, formatPct, formatPrice, formatRatio, formatShortDate, toLocalISODate,
} from './format.js';

// What every numeric formatter shows for a value it cannot format.
const DASH = '—';
const UNFORMATTABLE = [null, undefined, NaN, 'abc', Infinity, -Infinity];

describe('formatDollar', () => {
  it('shows dollars and cents below $1,000', () => {
    expect(formatDollar(0)).toBe('$0.00');
    expect(formatDollar(999)).toBe('$999.00');
    expect(formatDollar(999.994)).toBe('$999.99');
  });

  it('switches to K at $1,000 (one decimal), M at $1,000,000 and B at $1,000,000,000 (two decimals)', () => {
    expect(formatDollar(1000)).toBe('$1.0K');
    expect(formatDollar(1500)).toBe('$1.5K');
    expect(formatDollar(1_000_000)).toBe('$1.00M');
    expect(formatDollar(2_500_000)).toBe('$2.50M');
    expect(formatDollar(1_000_000_000)).toBe('$1.00B');
    expect(formatDollar(12_500_000_000)).toBe('$12.50B');
  });

  it('puts the minus sign before the dollar sign', () => {
    expect(formatDollar(-345_000)).toBe('-$345.0K');
    expect(formatDollar(-42.5)).toBe('-$42.50');
  });

  it('formats a numeric string like the number', () => {
    expect(formatDollar('1500')).toBe('$1.5K');
  });

  it.each(UNFORMATTABLE)('shows a dash for %s', (value) => {
    expect(formatDollar(value)).toBe(DASH);
  });
});

describe('formatDollarFull', () => {
  it('rounds to whole dollars with thousands separators', () => {
    expect(formatDollarFull(0)).toBe('$0');
    expect(formatDollarFull(1234.4)).toBe('$1,234');
    expect(formatDollarFull(1234.5)).toBe('$1,235');
    expect(formatDollarFull(1_000_000)).toBe('$1,000,000');
  });

  it('puts the minus sign before the dollar sign', () => {
    expect(formatDollarFull(-1234.6)).toBe('-$1,235');
  });

  it('formats a numeric string like the number', () => {
    expect(formatDollarFull('1000')).toBe('$1,000');
  });

  it.each(UNFORMATTABLE)('shows a dash for %s', (value) => {
    expect(formatDollarFull(value)).toBe(DASH);
  });
});

describe('formatPct', () => {
  it('shows one decimal and a percent sign', () => {
    expect(formatPct(12.34)).toBe('12.3%');
    expect(formatPct(5)).toBe('5.0%');
    expect(formatPct(0)).toBe('0.0%');
    expect(formatPct(-2.5)).toBe('-2.5%');
    expect(formatPct('7')).toBe('7.0%');
  });

  it.each(UNFORMATTABLE)('shows a dash for %s', (value) => {
    expect(formatPct(value)).toBe(DASH);
  });
});

describe('formatRatio', () => {
  it('shows two decimals', () => {
    expect(formatRatio(1.234)).toBe('1.23');
    expect(formatRatio(0.5)).toBe('0.50');
    expect(formatRatio(-0.756)).toBe('-0.76');
    expect(formatRatio('2')).toBe('2.00');
  });

  it.each(UNFORMATTABLE)('shows a dash for %s', (value) => {
    expect(formatRatio(value)).toBe(DASH);
  });
});

describe('formatCompact', () => {
  it('rounds a value below 1,000 to a whole number', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(12.4)).toBe('12');
    expect(formatCompact(950)).toBe('950');
  });

  it('switches to K, M and B with one decimal and no currency sign', () => {
    expect(formatCompact(1500)).toBe('1.5K');
    expect(formatCompact(2_500_000)).toBe('2.5M');
    expect(formatCompact(3_000_000_000)).toBe('3.0B');
  });

  it('keeps the sign and accepts a numeric string', () => {
    expect(formatCompact(-1500)).toBe('-1.5K');
    expect(formatCompact('4200')).toBe('4.2K');
  });

  it.each(UNFORMATTABLE)('shows a dash for %s', (value) => {
    expect(formatCompact(value)).toBe(DASH);
  });
});

describe('formatPrice', () => {
  it('shows dollars and cents', () => {
    expect(formatPrice(0)).toBe('$0.00');
    expect(formatPrice(3.5)).toBe('$3.50');
  });

  it('puts the minus sign before the dollar sign (-$3.50, not $-3.50: #19)', () => {
    expect(formatPrice(-3.5)).toBe('-$3.50');
  });

  it('formats a numeric string like the number', () => {
    expect(formatPrice('42.1')).toBe('$42.10');
  });

  it.each(UNFORMATTABLE)('shows a dash for %s', (value) => {
    expect(formatPrice(value)).toBe(DASH);
  });
});

describe('formatShortDate', () => {
  it('reads M/D from the digits, without leading zeros', () => {
    expect(formatShortDate('2026-03-12')).toBe('3/12');
    expect(formatShortDate('2026-01-05')).toBe('1/5');
  });

  it('keeps the date as written when a time follows (no time-zone shift)', () => {
    expect(formatShortDate('2026-09-25T20:00:00Z')).toBe('9/25');
  });

  it('returns an empty string for null and undefined', () => {
    expect(formatShortDate(null)).toBe('');
    expect(formatShortDate(undefined)).toBe('');
  });

  it('returns any other value unchanged', () => {
    expect(formatShortDate('not a date')).toBe('not a date');
    expect(formatShortDate(42)).toBe(42);
  });
});

describe('toLocalISODate', () => {
  it('gives the local calendar date, zero-padded', () => {
    expect(toLocalISODate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toLocalISODate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    expect(toLocalISODate(new Date(999, 0, 1))).toBe('0999-01-01');
  });

  it('returns an empty string for an invalid date or anything that is not a Date', () => {
    expect(toLocalISODate(new Date('not a date'))).toBe('');
    expect(toLocalISODate('2026-01-05')).toBe('');
    expect(toLocalISODate(Date.UTC(2026, 0, 5))).toBe('');
    expect(toLocalISODate(null)).toBe('');
  });
});
