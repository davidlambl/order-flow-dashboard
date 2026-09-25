// scripts/verify-functions.mjs
// Drives the Netlify Functions in-process with a stubbed upstream fetch and a
// controlled environment, asserting the auth / cost-control / validation
// behaviour introduced in roadmap Phase 1. No network, no real keys.
// Run: npm run verify:functions   (also runs in CI). Vitest replaces this in Phase 4b.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const ROOT = new URL('../netlify/functions/', import.meta.url).href;
const SECRET = 'x'.repeat(48);
const calls = [];
let fetchImpl = async () => new Response('{}', { status: 200 });
globalThis.fetch = (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(url, init); };

const { verifyAccessToken, TOKEN_ISSUER, TOKEN_AUDIENCE, _resetRevocationCache } = await import(ROOT + 'lib/auth.js');
const { _resetRateLimiter, rateLimit } = await import(ROOT + 'lib/http.js');
const askLLM = (await import(ROOT + 'askLLM.js')).default;
const { validatePayload, modelAllowed, maxOutputTokens } = await import(ROOT + 'askLLM.js');
const validateToken = (await import(ROOT + 'validateToken.js')).default;
const getMarketData = (await import(ROOT + 'getMarketData.js')).default;
const getTickerContext = (await import(ROOT + 'getTickerContext.js')).default;
const getLiveQuote = (await import(ROOT + 'getLiveQuote.js')).default;
const getModels = (await import(ROOT + 'getModels.js')).default;

const mint = (over = {}, opts = {}) => jwt.sign({ tier: 'pro', ...over }, opts.secret || SECRET, {
  algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, subject: 'tester', jwtid: 'jti-1', expiresIn: '1d', ...opts.sign,
});
const req = (path, { method = 'GET', body, headers = {} } = {}) => new Request(`https://site.test/.netlify/functions/${path}`, {
  method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
});
const json = async (res) => ({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.json().catch(() => null) });
const reset = () => { _resetRateLimiter(); _resetRevocationCache(); calls.length = 0; for (const k of ['TOKEN_SECRET','ANTHROPIC_API_KEY','TRADIER_API_KEY','FINNHUB_API_KEY','ALPHA_VANTAGE_KEY','SITE_ORIGIN','ALLOWED_MODELS','TRACKED_TICKERS','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_ANON_KEY','VITE_SUPABASE_URL','VITE_SUPABASE_ANON_KEY']) delete process.env[k]; };
let passed = 0;
const t = async (name, fn) => { reset(); try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };

console.log('lib/auth');
await t('rejects when TOKEN_SECRET unset (503 AUTH_NOT_CONFIGURED)', async () => {
  const r = await verifyAccessToken(mint()); assert.equal(r.code, 'AUTH_NOT_CONFIGURED'); assert.equal(r.status, 503);
});
await t('rejects a short secret as not configured', async () => {
  process.env.TOKEN_SECRET = 'short'; const r = await verifyAccessToken(mint({}, { secret: 'short' })); assert.equal(r.code, 'AUTH_NOT_CONFIGURED');
});
await t('accepts a well-formed token and normalizes tier', async () => {
  process.env.TOKEN_SECRET = SECRET; const r = await verifyAccessToken(mint({ tier: 'bogus' })); assert.equal(r.ok, true); assert.equal(r.claims.tier, 'trial'); assert.equal(r.claims.sub, 'tester');
});
await t('rejects legacy token without iss/aud/jti', async () => {
  process.env.TOKEN_SECRET = SECRET; const legacy = jwt.sign({ tier: 'pro' }, SECRET, { expiresIn: '1d' });
  const r = await verifyAccessToken(legacy); assert.equal(r.code, 'TOKEN_INVALID');
});
await t('rejects token without exp', async () => {
  process.env.TOKEN_SECRET = SECRET; const tok = jwt.sign({ tier: 'pro' }, SECRET, { algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, subject: 's', jwtid: 'j' });
  const r = await verifyAccessToken(tok); assert.equal(r.code, 'TOKEN_INVALID');
});
await t('rejects expired token with TOKEN_EXPIRED', async () => {
  process.env.TOKEN_SECRET = SECRET; const r = await verifyAccessToken(mint({}, { sign: { expiresIn: '-1s' } })); assert.equal(r.code, 'TOKEN_EXPIRED');
});
await t('rejects wrong algorithm (none / HS512) and wrong secret', async () => {
  process.env.TOKEN_SECRET = SECRET;
  const hs512 = jwt.sign({ tier: 'pro' }, SECRET, { algorithm: 'HS512', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, subject: 's', jwtid: 'j', expiresIn: '1d' });
  assert.equal((await verifyAccessToken(hs512)).code, 'TOKEN_INVALID');
  assert.equal((await verifyAccessToken(mint({}, { secret: 'y'.repeat(48) }))).code, 'TOKEN_INVALID');
});

