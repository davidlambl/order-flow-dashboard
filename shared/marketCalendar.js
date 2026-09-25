// shared/marketCalendar.js
//
// US equity / options market calendar in Eastern Time: session windows, NYSE
// holidays, early closes, and the "is this expiry already closed?" question.
//
// This module is shared by the browser (src/) and the Netlify Functions
// (netlify/). It must stay pure: only Intl, Date and Map — no console, process,
// window or fetch — and every time-dependent function takes an injectable `now`
// so callers and tests never depend on the wall clock.

export const ET_TIME_ZONE = 'America/New_York';

export const PRE_MARKET_OPEN_MIN = 240;      // 4:00 AM ET
export const EQUITY_OPEN_MIN = 570;          // 9:30 AM ET
export const EQUITY_CLOSE_MIN = 960;         // 4:00 PM ET
export const EARLY_CLOSE_MIN = 780;          // 1:00 PM ET on early-close days
export const OPTIONS_CLOSE_OFFSET_MIN = 15;  // options trade until 4:15 PM (1:15 PM on early closes)
export const POST_MARKET_CLOSE_MIN = 1200;   // 8:00 PM ET

/** Ad-hoc full-day closures that no rule produces. Add new ones here. */
export const SPECIAL_CLOSURES = Object.freeze({
  '2018-12-05': 'National Day of Mourning (George H. W. Bush)',
  '2025-01-09': 'National Day of Mourning (Jimmy Carter)',
});

const SUNDAY = 0;
const SATURDAY = 6;

