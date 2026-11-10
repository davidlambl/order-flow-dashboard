// netlify/functions/lib/http.ts
// Shared HTTP helpers for Netlify Functions (v2 Request/Response style):
// CORS restricted to known origins, JSON responses, request ids, upstream fetch
// with timeouts, and a small per-instance rate limiter.

import { randomUUID } from 'node:crypto';
import type { ApiErrorBody, ApiErrorCode } from '../../../types/market.js';

// ─── CORS ────────────────────────────────────────────────────────────────────
// The dashboard calls its functions same-origin, so no Access-Control-Allow-Origin
// header is needed for the app itself. Cross-origin access is granted only to
// origins listed in SITE_ORIGIN (comma-separated) plus the Netlify-provided
// URL / DEPLOY_PRIME_URL of the current deploy.

function allowedOrigins(): Set<string> {
  const list = new Set<string>();
  for (const v of [process.env.SITE_ORIGIN, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    if (!v) continue;
    for (const o of v.split(',')) {
      const t = o.trim().replace(/\/$/, '');
      if (t) list.add(t);
    }
  }
  return list;
}

export function corsHeaders(req: Request, extraAllowedHeaders = ''): Record<string, string> {
  const origin = req.headers.get('origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': ['Content-Type', 'Authorization', extraAllowedHeaders].filter(Boolean).join(', '),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (origin && allowedOrigins().has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function preflight(req: Request, extraAllowedHeaders = ''): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req, extraAllowedHeaders) });
}

// ─── Responses ───────────────────────────────────────────────────────────────

/** `body` is serialised as it is: each function types its own, from types/market.ts. */
export function jsonResponse(req: Request, body: unknown, status = 200, headers: Record<string, string> = {}): Response {
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

export function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

/** What errorResponse takes. `cause` is logged, never sent: any thrown value, or nothing. */
interface ErrorResponseOptions {
  status: number;
  code: ApiErrorCode;
  message: string;
  requestId: string;
  cause?: unknown;
}

/**
 * Log the real error server-side and return a generic client-facing body.
 * The requestId lets the operator match a user report to the function log.
 */
export function errorResponse(req: Request, { status, code, message, requestId, cause }: ErrorResponseOptions): Response {
  const rid = requestId || newRequestId();
  if (cause) {
    console.error(`[${rid}] ${code}: ${message}`, cause instanceof Error ? cause.message : cause);
  }
  return jsonResponse(req, { error: message, code, requestId: rid } satisfies ApiErrorBody, status);
}

// ─── Upstream fetch with timeout ─────────────────────────────────────────────

/**
 * fetch() with a timeout. If `parentSignal` (the incoming request's signal) aborts,
 * the upstream call aborts too, so a client that disconnects mid-stream stops billing us.
 *
 * By default (`bodyTimeout: true`) the timeout covers the whole exchange, body included:
 * the signal stays attached to the response body, so reading it past `timeoutMs` fails.
 * With `bodyTimeout: false` it bounds only the time to the response headers (first byte);
 * the timer is cleared once they arrive, so a streamed body is never cut by it (the
 * platform's function timeout still bounds the stream). Either way an expiry rejects with
 * a `TimeoutError` (see isTimeoutError).
 *
 * @param init - `init.signal`, when present, is honoured as well
 */
export function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 8000,
  parentSignal: AbortSignal | null = null,
  { bodyTimeout = true }: { bodyTimeout?: boolean } = {},
): Promise<Response> {
  if (bodyTimeout) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (parentSignal) signals.push(parentSignal);
    if (init.signal) signals.push(init.signal);
    return fetch(url, { ...init, signal: AbortSignal.any(signals) });
  }
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new DOMException(`Upstream did not respond within ${timeoutMs} ms`, 'TimeoutError')),
    timeoutMs,
  );
  const signals = [ctl.signal];
  if (parentSignal) signals.push(parentSignal);
  if (init.signal) signals.push(init.signal);
  return fetch(url, { ...init, signal: AbortSignal.any(signals) }).finally(() => clearTimeout(timer));
}

export function isTimeoutError(err: unknown): boolean {
  // A caught value is unknown. What reaches here is in practice an Error (fetch rejects with a TypeError, or with the
  // aborting signal's reason: a TimeoutError or AbortError DOMException by default), so this asserts that instead of
  // narrowing, which would change what any other value does: `name` stays the optional-chained read it was.
  return (err as Error | undefined)?.name === 'TimeoutError' || (err as Error | undefined)?.name === 'AbortError';
}

// ─── Rate limiting (per warm function instance) ──────────────────────────────
// Netlify functions are stateless across cold starts, so this is a best-effort
// brake, not a guarantee. Netlify's platform rate limiting (Site configuration →
// Access & security) should be enabled for /.netlify/functions/* as the real limit.

/** Each key's request times (epoch ms), oldest first. */
const buckets = new Map<string, number[]>();
const BUCKET_SWEEP_EVERY = 500;
let calls = 0;

export function clientIp(req: Request): string {
  return req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
}

/** At most `limit` requests per key in any `windowMs` window. */
interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/** `retryAfterSec`: 0 when ok, else the whole seconds (at least 1) until the oldest request leaves the window. */
interface RateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

/**
 * Sliding-window limiter. Returns { ok, retryAfterSec }.
 */
export function rateLimit(key: string, { limit, windowMs }: RateLimitOptions): RateLimitResult {
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

export function rateLimitResponse(req: Request, retryAfterSec: number, requestId: string): Response {
  return jsonResponse(req, { error: 'Too many requests', code: 'RATE_LIMITED', requestId } satisfies ApiErrorBody, 429, {
    'Retry-After': String(retryAfterSec),
  });
}

/** Reset limiter state — for tests. */
export function _resetRateLimiter(): void {
  buckets.clear();
  calls = 0;
}
