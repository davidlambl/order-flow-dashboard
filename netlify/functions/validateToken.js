// netlify/functions/validateToken.js
// Validates JWT access tokens for premium feature gating.

import jwt from 'jsonwebtoken';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405);
  }

  const secret = process.env.TOKEN_SECRET;
  if (!secret) {
    return jsonResponse({ error: 'Server misconfigured: TOKEN_SECRET not set' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { token } = body;
  if (!token) {
    return jsonResponse({ valid: false, error: 'Token is required' }, 400);
  }

  try {
    const decoded = jwt.verify(token, secret);
    return jsonResponse({
      valid: true,
      tier: decoded.tier || 'pro',
      sub: decoded.sub || null,
      expiresAt: new Date(decoded.exp * 1000).toISOString(),
    });
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? 'Token has expired'
      : 'Invalid token';
    return jsonResponse({ valid: false, error: message }, 401);
  }
};
