// src/lib/auth.test.js — client-side token handling: storage and the auth-changed event, the Authorization header,
// the unverified payload decode behind the tier badge and the days-left count, which server codes clear the token,
// and the startup check against validateToken (answered by MSW). Signature, issuer and revocation checks are the
// server's: netlify/functions/__tests__/validateToken.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import {
  AUTH_EVENT, clearToken, clearTokenIfDead, daysRemaining, decodeTokenPayload, getAuthHeaders, getToken, getTokenTier,
  hasValidToken, setToken, validateToken, verifyStoredToken,
} from './auth.js';

const FN = 'http://localhost:3000/.netlify/functions';
const DEAD_CODES = ['TOKEN_EXPIRED', 'TOKEN_INVALID', 'TOKEN_REVOKED'];

/** base64url without padding, as JWT segments are written. */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A header.payload.signature token; nothing client-side checks the signature. */
const jwt = (payload) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;

let authEvents;
const onAuth = () => { authEvents += 1; };

beforeEach(() => {
  authEvents = 0;
  window.addEventListener(AUTH_EVENT, onAuth);
});

afterEach(() => {
  window.removeEventListener(AUTH_EVENT, onAuth);
});

describe('token storage', () => {
  it('setToken stores the token under access_token and dispatches auth-changed', () => {
    expect(AUTH_EVENT).toBe('auth-changed');
    setToken('tok-1');
    expect(localStorage.getItem('access_token')).toBe('tok-1');
    expect(getToken()).toBe('tok-1');
    expect(authEvents).toBe(1);
  });

  it('clearToken removes the token and dispatches auth-changed', () => {
    localStorage.setItem('access_token', 'tok-1');
    clearToken();
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(getToken()).toBeNull();
    expect(authEvents).toBe(1);
  });

  it('setToken still dispatches auth-changed when storage throws, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    setToken('tok-1');
    expect(authEvents).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('getToken returns null when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(getToken()).toBeNull();
    expect(getAuthHeaders()).toEqual({});
  });

  it('getAuthHeaders is {} without a token and a Bearer Authorization header with one', () => {
    expect(getAuthHeaders()).toEqual({});
    localStorage.setItem('access_token', 'tok-1');
    expect(getAuthHeaders()).toEqual({ Authorization: 'Bearer tok-1' });
  });
});

describe('decodeTokenPayload', () => {
  it('decodes an unpadded base64url payload that uses - and _, without checking the signature', () => {
    // {"sub":"user-1","tier":"premium","note":"???>>>"} — base64 would need "==" and contain "/" and "+".
    const payload = 'eyJzdWIiOiJ1c2VyLTEiLCJ0aWVyIjoicHJlbWl1bSIsIm5vdGUiOiI_Pz8-Pj4ifQ';
    expect(decodeTokenPayload(`header.${payload}.not-a-real-signature`)).toEqual({ sub: 'user-1', tier: 'premium', note: '???>>>' });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['two parts', `header.${b64url('{"tier":"premium"}')}`],
    ['four parts', `header.${b64url('{"tier":"premium"}')}.sig.extra`],
    ['a payload that is not base64', 'header.!!!.sig'],
    ['a payload that is not JSON', `header.${b64url('not json')}.sig`],
  ])('returns null for %s', (_label, token) => {
    expect(decodeTokenPayload(token)).toBeNull();
  });
});

describe('hasValidToken, daysRemaining and getTokenTier (client clock, no signature check)', () => {
  const NOW = Date.parse('2026-09-26T12:00:00Z');
  const nowSec = NOW / 1000;
  const HOUR = 3600;

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a token expiring in 36 h is valid with 2 days remaining (days round up) and its tier', () => {
    setToken(jwt({ sub: 'user-1', tier: 'premium', exp: nowSec + 36 * HOUR }));
    expect(hasValidToken()).toBe(true);
    expect(daysRemaining()).toBe(2);
    expect(getTokenTier()).toBe('premium');
  });

  it.each([
    ['1 s', 1, 1],
    ['exactly 24 h', 24 * HOUR, 1],
    ['24 h and 1 s', 24 * HOUR + 1, 2],
    ['30 days', 30 * 24 * HOUR, 30],
  ])('%s left counts as %i day(s)', (_label, secondsLeft, days) => {
    setToken(jwt({ tier: 'trial', exp: nowSec + secondsLeft }));
    expect(hasValidToken()).toBe(true);
    expect(daysRemaining()).toBe(days);
  });

  it.each([
    ['expiring now', 0],
    ['expired a second ago', -1],
    ['expired a week ago', -7 * 24 * HOUR],
  ])('a token %s is not valid and has 0 days remaining; its tier still reads', (_label, offset) => {
    setToken(jwt({ tier: 'premium', exp: nowSec + offset }));
    expect(hasValidToken()).toBe(false);
    expect(daysRemaining()).toBe(0);
    expect(getTokenTier()).toBe('premium');
  });

  it('without an exp claim the token is not valid and has 0 days; without a tier the tier is null', () => {
    setToken(jwt({ tier: 'premium' }));
    expect(hasValidToken()).toBe(false);
    expect(daysRemaining()).toBe(0);
    setToken(jwt({ exp: nowSec + HOUR }));
    expect(hasValidToken()).toBe(true);
    expect(getTokenTier()).toBeNull();
  });

  it('with no token, or a malformed one: not valid, 0 days, no tier', () => {
    expect([hasValidToken(), daysRemaining(), getTokenTier()]).toEqual([false, 0, null]);
    setToken('not-a-jwt');
    expect([hasValidToken(), daysRemaining(), getTokenTier()]).toEqual([false, 0, null]);
  });
});

