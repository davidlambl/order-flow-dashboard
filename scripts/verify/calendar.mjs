// scripts/verify/calendar.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// shared/marketCalendar.js is pure (no fetch, env or wall clock), so nothing is stubbed: every
// instant is passed in explicitly. 2026-09-25 (Fri) is EDT, UTC-4; 2026-11-27 (Fri, the early
// close after Thanksgiving) is EST, UTC-5.
import { readFile } from 'node:fs/promises';

const MODULE_URL = new URL('../../shared/marketCalendar.js', import.meta.url);

// The exported API is frozen: src/ and netlify/ both import these names.
const FUNCTIONS = [
  'getETParts', 'etDateString', 'isWeekend', 'getHolidays', 'getHolidayName', 'isMarketHoliday',
  'isTradingDay', 'getEarlyClose', 'getMarketSession', 'isMarketOpen', 'isOptionsMarketOpen', 'isExpiryClosed',
];
const CONSTANTS = [
  'ET_TIME_ZONE', 'PRE_MARKET_OPEN_MIN', 'EQUITY_OPEN_MIN', 'EQUITY_CLOSE_MIN', 'EARLY_CLOSE_MIN',
  'OPTIONS_CLOSE_OFFSET_MIN', 'POST_MARKET_CLOSE_MIN', 'SPECIAL_CLOSURES',
];
const HOST_GLOBALS = /\b(?:console|process|window|document|navigator|globalThis|fetch|require|localStorage|sessionStorage|Buffer)\b/g;

const YEARS = [2025, 2026, 2027, 2028];
// Every instant the session checks use; the wrappers must agree with getMarketSession at each.
const INSTANTS = [
  '2026-09-25T07:59:00Z', '2026-09-25T08:00:00Z', '2026-09-25T13:29:00Z', '2026-09-25T13:30:00Z',
  '2026-09-25T20:00:00Z', '2026-09-25T20:15:00Z', '2026-09-25T23:59:00Z', '2026-09-26T00:00:00Z',
  '2026-11-27T17:59:00Z', '2026-11-27T18:00:00Z', '2026-11-27T18:15:00Z',
  '2026-07-03T09:00:00Z', '2026-07-03T14:00:00Z', '2026-07-03T21:00:00Z', '2026-09-26T15:00:00Z', '2026-09-27T14:00:00Z',
];

const at = (iso) => new Date(iso);

