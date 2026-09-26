// netlify/functions/__tests__/getTickerContext.test.js — ticker research context. Access (roadmap Phase 1): a BYOK
// Finnhub key works without a token and never reaches Alpha Vantage; the server keys and Alpha Vantage are for
// token holders. The response (M5): status and the per-section errors map, section correctness, Wilder RSI. The
// earnings cache (M6): the refetch floor, and fetchEarnings against a recording Supabase admin client stand-in.
import { describe, it } from 'vitest';
import getTickerContext, { computeRSI, earningsCacheState, fetchEarnings, EARNINGS_REFETCH_FLOOR_MS } from '../getTickerContext.js';
import { installFunctionHarness } from '../../../test/helpers/functions.js';

const { calls, setFetch, req, json, mint, assert, SECRET } = installFunctionHarness();

// StockCharts' worked RSI example (Wilder): 70.53 after the first 15 closes, 37.77 after all 33.
const STOCKCHARTS_CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];

const AV_BODY = { quarterlyEarnings: [{ reportedDate: '2026-08-05', estimatedEPS: '1.10', reportedEPS: '1.20', surprise: '0.10' }] };
const AV_DAILY_CAP = { Information: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans to instantly remove all daily rate limits.' };
const AV_MINUTE_CAP = { Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day.' };

const NOW = new Date('2026-09-25T12:00:00Z');
const now = () => new Date(NOW);
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
// Last report 2026-04-28 → estimated next report 2026-08-01, which has passed by NOW.
const STALE_ROW = {
  data: { date: '2026-04-28', epsEstimate: 1, epsActual: 1.05, revenueEstimate: null, revenueActual: null, quarter: null, year: null, surprise: 0.05 },
  next_report_date: '2026-08-01',
  fetched_at: hoursAgo(48),
};
const FRESH_ROW = { ...STALE_ROW, next_report_date: '2026-12-01' };

const ok = (body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
const fail = (status) => new Response(JSON.stringify({ error: 'upstream says no' }), { status });
const timeout = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };

// Fetch stub routed by URL substring (first match wins); anything unmatched gets `fallback`.
const route = (table, fallback = () => ok('[]')) => async (url) => {
  const u = String(url);
  for (const [needle, respond] of table) if (u.includes(needle)) return respond(u);
  return fallback(u);
};

// Stand-in for the Supabase admin client's earnings_cache calls; `recorded` holds the writes.
function fakeClient({ row = null, selectError = null, updateError = null, upsertError = null } = {}) {
  const recorded = { selects: 0, updates: [], upserts: [] };
  return {
    recorded,
    from(table) {
      if (table !== 'earnings_cache') throw new Error(`unexpected table ${table}`);
      const builder = {
        select() { recorded.selects++; return builder; },
        eq() { return builder; },
        single: async () => ({ data: row, error: selectError }),
        update(patch) {
          const entry = { patch };
          recorded.updates.push(entry);
          return { eq: async (column, value) => { entry.where = [column, value]; return { error: updateError }; } };
        },
        upsert: async (upserted, opts) => { recorded.upserts.push({ row: upserted, opts }); return { error: upsertError }; },
      };
      return builder;
    },
  };
}

const call = async (request) => json(await getTickerContext(request));
const byok = () => req('getTickerContext?ticker=AVGO', { headers: { 'x-finnhub-key': 'fh-user' } });
const tokenHolder = () => {
  process.env.TOKEN_SECRET = SECRET; process.env.FINNHUB_API_KEY = 'fh-server'; process.env.ALPHA_VANTAGE_KEY = 'av';
  return req('getTickerContext?ticker=AVGO', { headers: { authorization: `Bearer ${mint()}` } });
};
const avCalls = () => calls.filter((c) => c.url.includes('alphavantage.co')).length;

describe('getTickerContext', () => {
  it('no key, no token → 401 KEY_REQUIRED, no upstream', async () => {
    process.env.FINNHUB_API_KEY = 'fh-server'; process.env.TOKEN_SECRET = SECRET;
    const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO'))); assert.equal(r.status, 401); assert.equal(r.body.code, 'KEY_REQUIRED'); assert.equal(calls.length, 0);
  });
  it('BYOK finnhub: called with user key, Alpha Vantage NOT called', async () => {
    process.env.FINNHUB_API_KEY = 'fh-server'; process.env.ALPHA_VANTAGE_KEY = 'av'; process.env.TOKEN_SECRET = SECRET;
    setFetch(async () => new Response('[]', { status: 200 }));
    const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO', { headers: { 'x-finnhub-key': 'fh-user' } })));
    assert.equal(r.status, 200); assert.ok(calls.length > 5);
    assert.ok(calls.every((c) => !c.url.includes('alphavantage')), 'AV must not be called for anonymous BYOK');
    assert.ok(calls.every((c) => c.url.includes('token=fh-user')));
    assert.ok(calls.every((c) => !c.url.includes('fh-server')));
  });
  it('token holder: server finnhub key + Alpha Vantage', async () => {
    process.env.FINNHUB_API_KEY = 'fh-server'; process.env.ALPHA_VANTAGE_KEY = 'av'; process.env.TOKEN_SECRET = SECRET;
    setFetch(async () => new Response('[]', { status: 200 }));
    const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO', { headers: { authorization: `Bearer ${mint()}` } })));
    assert.equal(r.status, 200); assert.ok(calls.some((c) => c.url.includes('alphavantage')));
    const av = calls.find((c) => c.url.includes('alphavantage')); assert.match(av.url, /symbol=AVGO/);
  });
  it('presented-but-expired token → 401 TOKEN_EXPIRED', async () => {
    process.env.FINNHUB_API_KEY = 'fh-server'; process.env.TOKEN_SECRET = SECRET;
    const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO', { headers: { authorization: `Bearer ${mint({}, { sign: { expiresIn: '-1s' } })}` } })));
    assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_EXPIRED');
  });
});

describe('tickerContext', () => {
  // ── Response status + errors map (M5) ──
  it('every Finnhub call 500 → 502 CONTEXT_UNAVAILABLE, per-section errors, no-store, no key material', async () => {
    process.env.TOKEN_SECRET = SECRET; process.env.FINNHUB_API_KEY = 'fh-server';
    setFetch(async () => fail(500));
    const r = await call(byok());
    assert.equal(r.status, 502, JSON.stringify(r.body)); assert.equal(r.body.code, 'CONTEXT_UNAVAILABLE');
    assert.equal(r.body.errors.news, 'HTTP 500'); assert.equal(r.body.errors.metrics, 'HTTP 500'); assert.equal(r.body.errors.marketQuotes, 'HTTP 500');
    assert.deepEqual(Object.keys(r.body.errors).sort(), ['candles', 'earningsCalendar', 'marketNews', 'marketQuotes', 'metrics', 'news', 'priceTarget', 'recommendation']);
    assert.equal(r.headers['cache-control'], 'no-store'); assert.ok(r.body.requestId);
    const text = JSON.stringify(r.body);
    for (const secret of ['fh-user', 'fh-server', 'token=']) assert.ok(!text.includes(secret), `body leaks ${secret}`);
    assert.equal(calls.length, 12); assert.ok(calls.every((c) => c.url.includes('token=fh-user')));
  });
  it('every Finnhub call 401 → 401 FINNHUB_KEY_REJECTED for a BYOK key, 502 for the server key; mixed failures → 502', async () => {
    setFetch(async () => fail(401));
    const r = await call(byok());
    assert.equal(r.status, 401, JSON.stringify(r.body)); assert.equal(r.body.code, 'FINNHUB_KEY_REJECTED');
    assert.equal(r.body.errors.news, 'HTTP 401'); assert.equal(r.headers['cache-control'], 'no-store'); assert.ok(r.body.requestId);
    // The server's own key being refused is a deployment problem, not the caller's key.
    const request = tokenHolder();
    setFetch(route([['alphavantage', () => ok('{}')]], () => fail(401)));
    const rs = await call(request);
    assert.equal(rs.status, 502, JSON.stringify(rs.body)); assert.equal(rs.body.code, 'CONTEXT_UNAVAILABLE'); assert.equal(rs.body.errors.news, 'HTTP 401');
    setFetch(route([['/stock/candle', () => fail(403)]], () => fail(401)));
    const r2 = await call(byok());
    assert.equal(r2.status, 502); assert.equal(r2.body.code, 'CONTEXT_UNAVAILABLE'); assert.equal(r2.body.errors.candles, 'HTTP 403');
  });
  it('only /stock/candle 403 (paid endpoint, free key) → 200, technicals null, errors { candles }, cache kept at 900; a 500 there → 60', async () => {
    setFetch(route([['/stock/candle', () => fail(403)]]));
    const r = await call(byok());
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.technicals, null);
    assert.deepEqual(r.body.errors, { candles: 'HTTP 403' });
    assert.equal(r.headers['cache-control'], 'private, max-age=900');
    setFetch(route([['/stock/candle', () => fail(500)]]));
    const r2 = await call(byok());
    assert.equal(r2.status, 200); assert.deepEqual(r2.body.errors, { candles: 'HTTP 500' });
    assert.equal(r2.headers['cache-control'], 'private, max-age=60');
  });
  it('every section answers (empty data is not an error) → 200, errors {}, max-age=900', async () => {
    setFetch(async () => ok('[]'));
    const r = await call(byok());
    assert.equal(r.status, 200); assert.deepEqual(r.body.errors, {});
    assert.equal(r.headers['cache-control'], 'private, max-age=900'); assert.match(r.headers.vary, /x-finnhub-key/);
  });
  it('timeout / network failure → "timeout" / "error"; one failed market quote is not a section error', async () => {
    setFetch(route([['/company-news', timeout], ['/news?', () => { throw new TypeError('fetch failed'); }], ['symbol=VIX', () => fail(500)]]));
    const r = await call(byok());
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.errors, { news: 'timeout', marketNews: 'error' });
    assert.equal(r.headers['cache-control'], 'private, max-age=60');
  });
  it('every Finnhub call fails but Alpha Vantage earnings arrive → 200 partial, not 502', async () => {
    const request = tokenHolder();
    setFetch(route([['alphavantage', () => ok(AV_BODY)]], () => fail(500)));
    const r = await call(request);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.earnings.epsActual, 1.2); assert.equal(r.body.earnings.revenueActual, null);
    assert.equal(r.body.errors.earningsCalendar, 'HTTP 500'); assert.equal('earnings' in r.body.errors, false);
    assert.equal(r.headers['cache-control'], 'private, max-age=60');
  });

  // ── Section correctness (M5) ──
  it('fundamentals.forwardPE is Finnhub forwardPE, not the trailing peTTM', async () => {
    setFetch(route([['/stock/metric', () => ok({ metric: { forwardPE: 34.85, peTTM: 30.1, peBasicExclExtraTTM: 29 } })]]));
    const r = await call(byok());
    assert.equal(r.body.fundamentals.forwardPE, 34.85); assert.equal(r.body.fundamentals.peRatio, 29);
    setFetch(route([['/stock/metric', () => ok({ metric: { peTTM: 30.1 } })]]));
    const r2 = await call(byok());
    assert.equal(r2.body.fundamentals.forwardPE, null);
  });
  it('revenue pairs only with the same quarter: exact date, else closest within 3 days, never cal[0]', async () => {
    const revenueFor = async (earningsCalendar) => {
      setFetch(route([['/calendar/earnings', () => ok({ earningsCalendar })], ['alphavantage', () => ok(AV_BODY)]]));
      const r = await call(tokenHolder());
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.earnings.date, '2026-08-05'); assert.equal(r.body.earnings.epsActual, 1.2);
      return [r.body.earnings.revenueActual, r.body.earnings.revenueEstimate];
    };
    assert.deepEqual(await revenueFor([{ date: '2026-08-06', revenueActual: 5, revenueEstimate: 4 }, { date: '2026-11-04', revenueEstimate: 9 }]), [5, 4]);
    assert.deepEqual(await revenueFor([{ date: '2026-11-04', revenueEstimate: 9 }]), [null, null], 'next quarter only → no revenue');
    assert.deepEqual(await revenueFor([{ date: '2026-08-04', revenueActual: 1, revenueEstimate: 1 }, { date: '2026-08-05', revenueActual: 5, revenueEstimate: 4 }]), [5, 4], 'exact beats 1 day off');
    assert.deepEqual(await revenueFor([{ date: '2026-08-08', revenueActual: 8, revenueEstimate: 8 }, { date: '2026-08-03', revenueActual: 3, revenueEstimate: 3 }]), [3, 3], 'closest wins');
    assert.deepEqual(await revenueFor([{ date: '2026-08-09', revenueActual: 9, revenueEstimate: 9 }]), [null, null], '4 days off → another quarter');
  });
  it('computeRSI is Wilder-smoothed (StockCharts reference: 70.53 → 37.77)', async () => {
    const rsi = computeRSI(STOCKCHARTS_CLOSES);
    assert.ok(Math.abs(rsi - 37.77) < 0.1, `rsi ${rsi}`);
    assert.ok(rsi > 35, `rsi ${rsi}: Cutler's simple average of the last 14 changes gives ~30.2`);
    const first = computeRSI(STOCKCHARTS_CLOSES.slice(0, 15));
    assert.ok(Math.abs(first - 70.53) < 0.1, `first rsi ${first}`);
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    assert.equal(computeRSI(rising), 100); assert.equal(computeRSI([...rising].reverse()), 0);
    assert.equal(computeRSI(Array(20).fill(50)), null); assert.equal(computeRSI(STOCKCHARTS_CLOSES.slice(0, 14)), null);
  });

  // ── Earnings cache refetch floor (M6) ──
  it('earningsCacheState: fresh before next_report_date, then a 12 h fetched_at floor', async () => {
    const state = (cached) => earningsCacheState({ cached, now: NOW });
    const data = STALE_ROW.data;
    assert.equal(EARNINGS_REFETCH_FLOOR_MS, 12 * 3600e3);
    assert.equal(state({ data, next_report_date: '2026-12-01', fetched_at: hoursAgo(24 * 60) }), 'fresh');
    assert.equal(state({ data, next_report_date: '2026-12-01', fetched_at: null }), 'fresh');
    assert.equal(state({ data, next_report_date: '2026-08-01', fetched_at: hoursAgo(1) }), 'fresh');
    assert.equal(state({ data, next_report_date: '2026-08-01', fetched_at: hoursAgo(12) }), 'refetch');
    assert.equal(state({ data, next_report_date: '2026-08-01', fetched_at: hoursAgo(13) }), 'refetch');
    assert.equal(state({ data, next_report_date: null, fetched_at: hoursAgo(2) }), 'fresh');
    assert.equal(state(null), 'refetch'); assert.equal(state({ data: null, next_report_date: '2026-12-01', fetched_at: hoursAgo(1) }), 'refetch');
    assert.equal(state({ data, next_report_date: '2026-08-01', fetched_at: hoursAgo(-1) }), 'refetch', 'fetched_at in the future');
  });
  it('fetchEarnings: AV daily cap → stale row served and touched (one AV call); the next request skips AV', async () => {
    process.env.ALPHA_VANTAGE_KEY = 'av';
    setFetch(route([['alphavantage', () => ok(AV_DAILY_CAP)]]));
    const sb = fakeClient({ row: STALE_ROW });
    const r = await fetchEarnings('AVGO', undefined, { getClient: () => sb, now });
    assert.deepEqual(r, { data: STALE_ROW.data, reason: 'rate-limited' }); assert.equal(avCalls(), 1);
    assert.equal(sb.recorded.updates.length, 1); assert.equal(sb.recorded.upserts.length, 0);
    assert.equal(sb.recorded.updates[0].patch.fetched_at, now().toISOString()); assert.deepEqual(sb.recorded.updates[0].where, ['ticker', 'AVGO']);
    const touched = fakeClient({ row: { ...STALE_ROW, fetched_at: sb.recorded.updates[0].patch.fetched_at } });
    const r2 = await fetchEarnings('AVGO', undefined, { getClient: () => touched, now: () => new Date(NOW.getTime() + 3600e3) });
    assert.deepEqual(r2, { data: STALE_ROW.data, reason: null }); assert.equal(avCalls(), 1, 'no second AV call inside the floor');
  });
  it('fetchEarnings: fresh row → served from cache, no AV call', async () => {
    process.env.ALPHA_VANTAGE_KEY = 'av';
    setFetch(route([['alphavantage', () => ok(AV_BODY)]]));
    const sb = fakeClient({ row: FRESH_ROW });
    const r = await fetchEarnings('AVGO', undefined, { getClient: () => sb, now });
    assert.deepEqual(r, { data: FRESH_ROW.data, reason: null }); assert.equal(avCalls(), 0);
    assert.equal(sb.recorded.updates.length + sb.recorded.upserts.length, 0);
  });
  it('fetchEarnings: stale row + AV data → upsert with a new fetched_at, no touch', async () => {
    process.env.ALPHA_VANTAGE_KEY = 'av';
    setFetch(route([['alphavantage', () => ok(AV_BODY)]]));
    const sb = fakeClient({ row: STALE_ROW });
    const r = await fetchEarnings('AVGO', undefined, { getClient: () => sb, now });
    assert.equal(r.reason, null); assert.equal(r.data.date, '2026-08-05'); assert.equal(r.data.epsActual, 1.2); assert.equal(avCalls(), 1);
    assert.equal(sb.recorded.updates.length, 0); assert.equal(sb.recorded.upserts.length, 1);
    const { row, opts } = sb.recorded.upserts[0];
    assert.equal(row.ticker, 'AVGO'); assert.equal(row.fetched_at, now().toISOString()); assert.equal(row.next_report_date, '2026-11-08');
    assert.deepEqual(row.data, r.data); assert.deepEqual(opts, { onConflict: 'ticker' });
  });
  it('fetchEarnings: no Supabase client + AV 500 → { data: null, reason: "HTTP 500" }', async () => {
    process.env.ALPHA_VANTAGE_KEY = 'av';
    setFetch(route([['alphavantage', () => fail(500)]]));
    const r = await fetchEarnings('AVGO', undefined, { getClient: () => { throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set'); }, now });
    assert.deepEqual(r, { data: null, reason: 'HTTP 500' }); assert.equal(avCalls(), 1);
  });
  it('fetchEarnings: no ALPHA_VANTAGE_KEY → no-key, nothing called', async () => {
    let asked = 0;
    const r = await fetchEarnings('AVGO', undefined, { getClient: () => { asked++; return fakeClient({ row: STALE_ROW }); }, now });
    assert.deepEqual(r, { data: null, reason: 'no-key' }); assert.equal(calls.length, 0); assert.equal(asked, 0);
  });
  it('fetchEarnings: per-minute Note / timeout / no-data reasons; cache read and write errors are best effort', async () => {
    process.env.ALPHA_VANTAGE_KEY = 'av';
    const run = async (respond, clientOpts) => {
      setFetch(route([['alphavantage', respond]]));
      const sb = fakeClient(clientOpts);
      return { r: await fetchEarnings('AVGO', undefined, { getClient: () => sb, now }), sb };
    };
    let { r, sb } = await run(() => ok(AV_MINUTE_CAP), { row: null, selectError: { code: 'PGRST116', message: 'no rows' } });
    assert.deepEqual(r, { data: null, reason: 'rate-limited' }); assert.equal(sb.recorded.updates.length, 0, 'no row to touch');
    ({ r, sb } = await run(timeout, { row: STALE_ROW }));
    assert.deepEqual(r, { data: STALE_ROW.data, reason: 'timeout' }); assert.equal(sb.recorded.updates.length, 1);
    ({ r, sb } = await run(() => ok({}), { row: STALE_ROW }));
    assert.deepEqual(r, { data: STALE_ROW.data, reason: 'no-data' }); assert.equal(sb.recorded.updates.length, 1);
    ({ r } = await run(() => ok(AV_DAILY_CAP), { row: STALE_ROW, updateError: { message: 'permission denied' } }));
    assert.deepEqual(r, { data: STALE_ROW.data, reason: 'rate-limited' });
    ({ r, sb } = await run(() => ok(AV_BODY), { row: FRESH_ROW, selectError: { code: '42P01', message: 'relation "earnings_cache" does not exist' }, upsertError: { message: 'boom' } }));
    assert.equal(r.reason, null); assert.equal(r.data.date, '2026-08-05'); assert.equal(sb.recorded.upserts.length, 1);
  });
  it('token holder, AV rate-limited → 200, errors.earnings, max-age=60; AV no data (ETF) is not an error', async () => {
    setFetch(route([['alphavantage', () => ok(AV_DAILY_CAP)]]));
    const r = await call(tokenHolder());
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.earnings, null);
    assert.deepEqual(r.body.errors, { earnings: 'rate-limited' }); assert.equal(r.headers['cache-control'], 'private, max-age=60');
    setFetch(route([['alphavantage', () => ok({})]]));
    const r2 = await call(tokenHolder());
    assert.equal(r2.status, 200); assert.equal(r2.body.earnings, null);
    assert.deepEqual(r2.body.errors, {}); assert.equal(r2.headers['cache-control'], 'private, max-age=900');
  });
});