console.log('askLLM');
const goodBody = { provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }], stream: true, ticker: 'AVGO' };
await t('validatePayload enforces shape limits', async () => {
  assert.equal(validatePayload({ ...goodBody, provider: 'x' }).error.code, 'PROVIDER_REQUIRED');
  assert.equal(validatePayload({ ...goodBody, messages: [] }).error.code, 'MESSAGES_REQUIRED');
  assert.equal(validatePayload({ ...goodBody, messages: Array(41).fill({ role: 'user', content: 'x' }) }).error.code, 'TOO_MANY_MESSAGES');
  assert.equal(validatePayload({ ...goodBody, messages: [{ role: 'user', content: [{ type: 'image' }] }] }).error.code, 'INVALID_MESSAGE');
  assert.equal(validatePayload({ ...goodBody, messages: [{ role: 'user', content: 'x'.repeat(9000) }] }).error.code, 'MESSAGE_TOO_LONG');
  assert.equal(validatePayload({ ...goodBody, financialContext: 'x'.repeat(40000) }).error.code, 'CONTEXT_TOO_LONG');
  assert.equal(validatePayload({ ...goodBody, ticker: '../x' }).error.code, 'INVALID_TICKER');
  assert.equal(validatePayload({ ...goodBody, model: 'gpt 4o' }).error.code, 'INVALID_MODEL');
  assert.equal(validatePayload({ ...goodBody, userApiKey: 'sk-openai' }).error.code, 'KEY_PROVIDER_MISMATCH');
  assert.equal(validatePayload(goodBody).value.model, 'claude-opus-5');
});
await t('model allowlist + output cap', async () => {
  assert.equal(modelAllowed('claude-opus-5'), true); assert.equal(modelAllowed('gpt-4o'), false);
  assert.equal(modelAllowed('claude-x', ['claude-haiku-4-5']), false);
  assert.equal(maxOutputTokens('claude-opus-5', 'server'), 4096); assert.equal(maxOutputTokens('claude-opus-5', 'user'), 16384);
  process.env.MAX_OUTPUT_TOKENS = '1000'; assert.equal(maxOutputTokens('claude-opus-5', 'server'), 1000); delete process.env.MAX_OUTPUT_TOKENS;
  assert.equal(maxOutputTokens('gpt-4-turbo', 'user'), 4096);
});
await t('fails CLOSED: server key present, TOKEN_SECRET unset → 503, upstream never called', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-server';
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
  assert.equal(r.status, 503); assert.equal(r.body.code, 'AUTH_NOT_CONFIGURED'); assert.equal(calls.length, 0);
});
await t('server key without token → 401 TOKEN_REQUIRED', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
  assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_REQUIRED'); assert.equal(calls.length, 0);
});
await t('no server key, no user key → 400 KEY_REQUIRED', async () => {
  process.env.TOKEN_SECRET = SECRET;
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'KEY_REQUIRED');
});
await t('token + disallowed model → 403 MODEL_NOT_ALLOWED', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, model: 'claude-opus-5' }, headers: { authorization: `Bearer ${mint()}` } })));
  assert.equal(r.status, 200, JSON.stringify(r.body)); // sanity: allowed by default
  reset(); process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET; process.env.ALLOWED_MODELS = 'claude-haiku-4-5';
  const r2 = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, model: 'claude-opus-5' }, headers: { authorization: `Bearer ${mint()}` } })));
  assert.equal(r2.status, 403); assert.equal(r2.body.code, 'MODEL_NOT_ALLOWED');
});
await t('token + server key streams through with capped max_tokens and X-Provider', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async () => new Response('data: {"type":"content_block_delta"}\n', { status: 200 });
  const res = await askLLM(req('askLLM', { method: 'POST', body: goodBody, headers: { authorization: `Bearer ${mint()}` } }));
  assert.equal(res.status, 200); assert.equal(res.headers.get('x-provider'), 'anthropic'); assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(calls.length, 1); const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.max_tokens, 4096); assert.equal(sent.model, 'claude-opus-5'); assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-server');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'timeout signal attached');
  fetchImpl = async () => new Response('{}', { status: 200 });
});
await t('BYOK openai: no token needed, key goes to OpenAI, no key-source leak', async () => {
  process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 });
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, stream: false, provider: 'openai', userApiKey: 'sk-user-openai', model: 'gpt-4o' } })));
  assert.equal(r.status, 200); assert.equal(r.body.message, 'hello');
  assert.match(calls[0].url, /api\.openai\.com/); assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-user-openai');
  fetchImpl = async () => new Response('{}', { status: 200 });
});
await t('BYOK gemini: key in header not URL, model encoded', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'g' }] } }] }), { status: 200 });
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, stream: false, provider: 'gemini', userApiKey: 'AIzaXYZ', model: 'gemini-2.0-flash' } })));
  assert.equal(r.status, 200); assert.ok(!calls[0].url.includes('AIzaXYZ'), 'key must not be in URL'); assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIzaXYZ');
  fetchImpl = async () => new Response('{}', { status: 200 });
});
await t('upstream 401 → sanitized message, no detail leak, requestId present', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'SECRET-DETAIL' } }), { status: 401 });
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, provider: 'openai', userApiKey: 'sk-u', model: 'gpt-4o' } })));
  assert.equal(r.status, 401); assert.ok(!JSON.stringify(r.body).includes('SECRET-DETAIL')); assert.ok(r.body.requestId);
  fetchImpl = async () => new Response('{}', { status: 200 });
});
await t('upstream timeout → 504', async () => {
  fetchImpl = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: { ...goodBody, provider: 'openai', userApiKey: 'sk-u', model: 'gpt-4o' } })));
  assert.equal(r.status, 504); assert.equal(r.body.code, 'UPSTREAM_TIMEOUT');
  fetchImpl = async () => new Response('{}', { status: 200 });
});
await t('rate limit → 429 with Retry-After', async () => {
  for (let i = 0; i < 30; i++) rateLimit('askLLM:unknown', { limit: 30, windowMs: 60000 });
  const r = await json(await askLLM(req('askLLM', { method: 'POST', body: goodBody })));
  assert.equal(r.status, 429); assert.ok(r.headers['retry-after']);
});