// ─── Date-string helpers (all 'YYYY-MM-DD', computed in UTC so no local TZ leaks in) ──

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function toDateStr(year, month, day) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function fromDateStr(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

function dateStrOf(date) {
  return toDateStr(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function addDays(dateStr, days) {
  const d = fromDateStr(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return dateStrOf(d);
}

function weekdayOf(dateStr) {
  return fromDateStr(dateStr).getUTCDay();
}

// Round-trips so impossible dates are rejected on every engine: V8 parses '2026-02-30'
// as March 2 (and '2026-02-29' as Sunday March 1) where others return an Invalid Date.
function isValidDateStr(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = fromDateStr(dateStr);
  return !Number.isNaN(d.getTime()) && dateStrOf(d) === dateStr;
}

/** nth (1-based) occurrence of `weekday` (0 = Sunday) in a month. */
function nthWeekday(year, month, weekday, n) {
  const first = weekdayOf(toDateStr(year, month, 1));
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return toDateStr(year, month, day);
}

function lastWeekday(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekdayOf(toDateStr(year, month, lastDay));
  return toDateStr(year, month, lastDay - ((last - weekday + 7) % 7));
}

/** Easter Sunday (Gregorian), anonymous algorithm. */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toDateStr(year, month, day);
}

/** NYSE observance: Saturday → preceding Friday, Sunday → following Monday. */
function nearestWorkday(dateStr) {
  const wd = weekdayOf(dateStr);
  if (wd === SATURDAY) return addDays(dateStr, -1);
  if (wd === SUNDAY) return addDays(dateStr, 1);
  return dateStr;
}

// ─── Eastern-Time clock ───────────────────────────────────────────────────────

let etFormatter = null;

function formatter() {
  if (!etFormatter) {
    // hourCycle (not hour12) so midnight is '00', never '24'.
    etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return etFormatter;
}

/**
 * The instant `now` expressed in Eastern Time.
 * @returns {{ date: string, year: number, month: number, day: number, hour: number,
 *   minute: number, mins: number, weekday: number } | null}  weekday: 0 = Sunday
 */
export function getETParts(now = new Date()) {
  try {
    const parts = {};
    for (const p of formatter().formatToParts(now)) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour) % 24;
    const minute = Number(parts.minute);
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    const date = toDateStr(year, month, day);
    return { date, year, month, day, hour, minute, mins: hour * 60 + minute, weekday: weekdayOf(date) };
  } catch {
    return null;
  }
}

/** 'YYYY-MM-DD' of `now` in Eastern Time, or null if Intl is unavailable. */
export function etDateString(now = new Date()) {
  return getETParts(now)?.date ?? null;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

export function isWeekend(dateStr) {
  if (!isValidDateStr(dateStr)) return false;
  const wd = weekdayOf(dateStr);
  return wd === SATURDAY || wd === SUNDAY;
}

const holidayCache = new Map();

/**
 * NYSE full-day holidays for a year, as Map<'YYYY-MM-DD', name>.
 * Rules: New Year's Day (Sunday → Monday; a Saturday New Year's is not observed),
 * MLK Day, Presidents' Day, Good Friday, Memorial Day, Juneteenth (from 2022),
 * Independence Day, Labor Day, Thanksgiving, Christmas; Saturday → Friday and
 * Sunday → Monday observance for the fixed-date holidays; plus SPECIAL_CLOSURES.
 */
export function getHolidays(year) {
  if (!Number.isInteger(year)) return new Map();
  if (holidayCache.has(year)) return holidayCache.get(year);
  const h = new Map();
  const add = (dateStr, name) => { if (dateStr) h.set(dateStr, name); };

  const newYear = toDateStr(year, 1, 1);
  const nyWeekday = weekdayOf(newYear);
  if (nyWeekday === SUNDAY) add(addDays(newYear, 1), "New Year's Day (observed)");
  else if (nyWeekday !== SATURDAY) add(newYear, "New Year's Day");

  add(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  add(nthWeekday(year, 2, 1, 3), "Presidents' Day");
  add(addDays(easterSunday(year), -2), 'Good Friday');
  add(lastWeekday(year, 5, 1), 'Memorial Day');
  if (year >= 2022) add(nearestWorkday(toDateStr(year, 6, 19)), 'Juneteenth');
  add(nearestWorkday(toDateStr(year, 7, 4)), 'Independence Day');
  add(nthWeekday(year, 9, 1, 1), 'Labor Day');
  add(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  add(nearestWorkday(toDateStr(year, 12, 25)), 'Christmas Day');

  for (const [date, name] of Object.entries(SPECIAL_CLOSURES)) {
    if (date.startsWith(`${pad(year, 4)}-`)) add(date, name);
  }

  holidayCache.set(year, h);
  return h;
}

/** Holiday name for a date, or null. */
export function getHolidayName(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  return getHolidays(Number(dateStr.slice(0, 4))).get(dateStr) ?? null;
}

export function isMarketHoliday(dateStr) {
  return getHolidayName(dateStr) != null;
}

export function isTradingDay(dateStr) {
  return isValidDateStr(dateStr) && !isWeekend(dateStr) && !isMarketHoliday(dateStr);
}

/**
 * Early close (1:00 PM equities, 1:15 PM options) on the day before Independence
 * Day when it is Mon–Thu, the Friday after Thanksgiving, and Christmas Eve when it
 * is Mon–Thu. Never on a non-trading day.
 * @returns {{ closeMin: number, reason: string } | null}
 */
export function getEarlyClose(dateStr) {
  if (!isTradingDay(dateStr)) return null;
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  const wd = weekdayOf(dateStr);
  const monToThu = wd >= 1 && wd <= 4;
  if (month === 7 && day === 3 && monToThu) return { closeMin: EARLY_CLOSE_MIN, reason: 'Day before Independence Day' };
  if (month === 12 && day === 24 && monToThu) return { closeMin: EARLY_CLOSE_MIN, reason: 'Christmas Eve' };
  if (month === 11 && wd === 5 && dateStr === addDays(nthWeekday(year, 11, 4, 4), 1)) {
    return { closeMin: EARLY_CLOSE_MIN, reason: 'Day after Thanksgiving' };
  }
  return null;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const CLOSED_SESSION = Object.freeze({
  date: null,
  weekday: null,
  mins: null,
  isTradingDay: false,
  holiday: null,
  earlyClose: false,
  openMin: EQUITY_OPEN_MIN,
  closeMin: EQUITY_CLOSE_MIN,
  optionsCloseMin: EQUITY_CLOSE_MIN + OPTIONS_CLOSE_OFFSET_MIN,
  preMarket: false,
  equityOpen: false,
  optionsOpen: false,
  postMarket: false,
  session: 'closed',
});

/**
 * Where the market is at instant `now` (Eastern Time). Between the equity close
 * and the options close, `equityOpen` is false while `optionsOpen` is still true.
 * If the ET clock is unavailable everything reports closed with `date: null`.
 */
export function getMarketSession(now = new Date()) {
  const parts = getETParts(now);
  if (!parts) return CLOSED_SESSION;
  const { date, weekday, mins } = parts;
  const holiday = getHolidayName(date);
  const tradingDay = !isWeekend(date) && holiday == null;
  const early = tradingDay ? getEarlyClose(date) : null;
  const closeMin = early ? early.closeMin : EQUITY_CLOSE_MIN;
  const optionsCloseMin = closeMin + OPTIONS_CLOSE_OFFSET_MIN;
  const preMarket = tradingDay && mins >= PRE_MARKET_OPEN_MIN && mins < EQUITY_OPEN_MIN;
  const equityOpen = tradingDay && mins >= EQUITY_OPEN_MIN && mins < closeMin;
  const optionsOpen = tradingDay && mins >= EQUITY_OPEN_MIN && mins < optionsCloseMin;
  const postMarket = tradingDay && mins >= closeMin && mins < POST_MARKET_CLOSE_MIN;
  const session = equityOpen ? 'regular' : preMarket ? 'pre' : postMarket ? 'post' : 'closed';
  return {
    date,
    weekday,
    mins,
    isTradingDay: tradingDay,
    holiday,
    earlyClose: early != null,
    openMin: EQUITY_OPEN_MIN,
    closeMin,
    optionsCloseMin,
    preMarket,
    equityOpen,
    optionsOpen,
    postMarket,
    session,
  };
}

/** Regular equity session open (9:30 AM – 4:00 PM ET, 1:00 PM on early closes; never on holidays/weekends). */
export function isMarketOpen(now = new Date()) {
  return getMarketSession(now).equityOpen;
}

/** Options session open (9:30 AM – 4:15 PM ET, 1:15 PM on early closes). */
export function isOptionsMarketOpen(now = new Date()) {
  return getMarketSession(now).optionsOpen;
}

/**
 * True once an expiry can no longer trade: the date is in the past (ET), or it is
 * today and the options session has ended. Unknown clock → false (keep the data).
 */
export function isExpiryClosed(expiryDateStr, now = new Date()) {
  if (!isValidDateStr(expiryDateStr)) return false;
  const s = getMarketSession(now);
  if (!s.date) return false;
  return expiryDateStr < s.date || (expiryDateStr === s.date && s.mins >= s.optionsCloseMin);
}
