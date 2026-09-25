// netlify/functions/collectFlowHistory.js
//
// Scheduled function: snapshots each tracked ticker's options flow into the Supabase
// flow_history table, one row per ticker per trading day (UNIQUE (date, ticker)).
//
// When: Mon–Fri at 21:30 UTC = 4:30 PM EST / 5:30 PM EDT, after the 4:15 PM ET options
// close in both DST regimes.
// Date: rows are keyed by the Eastern-Time trading date of the run, never the UTC or
// server-local date. Weekends and NYSE holidays are skipped via shared/marketCalendar.js:
// on a weekday holiday CBOE re-serves the previous session, and storing it again would
// count that session's net premium into cum_premium twice.
// Budget: Netlify scheduled functions are killed after 30 s, so the run gets a
// COLLECTION_BUDGET_MS (24 s) deadline. Tickers run DEFAULT_CONCURRENCY at a time, each
// CBOE fetch is capped at 8 s and aborted when the deadline passes, and every row is
// upserted as soon as its ticker is done: a slow run loses only its unfinished tickers.
// Window: metrics use normalizeChain's expiry window (past expiries dropped, the 6 nearest
// kept), the same one getMarketData measures the dashboard on, so history and the live
// panel agree.
// cum_premium: the previous row's cum_premium + today's net premium. If that row cannot
// be read the ticker is skipped rather than restarting its running total from 0. A
// re-run on the same date recomputes from the prior day and overwrites the row.
// Tickers: TRACKED_TICKERS (comma-separated), else DEFAULT_TRACKED_TICKERS.

import { schedule } from '@netlify/functions';
import pLimit from 'p-limit';
import { getSupabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchCBOE, normalizeChain, computeNetPremium, computePutCallRatio } from './lib/marketDataHelpers.js';
import { isTimeoutError } from './lib/http.js';
import { parseTicker } from './lib/ticker.js';
import { etDateString, isTradingDay } from '../../shared/marketCalendar.js';

/** User positions + major indices/ETFs. Override with the TRACKED_TICKERS env var. */
export const DEFAULT_TRACKED_TICKERS = Object.freeze([
  'AVGO', 'NVDA', 'AAPL', 'TSLA', 'MSFT',
  'META', 'AMZN', 'GOOGL', 'AMD',
  'SPY', 'QQQ',
]);
export const DEFAULT_CONCURRENCY = 3;
export const COLLECTION_BUDGET_MS = 24_000; // Netlify scheduled functions are limited to 30 s

/**
 * Parse a comma-separated ticker list such as TRACKED_TICKERS. Each entry is trimmed and
 * validated by parseTicker; invalid entries are dropped and duplicates removed (first
 * occurrence wins). Nothing valid (or no string at all) → `fallback`.
 * @returns {readonly string[]}
 */
export function parseTrackedTickers(raw, fallback = DEFAULT_TRACKED_TICKERS) {
  if (typeof raw !== 'string') return fallback;
  const tickers = new Set();
  for (const entry of raw.split(',')) {
    const ticker = parseTicker(entry);
    if (ticker) tickers.add(ticker);
  }
  return tickers.size > 0 ? [...tickers] : fallback;
}

/**
 * Snapshot one ticker's flow for `date` and upsert its row immediately. Never throws.
 * Reasons: skipped → 'no-options' | 'lookup-error'; failed → 'upsert-error' | 'timeout' | 'error'.
 * @returns {Promise<{ ticker: string, status: 'stored' | 'skipped' | 'failed', reason?: string }>}
 */
export async function collectTicker({ ticker, date, now, supabase, signal, log = console }) {
  try {
    const raw = await fetchCBOE(ticker, signal);
    const { options } = normalizeChain(raw.options, { now });
    if (options.length === 0) {
      log.warn(`No options data for ${ticker}, skipping`);
      return { ticker, status: 'skipped', reason: 'no-options' };
    }
    const premium = computeNetPremium(options);
    const pc = computePutCallRatio(options);

    // A failed lookup is not "no history": treating it as 0 would restart the running total.
    const { data: prevRows, error: lookupError } = await supabase
      .from('flow_history')
      .select('cum_premium')
      .eq('ticker', ticker)
      .lt('date', date)
      .order('date', { ascending: false })
      .limit(1);
    if (lookupError) {
      log.error(`Skipping ${ticker}: previous cum_premium lookup failed:`, lookupError.message);
      return { ticker, status: 'skipped', reason: 'lookup-error' };
    }
    const prevCum = Number(prevRows?.[0]?.cum_premium) || 0; // no prior row is a legitimate 0

    const row = {
      date,
      ticker,
      net_premium: premium.netPremium,
      cum_premium: prevCum + premium.netPremium,
      call_volume: pc.callVolume,
      put_volume: pc.putVolume,
      call_premium: premium.callPremium,
      put_premium: premium.putPremium,
      spot_price: raw.spotPrice,
      provider: raw.provider,
    };
    const { error: upsertError } = await supabase
      .from('flow_history')
      .upsert(row, { onConflict: 'date,ticker' });
    if (upsertError) {
      log.error(`Supabase upsert failed for ${ticker}:`, upsertError.message);
      return { ticker, status: 'failed', reason: 'upsert-error' };
    }

    log.log(`Collected ${ticker}: net=${premium.netPremium.toFixed(0)}, calls=${pc.callVolume}, puts=${pc.putVolume}`);
    return { ticker, status: 'stored' };
  } catch (err) {
    const reason = isTimeoutError(err) ? 'timeout' : 'error';
    log.error(`Failed to collect ${ticker} (${reason}):`, err?.message ?? String(err));
    return { ticker, status: 'failed', reason };
  }
}

/**
 * Collect every ticker for the Eastern-Time trading date of `now`, `concurrency` at a
 * time, under the `signal` deadline. Weekends and NYSE holidays (or an unknown ET date)
 * are skipped without fetching anything.
 * @returns {Promise<{ date: string | null, skipped: 'not-trading-day' | null, results: object[] }>}
 */
export async function runCollection({
  tickers = parseTrackedTickers(process.env.TRACKED_TICKERS),
  supabase,
  now = new Date(),
  signal = AbortSignal.timeout(COLLECTION_BUDGET_MS),
  concurrency = DEFAULT_CONCURRENCY,
  log = console,
} = {}) {
  const date = etDateString(now);
  if (!date || !isTradingDay(date)) {
    log.log(date
      ? `${date} is not a trading day (weekend or NYSE holiday) — skipping flow collection.`
      : 'Eastern-Time date unavailable — skipping flow collection.');
    return { date, skipped: 'not-trading-day', results: [] };
  }

  const limit = pLimit(concurrency);
  const results = await Promise.all(
    tickers.map((ticker) => limit(() => collectTicker({ ticker, date, now, supabase, signal, log }))),
  );

  const count = (status) => results.filter((r) => r.status === status).length;
  log.log(`Flow history ${date}: ${count('stored')} stored, ${count('skipped')} skipped, ${count('failed')} failed.`);
  return { date, skipped: null, results };
}

const collectFlow = async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase env vars not set — skipping flow collection.');
    return { statusCode: 200 };
  }

  try {
    await runCollection({ supabase: getSupabaseAdmin() });
  } catch (err) {
    console.error('Flow collection failed:', err?.message ?? String(err));
  }
  return { statusCode: 200 };
};

// Mon–Fri at 21:30 UTC — 4:30 PM EST / 5:30 PM EDT, always after the options close.
export const handler = schedule('30 21 * * 1-5', collectFlow);