console.log('CORS');
await t('no ACAO header for unknown origin; echoed for SITE_ORIGIN', async () => {
  const r1 = await askLLM(req('askLLM', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }));
  assert.equal(r1.status, 204); assert.equal(r1.headers.get('access-control-allow-origin'), null);
  process.env.SITE_ORIGIN = 'https://dash.test, http://localhost:5173';
  const r2 = await askLLM(req('askLLM', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }));
  assert.equal(r2.headers.get('access-control-allow-origin'), 'http://localhost:5173'); assert.match(r2.headers.get('vary'), /Origin/);
});

console.log('validateToken');
await t('valid token → tier/sub/expiresAt; expired → 401', async () => {
  process.env.TOKEN_SECRET = SECRET;
  const r = await json(await validateToken(req('validateToken', { method: 'POST', body: { token: mint() } })));
  assert.equal(r.status, 200); assert.equal(r.body.valid, true); assert.equal(r.body.tier, 'pro'); assert.ok(r.body.expiresAt);
  const r2 = await json(await validateToken(req('validateToken', { method: 'POST', body: { token: mint({}, { sign: { expiresIn: '-1s' } }) } })));
  assert.equal(r2.status, 401); assert.equal(r2.body.code, 'TOKEN_EXPIRED');
});
await t('unconfigured → 503 without leaking config', async () => {
  const r = await json(await validateToken(req('validateToken', { method: 'POST', body: { token: 'abc' } })));
  assert.equal(r.status, 503); assert.ok(!/TOKEN_SECRET/.test(r.body.error));
});

