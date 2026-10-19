// src/hooks/useTokenActivation.test.jsx — the activation handler the token forms share: a valid token is stored
// trimmed and announced with auth-changed; a refusal shows the server's reason ('Invalid token' without one); a failed
// request and a 200 that is not JSON both show the one network sentence and never throw; a blank input does nothing;
// a reply is dropped once reset() or a newer activate() has come after its request, and kept across an unmount. MSW
// answers validateToken as the function would ('good' is valid, any other token has expired) and `tokens` keeps the
// token of every request; a gated reply holds its request until release(). src/test/setup.js clears localStorage.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { AUTH_EVENT } from '../lib/auth.js';
import { useTokenActivation } from './useTokenActivation.js';

const FN = 'http://localhost:3000/.netlify/functions';
const NO_VERDICT = 'Could not validate token. Try again.';

let tokens;
let authEvents;
const countAuth = () => { authEvents += 1; };

/** validateToken's two answers: 'good' is valid, any other token has expired (a 401 with the reason). */
const verdict = (token) => (token === 'good'
  ? HttpResponse.json({ valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-11-01T00:00:00.000Z', requestId: 'v1' })
  : HttpResponse.json({ valid: false, error: 'Token expired', code: 'TOKEN_EXPIRED', requestId: 'v2' }, { status: 401 }));

/** Answer validateToken with reply(token), recording the token of every request; a later serve() takes precedence. */
function serve(reply = verdict) {
  server.use(http.post(`${FN}/validateToken`, async ({ request }) => {
    const { token } = await request.json();
    tokens.push(token);
    return reply(token);
  }));
}

/** A reply held until release(), so the request stays in flight. */
function gated(reply) {
  let release;
  const open = new Promise((resolve) => { release = resolve; });
  return { reply: async (token) => { await open; return reply(token); }, release };
}

/** activate(raw) inside act, so the state set after the reply is flushed; resolves what activate resolved. */
async function run(result, raw) {
  let outcome;
  await act(async () => { outcome = await result.current.activate(raw); });
  return outcome;
}

/** activate(raw) with its reply held: the request is in flight when this returns, and its promise is returned. */
function start(result, raw) {
  let pending;
  act(() => { pending = result.current.activate(raw); });
  return pending;
}

/** Release a held reply and wait for the activation inside act; resolves what activate resolved. */
async function finish(gate, pending) {
  let outcome;
  await act(async () => { gate.release(); outcome = await pending; });
  return outcome;
}

describe('useTokenActivation', () => {
  beforeEach(() => {
    tokens = [];
    authEvents = 0;
    window.addEventListener(AUTH_EVENT, countAuth);
  });

  afterEach(() => {
    window.removeEventListener(AUTH_EVENT, countAuth);
  });

  it('stores the trimmed token and dispatches auth-changed when the server accepts it', async () => {
    serve();
    const { result } = renderHook(() => useTokenActivation());
    expect(result.current).toMatchObject({ status: 'idle', error: '' });

    expect(await run(result, '  good \n')).toBe(true);
    expect(tokens).toEqual(['good']);
    expect(localStorage.getItem('access_token')).toBe('good');
    expect(authEvents).toBe(1);
    expect(result.current).toMatchObject({ status: 'success', error: '' });
  });

  it("shows the server's reason for a refusal, stores nothing, and reset() clears it", async () => {
    serve();
    const { result } = renderHook(() => useTokenActivation());

    expect(await run(result, 'bad')).toBe(false);
    expect(result.current).toMatchObject({ status: 'error', error: 'Token expired' });
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);

    act(() => result.current.reset());
    expect(result.current).toMatchObject({ status: 'idle', error: '' });
  });

  it("says 'Invalid token' for a refusal that gives no reason", async () => {
    serve(() => HttpResponse.json({ valid: false }));
    const { result } = renderHook(() => useTokenActivation());

    expect(await run(result, 'good')).toBe(false);
    expect(result.current).toMatchObject({ status: 'error', error: 'Invalid token' });
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('shows the network sentence when the request fails, without throwing', async () => {
    serve(() => HttpResponse.error());
    const { result } = renderHook(() => useTokenActivation());

    expect(await run(result, 'good')).toBe(false);
    expect(result.current).toMatchObject({ status: 'error', error: NO_VERDICT });
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  it('shows the same sentence for a 200 whose body is not JSON (validateToken resolves null), without throwing', async () => {
    serve(() => HttpResponse.text('<html>'));
    const { result } = renderHook(() => useTokenActivation());

    expect(await run(result, 'good')).toBe(false);
    expect(tokens).toEqual(['good']);
    expect(result.current).toMatchObject({ status: 'error', error: NO_VERDICT });
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  it('does nothing for an empty or blank input: no request, no status', async () => {
    serve();
    const { result } = renderHook(() => useTokenActivation());

    expect(await run(result, '')).toBe(false);
    expect(await run(result, ' \t\n ')).toBe(false);
    expect(tokens).toEqual([]);
    expect(result.current).toMatchObject({ status: 'idle', error: '' });
  });

  it('is validating while the request is in flight, with the last error cleared', async () => {
    serve();
    const { result } = renderHook(() => useTokenActivation());
    await run(result, 'bad');
    expect(result.current.error).toBe('Token expired');

    const gate = gated(verdict);
    serve(gate.reply);
    const pending = start(result, 'good');
    expect(result.current).toMatchObject({ status: 'validating', error: '' });

    expect(await finish(gate, pending)).toBe(true);
    expect(result.current).toMatchObject({ status: 'success', error: '' });
  });

  it('drops the reply when reset() comes while the request is in flight', async () => {
    const gate = gated(verdict);
    serve(gate.reply);
    const { result } = renderHook(() => useTokenActivation());
    const pending = start(result, 'good');
    expect(result.current.status).toBe('validating');

    act(() => result.current.reset());
    expect(result.current).toMatchObject({ status: 'idle', error: '' });

    expect(await finish(gate, pending)).toBe(false);
    expect(tokens).toEqual(['good']);
    expect(result.current).toMatchObject({ status: 'idle', error: '' });
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  it('drops the older reply when a newer activate() comes while it is in flight', async () => {
    const gate = gated(verdict);
    serve((token) => (token === 'good' ? gate.reply(token) : verdict(token)));
    const { result } = renderHook(() => useTokenActivation());
    const older = start(result, 'good');

    expect(await run(result, 'bad')).toBe(false);
    expect(result.current).toMatchObject({ status: 'error', error: 'Token expired' });

    expect(await finish(gate, older)).toBe(false);
    expect(result.current).toMatchObject({ status: 'error', error: 'Token expired' });
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  it('still activates a token whose reply lands after the form unmounted', async () => {
    const gate = gated(verdict);
    serve(gate.reply);
    const { result, unmount } = renderHook(() => useTokenActivation());
    const pending = start(result, 'good');
    unmount();

    expect(await finish(gate, pending)).toBe(true);
    expect(localStorage.getItem('access_token')).toBe('good');
    expect(authEvents).toBe(1);
  });

  it('keeps activate and reset the same functions across renders', async () => {
    serve();
    const { result, rerender } = renderHook(() => useTokenActivation());
    const { activate, reset } = result.current;

    await run(result, 'bad');
    rerender();
    expect(result.current.activate).toBe(activate);
    expect(result.current.reset).toBe(reset);
  });
});
