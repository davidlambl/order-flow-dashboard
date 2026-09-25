// netlify/functions/validateToken.js
// Verifies an access token (signature, issuer/audience, expiry, revocation)
// so the client can unlock premium UI. Every server-key endpoint re-verifies
// on each call; this endpoint only exists for the activation UX.

import { preflight, jsonResponse, newRequestId, clientIp, rateLimit, rateLimitResponse } from './lib/http.js';
import { verifyAccessToken } from './lib/auth.js';

const RATE_LIMIT = { limit: 10, windowMs: 60 * 1000 };

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return jsonResponse(req, { error: 'POST only', code: 'METHOD_NOT_ALLOWED' }, 405);

  const requestId = newRequestId();
  const rl = rateLimit(`validateToken:${clientIp(req)}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(req, rl.retryAfterSec, requestId);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { valid: false, error: 'Invalid JSON body', code: 'INVALID_JSON', requestId }, 400);
  }

  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return jsonResponse(req, { valid: false, error: 'Token is required', code: 'TOKEN_REQUIRED', requestId }, 400);
  }
  if (token.length > 4096) {
    return jsonResponse(req, { valid: false, error: 'Invalid access token', code: 'TOKEN_INVALID', requestId }, 401);
  }

  const result = await verifyAccessToken(token);
  if (!result.ok) {
    return jsonResponse(req, { valid: false, error: result.message, code: result.code, requestId }, result.status);
  }

  const { claims } = result;
  return jsonResponse(req, {
    valid: true,
    tier: claims.tier,
    sub: claims.sub,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    requestId,
  });
};
