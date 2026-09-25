// scripts/verify/liveQuote.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// getLiveQuote (roadmap M3, M4): the newest-timestamped price wins, NQ futures are context only and
// never overwrite `current`, "market closed" comes from the shared holiday calendar, and Finnhub's
// zero / non-numeric quotes are rejected. Pure checks use far-past Unix seconds; the futures checks
// inject `now`, so nothing here depends on the wall clock.

/** Yahoo v8 chart body with a single result. */
const chart = ({ meta, timestamps = [], closes = [] }) => ({
  chart: { result: [{ meta, timestamp: timestamps, indicators: { quote: [{ close: closes }] } }] },
});
const resultOf = (args) => chart(args).chart.result[0];
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
const noFetch = async (url) => { throw new Error(`unexpected fetch: ${url}`); };

// Yahoo trading periods (Unix seconds); they abut, as Yahoo's do.
const PERIODS = { pre: { start: 0, end: 1000 }, regular: { start: 1000, end: 2000 }, post: { start: 2000, end: 3000 } };

// AAPL (a Nasdaq-100 member) last traded at 10 after a 9 prior close, and NQ is up 5 %.
// fetchNasdaqFutures caches per process for 60 s, so this is the run's ONLY NQ fixture.
const AAPL = chart({ meta: { regularMarketPrice: 10, regularMarketTime: 100, chartPreviousClose: 9 } });
const NQ = chart({ meta: { regularMarketPrice: 21000, regularMarketTime: 100, chartPreviousClose: 20000 } });
const stockAndFutures = async (url) => {
  const u = String(url);
  if (u.includes('/chart/NQ%3DF?')) return ok(NQ);
  if (u.includes('/chart/AAPL?')) return ok(AAPL);
  return new Response('unexpected upstream', { status: 500 });
};

