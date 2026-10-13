// src/lib/format.test.js — the number and date formatters behind the KPI cards, tables, charts and research panel.
import { describe, expect, it } from 'vitest';
import {
  daysUntil, formatCompact, formatDollar, formatDollarFull, formatPct, formatPrice, formatRatio, formatShortDate,
  timeAgo, toLocalISODate,
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

describe('timeAgo', () => {
  const NOW = Date.UTC(2026, 9, 13, 12);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // An ISO datetime `ms` before NOW, as the news items carry it.
  const before = (ms) => new Date(NOW - ms).toISOString();

  it('counts whole minutes under an hour, rounded down', () => {
    expect(timeAgo(before(30 * MINUTE), NOW)).toBe('30m ago');
    expect(timeAgo(before(59 * MINUTE + 30_000), NOW)).toBe('59m ago');
  });

  it('switches to whole hours at an hour and to whole days at a day, rounded down', () => {
    expect(timeAgo(before(60 * MINUTE), NOW)).toBe('1h ago');
    expect(timeAgo(before(23 * HOUR + 59 * MINUTE), NOW)).toBe('23h ago');
    expect(timeAgo(before(DAY), NOW)).toBe('1d ago');
    expect(timeAgo(before(10 * DAY), NOW)).toBe('10d ago');
  });

  it('reads a datetime after now (clock skew) as 0m ago, never a negative age', () => {
    expect(timeAgo(before(-30_000), NOW)).toBe('0m ago');
  });

  it.each([null, undefined, '', 'garbage'])('returns an empty string for %o', (value) => {
    expect(timeAgo(value, NOW)).toBe('');
  });
});

describe('daysUntil', () => {
  // Local noon on 2026-10-13: the count runs from now's local date.
  const NOW = new Date(2026, 9, 13, 12).getTime();

  // Runs fn with the process in time zone `tz` (Node applies a TZ assignment at once), restoring it afterwards.
  function inZone(tz, fn) {
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = tz;
      fn();
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
  }

  it('counts calendar days to the date: 0 today, 1 tomorrow, 7 a week out', () => {
    expect(daysUntil('2026-10-13', NOW)).toBe(0);
    expect(daysUntil('2026-10-14', NOW)).toBe(1);
    expect(daysUntil('2026-10-20', NOW)).toBe(7);
  });

  it('counts from midnight, whatever the hour of now', () => {
    expect(daysUntil('2026-10-14', new Date(2026, 9, 13, 0, 1).getTime())).toBe(1);
    expect(daysUntil('2026-10-14', new Date(2026, 9, 13, 23, 59).getTime())).toBe(1);
  });

  it('goes negative once the date has passed', () => {
    expect(daysUntil('2026-10-12', NOW)).toBe(-1);
    expect(daysUntil('2025-10-13', NOW)).toBe(-365);
  });

  it('counts the 23- and 25-hour days of a DST change as whole days', () => {
    // CI runs in UTC, which has no DST. New York springs forward on 2026-03-08, so the two midnights are 47 hours
    // apart and only the rounding makes them 2 days; it falls back on 2026-11-01, a 25-hour day that only the
    // rounding keeps at one (a ceiling would read 2). Both halves are pins on the inline formula too.
    inZone('America/New_York', () => {
      expect(new Date(2026, 2, 9) - new Date(2026, 2, 7)).toBe(47 * 3_600_000);
      expect(daysUntil('2026-03-09', new Date(2026, 2, 7, 12).getTime())).toBe(2);
      expect(new Date(2026, 10, 2) - new Date(2026, 10, 1)).toBe(25 * 3_600_000);
      expect(daysUntil('2026-11-02', new Date(2026, 10, 1, 12).getTime())).toBe(1);
    });
  });

  it('reads the date as local midnight, not UTC midnight', () => {
    // At UTC+14 the UTC midnight of 2026-10-14 is 14:00 local, which would round tomorrow up to 2 days.
    inZone('Pacific/Kiritimati', () => {
      expect(daysUntil('2026-10-14', new Date(2026, 9, 13, 12).getTime())).toBe(1);
    });
  });

  it.each([null, undefined, '', 'garbage'])('returns null for %o', (value) => {
    expect(daysUntil(value, NOW)).toBeNull();
  });

  it('returns null for a datetime, which is not a calendar date', () => {
    expect(daysUntil('2026-10-13T12:00:00Z', NOW)).toBeNull();
  });
});
