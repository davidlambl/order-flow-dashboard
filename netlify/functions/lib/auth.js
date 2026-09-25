// netlify/functions/lib/auth.js
// Access-token verification shared by every function that spends a server-side
// API key. Fail closed: if TOKEN_SECRET is not configured, nothing that would
// use a server key is allowed.

import jwt from 'jsonwebtoken';

export const TOKEN_ISSUER = 'order-flow-dashboard';
export const TOKEN_AUDIENCE = 'order-flow-api';
export const TOKEN_ALGORITHM = 'HS256';
export const MIN_SECRET_LENGTH = 32;
export const VALID_TIERS = ['trial', 'pro'];

export function authConfigured() {
  const s = process.env.TOKEN_SECRET;
  return typeof s === 'string' && s.length >= MIN_SECRET_LENGTH;
}

export function bearerFromRequest(req) {
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

// ─── Revocation (jti denylist in Supabase; skipped when Supabase is not configured) ──

const REVOCATION_CACHE_TTL = 60 * 1000;
let revokedCache = { at: 0, set: new Set() };

async function loadRevoked() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return new Set();
  if (Date.now() - revokedCache.at < REVOCATION_CACHE_TTL) return revokedCache.set;
  try {
    const { getSupabaseAdmin } = await import('./supabaseAdmin.js');
    const { data, error } = await getSupabaseAdmin().from('revoked_tokens').select('jti');
    if (error) throw new Error(error.message);
    revokedCache = { at: Date.now(), set: new Set((data || []).map((r) => r.jti)) };
  } catch (err) {
    // Keep the previous cache on failure rather than failing every request.
    console.warn('revoked_tokens lookup failed:', err.message);
    revokedCache.at = Date.now();
  }
  return revokedCache.set;
}

/** For tests. */
export function _resetRevocationCache() {
  revokedCache = { at: 0, set: new Set() };
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Verify a bearer token.
 * @returns {Promise<{ok:true, claims:object} | {ok:false, status:number, code:string, message:string}>}
 */
export async function verifyAccessToken(token) {
  if (!authConfigured()) {
    return {
      ok: false, status: 503, code: 'AUTH_NOT_CONFIGURED',
      message: 'Access tokens are not configured on this server',
    };
  }
  if (!token) {
    return { ok: false, status: 401, code: 'TOKEN_REQUIRED', message: 'Access token required' };
  }

  let claims;
  try {
    claims = jwt.verify(token, process.env.TOKEN_SECRET, {
      algorithms: [TOKEN_ALGORITHM],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return {
      ok: false, status: 401,
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      message: expired ? 'Access token has expired' : 'Invalid access token',
    };
  }

  // jsonwebtoken only checks exp when present; require it.
  if (!Number.isFinite(claims.exp) || !claims.jti || !claims.sub) {
    return { ok: false, status: 401, code: 'TOKEN_INVALID', message: 'Invalid access token' };
  }

  const tier = VALID_TIERS.includes(claims.tier) ? claims.tier : 'trial';

  const revoked = await loadRevoked();
  if (revoked.has(claims.jti)) {
    return { ok: false, status: 401, code: 'TOKEN_REVOKED', message: 'Access token has been revoked' };
  }

  return { ok: true, claims: { ...claims, tier } };
}

/**
 * Convenience for handlers: verifies the request's bearer token.
 * Same return shape as verifyAccessToken.
 */
export function verifyRequestToken(req) {
  return verifyAccessToken(bearerFromRequest(req));
}