/** Every 'YYYY-MM-DD' of a year (UTC arithmetic, so the process time zone cannot leak in). */
function daysOf(year) {
  const days = [];
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export default async function run(ctx) {
  const { t, assert } = ctx;
  console.log('calendar');

  let cal = null;
  // Compares only the named fields of getMarketSession(iso); a failure names the instant and both sides.
  const expectSession = (iso, want) => {
    const s = cal.getMarketSession(at(iso));
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, s[k]]));
    assert.deepEqual(got, want, `${iso}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };

  await t('module: frozen export surface; no host globals (console, process, window, fetch, ...) or hour12', async () => {
    cal = await import(MODULE_URL);
    for (const name of FUNCTIONS) assert.equal(typeof cal[name], 'function', `export ${name}`);
    for (const name of CONSTANTS) assert.notEqual(cal[name], undefined, `export ${name}`);
    // Strip comments (keeping string literals, so a '//' inside a string is not taken for one).
    const src = await readFile(MODULE_URL, 'utf8');
    const code = src.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, str) => str ?? '');
    assert.deepEqual(code.match(HOST_GLOBALS), null, 'shared/ must stay pure (Intl, Date, Map only)');
    // hour12 overrides hourCycle, and an h24 clock renders midnight as '24' in some engines.
    assert.doesNotMatch(code, /\bhour12\b/, "the ET formatter must use hourCycle: 'h23', not hour12");
  });
  if (!cal) return; // every later check would only repeat the load failure

  await t('holidays: rule-based, weekend-shifted and special-closure dates are closed', async () => {
    for (const d of [
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
      '2026-11-26', '2026-12-25', '2027-03-26', '2027-06-18', '2027-07-05', '2027-12-24', '2023-01-02', '2025-01-09',
      '2018-12-05',
    ]) {
      assert.equal(cal.isMarketHoliday(d), true, `${d} should be a holiday`);
      assert.equal(typeof cal.getHolidayName(d), 'string', `${d} should have a holiday name`);
    }
  });

  await t('holidays: getHolidays(2025-2028) is exactly the NYSE calendar (no Jan 1 in 2028)', async () => {
    const nyse = {
      2025: '01-01 01-09 01-20 02-17 04-18 05-26 06-19 07-04 09-01 11-27 12-25',
      2026: '01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25',
      2027: '01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24',
      2028: '01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25',
    };
    for (const [year, days] of Object.entries(nyse)) {
      assert.deepEqual([...cal.getHolidays(Number(year)).keys()].sort(), days.split(' ').map((md) => `${year}-${md}`));
    }
  });

  await t('trading days: weekends/holidays closed; Sat New Year, Columbus, Veterans Day, pre-2022 Juneteenth open', async () => {
    for (const d of ['2027-12-31', '2021-12-31', '2022-01-03', '2026-07-02', '2026-10-12', '2026-11-11', '2021-06-18']) {
      assert.equal(cal.isMarketHoliday(d), false, `${d} should not be a holiday`);
      assert.equal(cal.getHolidayName(d), null, `${d} should have no holiday name`);
      assert.equal(cal.isTradingDay(d), true, `${d} should be a trading day`);
    }
    for (const d of ['2026-09-26', '2026-09-27', '2026-07-03', '2026-11-26', '2026-12-25', '2025-01-09']) {
      assert.equal(cal.isTradingDay(d), false, `${d} should not be a trading day`);
    }
    for (const d of ['2026-09-25', '2026-11-27', '2026-12-24']) assert.equal(cal.isTradingDay(d), true, `${d} should be a trading day`);
    assert.deepEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'].map((d) => cal.isWeekend(d)), [false, true, true, false]);
  });

  await t('early close: 1:00 PM on Jul 3 / Dec 24 (Mon-Thu) and the day after Thanksgiving, never on a closed day', async () => {
    for (const d of ['2026-11-27', '2026-12-24', '2025-07-03', '2028-07-03']) {
      assert.equal(cal.getEarlyClose(d)?.closeMin, 780, `${d} should close at 1:00 PM`);
    }
    for (const d of ['2026-07-02', '2027-12-24', '2026-09-25', '2026-07-03']) {
      assert.equal(cal.getEarlyClose(d), null, `${d} should not be an early close`);
    }
    const early = YEARS.flatMap(daysOf).filter((d) => cal.getEarlyClose(d) != null);
    assert.deepEqual(early, ['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
  });

  await t('session (EDT): closed -> pre 4:00 AM -> regular 9:30 -> options-only 4:00-4:15 PM -> post -> closed 8:00 PM', async () => {
    expectSession('2026-09-25T07:59:00Z', { isTradingDay: true, session: 'closed', preMarket: false });
    expectSession('2026-09-25T08:00:00Z', { session: 'pre', preMarket: true, equityOpen: false });
    expectSession('2026-09-25T13:29:00Z', { session: 'pre', preMarket: true, equityOpen: false, optionsOpen: false });
    expectSession('2026-09-25T13:30:00Z', {
      session: 'regular', preMarket: false, equityOpen: true, optionsOpen: true, postMarket: false,
      earlyClose: false, closeMin: 960, optionsCloseMin: 975,
    });
    expectSession('2026-09-25T20:00:00Z', { session: 'post', equityOpen: false, optionsOpen: true, postMarket: true });
    expectSession('2026-09-25T20:15:00Z', { session: 'post', equityOpen: false, optionsOpen: false, postMarket: true });
    expectSession('2026-09-25T23:59:00Z', { session: 'post', postMarket: true });
    expectSession('2026-09-26T00:00:00Z', { date: '2026-09-25', mins: 1200, session: 'closed', postMarket: false, optionsOpen: false });
  });

  await t('session (EST early close): equities stop at 1:00 PM, options at 1:15 PM', async () => {
    const early = { earlyClose: true, closeMin: 780, optionsCloseMin: 795 };
    expectSession('2026-11-27T17:59:00Z', { ...early, session: 'regular', equityOpen: true, optionsOpen: true });
    expectSession('2026-11-27T18:00:00Z', { ...early, session: 'post', equityOpen: false, optionsOpen: true, postMarket: true });
    expectSession('2026-11-27T18:15:00Z', { ...early, session: 'post', equityOpen: false, optionsOpen: false });
  });

  await t('session: holidays and weekends are closed all day; isMarketOpen/isOptionsMarketOpen match the flags', async () => {
    const closed = { isTradingDay: false, session: 'closed', preMarket: false, equityOpen: false, optionsOpen: false, postMarket: false };
    for (const iso of ['2026-07-03T09:00:00Z', '2026-07-03T14:00:00Z', '2026-07-03T21:00:00Z']) expectSession(iso, closed);
    assert.match(String(cal.getMarketSession(at('2026-07-03T14:00:00Z')).holiday), /Independence/);
    expectSession('2026-09-26T15:00:00Z', { ...closed, holiday: null });
    expectSession('2026-09-27T14:00:00Z', { ...closed, holiday: null });
    for (const iso of INSTANTS) {
      const s = cal.getMarketSession(at(iso));
      assert.equal(cal.isMarketOpen(at(iso)), s.equityOpen, `isMarketOpen at ${iso}`);
      assert.equal(cal.isOptionsMarketOpen(at(iso)), s.optionsOpen, `isOptionsMarketOpen at ${iso}`);
    }
  });

  await t('getETParts: the ET date rolls at local midnight (hour 0, never 24) and follows DST', async () => {
    assert.deepEqual(cal.getETParts(at('2026-07-03T04:00:00Z')), {
      date: '2026-07-03', year: 2026, month: 7, day: 3, hour: 0, minute: 0, mins: 0, weekday: 5,
    });
    assert.deepEqual(cal.getETParts(at('2026-07-03T03:59:59Z')), {
      date: '2026-07-02', year: 2026, month: 7, day: 2, hour: 23, minute: 59, mins: 1439, weekday: 4,
    });
    assert.equal(cal.etDateString(at('2026-07-03T04:00:00Z')), '2026-07-03');
    assert.equal(cal.etDateString(at('2026-07-03T03:59:59Z')), '2026-07-02');
    // EST: midnight is 05:00Z; the 9:30 AM open moves from 14:30Z (Fri before DST) to 13:30Z (Mon after).
    assert.equal(cal.etDateString(at('2026-11-27T05:00:00Z')), '2026-11-27');
    assert.equal(cal.etDateString(at('2026-11-27T04:59:00Z')), '2026-11-26');
    assert.equal(cal.getETParts(at('2026-03-06T14:30:00Z')).mins, 570);
    assert.equal(cal.getETParts(at('2026-03-09T13:30:00Z')).mins, 570);
  });

  await t('isExpiryClosed: past dates, and today once options stop (4:15 PM; 1:15 PM on early closes)', async () => {
    for (const [expiry, iso, want] of [
      ['2026-09-25', '2026-09-25T20:14:00Z', false],
      ['2026-09-25', '2026-09-25T20:15:00Z', true],
      ['2026-09-25', '2026-09-25T20:16:00Z', true],
      ['2026-09-24', '2026-09-25T13:00:00Z', true],
      ['2026-10-02', '2026-09-25T13:00:00Z', false],
      ['2026-09-25', '2026-09-25T02:00:00Z', false], // 10 PM ET on Sep 24: the UTC date is already the 25th
      ['2026-11-27', '2026-11-27T18:14:00Z', false],
      ['2026-11-27', '2026-11-27T18:15:00Z', true],
    ]) {
      assert.equal(cal.isExpiryClosed(expiry, at(iso)), want, `isExpiryClosed('${expiry}', ${iso})`);
    }
  });

  await t('robustness: bad dates and Invalid Date degrade safely (impossible dates rejected); getHolidays memoized', async () => {
    assert.equal(cal.isMarketHoliday('not-a-date'), false);
    assert.equal(cal.getHolidayName('2026-13-45'), null);
    assert.equal(cal.isTradingDay(undefined), false);
    assert.equal(cal.getEarlyClose(undefined), null);
    // V8 parses '2026-02-30' as March 2 (other engines: Invalid Date); it must not count as a day at all.
    for (const d of ['2026-02-30', '2026-04-31', '2026-02-29']) {
      assert.equal(cal.isTradingDay(d), false, `${d} is not a real date`);
      assert.equal(cal.isWeekend(d), false, `${d} is not a real date`);
    }
    assert.equal(cal.isTradingDay('2028-02-29'), true, 'a real leap day still trades');
    const holidays2026 = cal.getHolidays(2026);
    assert.ok(holidays2026 instanceof Map);
    assert.equal(cal.getHolidays(2026), holidays2026, 'getHolidays(2026) should return the cached Map');
    assert.equal(cal.getHolidays(Number.NaN).size, 0);
    const invalid = new Date(Number.NaN);
    assert.equal(cal.getETParts(invalid), null);
    assert.equal(cal.etDateString(invalid), null);
    const s = cal.getMarketSession(invalid);
    assert.equal(s.session, 'closed');
    assert.equal(s.date, null);
    assert.equal(cal.isMarketOpen(invalid), false);
    assert.equal(cal.isOptionsMarketOpen(invalid), false);
    assert.equal(cal.isExpiryClosed('2026-09-24', invalid), false, 'unknown clock keeps the data');
    assert.equal(cal.isExpiryClosed('not-a-date', at('2026-09-25T20:16:00Z')), false);
  });

  await t('time-zone independent: fresh copies in a UTC-11 and a UTC+14 process give identical answers', async () => {
    // CI runs in UTC, where a local-time slip (getDay, a date parsed without 'Z') is invisible.
    const answers = (c) => ({
      holidays: YEARS.map((y) => [...c.getHolidays(y).keys()].sort()),
      tradingDays: YEARS.flatMap(daysOf).filter((d) => c.isTradingDay(d)),
      earlyCloses: YEARS.flatMap(daysOf).filter((d) => c.getEarlyClose(d) != null),
      sessions: INSTANTS.map((iso) => c.getMarketSession(at(iso))),
    });
    const expected = answers(cal);
    const originalTZ = process.env.TZ;
    try {
      for (const tz of ['Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        const fresh = await import(`${MODULE_URL.href}?tz=${tz}`); // new instance, so an empty holiday cache
        assert.deepEqual({ tz, ...answers(fresh) }, { tz, ...expected });
      }
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
  });
}