console.log('getMarketData');
// Expiry 30 days out: past expiries are dropped by normalizeChain, so a fixed date would go stale.
const fixtureExpiry = new Date(Date.now() + 30 * 86400000).toISOString().slice(2, 10).replace(/-/g, '');
const cboeBody = { data: { current_price: 100, options: [{ option: `AVGO${fixtureExpiry}C00100000`, bid: 1, ask: 2, volume: 10, open_interest: 5, gamma: 0.01 }] } };
await t('invalid ticker → 400', async () => {
  const r = await json(await getMarketData(req('getMarketData?ticker=..%2Fx'))); assert.equal(r.status, 400); assert.equal(calls.length, 0);
});
await t('anonymous + server TRADIER key → CBOE only (server key never spent)', async () => {
  process.env.TRADIER_API_KEY = 'tr-server'; process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async () => new Response(JSON.stringify(cboeBody), { status: 200 });
  const r = await json(await getMarketData(req('getMarketData?ticker=avgo')));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.provider, 'cboe'); assert.equal(r.body.ticker, 'AVGO');
  assert.ok(calls.some((c) => c.url.includes('cboe.com')) && calls.every((c) => !c.url.includes('tradier')), 'CBOE called, Tradier never called');
  assert.equal(r.headers['cache-control'], 'private, max-age=60'); assert.match(r.headers['vary'], /x-tradier-key/);
});
await t('token holder → Tradier attempted with server key, URL built safely', async () => {
  process.env.TRADIER_API_KEY = 'tr-server'; process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async (url) => String(url).includes('tradier') ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(cboeBody), { status: 200 });
  const r = await json(await getMarketData(req('getMarketData?ticker=BRK.B', { headers: { authorization: `Bearer ${mint()}` } })));
  assert.equal(r.status, 200); assert.equal(r.body.provider, 'cboe'); assert.equal(r.body.fallbackReason, 'tradier-error');
  const tr = calls.find((c) => c.url.includes('tradier')); assert.ok(tr); assert.match(tr.url, /symbol=BRK\.B/); assert.equal(tr.init.headers.Authorization, 'Bearer tr-server');
});
await t('BYOK tradier header used without token', async () => {
  process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async (url) => String(url).includes('tradier') ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(cboeBody), { status: 200 });
  await getMarketData(req('getMarketData?ticker=AVGO', { headers: { 'x-tradier-key': 'tr-user' } }));
  const tr = calls.find((c) => c.url.includes('tradier')); assert.equal(tr.init.headers.Authorization, 'Bearer tr-user');
});

console.log('getTickerContext');
await t('no key, no token → 401 KEY_REQUIRED, no upstream', async () => {
  process.env.FINNHUB_API_KEY = 'fh-server'; process.env.TOKEN_SECRET = SECRET;
  const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO'))); assert.equal(r.status, 401); assert.equal(r.body.code, 'KEY_REQUIRED'); assert.equal(calls.length, 0);
});
await t('BYOK finnhub: called with user key, Alpha Vantage NOT called', async () => {
  process.env.FINNHUB_API_KEY = 'fh-server'; process.env.ALPHA_VANTAGE_KEY = 'av'; process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async () => new Response('[]', { status: 200 });
  const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO', { headers: { 'x-finnhub-key': 'fh-user' } })));
  assert.equal(r.status, 200); assert.ok(calls.length > 5);
  assert.ok(calls.every((c) => !c.url.includes('alphavantage')), 'AV must not be called for anonymous BYOK');
  assert.ok(calls.every((c) => c.url.includes('token=fh-user')));
  assert.ok(calls.every((c) => !c.url.includes('fh-server')));
});
await t('token holder: server finnhub key + Alpha Vantage', async () => {
  process.env.FINNHUB_API_KEY = 'fh-server'; process.env.ALPHA_VANTAGE_KEY = 'av'; process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async () => new Response('[]', { status: 200 });
  const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO', { headers: { authorization: `Bearer ${mint()}` } })));
  assert.equal(r.status, 200); assert.ok(calls.some((c) => c.url.includes('alphavantage')));
  const av = calls.find((c) => c.url.includes('alphavantage')); assert.match(av.url, /symbol=AVGO/);
});
await t('presented-but-expired token → 401 TOKEN_EXPIRED', async () => {
  process.env.FINNHUB_API_KEY = 'fh-server'; process.env.TOKEN_SECRET = SECRET;
  const r = await json(await getTickerContext(req('getTickerContext?ticker=AVGO', { headers: { authorization: `Bearer ${mint({}, { sign: { expiresIn: '-1s' } })}` } })));
  assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_EXPIRED');
});

