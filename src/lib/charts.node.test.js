// src/lib/charts.node.test.js — chart helpers: time-zone-safe date labels (F16), mock flow dates, GEX axis ticks and
// reference levels (F14). Every input is fixed except the mock flow history, which by design covers the 30 days
// ending today; that test reads "today" from the same process clock, in the same zone: never fake timers here.
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as format from './format.js';
import * as mock from './mockData.js';
import * as gex from './gexChartHelpers.js';

// What inZone loads a fresh copy of.
const importFormat = () => import('./format.js');
const importMock = () => import('./mockData.js');

// CI runs in UTC, where a local-vs-UTC date slip is invisible. US zones show a date-only string
// a day early. Pago Pago (UTC-11) and Kiritimati (UTC+14) straddle the date line: at any hour at
// least one of them has a local date different from the UTC date, so a row labelled with the
// UTC date (the old toISOString() mock) fails in one of the two whenever the check runs.
const LABEL_ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Pacific/Kiritimati'];
const FAR_ZONES = ['Pacific/Pago_Pago', 'Pacific/Kiritimati'];

/**
 * Runs `fn(module)` with process.env.TZ = `tz` and a fresh copy of the module `importer` loads
 * (vi.resetModules() first, so the import makes a new instance), restoring TZ afterwards.
 */
async function inZone(tz, importer, fn) {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = tz;
    vi.resetModules();
    return await fn(await importer());
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
}

/** 'YYYY-MM-DD' as UTC midnight: UTC arithmetic, so the process time zone cannot leak in. */
function utcDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const isWeekend = (day) => day.getUTCDay() === 0 || day.getUTCDay() === 6;

