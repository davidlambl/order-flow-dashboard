// scripts/verify/marketData.mjs — Phase 2 checks; loaded by scripts/verify-functions.mjs with its helpers.
// getMarketData: provider answers validated before they are accepted (Tradier → CBOE fallback with
// `fallbackReason`), one expiry window for every provider, and honest metrics (P/C null without
// call volume, max pain skipping closed expiries, no fake Tradier IV30).
import { etDateString } from '../../shared/marketCalendar.js';

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 'YYYY-MM-DD' `days` after today's Eastern-Time date. */
function isoFromToday(days) {
  const d = new Date(`${etDateString(new Date())}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** OCC symbol: ticker + YYMMDD (today ET + daysFromNow) + C|P + strike × 1000 padded to 8. */
function sym(ticker, daysFromNow, type, strike) {
  const yymmdd = isoFromToday(daysFromNow).slice(2).replace(/-/g, '');
  return `${ticker}${yymmdd}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

/** Provider-neutral fixtures: calls and/or puts at 90/100/110 on each relative expiry. */
function contractsFor(days, { calls = true, puts = true } = {}) {
  const out = [];
  for (const d of days) {
    for (const strike of [90, 100, 110]) {
      if (calls) out.push({ symbol: sym('AVGO', d, 'C', strike), bid: 1.1, ask: 1.3, volume: 30 + strike - 90, oi: 300 - strike, gamma: 0.02, delta: 0.5 });
      if (puts) out.push({ symbol: sym('AVGO', d, 'P', strike), bid: 0.9, ask: 1.1, volume: 20 + (strike - 90) / 2, oi: 100 + strike, gamma: 0.015, delta: -0.5 });
    }
  }
  return out;
}

const toTradier = (c) => ({ symbol: c.symbol, bid: c.bid, ask: c.ask, volume: c.volume, open_interest: c.oi, greeks: { gamma: c.gamma, delta: c.delta } });
const toCboe = (c) => ({ option: c.symbol, bid: c.bid, ask: c.ask, volume: c.volume, open_interest: c.oi, gamma: c.gamma, delta: c.delta });
const timeoutError = () => Object.assign(new Error('t'), { name: 'TimeoutError' });

export default async function run(ctx) {
  console.log('marketData');
  const { t, req, json, mint, calls, assert, ROOT, SECRET, setFetch } = ctx;
  const getMarketData = (await import(ROOT + 'getMarketData.js')).default;
  const {
    fetchTradier, computeMaxPain, computePutCallRatio, parseOptionSymbol, EXPIRY_WINDOW,
  } = await import(ROOT + 'lib/marketDataHelpers.js');

  const expiryOf = (symbol) => parseOptionSymbol(symbol).expiry;

  /** Tradier API stub: expirations = the fixtures' expiries; chains answer per ?expiration=, unless `chain(exp)` returns a Response. */
  function tradierApi({ contracts = [], quote = {}, chain = () => null } = {}) {
    const expirations = [...new Set(contracts.map((c) => expiryOf(c.symbol)))].sort();
    return (u) => {
      if (u.pathname.endsWith('/options/expirations')) return jsonRes({ expirations: { date: expirations } });
      if (u.pathname.endsWith('/quotes')) {
        return jsonRes({ quotes: { quote: { last: 100, change: 1.5, change_percentage: 1.5, volume: 2_000_000, trade_date: 1, ...quote } } });
      }
      if (u.pathname.endsWith('/options/chains')) {
        const exp = u.searchParams.get('expiration');
        return chain(exp) || jsonRes({ options: { option: contracts.filter((c) => expiryOf(c.symbol) === exp).map(toTradier) } });
      }
      return jsonRes({}, 404);
    };
  }

  /** CBOE delayed-quotes stub. */
  function cboeApi({ contracts = [], price = 100, status = 200 } = {}) {
    return () => (status === 200
      ? jsonRes({ data: { current_price: price, price_change: 1.5, price_change_percent: 1.5, volume: 2_000_000, options: contracts.map(toCboe) } })
      : jsonRes({ error: 'upstream down' }, status));
  }

  /** Route stubbed fetches by host; a provider the check did not stub fails loudly. */
  function stub({ tradier, cboe }) {
    return async (url) => {
      const u = new URL(String(url));
      if (u.hostname.endsWith('tradier.com')) {
        if (!tradier) throw new Error(`unexpected Tradier call: ${u}`);
        return tradier(u);
      }
      if (u.hostname.endsWith('cboe.com')) {
        if (!cboe) throw new Error(`unexpected CBOE call: ${u}`);
        return cboe(u);
      }
      return jsonRes({}, 404);
    };
  }

  /** Configure the server Tradier key + token secret; returns headers carrying a valid access token. */
  const tokenHolder = () => {
    process.env.TOKEN_SECRET = SECRET;
    process.env.TRADIER_API_KEY = 'tr-server';
    return { authorization: `Bearer ${mint()}` };
  };
  const get = async (headers = {}) => json(await getMarketData(req('getMarketData?ticker=AVGO', { headers })));
  const called = (host) => calls.some((c) => c.url.includes(host));

  await t('Tradier valid → served by Tradier: no fallback, window ≤ 6, max pain expiry in window, iv30 null', async () => {
    const headers = tokenHolder();
    const contracts = contractsFor([7, 14]);
    setFetch(stub({ tradier: tradierApi({ contracts }) }));
    const r = await get(headers);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider, 'tradier');
    assert.equal(r.body.fallbackReason, null);
    assert.ok(!called('cboe.com'), 'CBOE must not be called when Tradier data is valid');
    assert.ok(r.body.expiries.length >= 1 && r.body.expiries.length <= EXPIRY_WINDOW);
    assert.deepEqual(r.body.expiries, [isoFromToday(7), isoFromToday(14)]);
    assert.ok(r.body.expiries.includes(r.body.kpis.maxPainExpiry), `maxPainExpiry ${r.body.kpis.maxPainExpiry} not in the window`);
    assert.ok(Number.isFinite(r.body.kpis.maxPain) && r.body.kpis.maxPain > 0);
    assert.equal(r.body.iv30, null);
    assert.equal(r.body.kpis.darkPoolPct, null, 'no IV30 → no dark-pool estimate');
    assert.equal(r.body.totalOptionsCount, contracts.length);
    assert.equal(r.headers['cache-control'], 'private, max-age=60');
    assert.match(r.headers.vary, /Authorization/);
  });

  await t('Tradier quote without spot (last 0, no close) → CBOE, fallbackReason tradier-no-spot', async () => {
    const headers = tokenHolder();
    const contracts = contractsFor([7, 14]);
    setFetch(stub({ tradier: tradierApi({ contracts, quote: { last: 0 } }), cboe: cboeApi({ contracts }) }));
    const r = await get(headers);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider, 'cboe');
    assert.equal(r.body.fallbackReason, 'tradier-no-spot');
    assert.ok(called('tradier.com') && called('cboe.com'));
  });

  await t('Tradier chains all empty ({ options: null }) → CBOE, fallbackReason tradier-no-options', async () => {
    const headers = tokenHolder();
    const contracts = contractsFor([7, 14]);
    setFetch(stub({ tradier: tradierApi({ contracts, chain: () => jsonRes({ options: null }) }), cboe: cboeApi({ contracts }) }));
    const r = await get(headers);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider, 'cboe');
    assert.equal(r.body.fallbackReason, 'tradier-no-options');
    assert.equal(r.body.totalOptionsCount, contracts.length);
  });

  await t('Tradier timeout (every call, or just the quote) → CBOE, fallbackReason tradier-timeout', async () => {
    const headers = tokenHolder();
    const contracts = contractsFor([7, 14]);
    setFetch(stub({ tradier: () => { throw timeoutError(); }, cboe: cboeApi({ contracts }) }));
    const r = await get(headers);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider, 'cboe');
    assert.equal(r.body.fallbackReason, 'tradier-timeout');

    const api = tradierApi({ contracts });
    setFetch(stub({ tradier: (u) => { if (u.pathname.endsWith('/quotes')) throw timeoutError(); return api(u); }, cboe: cboeApi({ contracts }) }));
    const r2 = await get(headers);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.provider, 'cboe');
    assert.equal(r2.body.fallbackReason, 'tradier-timeout');
  });

  await t('CBOE unusable after fallback → its code + fallbackReason; CBOE down → generic 502; expired-only chain → 404', async () => {
    const headers = tokenHolder();
    const contracts = contractsFor([7, 14]);
    setFetch(stub({ tradier: tradierApi({ contracts, quote: { last: 0 } }), cboe: cboeApi({ contracts, price: 0 }) }));
    const r = await get(headers);
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(r.body.code, 'NO_SPOT_PRICE');
    assert.equal(r.body.provider, 'cboe');
    assert.equal(r.body.fallbackReason, 'tradier-no-spot');
    assert.equal(r.headers['cache-control'], 'no-store');

    setFetch(stub({ tradier: tradierApi({ contracts, quote: { last: 0 } }), cboe: cboeApi({ status: 500 }) }));
    const r2 = await get(headers);
    assert.equal(r2.status, 502, JSON.stringify(r2.body));
    assert.equal(r2.body.code, 'UPSTREAM_ERROR');
    assert.deepEqual(Object.keys(r2.body).sort(), ['code', 'error', 'requestId'], 'generic body only');
    assert.equal(r2.headers['cache-control'], 'no-store');

    // Anonymous: CBOE serves only an already-expired expiry → nothing in the window.
    setFetch(stub({ cboe: cboeApi({ contracts: contractsFor([-7]) }) }));
    const r3 = await get();
    assert.equal(r3.status, 404, JSON.stringify(r3.body));
    assert.equal(r3.body.code, 'NO_OPTIONS');
    assert.equal(r3.body.fallbackReason, null);
  });

  await t('expiry window: past expiries dropped, 6 nearest kept, metrics computed on the window only', async () => {
    const days = [7, 14, 21, 28, 35, 42, 49, 56];
    const contracts = contractsFor([-7, ...days]);
    setFetch(stub({ cboe: cboeApi({ contracts }) }));
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expiries.length, 6);
    const today = etDateString(new Date());
    assert.ok(r.body.expiries.every((e) => e >= today), `past expiry served: ${r.body.expiries}`);
    assert.deepEqual(r.body.expiries, days.slice(0, 6).map(isoFromToday));
    const inWindow = contracts.filter((c) => r.body.expiries.includes(expiryOf(c.symbol)));
    assert.equal(r.body.totalOptionsCount, inWindow.length);
    const callVolume = inWindow.filter((c) => parseOptionSymbol(c.symbol).type === 'call').reduce((s, c) => s + c.volume, 0);
    assert.equal(r.body.kpis.callVolume, callVolume, 'P/C inputs limited to the window');
  });

  await t('P/C ratios are null (not 0) without call volume / OI', async () => {
    setFetch(stub({ cboe: cboeApi({ contracts: contractsFor([7, 14], { calls: false }) }) }));
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kpis.putCallRatio, null);
    assert.equal(r.body.kpis.putCallOIRatio, null);
    assert.equal(r.body.kpis.callVolume, 0);
    assert.ok(r.body.kpis.putVolume > 0);
    assert.deepEqual(computePutCallRatio([]), { volumeRatio: null, oiRatio: null, callVolume: 0, putVolume: 0, callOI: 0, putOI: 0 });
  });

  await t('computeMaxPain skips a closed 0DTE and expiries without OI; null (never 0) when nothing is open', async () => {
    const c = (date, type, strike, openInterest) => ({
      symbol: `AVGO${date.slice(2).replace(/-/g, '')}${type}${String(strike * 1000).padStart(8, '0')}`, openInterest,
    });
    // 2026-09-25 is a Friday: pain is 0 at 100 there; on 2026-10-02 it is 0 at 110.
    const sep25 = [c('2026-09-25', 'C', 100, 10), c('2026-09-25', 'P', 100, 10), c('2026-09-25', 'C', 110, 1), c('2026-09-25', 'P', 90, 1)];
    const oct02 = [c('2026-10-02', 'C', 110, 10), c('2026-10-02', 'P', 110, 10), c('2026-10-02', 'C', 120, 1), c('2026-10-02', 'P', 100, 1)];
    const afterClose = new Date('2026-09-25T20:16:00Z'); // 4:16 PM ET: the 0DTE stopped trading at 4:15
    const beforeClose = new Date('2026-09-25T19:00:00Z'); // 3:00 PM ET
    assert.deepEqual(computeMaxPain([...sep25, ...oct02], { now: afterClose }), { strike: 110, expiry: '2026-10-02' });
    const open = computeMaxPain([...oct02, ...sep25], { now: beforeClose });
    assert.deepEqual(open, { strike: 100, expiry: '2026-09-25' });
    assert.ok(Number.isFinite(open.strike));
    const noOi = (list) => list.map((o) => ({ ...o, openInterest: 0 }));
    assert.deepEqual(computeMaxPain([...noOi(sep25), ...oct02], { now: beforeClose }), { strike: 110, expiry: '2026-10-02' });
    assert.equal(computeMaxPain([c('2026-09-18', 'C', 100, 10), c('2026-09-24', 'P', 100, 5)], { now: beforeClose }), null);
    assert.equal(computeMaxPain([...noOi(sep25), ...noOi(oct02)], { now: beforeClose }), null);
    assert.equal(computeMaxPain([], { now: beforeClose }), null);
  });

  await t('provider parity: the same contracts via Tradier and via CBOE → identical metrics and window', async () => {
    const headers = tokenHolder();
    const contracts = contractsFor([3, 7, 14, 21, 28, 35, 42, 49]); // 8 expiries: both sides end on the same 6
    setFetch(stub({ tradier: tradierApi({ contracts }) }));
    const viaTradier = await get(headers);
    setFetch(stub({ cboe: cboeApi({ contracts }) }));
    const viaCboe = await get(); // anonymous → CBOE
    assert.equal(viaTradier.body.provider, 'tradier', JSON.stringify(viaTradier.body));
    assert.equal(viaCboe.body.provider, 'cboe', JSON.stringify(viaCboe.body));
    assert.equal(viaTradier.body.expiries.length, 6);
    assert.deepEqual(viaTradier.body.expiries, viaCboe.body.expiries);
    for (const key of ['netPremium', 'callPremium', 'putPremium', 'putCallRatio', 'putCallOIRatio', 'maxPain', 'maxPainExpiry', 'callVolume', 'putVolume', 'callOI', 'putOI']) {
      assert.equal(viaTradier.body.kpis[key], viaCboe.body.kpis[key], `kpis.${key}`);
    }
    assert.equal(viaTradier.body.totalOptionsCount, viaCboe.body.totalOptionsCount);
    assert.deepEqual(viaTradier.body.gexByStrike, viaCboe.body.gexByStrike);
  });

  await t('fetchTradier: a failed chain is tolerated; all chains failed → throws and the handler falls back', async () => {
    const headers = tokenHolder();
    const contracts = contractsFor([7, 14]);
    const firstFails = tradierApi({ contracts, chain: (exp) => (exp === isoFromToday(7) ? jsonRes({}, 500) : null) });
    setFetch(stub({ tradier: firstFails }));
    const r = await get(headers);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider, 'tradier');
    assert.equal(r.body.fallbackReason, null);
    assert.deepEqual(r.body.expiries, [isoFromToday(14)]);

    // One chain answers 500, the other throws (network error): nothing usable.
    const allFail = tradierApi({
      contracts,
      chain: (exp) => { if (exp === isoFromToday(7)) return jsonRes({}, 500); throw new Error('socket hang up'); },
    });
    setFetch(stub({ tradier: allFail, cboe: cboeApi({ contracts }) }));
    await assert.rejects(fetchTradier('AVGO', 'tr-key'), /all chain fetches failed/);
    const r2 = await get(headers);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.provider, 'cboe');
    assert.ok(['tradier-no-options', 'tradier-error'].includes(r2.body.fallbackReason), `fallbackReason ${r2.body.fallbackReason}`);
  });

  ctx.resetFetch();
}
