// netlify/functions/validateToken.ts
// Verifies an access token (signature, issuer/audience, expiry, revocation)
// so the client can unlock premium UI. Every server-key endpoint re-verifies
// on each call; this endpoint only exists for the activation UX.

import { preflight, jsonResponse, newRequestId, clientIp, rateLimit, rateLimitResponse } from './lib/http.js';
import { verifyAccessToken } from './lib/auth.js';
import type { ApiErrorBody, TokenValidation } from '../../types/market.js';

const RATE_LIMIT = { limit: 10, windowMs: 60 * 1000 };

/** The request body as this function reads it: the token alone. */
interface TokenRequestBody {
  token?: unknown;
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return jsonResponse(req, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' } satisfies ApiErrorBody, 405);

  const requestId = newRequestId();
  const rl = rateLimit(`validateToken:${clientIp(req)}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(req, rl.retryAfterSec, requestId);

  let body: TokenRequestBody | null;
  try {
    // req.json() is unknown, and a JSON body can be any value: asserted once, to the one field read, which stays
    // unknown until its typeof check. The optional chain and that check read an array or a primitive as a body
    // without a token.
    body = await req.json() as TokenRequestBody | null;
  } catch {
    return jsonResponse(req, { valid: false, error: 'Invalid JSON body', code: 'INVALID_JSON', requestId } satisfies ApiErrorBody, 400);
  }

  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return jsonResponse(req, { valid: false, error: 'Token is required', code: 'TOKEN_REQUIRED', requestId } satisfies ApiErrorBody, 400);
  }
  if (token.length > 4096) {
    return jsonResponse(req, { valid: false, error: 'Invalid access token', code: 'TOKEN_INVALID', requestId } satisfies ApiErrorBody, 401);
  }

  const result = await verifyAccessToken(token);
  if (!result.ok) {
    return jsonResponse(req, { valid: false, error: result.message, code: result.code, requestId } satisfies ApiErrorBody, result.status);
  }

  const { claims } = result;
  return jsonResponse(req, {
    valid: true,
    tier: claims.tier,
    sub: claims.sub,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    requestId,
  } satisfies TokenValidation);
};