/** The latest Monday-Friday on or before `iso`. */
function latestWeekdayOnOrBefore(iso) {
  const day = utcDay(iso);
  while (isWeekend(day)) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** The first Monday-Friday after `iso`. */
function nextWeekday(iso) {
  const day = utcDay(iso);
  do day.setUTCDate(day.getUTCDate() + 1); while (isWeekend(day));
  return day.toISOString().slice(0, 10);
}

const increasing = (xs) => xs.every((v, i) => i === 0 || xs[i - 1] < v);

describe('charts', () => {
  it('modules load in Node (no DOM): format, mockData and gexChartHelpers exports', async () => {
    for (const [mod, name] of [
      [format, 'formatShortDate'], [format, 'toLocalISODate'], [mock, 'generateMockData'],
      [gex, 'gexAxisTicks'], [gex, 'referenceLevels'],
    ]) {
      assert.equal(typeof mod[name], 'function', `export ${name}`);
    }
  });

  it('formatShortDate: M/D read from the digits, identical in UTC, New York, Los Angeles and Kiritimati', async () => {
    for (const tz of LABEL_ZONES) {
      await inZone(tz, importFormat, ({ formatShortDate }) => {
        assert.equal(formatShortDate('2026-03-12'), '3/12', tz);
        assert.equal(formatShortDate('2026-09-01'), '9/1', `${tz}: no leading zeros`);
        assert.equal(formatShortDate('2026-09-25T20:00:00Z'), '9/25', `${tz}: the date as written`);
        assert.equal(formatShortDate(null), '', tz);
        assert.equal(formatShortDate(undefined), '', tz);
        assert.equal(formatShortDate('n/a'), 'n/a', `${tz}: anything else is returned as-is`);
      });
    }
  });

  it('F16 bug class: in Los Angeles new Date("2026-03-12") is Mar 11 locally; formatShortDate still says 3/12', async () => {
    await inZone('America/Los_Angeles', importFormat, ({ formatShortDate }) => {
      const parsed = new Date('2026-03-12'); // a date-only ISO string parses as UTC midnight
      assert.equal(parsed.getDate(), 11, 'what the old tickFormatter read');
      assert.equal(`${parsed.getMonth() + 1}/${parsed.getDate()}`, '3/11');
      assert.equal(formatShortDate('2026-03-12'), '3/12');
    });
  });

  it('toLocalISODate: the local calendar date, zero-padded, in any zone; invalid -> ""', async () => {
    for (const tz of FAR_ZONES) {
      await inZone(tz, importFormat, ({ toLocalISODate }) => {
        assert.equal(toLocalISODate(new Date(2026, 8, 5)), '2026-09-05', `${tz}: local constructor`);
        assert.equal(toLocalISODate(new Date(Number.NaN)), '', tz);
        assert.equal(toLocalISODate(null), '', tz);
        assert.equal(toLocalISODate('2026-09-05'), '', `${tz}: not a Date`);
      });
    }
    // Why not toISOString(): in a UTC+14 process, local midnight is still the previous day in UTC.
    await inZone('Pacific/Kiritimati', importFormat, ({ toLocalISODate }) => {
      const local = new Date(2026, 8, 5);
      assert.equal(local.toISOString().slice(0, 10), '2026-09-04');
      assert.equal(toLocalISODate(local), '2026-09-05');
    });
  });

  it('mock flow history (UTC-11, UTC+14): weekday YYYY-MM-DD labels, consecutive, ending on the latest weekday <= local today', async () => {
    const realRandom = Math.random;
    Math.random = () => 0.5; // generateMockData is random; its dates must not depend on it
    try {
      for (const tz of FAR_ZONES) {
        await inZone(tz, importMock, async ({ generateMockData }) => {
          const { toLocalISODate } = await import('./format.js');
          // "Today" is read on both sides of the call, so a local midnight in between cannot flake it.
          const before = toLocalISODate(new Date());
          const dates = generateMockData('AVGO').flowHistory.map((row) => row.date);
          const after = toLocalISODate(new Date());

          assert.ok(dates.length >= 20 && dates.length <= 22, `${tz}: ${dates.length} weekdays in 30 calendar days`);
          for (const d of dates) {
            assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `${tz}: ${d}`);
            assert.ok(!isWeekend(utcDay(d)), `${tz}: ${d} is a weekend day`);
          }
          assert.ok(increasing(dates), `${tz}: dates not strictly increasing: ${dates.join(' ')}`);
          for (let i = 1; i < dates.length; i++) {
            assert.equal(dates[i], nextWeekday(dates[i - 1]), `${tz}: weekday skipped or repeated after ${dates[i - 1]}`);
          }
          const last = dates[dates.length - 1];
          const want = [latestWeekdayOnOrBefore(before), latestWeekdayOnOrBefore(after)];
          assert.ok(want.includes(last), `${tz}: last row ${last}, want ${want[0]} (local today ${before})`);
        });
      }
    } finally {
      Math.random = realRandom;
    }
  });

  it('gexAxisTicks: at most 8 real strikes, both ends kept, sorted, deduplicated, spread evenly by price', async () => {
    const { gexAxisTicks } = gex;

    const nine = [100, 102.5, 105, 110, 115, 117.5, 120, 125, 130];
    const t9 = gexAxisTicks(nine);
    assert.ok(t9.length <= 8, `9 strikes -> ${t9.length} ticks`);
    assert.deepEqual([t9[0], t9.at(-1)], [100, 130], 'both ends');
    assert.ok(increasing(t9) && t9.every((v) => nine.includes(v)), JSON.stringify(t9));

    // 40 strikes: $5 apart on the wings, $2.50 near the money, given out of order.
    const forty = [
      ...Array.from({ length: 10 }, (_, i) => 100 + 5 * i), // 100 .. 145
      ...Array.from({ length: 20 }, (_, i) => 150 + 2.5 * i), // 150 .. 197.5
      ...Array.from({ length: 10 }, (_, i) => 200 + 5 * i), // 200 .. 245
    ];
    const t40 = gexAxisTicks([...forty].reverse());
    assert.ok(t40.length >= 2 && t40.length <= 8, `40 strikes -> ${t40.length} ticks`);
    assert.ok(increasing(t40), `not strictly increasing: ${JSON.stringify(t40)}`);
    assert.ok(t40.every((v) => forty.includes(v)), `not a subset of the strikes: ${JSON.stringify(t40)}`);
    assert.deepEqual([t40[0], t40.at(-1)], [100, 245], 'both ends');
    // On a numeric axis the ticks should be even along the price scale (index thinning gives gaps of 30 vs 12.5 here).
    const gaps = t40.slice(1).map((v, i) => v - t40[i]);
    assert.ok(Math.max(...gaps) <= 1.5 * Math.min(...gaps), `uneven tick gaps ${JSON.stringify(gaps)}`);

    assert.deepEqual(gexAxisTicks(['100', 100, 105]), [100, 105], 'numeric strings coerced, duplicates dropped');
    assert.deepEqual(gexAxisTicks([null, '', 'abc', Number.NaN, Infinity, 100]), [100], 'null and blank are not strike 0');
    assert.deepEqual(gexAxisTicks([110, 100, 105]), [100, 105, 110], 'few strikes: all of them, sorted');
    assert.deepEqual(gexAxisTicks([]), []);
    assert.deepEqual(gexAxisTicks(null), []);
    assert.deepEqual(gexAxisTicks([100, 105, 110, 115, 120], 3), [100, 110, 120], 'first, middle, last');
  });

  it('referenceLevels: exact prices in spot/basis/sma50/sma200 order; visible only within the strike range', async () => {
    const { referenceLevels } = gex;
    const strikes = [172.5, 175, 177.5, 180, 182.5, 185, 190, 195, 200];

    assert.deepEqual(referenceLevels({ costBasis: 150 }, strikes), [{ key: 'basis', value: 150, visible: false }], 'below the lowest strike');
    assert.deepEqual(referenceLevels({ spotPrice: 181 }, strikes), [{ key: 'spot', value: 181, visible: true }], 'between strikes, not snapped');
    for (const costBasis of [0, null, undefined, 'abc', '', -5]) {
      assert.deepEqual(referenceLevels({ costBasis }, strikes), [], `costBasis ${JSON.stringify(costBasis)} draws no level`);
    }
    assert.deepEqual(referenceLevels({ sma50: 178, showMAs: false }, strikes), [], 'MAs hidden');
    assert.deepEqual(referenceLevels({ sma50: 178, showMAs: true }, strikes), [{ key: 'sma50', value: 178, visible: true }]);
    assert.deepEqual(referenceLevels({ sma50: 178 }, strikes), [{ key: 'sma50', value: 178, visible: true }], 'MAs shown by default');
    assert.deepEqual(
      referenceLevels({ sma200: '210.5', sma50: 178, costBasis: '150', spotPrice: '181' }, strikes),
      [
        { key: 'spot', value: 181, visible: true },
        { key: 'basis', value: 150, visible: false },
        { key: 'sma50', value: 178, visible: true },
        { key: 'sma200', value: 210.5, visible: false },
      ],
      'fixed order whatever the argument order; numeric strings coerced',
    );
    assert.deepEqual(referenceLevels({ spotPrice: 172.5, costBasis: 200 }, strikes).map((l) => l.visible), [true, true], 'range ends are inclusive');
    assert.deepEqual(referenceLevels({ spotPrice: 181 }, []), [{ key: 'spot', value: 181, visible: false }], 'no strikes: nothing is on the chart');
  });
});
