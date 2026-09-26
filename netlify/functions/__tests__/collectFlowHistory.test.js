// netlify/functions/__tests__/collectFlowHistory.test.js — the nightly flow collector (roadmap Phase 2): ET
// trading-date gating, per-ticker upserts, cum_premium lookup errors, the concurrency cap and the run deadline.
// Supabase is a recording fake of the collector's own queries (not test/helpers/fakeSupabase.js). Timers are real:
// the concurrency and deadline checks wait on them.
import { describe, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_TRACKED_TICKERS, parseTrackedTickers, runCollection, handler } from '../collectFlowHistory.js';
import { EXPIRY_WINDOW } from '../lib/marketDataHelpers.js';
import { installFunctionHarness } from '../../../test/helpers/functions.js';

const { calls, setFetch, assert } = installFunctionHarness();

const DAY_MS = 86_400_000;
const FRIDAY = new Date('2026-09-25T21:30:00Z'); // Friday 5:30 PM EDT, a trading day

const quiet = { log() {}, warn() {}, error() {} };

/** Logger that keeps every line, for asserting on what was reported. */
function recorder() {
  const lines = [];
  const push = (...args) => { lines.push(args.map(String).join(' ')); };
  return { lines, log: push, warn: push, error: push };
}

/** OCC symbol `days` after `now`: TICKER + YYMMDD + C|P + strike×1000 padded to 8. */
function occ(ticker, now, days, type, strike) {
  const yymmdd = new Date(now.getTime() + days * DAY_MS).toISOString().slice(2, 10).replace(/-/g, '');
  return `${ticker}${yymmdd}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

/** Ticker from a CBOE delayed-quotes URL (…/options/<TICKER>.json). */
const tickerOf = (url) => decodeURIComponent(String(url).split('/').pop().replace(/\.json$/, ''));

/**
 * 200 CBOE response for the ticker in `url`: a call (volume 10) and a put (volume 4), both
 * $100 strike, bid 1 / ask 2, expiring 7 days after `now`, plus `extra(sym)` contracts.
 */
function cboeOk(url, now, extra = () => []) {
  const ticker = tickerOf(url);
  const sym = (days, type, strike) => occ(ticker, now, days, type, strike);
  const body = {
    data: {
      current_price: 100,
      options: [
        { option: sym(7, 'C', 100), bid: 1, ask: 2, volume: 10, open_interest: 5 },
        { option: sym(7, 'P', 100), bid: 1, ask: 2, volume: 4, open_interest: 5 },
        ...extra(sym),
      ],
    },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Fake service-role client. from(table) → builder: select/eq/lt/order are chainable and
 * limit() resolves to `lookup` (or `lookup(ticker)`); upsert(row, opts) records and resolves
 * { error: upsertError }. Every table, lookup query and upsert is recorded.
 */
function fakeSupabase({ lookup = { data: [], error: null }, upsertError = null } = {}) {
  const tables = [];
  const lookups = [];
  const upserts = [];
  return {
    tables,
    lookups,
    upserts,
    from(table) {
      tables.push(table);
      const q = {};
      const builder = {
        select(cols) { q.select = cols; return builder; },
        eq(col, value) { q.eq = [col, value]; return builder; },
        lt(col, value) { q.lt = [col, value]; return builder; },
        order(col, opts) { q.order = [col, opts]; return builder; },
        limit(n) {
          q.limit = n;
          lookups.push(q);
          return Promise.resolve(typeof lookup === 'function' ? lookup(q.eq?.[1]) : lookup);
        },
        upsert(row, opts) {
          upserts.push({ row, opts });
          return Promise.resolve({ error: upsertError });
        },
      };
      return builder;
    },
  };
}

const byTicker = (results) => Object.fromEntries(results.map((r) => [r.ticker, r]));

describe('collector', () => {
  it('parseTrackedTickers: comma list trimmed, invalid dropped, deduped; nothing valid → defaults', async () => {
    assert.deepEqual([...DEFAULT_TRACKED_TICKERS], ['AVGO', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'SPY', 'QQQ']);
    assert.deepEqual(parseTrackedTickers('spy, qqq,bad ticker!,SPY,../x'), ['SPY', 'QQQ']);
    for (const raw of ['', '  ,, ', undefined]) assert.deepEqual(parseTrackedTickers(raw), DEFAULT_TRACKED_TICKERS, `raw=${JSON.stringify(raw)}`);
    assert.deepEqual(parseTrackedTickers('brk.b'), ['BRK.B']);
    assert.deepEqual(parseTrackedTickers('../x', ['SPY']), ['SPY'], 'custom fallback');
  });

  it('NYSE holiday / weekend → skipped not-trading-day, nothing fetched or written', async () => {
    setFetch(async (url) => cboeOk(url, FRIDAY));
    const supabase = fakeSupabase();
    const cases = [['2026-07-03T21:30:00Z', '2026-07-03'], ['2026-09-26T21:30:00Z', '2026-09-26']]; // Independence Day (observed), Saturday
    for (const [iso, date] of cases) {
      const r = await runCollection({ tickers: ['SPY'], supabase, now: new Date(iso), log: quiet });
      assert.equal(r.date, date); assert.equal(r.skipped, 'not-trading-day'); assert.equal(r.results.length, 0);
    }
    assert.equal(calls.length, 0); assert.equal(supabase.upserts.length, 0); assert.equal(supabase.lookups.length, 0);
  });

  it('row date is the ET trading date (Fri 9 PM EDT = Sat 01:00 UTC → 2026-09-25)', async () => {
    const now = new Date('2026-09-26T01:00:00Z');
    setFetch(async (url) => cboeOk(url, now));
    const supabase = fakeSupabase();
    const r = await runCollection({ tickers: ['SPY'], supabase, now, log: quiet });
    assert.equal(r.skipped, null); assert.equal(r.date, '2026-09-25');
    assert.equal(supabase.upserts.length, 1);
    const { row } = supabase.upserts[0];
    assert.equal(row.date, '2026-09-25');
    assert.deepEqual(supabase.lookups[0].lt, ['date', '2026-09-25'], 'previous row looked up strictly before the ET date');
    assert.equal(row.cum_premium, row.net_premium, 'no prior row → running total starts at 0');
  });

  it('cum_premium lookup error ⇒ skipped (lookup-error), nothing written, message logged', async () => {
    setFetch(async (url) => cboeOk(url, FRIDAY));
    const supabase = fakeSupabase({ lookup: { data: null, error: { message: 'boom' } } });
    const log = recorder();
    const r = await runCollection({ tickers: ['SPY'], supabase, now: FRIDAY, log });
    assert.deepEqual(r.results, [{ ticker: 'SPY', status: 'skipped', reason: 'lookup-error' }]);
    assert.equal(supabase.upserts.length, 0);
    assert.ok(log.lines.some((l) => l.includes('boom')), 'lookup error message logged');
    // Per ticker: only the ticker whose lookup failed is skipped.
    const partial = fakeSupabase({ lookup: (ticker) => (ticker === 'SPY' ? { data: null, error: { message: 'boom' } } : { data: [], error: null }) });
    const r2 = await runCollection({ tickers: ['SPY', 'QQQ'], supabase: partial, now: FRIDAY, log: quiet });
    assert.deepEqual(r2.results.map((x) => x.status), ['skipped', 'stored']);
    assert.deepEqual(partial.upserts.map((u) => u.row.ticker), ['QQQ']);
  });

  it('per-ticker upsert: a CBOE 500 loses only that ticker; cum_premium = previous + net', async () => {
    setFetch(async (url) => (tickerOf(url) === 'QQQ' ? new Response('{}', { status: 500 }) : cboeOk(url, FRIDAY)));
    const supabase = fakeSupabase({ lookup: { data: [{ cum_premium: 1000 }], error: null } });
    const r = await runCollection({ tickers: ['SPY', 'QQQ', 'NVDA'], supabase, now: FRIDAY, log: quiet });
    assert.deepEqual(r.results.map((x) => x.status), ['stored', 'failed', 'stored']);
    assert.equal(r.results[1].reason, 'error');
    assert.equal(supabase.upserts.length, 2);
    assert.deepEqual(supabase.upserts.map((u) => u.row.ticker).sort(), ['NVDA', 'SPY']);
    for (const { row, opts } of supabase.upserts) {
      assert.ok(!Array.isArray(row), 'one row per upsert call');
      assert.equal(opts.onConflict, 'date,ticker');
      assert.equal(row.date, '2026-09-25');
      assert.equal(row.net_premium, row.call_premium - row.put_premium);
      assert.equal(row.cum_premium, 1000 + row.net_premium);
      assert.equal(row.call_volume, 10); assert.equal(row.put_volume, 4);
      assert.equal(row.spot_price, 100); assert.equal(row.provider, 'cboe');
    }
    assert.ok(supabase.tables.every((name) => name === 'flow_history'));
    const q = supabase.lookups.find((x) => x.eq?.[1] === 'SPY');
    assert.deepEqual(q, { select: 'cum_premium', eq: ['ticker', 'SPY'], lt: ['date', '2026-09-25'], order: ['date', { ascending: false }], limit: 1 });
  });

  it('p-limit caps concurrent CBOE fetches (6 tickers, concurrency 2)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    setFetch(async (url) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try { await sleep(20); return cboeOk(url, FRIDAY); } finally { inFlight--; }
    });
    const supabase = fakeSupabase();
    const tickers = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'SPY', 'QQQ'];
    const r = await runCollection({ tickers, supabase, now: FRIDAY, concurrency: 2, log: quiet });
    assert.equal(maxInFlight, 2);
    assert.equal(calls.length, 6);
    assert.ok(r.results.every((x) => x.status === 'stored'), JSON.stringify(r.results));
  });

  it('run deadline aborts a hanging CBOE fetch → failed/timeout, others stored, resolves < 1 s', async () => {
    setFetch((url, init) => {
      if (tickerOf(url) !== 'HANG') return Promise.resolve(cboeOk(url, FRIDAY));
      return new Promise((_, reject) => {
        // AbortSignal.timeout() timers are unref'd: like a real hung socket, hold the event loop
        // open until the deadline aborts us, and fail loudly (not hang) if it never does.
        const guard = setTimeout(() => reject(new Error('HANG fetch was never aborted')), 2000);
        const fail = (err) => { clearTimeout(guard); reject(err); };
        const abort = () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (!init?.signal) fail(new Error('fetch called without a signal'));
        else if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    });
    const supabase = fakeSupabase();
    const started = performance.now();
    const r = await runCollection({ tickers: ['SPY', 'HANG', 'QQQ'], supabase, now: FRIDAY, signal: AbortSignal.timeout(50), log: quiet });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `resolved after ${Math.round(elapsed)} ms`);
    const res = byTicker(r.results);
    assert.deepEqual(res.HANG, { ticker: 'HANG', status: 'failed', reason: 'timeout' });
    assert.equal(res.SPY.status, 'stored'); assert.equal(res.QQQ.status, 'stored');
    assert.deepEqual(supabase.upserts.map((u) => u.row.ticker).sort(), ['QQQ', 'SPY']);
  });

  it('nightly rows use the dashboard expiry window (expired and beyond-window contracts excluded)', async () => {
    setFetch(async (url) => cboeOk(url, FRIDAY, (sym) => [
      { option: sym(-7, 'C', 100), bid: 1, ask: 2, volume: 50, open_interest: 5 }, // expired last week
      // Fill the window with EXPIRY_WINDOW - 1 more (zero-volume) expiries after the +7-day one…
      ...Array.from({ length: EXPIRY_WINDOW - 1 }, (_, i) => ({ option: sym(8 + i, 'C', 100), bid: 1, ask: 2, volume: 0, open_interest: 5 })),
      // …so this one is the (EXPIRY_WINDOW + 1)th and must be dropped.
      { option: sym(7 + EXPIRY_WINDOW, 'C', 100), bid: 1, ask: 2, volume: 1000, open_interest: 5 },
    ]));
    const supabase = fakeSupabase();
    const r = await runCollection({ tickers: ['SPY'], supabase, now: FRIDAY, log: quiet });
    assert.equal(r.results[0].status, 'stored');
    const { row } = supabase.upserts[0];
    assert.equal(row.call_volume, 10); assert.equal(row.put_volume, 4);
    assert.equal(row.call_premium, 1500); assert.equal(row.put_premium, 600); assert.equal(row.net_premium, 900);
  });

  it('TRACKED_TICKERS env drives the default ticker list', async () => {
    process.env.TRACKED_TICKERS = 'nvda';
    setFetch(async (url) => cboeOk(url, FRIDAY));
    const supabase = fakeSupabase();
    const r = await runCollection({ supabase, now: FRIDAY, log: quiet });
    assert.equal(calls.length, 1); assert.match(calls[0].url, /cboe\.com\/.*\/NVDA\.json$/);
    assert.deepEqual(r.results, [{ ticker: 'NVDA', status: 'stored' }]);
    delete process.env.TRACKED_TICKERS;
  });

  it('a throwing ticker is contained: failed/error, the run resolves, the other ticker stored', async () => {
    setFetch((url) => {
      if (tickerOf(url) === 'AMD') throw new Error('kaboom'); // synchronous throw from fetch()
      return Promise.resolve(cboeOk(url, FRIDAY));
    });
    const supabase = fakeSupabase();
    const log = recorder();
    const r = await runCollection({ tickers: ['AMD', 'SPY'], supabase, now: FRIDAY, log });
    assert.deepEqual(r.results, [{ ticker: 'AMD', status: 'failed', reason: 'error' }, { ticker: 'SPY', status: 'stored' }]);
    assert.ok(log.lines.some((l) => l.includes('kaboom')), 'error message logged');
    assert.deepEqual(supabase.upserts.map((u) => u.row.ticker), ['SPY']);
  });

  it('scheduled handler without Supabase env → 200, nothing fetched', async () => {
    setFetch(async (url) => cboeOk(url, FRIDAY));
    const warn = console.warn;
    const warned = [];
    console.warn = (...args) => { warned.push(args.join(' ')); };
    try {
      assert.deepEqual(await handler({}, {}), { statusCode: 200 });
    } finally {
      console.warn = warn;
    }
    assert.equal(calls.length, 0);
    assert.ok(warned.some((l) => l.includes('Supabase env vars not set')), 'guard reason logged');
  });
});
