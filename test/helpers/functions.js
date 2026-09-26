// test/helpers/functions.js — what the Netlify function tests share: the verify runner's ctx
// (scripts/verify-functions.mjs) lifted into a module, so its checks move over unchanged. Function tests live in
// netlify/functions/__tests__/ (Netlify deploys every top-level file of netlify/functions/ as a function) and
// call installFunctionHarness() once, at the top level of the file.
// Imports the functions' own lib modules, never src/: the same module instances the functions under test use.
import { afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { TOKEN_ISSUER, TOKEN_AUDIENCE, _resetRevocationCache } from '../../netlify/functions/lib/auth.js';
import { _resetRateLimiter } from '../../netlify/functions/lib/http.js';
import { installFetchRecorder } from './fetch.js';

/** node:assert/strict, the runner's assertion library (its checks move over as they are). */
export { assert };

/** The access-token secret tests set as TOKEN_SECRET and sign with (48 characters, above the 32 minimum). */
export const SECRET = 'x'.repeat(48);

/**
 * Sign an access token the functions accept once TOKEN_SECRET = SECRET.
 * @param {object} [over] claims merged over `{ tier: 'pro' }`
 * @param {{ secret?: string, sign?: import('jsonwebtoken').SignOptions }} [opts] `secret` signs with another key
 *   instead of SECRET; `sign` overrides the signing options (`{ expiresIn: '-1s' }` for an expired token)
 * @returns {string} an HS256 JWT with the functions' issuer and audience, subject 'tester', jwtid 'jti-1',
 *   valid for a day
 */
export const mint = (over = {}, opts = {}) => jwt.sign({ tier: 'pro', ...over }, opts.secret || SECRET, {
  algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, subject: 'tester', jwtid: 'jti-1', expiresIn: '1d', ...opts.sign,
});

/**
 * A request to a function, as the Netlify runtime hands it over.
 * @param {string} path the function name plus any query string, e.g. `'getMarketData?ticker=AVGO'`
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [options] `body` is sent as
 *   JSON; content-type application/json is always set, and `headers` add to or override it
 * @returns {Request} for `https://site.test/.netlify/functions/<path>`
 */
export const req = (path, { method = 'GET', body, headers = {} } = {}) => new Request(`https://site.test/.netlify/functions/${path}`, {
  method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
});

/**
 * A function's response, read into plain values to assert on.
 * @param {Response} res
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: any }>} header names in lower
 *   case; `body` is the parsed JSON, or null when the body is not JSON
 */
export const json = async (res) => ({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.json().catch(() => null) });

/**
 * The environment variables the functions read per request. resetFunctionState() deletes them all, so every
 * test starts unconfigured and sets only what it needs.
 */
export const FUNCTION_ENV_KEYS = [
  'TOKEN_SECRET', 'ANTHROPIC_API_KEY', 'TRADIER_API_KEY', 'FINNHUB_API_KEY', 'ALPHA_VANTAGE_KEY', 'SITE_ORIGIN',
  'ALLOWED_MODELS', 'TRACKED_TICKERS', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
  // Beyond the runner's list: the CORS allowlist (lib/http.js), the output cap (askLLM.js), the daily quotas
  // (lib/quota.js).
  'URL', 'DEPLOY_PRIME_URL', 'MAX_OUTPUT_TOKENS', 'DAILY_REQUEST_QUOTA_TRIAL', 'DAILY_REQUEST_QUOTA_PRO',
];

/**
 * Put the functions' per-instance state back: the rate limiter (lib/http.js), the token revocation cache
 * (lib/auth.js) and every FUNCTION_ENV_KEYS variable. Leaves fetch alone.
 */
export function resetFunctionState() {
  _resetRateLimiter();
  _resetRevocationCache();
  for (const k of FUNCTION_ENV_KEYS) delete process.env[k];
}

/**
 * Set up a function test file; call it once, at the top level. Installs the fetch recorder right away; before
 * each test resets the function state, empties `calls` and restores the default fetch (`{}`, status 200);
 * after the file, puts the original fetch back.
 * @returns {{
 *   calls: Array<{ url: string, init: RequestInit|undefined }>,
 *   setFetch: (fn: import('./fetch.js').FetchImpl) => void,
 *   resetFetch: () => void,
 *   reset: () => void,
 *   req: typeof req, json: typeof json, mint: typeof mint, assert: typeof assert, SECRET: string,
 * }} `reset` is what runs before each test, for a check that needs a clean slate halfway through
 */
export function installFunctionHarness() {
  const { calls, setFetch, resetFetch, uninstall } = installFetchRecorder();
  const reset = () => { resetFunctionState(); calls.length = 0; resetFetch(); };
  beforeEach(reset);
  afterAll(() => uninstall());
  return { calls, setFetch, resetFetch, reset, req, json, mint, assert, SECRET };
}