console.log('getLiveQuote');
await t('yahoo ok → 200 private cache; ticker encoded', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 10, regularMarketTime: 1, chartPreviousClose: 9 }, timestamp: [], indicators: { quote: [{}] } }] } }), { status: 200 });
  const r = await json(await getLiveQuote(req('getLiveQuote?ticker=brk.b')));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.headers['cache-control'], 'private, max-age=60'); assert.match(calls[0].url, /chart\/BRK\.B\?/);
});
await t('yahoo down, anonymous, server finnhub key → 502 generic (key not spent)', async () => {
  process.env.FINNHUB_API_KEY = 'fh-server'; process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async () => new Response('x', { status: 500 });
  const r = await json(await getLiveQuote(req('getLiveQuote?ticker=AVGO')));
  assert.equal(r.status, 502); assert.equal(r.body.code, 'QUOTE_UNAVAILABLE'); assert.ok(calls.every((c) => !c.url.includes('finnhub')));
  assert.equal(r.headers['cache-control'], 'no-store');
});
await t('yahoo down, token holder → finnhub fallback with server key', async () => {
  process.env.FINNHUB_API_KEY = 'fh-server'; process.env.TOKEN_SECRET = SECRET;
  fetchImpl = async (url) => String(url).includes('finnhub') ? new Response(JSON.stringify({ c: 5, pc: 4, t: 1 }), { status: 200 }) : new Response('x', { status: 500 });
  const r = await json(await getLiveQuote(req('getLiveQuote?ticker=AVGO', { headers: { authorization: `Bearer ${mint()}` } })));
  assert.equal(r.status, 200); assert.equal(r.body.source, 'finnhub');
});

console.log('getModels');
await t('server key without token → 401; BYOK gemini uses header', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-server'; process.env.TOKEN_SECRET = SECRET;
  const r = await json(await getModels(req('getModels?provider=anthropic'))); assert.equal(r.status, 401); assert.equal(calls.length, 0);
  fetchImpl = async () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.0-flash', displayName: 'F', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
  const r2 = await json(await getModels(req('getModels?provider=gemini', { headers: { 'x-api-key': 'AIzaK' } })));
  assert.equal(r2.status, 200); assert.equal(r2.body.models[0].id, 'gemini-2.0-flash'); assert.ok(!calls[0].url.includes('AIzaK')); assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIzaK');
});

// Phase 2 checks live in scripts/verify/<area>.mjs (one module per area) and share this
// runner's helpers through `ctx`. t() resets env, rate limiter, revocation cache and `calls`
// but not the fetch stub: every check sets its own stub with ctx.setFetch().
const ctx = {
  t, req, json, mint, calls, assert, ROOT, SECRET,
  setFetch: (fn) => { fetchImpl = fn; },
  resetFetch: () => { fetchImpl = async () => new Response('{}', { status: 200 }); },
};
for (const name of ['calendar', 'marketData', 'liveQuote', 'tickerContext', 'collector']) {
  await (await import(`./verify/${name}.mjs`)).default(ctx);
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