export default async function run(ctx) {
  const { t, req, json, calls, assert, ROOT, setFetch } = ctx;
  console.log('liveQuote');
  const mod = await import(ROOT + 'getLiveQuote.js');
  const getLiveQuote = mod.default;
  const { selectQuoteCandidate, fetchYahooQuote } = mod;

  const near = (actual, expected, what) => assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${what}: expected ≈${expected}, got ${actual}`,
  );
  const pick = (meta, nowSec = 1000) => selectQuoteCandidate(resultOf({ meta }), nowSec);
  const REGULAR = { regularMarketPrice: 10, regularMarketTime: 100 };
  const ALL = { ...REGULAR, postMarketPrice: 11, postMarketTime: 200, preMarketPrice: 9, preMarketTime: 150 };

  await t('selectQuoteCandidate: newest timestamp wins, ties prefer regular > post > pre', async () => {
    setFetch(noFetch);
    assert.deepEqual(pick(ALL), { source: 'yahoo-post', price: 11, timestamp: 200 });
    assert.deepEqual(pick({ ...ALL, preMarketTime: 300 }), { source: 'yahoo-pre', price: 9, timestamp: 300 });
    assert.deepEqual(pick(REGULAR), { source: 'yahoo-regular', price: 10, timestamp: 100 });
    assert.deepEqual(pick({ ...ALL, regularMarketTime: 400 }), { source: 'yahoo-regular', price: 10, timestamp: 400 },
      'a live regular print beats older post/pre prices');
    assert.equal(pick({ ...ALL, regularMarketTime: 200 }).source, 'yahoo-regular', 'tie regular vs post');
    assert.equal(pick({ ...ALL, preMarketTime: 200 }).source, 'yahoo-post', 'tie post vs pre');
    assert.equal(calls.length, 0);
  });

  await t('selectQuoteCandidate: skips 0 / blank / non-numeric / future-stamped prices; null when none', async () => {
    setFetch(noFetch);
    assert.equal(pick({}), null);
    assert.equal(selectQuoteCandidate({}, 1000), null, 'no meta at all');
    assert.equal(pick({ regularMarketPrice: 0, regularMarketTime: 100 }), null);
    assert.equal(pick({ regularMarketPrice: -3, regularMarketTime: 100 }), null);
    assert.equal(pick({ ...REGULAR, postMarketPrice: 0, postMarketTime: 200 }).source, 'yahoo-regular', 'price 0');
    assert.equal(pick({ ...REGULAR, postMarketPrice: '', postMarketTime: 200 }).source, 'yahoo-regular', "price ''");
    assert.equal(pick({ ...REGULAR, postMarketPrice: 'abc', postMarketTime: 200 }).source, 'yahoo-regular', "price 'abc'");
    assert.equal(pick({ ...REGULAR, postMarketPrice: 11, postMarketTime: null }).source, 'yahoo-regular', 'no timestamp');
    assert.equal(pick({ ...REGULAR, postMarketPrice: 11, postMarketTime: 1000 + 10_000 }).source, 'yahoo-regular', 'future stamp');
    assert.equal(pick({ ...REGULAR, postMarketPrice: 11, postMarketTime: 1000 + 60 }).source, 'yahoo-post', 'within skew allowance');
    assert.deepEqual(pick({ regularMarketPrice: '10.5', regularMarketTime: '100' }), { source: 'yahoo-regular', price: 10.5, timestamp: 100 });
    assert.equal(calls.length, 0);
  });

  await t('selectQuoteCandidate: extended-hours candles beat stale meta; only candles <= now count', async () => {
    setFetch(noFetch);
    const result = resultOf({
      meta: { regularMarketPrice: 10, regularMarketTime: 1500, currentTradingPeriod: PERIODS },
      timestamps: [500, 2500], closes: [8, 12],
    });
    assert.deepEqual(selectQuoteCandidate(result, 2600), { source: 'yahoo-post', price: 12, timestamp: 2500 });
    assert.deepEqual(selectQuoteCandidate(result, 900), { source: 'yahoo-pre', price: 8, timestamp: 500 });
    assert.deepEqual(selectQuoteCandidate(result, 1600), { source: 'yahoo-regular', price: 10, timestamp: 1500 },
      "inside the session the regular print beats the morning's pre-market candle");
    const future = resultOf({
      meta: { regularMarketPrice: 10, regularMarketTime: 1500, currentTradingPeriod: PERIODS },
      timestamps: [2400, 2900], closes: [11, 13],
    });
    assert.deepEqual(selectQuoteCandidate(future, 2500), { source: 'yahoo-post', price: 11, timestamp: 2400 },
      'a candle after now is skipped without hiding the older candle in the same window');
    const gappy = resultOf({ meta: { currentTradingPeriod: PERIODS }, timestamps: [2400, 2500], closes: [11, null] });
    assert.deepEqual(selectQuoteCandidate(gappy, 2600), { source: 'yahoo-post', price: 11, timestamp: 2400 }, 'newest finite candle');
    const atOpen = resultOf({ meta: { currentTradingPeriod: PERIODS }, timestamps: [900, 1000], closes: [8, 9] });
    assert.deepEqual(selectQuoteCandidate(atOpen, 1100), { source: 'yahoo-pre', price: 8, timestamp: 900 },
      'windows are [start, end): the candle at pre.end belongs to the regular session');
    assert.equal(calls.length, 0);
  });

  await t('handler: newest price wins (post 11@2 over regular 10@1) → 200, ms timestamp, private cache', async () => {
    setFetch(async () => ok(chart({ meta: {
      regularMarketPrice: 10, regularMarketTime: 1, postMarketPrice: 11, postMarketTime: 2, chartPreviousClose: 10,
    } })));
    const r = await json(await getLiveQuote(req('getLiveQuote?ticker=AVGO')));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'yahoo-post'); assert.equal(r.body.current, 11); assert.equal(r.body.timestamp, 2000);
    near(r.body.changePercent, 10, 'changePercent');
    assert.equal(r.headers['cache-control'], 'private, max-age=60');
    assert.notEqual(r.body.source, 'futures-implied');
    assert.equal(calls.length, 1, 'only the chart is fetched: no NQ lookup when the newest price is post-market');
  });

  await t('regular session (Fri 11:00 ET): NQ not fetched, no futuresContext', async () => {
    setFetch(stockAndFutures);
    const q = await fetchYahooQuote('AAPL', null, { now: new Date('2026-09-25T15:00:00Z') });
    assert.equal(q.current, 10); assert.equal(q.source, 'yahoo-regular');
    assert.ok(calls.every((c) => !c.url.includes('NQ')), 'NQ must not be fetched while the equity session is open');
    assert.equal(q.futuresContext, undefined);
  });

  await t('market closed (Sat): NQ goes to futuresContext only; current/source/changePercent stay the stock\'s own', async () => {
    setFetch(stockAndFutures);
    const q = await fetchYahooQuote('AAPL', null, { now: new Date('2026-09-26T15:00:00Z') });
    assert.equal(q.current, 10, 'current is the last trade, not the NQ-implied estimate');
    assert.equal(q.source, 'yahoo-regular'); assert.notEqual(q.source, 'futures-implied');
    assert.equal(q.timestamp, 100_000);
    near(q.changePercent, 100 / 9, 'changePercent vs prior close');
    assert.ok(q.futuresContext, 'futuresContext expected while the market is closed');
    near(q.futuresContext.nqChangePercent, 5, 'nqChangePercent');
    near(q.futuresContext.impliedPrice, 9.45, 'impliedPrice');
    assert.equal(q.futuresContext.nqCurrent, 21000); assert.equal(q.futuresContext.nqPreviousClose, 20000);
  });

  await t('shared calendar: Thanksgiving 11:00 ET and a post-early-close afternoon count as closed', async () => {
    setFetch(stockAndFutures);
    const holiday = await fetchYahooQuote('AAPL', null, { now: new Date('2026-11-26T16:00:00Z') });
    assert.ok(holiday.futuresContext, 'Thanksgiving is a market holiday'); assert.equal(holiday.current, 10);
    const beforeEarlyClose = await fetchYahooQuote('AAPL', null, { now: new Date('2026-11-27T17:00:00Z') });
    assert.equal(beforeEarlyClose.futuresContext, undefined, '12:00 ET on the day after Thanksgiving is still open');
    const afterEarlyClose = await fetchYahooQuote('AAPL', null, { now: new Date('2026-11-27T19:00:00Z') });
    assert.ok(afterEarlyClose.futuresContext, '14:00 ET is after the 1 PM early close'); assert.equal(afterEarlyClose.current, 10);
  });

  await t('handler never answers source futures-implied (Nasdaq-100, regular-only price, either session)', async () => {
    setFetch(stockAndFutures);
    const r = await json(await getLiveQuote(req('getLiveQuote?ticker=AAPL')));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'yahoo-regular'); assert.equal(r.body.current, 10); assert.equal(r.body.timestamp, 100_000);
    near(r.body.changePercent, 100 / 9, 'changePercent');
    // Whether futuresContext is present depends on the wall clock; either way it is context only.
    if (r.body.futuresContext) near(r.body.futuresContext.impliedPrice, 9.45, 'impliedPrice');
  });

  const finnhubOnly = (body) => async (url) => (String(url).includes('finnhub.io') ? ok(body) : new Response('x', { status: 500 }));
  const byok = { headers: { 'x-finnhub-key': 'fh-user' } };

  await t('finnhub c:0 (unknown symbol) or non-numeric c → 502 QUOTE_UNAVAILABLE', async () => {
    setFetch(finnhubOnly({ c: 0, pc: 4, t: 1 }));
    const r = await json(await getLiveQuote(req('getLiveQuote?ticker=AVGO', byok)));
    assert.equal(r.status, 502, JSON.stringify(r.body)); assert.equal(r.body.code, 'QUOTE_UNAVAILABLE');
    assert.match(calls.find((c) => c.url.includes('finnhub.io')).url, /token=fh-user/, 'BYOK key used for Finnhub');
    setFetch(finnhubOnly({ c: 'abc' }));
    const r2 = await json(await getLiveQuote(req('getLiveQuote?ticker=AVGO', byok)));
    assert.equal(r2.status, 502, JSON.stringify(r2.body)); assert.equal(r2.body.code, 'QUOTE_UNAVAILABLE');
  });

  await t('finnhub numeric strings coerced to numbers; t → ms, missing t → null (not now)', async () => {
    setFetch(finnhubOnly({ c: '5.5', pc: '5', t: 7 }));
    const r = await json(await getLiveQuote(req('getLiveQuote?ticker=AVGO', byok)));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.current, 5.5); assert.equal(r.body.previousClose, 5);
    near(r.body.changePercent, 10, 'changePercent');
    assert.equal(r.body.source, 'finnhub'); assert.equal(r.body.timestamp, 7000);
    setFetch(finnhubOnly({ c: 5, pc: 4, t: 0 }));
    const r2 = await json(await getLiveQuote(req('getLiveQuote?ticker=AVGO', byok)));
    assert.equal(r2.status, 200, JSON.stringify(r2.body)); assert.equal(r2.body.timestamp, null);
  });
}
