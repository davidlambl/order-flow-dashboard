// netlify/functions/__tests__/auth.test.js — access-token verification in lib/auth.js (roadmap Phase 1): without
// TOKEN_SECRET, or with one under 32 characters, nothing verifies; a token must be HS256, signed with the secret and
// carry the functions' issuer and audience, a jti and an expiry.
import { describe, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { verifyAccessToken, TOKEN_ISSUER, TOKEN_AUDIENCE } from '../lib/auth.js';
import { installFunctionHarness } from '../../../test/helpers/functions.js';

const { mint, assert, SECRET } = installFunctionHarness();

describe('lib/auth', () => {
  it('rejects when TOKEN_SECRET unset (503 AUTH_NOT_CONFIGURED)', async () => {
    const r = await verifyAccessToken(mint()); assert.equal(r.code, 'AUTH_NOT_CONFIGURED'); assert.equal(r.status, 503);
  });
  it('rejects a short secret as not configured', async () => {
    process.env.TOKEN_SECRET = 'short'; const r = await verifyAccessToken(mint({}, { secret: 'short' })); assert.equal(r.code, 'AUTH_NOT_CONFIGURED');
  });
  it('accepts a well-formed token and normalizes tier', async () => {
    process.env.TOKEN_SECRET = SECRET; const r = await verifyAccessToken(mint({ tier: 'bogus' })); assert.equal(r.ok, true); assert.equal(r.claims.tier, 'trial'); assert.equal(r.claims.sub, 'tester');
  });
  it('rejects legacy token without iss/aud/jti', async () => {
    process.env.TOKEN_SECRET = SECRET; const legacy = jwt.sign({ tier: 'pro' }, SECRET, { expiresIn: '1d' });
    const r = await verifyAccessToken(legacy); assert.equal(r.code, 'TOKEN_INVALID');
  });
  it('rejects token without exp', async () => {
    process.env.TOKEN_SECRET = SECRET; const tok = jwt.sign({ tier: 'pro' }, SECRET, { algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, subject: 's', jwtid: 'j' });
    const r = await verifyAccessToken(tok); assert.equal(r.code, 'TOKEN_INVALID');
  });
  it('rejects expired token with TOKEN_EXPIRED', async () => {
    process.env.TOKEN_SECRET = SECRET; const r = await verifyAccessToken(mint({}, { sign: { expiresIn: '-1s' } })); assert.equal(r.code, 'TOKEN_EXPIRED');
  });
  it('rejects wrong algorithm (none / HS512) and wrong secret', async () => {
    process.env.TOKEN_SECRET = SECRET;
    const hs512 = jwt.sign({ tier: 'pro' }, SECRET, { algorithm: 'HS512', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, subject: 's', jwtid: 'j', expiresIn: '1d' });
    assert.equal((await verifyAccessToken(hs512)).code, 'TOKEN_INVALID');
    assert.equal((await verifyAccessToken(mint({}, { secret: 'y'.repeat(48) }))).code, 'TOKEN_INVALID');
  });
});
