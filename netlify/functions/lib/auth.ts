// netlify/functions/lib/auth.ts
// Access-token verification shared by every function that spends a server-side
// API key. Fail closed: if TOKEN_SECRET is not configured, nothing that would
// use a server key is allowed.
//
// Plain Node loads this file for scripts/generate-token.js, stripping its types
// and finding no ./x.js for an x.ts: so erasable syntax only, and a relative
// import only as `import type { … }` or dynamic. verifyAccessToken needs a
// bundler or Vite: under plain Node its revocation lookup cannot load
// ./supabaseAdmin.js and is skipped; scripts import only the constants.

import jwt from 'jsonwebtoken';
import type { AuthErrorCode } from '../../../types/market.js';

export const TOKEN_ISSUER = 'order-flow-dashboard';
export const TOKEN_AUDIENCE = 'order-flow-api';
export const TOKEN_ALGORITHM = 'HS256';
export const MIN_SECRET_LENGTH = 32;
export const VALID_TIERS = ['trial', 'pro'] as const;

export type Tier = (typeof VALID_TIERS)[number];

export function authConfigured(): boolean {
  const s = process.env.TOKEN_SECRET;
  return typeof s === 'string' && s.length >= MIN_SECRET_LENGTH;
}

export function bearerFromRequest(req: Request): string {
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

// ─── Revocation (jti denylist in Supabase; skipped when Supabase is not configured) ──

const REVOCATION_CACHE_TTL = 60 * 1000;
let revokedCache: { at: number; set: Set<string> } = { at: 0, set: new Set() };

async function loadRevoked(): Promise<Set<string>> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return new Set();
  if (Date.now() - revokedCache.at < REVOCATION_CACHE_TTL) return revokedCache.set;
  try {
    const { getSupabaseAdmin } = await import('./supabaseAdmin.js');
    const { data, error } = await getSupabaseAdmin().from('revoked_tokens').select('jti');
    if (error) throw new Error(error.message);
    revokedCache = { at: Date.now(), set: new Set((data || []).map((r) => r.jti)) };
  } catch (err) {
    // Keep the previous cache on failure rather than failing every request.
    // Only Errors land here (import, client, rethrow): asserted, so .message reads as it did.
    console.warn('revoked_tokens lookup failed:', (err as Error).message);
    revokedCache.at = Date.now();
  }
  return revokedCache.set;
}

/** For tests. */
export function _resetRevocationCache(): void {
  revokedCache = { at: 0, set: new Set() };
}

// ─── Verification ────────────────────────────────────────────────────────────

/** A verified token's claims, the tier normalised. */
export interface TokenClaims {
  [claim: string]: unknown;
  exp: number;
  jti: string;
  sub: string;
  tier: Tier;
}

/** The verdict: the claims, or the status and code to refuse with. */
export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; status: 401 | 503; code: AuthErrorCode; message: string };

/**
 * jwt.verify's result past its checks (a string payload fails the audience), asserted at that one call. The check
 * after it requires exp finite and jti and sub present (any truthy value), which the token script mints as strings;
 * any other claim, the tier too, stays unknown until a check reads it.
 */
interface VerifiedPayload {
  [claim: string]: unknown;
  exp: number;
  jti: string;
  sub: string;
}

/**
 * Verify a bearer token.
 */
export async function verifyAccessToken(token: string): Promise<VerifyResult> {
  // For the compiler: authConfigured() means a string here, so the undefined test never decides.
  const secret = process.env.TOKEN_SECRET;
  if (!authConfigured() || secret === undefined) {
    return {
      ok: false, status: 503, code: 'AUTH_NOT_CONFIGURED',
      message: 'Access tokens are not configured on this server',
    };
  }
  if (!token) {
    return { ok: false, status: 401, code: 'TOKEN_REQUIRED', message: 'Access token required' };
  }

  let claims: VerifiedPayload;
  try {
    claims = jwt.verify(token, secret, {
      algorithms: [TOKEN_ALGORITHM],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    }) as VerifiedPayload;
  } catch (err) {
    // jwt.verify throws only Errors: its own, or a native one for a payload that is not JSON or is null.
    // Asserted, so .name reads as it did.
    const expired = (err as Error).name === 'TokenExpiredError';
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

  const tier = (VALID_TIERS as readonly unknown[]).includes(claims.tier) ? (claims.tier as Tier) : 'trial';

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
export function verifyRequestToken(req: Request): Promise<VerifyResult> {
  return verifyAccessToken(bearerFromRequest(req));
}
