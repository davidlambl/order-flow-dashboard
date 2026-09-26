// scripts/verify-functions.mjs
// Runs the client-side checks in scripts/verify/<area>.mjs (pure src/lib modules loaded under Node) with a
// stubbed fetch and a controlled environment. No network, no real keys. The function and calendar checks now
// live in Vitest (netlify/functions/__tests__/, shared/marketCalendar.test.js); the client areas move in the
// next commit.
// Run: npm run verify:functions   (also runs in CI). Vitest replaces this in Phase 4b.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const ROOT = new URL('../netlify/functions/', import.meta.url).href;
const SECRET = 'x'.repeat(48);
const calls = [];
let fetchImpl = async () => new Response('{}', { status: 200 });
globalThis.fetch = (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(url, init); };

const { TOKEN_ISSUER, TOKEN_AUDIENCE, _resetRevocationCache } = await import(ROOT + 'lib/auth.js');
const { _resetRateLimiter } = await import(ROOT + 'lib/http.js');

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

// Phase 2 checks live in scripts/verify/<area>.mjs (one module per area) and share this
// runner's helpers through `ctx`. t() resets env, rate limiter, revocation cache and `calls`
// but not the fetch stub: every check sets its own stub with ctx.setFetch().
const ctx = {
  t, req, json, mint, calls, assert, ROOT, SECRET,
  setFetch: (fn) => { fetchImpl = fn; },
  resetFetch: () => { fetchImpl = async () => new Response('{}', { status: 200 }); },
};
for (const name of ['recommend', 'clientLib', 'charts', 'sse', 'saver', 'store', 'sync']) {
  await (await import(`./verify/${name}.mjs`)).default(ctx);
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