describe('clearTokenIfDead', () => {
  it.each(DEAD_CODES)('%s removes the stored token, dispatches auth-changed and returns true', (code) => {
    localStorage.setItem('access_token', 'tok-1');
    expect(clearTokenIfDead(code)).toBe(true);
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(1);
  });

  it('a dead code with no stored token returns true without dispatching', () => {
    expect(clearTokenIfDead('TOKEN_EXPIRED')).toBe(true);
    expect(authEvents).toBe(0);
  });

  it.each(['RATE_LIMITED', 'TOKEN_REQUIRED', 'FINNHUB_KEY_REJECTED', null, undefined])('%s keeps the token and returns false', (code) => {
    localStorage.setItem('access_token', 'tok-1');
    expect(clearTokenIfDead(code)).toBe(false);
    expect(localStorage.getItem('access_token')).toBe('tok-1');
    expect(authEvents).toBe(0);
  });

  it('AUTH_NOT_CONFIGURED keeps the token here (only verifyStoredToken clears on it)', () => {
    localStorage.setItem('access_token', 'tok-1');
    expect(clearTokenIfDead('AUTH_NOT_CONFIGURED')).toBe(false);
    expect(localStorage.getItem('access_token')).toBe('tok-1');
  });
});

describe('validateToken and verifyStoredToken', () => {
  let requests;

  /** Answer validateToken with reply(request), recording every request. */
  const serve = (reply) => {
    server.use(http.post(`${FN}/validateToken`, ({ request }) => {
      requests.push(request);
      return reply(request);
    }));
  };
  const reject = (status, code, error) => () => HttpResponse.json({ valid: false, error, code, requestId: 'req-1' }, { status });

  beforeEach(() => {
    requests = [];
  });

  it('validateToken POSTs { token } as JSON without an Authorization header and returns a 200 body as-is', async () => {
    localStorage.setItem('access_token', 'stored-tok');
    const body = { valid: true, tier: 'premium', sub: 'user-1', expiresAt: '2026-10-26T12:00:00.000Z', requestId: 'req-1' };
    serve(() => HttpResponse.json(body));
    await expect(validateToken('tok-1')).resolves.toEqual(body);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.get('content-type')).toBe('application/json');
    expect(requests[0].headers.has('authorization')).toBe(false);
    await expect(requests[0].json()).resolves.toEqual({ token: 'tok-1' });
  });

  it('validateToken turns a JSON error into { valid: false, error, code }', async () => {
    serve(reject(401, 'TOKEN_EXPIRED', 'Access token has expired'));
    await expect(validateToken('tok-1')).resolves.toEqual({ valid: false, error: 'Access token has expired', code: 'TOKEN_EXPIRED' });
  });

  it('validateToken turns a non-JSON error into { valid: false, error: "Server error (<status>)", code: null }', async () => {
    serve(() => new HttpResponse('<html>Bad gateway</html>', { status: 500, headers: { 'Content-Type': 'text/html' } }));
    await expect(validateToken('tok-1')).resolves.toEqual({ valid: false, error: 'Server error (500)', code: null });
  });

  it('validateToken rejects on a network error', async () => {
    serve(() => HttpResponse.error());
    await expect(validateToken('tok-1')).rejects.toThrow();
  });

  it('validateToken resolves null for a 200 whose body is not JSON (current contract)', async () => {
    serve(() => new HttpResponse('OK', { status: 200 }));
    await expect(validateToken('tok-1')).resolves.toBeNull();
  });

  it("verifyStoredToken is 'none' without a stored token and sends nothing", async () => {
    serve(() => HttpResponse.json({ valid: true }));
    await expect(verifyStoredToken()).resolves.toBe('none');
    expect(requests).toHaveLength(0);
  });

  it("verifyStoredToken is 'valid' when the server accepts the stored token, which stays", async () => {
    localStorage.setItem('access_token', 'tok-1');
    serve(() => HttpResponse.json({ valid: true, tier: 'premium', sub: 'user-1', expiresAt: '2026-10-26T12:00:00.000Z' }));
    await expect(verifyStoredToken()).resolves.toBe('valid');
    await expect(requests[0].json()).resolves.toEqual({ token: 'tok-1' });
    expect(localStorage.getItem('access_token')).toBe('tok-1');
    expect(authEvents).toBe(0);
  });

  it.each(DEAD_CODES)("verifyStoredToken is 'cleared' on a 401 %s: the token is removed and auth-changed fires", async (code) => {
    localStorage.setItem('access_token', 'tok-1');
    serve(reject(401, code, 'Invalid access token'));
    await expect(verifyStoredToken()).resolves.toBe('cleared');
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(1);
  });

  it("verifyStoredToken is 'cleared' on a 503 AUTH_NOT_CONFIGURED", async () => {
    localStorage.setItem('access_token', 'tok-1');
    serve(reject(503, 'AUTH_NOT_CONFIGURED', 'Access tokens are not configured on this server'));
    await expect(verifyStoredToken()).resolves.toBe('cleared');
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it.each([
    ['a 429 RATE_LIMITED', () => HttpResponse.json({ error: 'Too many requests', code: 'RATE_LIMITED', requestId: 'req-1' }, { status: 429 })],
    ['a network error', () => HttpResponse.error()],
    ['a 500 without JSON', () => new HttpResponse('Internal error', { status: 500 })],
    ['a 200 without JSON', () => new HttpResponse('OK', { status: 200 })],
  ])("verifyStoredToken is 'unknown' on %s, and the token stays", async (_label, reply) => {
    localStorage.setItem('access_token', 'tok-1');
    serve(reply);
    await expect(verifyStoredToken()).resolves.toBe('unknown');
    expect(requests).toHaveLength(1);
    expect(localStorage.getItem('access_token')).toBe('tok-1');
    expect(authEvents).toBe(0);
  });
});
