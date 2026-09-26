// netlify/functions/__tests__/validateToken.test.js — the endpoint the client unlocks premium UI with: a valid
// token answers its tier and expiry, an expired one 401 TOKEN_EXPIRED, and an unconfigured server 503 without
// naming the missing variable.
import { describe, it } from 'vitest';
import validateToken from '../validateToken.js';
import { installFunctionHarness } from '../../../test/helpers/functions.js';

const { req, json, mint, assert, SECRET } = installFunctionHarness();

describe('validateToken', () => {
  it('valid token → tier/sub/expiresAt; expired → 401', async () => {
    process.env.TOKEN_SECRET = SECRET;
    const r = await json(await validateToken(req('validateToken', { method: 'POST', body: { token: mint() } })));
    assert.equal(r.status, 200); assert.equal(r.body.valid, true); assert.equal(r.body.tier, 'pro'); assert.ok(r.body.expiresAt);
    const r2 = await json(await validateToken(req('validateToken', { method: 'POST', body: { token: mint({}, { sign: { expiresIn: '-1s' } }) } })));
    assert.equal(r2.status, 401); assert.equal(r2.body.code, 'TOKEN_EXPIRED');
  });
  it('unconfigured → 503 without leaking config', async () => {
    const r = await json(await validateToken(req('validateToken', { method: 'POST', body: { token: 'abc' } })));
    assert.equal(r.status, 503); assert.ok(!/TOKEN_SECRET/.test(r.body.error));
  });
});
