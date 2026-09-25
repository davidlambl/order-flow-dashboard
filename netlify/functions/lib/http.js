// netlify/functions/lib/http.js
// Shared HTTP helpers for Netlify Functions (v2 Request/Response style):
// CORS restricted to known origins, JSON responses, request ids, upstream fetch
// with timeouts, and a small per-instance rate limiter.

import { randomUUID } from 'node:crypto';

// ─── CORS ────────────────────────────────────────────────────────────────────
// The dashboard calls its functions same-origin, so no Access-Control-Allow-Origin
// header is needed for the app itself. Cross-origin access is granted only to
// origins listed in SITE_ORIGIN (comma-separated) plus the Netlify-provided
// URL / DEPLOY_PRIME_URL of the current deploy.

function allowedOrigins() {
  const list = new Set();
  for (const v of [process.env.SITE_ORIGIN, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    if (!v) continue;
    for (const o of v.split(',')) {
      const t = o.trim().replace(/\/$/, '');
      if (t) list.add(t);
    }
  }
  return list;
}

export function corsHeaders(req, extraAllowedHeaders = '') {
  const origin = req.headers.get('origin');
  const headers = {
    'Access-Control-Allow-Headers': ['Content-Type', 'Authorization', extraAllowedHeaders].filter(Boolean).join(', '),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (origin && allowedOrigins().has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function preflight(req, extraAllowedHeaders = '') {
  return new Response(null, { status: 204, headers: corsHeaders(req, extraAllowedHeaders) });
}

// ─── Responses ───────────────────────────────────────────────────────────────

export function jsonResponse(req, body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req, headers['Access-Control-Allow-Headers']),
      'Content-Type': 'application/json',
      ...(status >= 400 ? { 'Cache-Control': 'no-store' } : {}),
      ...headers,
    },
  });
}

export function newRequestId() {
  return randomUUID().slice(0, 8);
}

/**
 * Log the real error server-side and return a generic client-facing body.
 * The requestId lets the operator match a user report to the function log.
 */
export function errorResponse(req, { status, code, message, requestId, cause }) {
  const rid = requestId || newRequestId();
  if (cause) {
    console.error(`[${rid}] ${code}: ${message}`, cause instanceof Error ? cause.message : cause);
  }
  return jsonResponse(req, { error: message, code, requestId: rid }, status);
}

// ─── Upstream fetch with timeout ─────────────────────────────────────────────

/**
 * fetch() with a hard timeout. If `parentSignal` (the incoming request's
 * signal) aborts, the upstream call aborts too, so a client that disconnects
 * mid-stream stops billing us.
 */
export function fetchWithTimeout(url, init = {}, timeoutMs = 8000, parentSignal = null) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (parentSignal) signals.push(parentSignal);
  if (init.signal) signals.push(init.signal);
  return fetch(url, { ...init, signal: AbortSignal.any(signals) });
}

export function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

// ─── Rate limiting (per warm function instance) ──────────────────────────────
// Netlify functions are stateless across cold starts, so this is a best-effort
// brake, not a guarantee. Netlify's platform rate limiting (Site configuration →
// Access & security) should be enabled for /.netlify/functions/* as the real limit.

const buckets = new Map();
const BUCKET_SWEEP_EVERY = 500;
let calls = 0;

export function clientIp(req) {
  return req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
}

/**
 * Sliding-window limiter. Returns { ok, retryAfterSec }.
 */
export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  if (++calls % BUCKET_SWEEP_EVERY === 0) {
    for (const [k, times] of buckets) {
      if (times[times.length - 1] < now - windowMs) buckets.delete(k);
    }
  }
  const times = (buckets.get(key) || []).filter((t) => t > now - windowMs);
  if (times.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000));
    buckets.set(key, times);
    return { ok: false, retryAfterSec };
  }
  times.push(now);
  buckets.set(key, times);
  return { ok: true, retryAfterSec: 0 };
}

export function rateLimitResponse(req, retryAfterSec, requestId) {
  return jsonResponse(req, { error: 'Too many requests', code: 'RATE_LIMITED', requestId }, 429, {
    'Retry-After': String(retryAfterSec),
  });
}

/** Reset limiter state — for tests. */
export function _resetRateLimiter() {
  buckets.clear();
  calls = 0;
}
