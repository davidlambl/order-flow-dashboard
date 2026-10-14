// src/components/TokenActivationForm.test.jsx — the access-token form the Account tab and the premium locks share,
// rendered bare (it reads no context): the placeholder it is given and the hint only when given; Activate is live only
// while the input holds more than whitespace; a submit sends the trimmed token, the button spins while the server
// checks, and a yes stores the token, announces it with auth-changed and, with no parent here to unmount the form,
// shows the shield; the error line shows the server's reason or the network sentence and goes with the next edit,
// which also drops a verdict still on its way. The last test mounts the form as its parents do, only while no premium
// token is stored: the activation unmounts it and a re-lock brings back an empty one. MSW answers validateToken as the
// function would ('good' is valid, any other token has expired) and `tokens` keeps the token of every request.
// src/test/setup.js clears localStorage.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { AUTH_EVENT, clearToken } from '../lib/auth.js';
import { usePremiumStatus } from '../hooks/usePremiumStatus.js';
import TokenActivationForm from './TokenActivationForm.js';

const FN = 'http://localhost:3000/.netlify/functions';
const PLACEHOLDER = 'Paste access token...';
const HINT = 'Unlocks premium features: AI Co-Pilot, Position Analysis, and Ticker Research.';
const VALID = { valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-11-01T00:00:00.000Z', requestId: 'v1' };

let tokens;
let authEvents;
const countAuth = () => { authEvents += 1; };

/** validateToken's two answers: 'good' is valid, any other token has expired (a 401 with the reason). */
const verdict = (token) => (token === 'good'
  ? HttpResponse.json(VALID)
  : HttpResponse.json({ valid: false, error: 'Token expired', code: 'TOKEN_EXPIRED', requestId: 'v2' }, { status: 401 }));

/** Answer validateToken with reply(token), recording the token of every request. */
function serve(reply = verdict) {
  server.use(http.post(`${FN}/validateToken`, async ({ request }) => {
    const { token } = await request.json();
    tokens.push(token);
    return reply(token);
  }));
}

/** A reply held until release(), so the request stays in flight; `answered` turns true once it is sent. */
function gated(reply) {
  let release;
  const open = new Promise((resolve) => { release = resolve; });
  const gate = {
    answered: false,
    release,
    reply: async (token) => { await open; gate.answered = true; return reply(token); },
  };
  return gate;
}

const input = () => screen.getByPlaceholderText(PLACEHOLDER);
const activateButton = () => screen.getByRole('button', { name: 'Activate' });
/** The submit button in any state: while it spins or shows the shield, its only content is an aria-hidden icon. */
const submitButton = () => screen.getByRole('button');

/** base64url without padding, as JWT segments are written. */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A pro token 30 days from expiry, which describeToken reads as premium; nothing client-side checks the signature. */
const proToken = () => [{ alg: 'HS256', typ: 'JWT' }, { tier: 'pro', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 }]
  .map((part) => b64url(JSON.stringify(part)))
  .concat('sig')
  .join('.');

/** A parent shaped like the Account tab and the premium locks: the form only while no premium token is stored. */
function Lock() {
  const { isPremium } = usePremiumStatus();
  return isPremium ? <p>Unlocked</p> : <TokenActivationForm placeholder="Paste token..." />;
}

describe('TokenActivationForm', () => {
  beforeEach(() => {
    tokens = [];
    authEvents = 0;
    window.addEventListener(AUTH_EVENT, countAuth);
  });

  afterEach(() => {
    window.removeEventListener(AUTH_EVENT, countAuth);
  });

  it('shows the placeholder it is given, and the hint as the last line of the form only when given', () => {
    const { container, rerender } = render(<TokenActivationForm placeholder="Paste token..." hint={HINT} />);
    expect(screen.getByPlaceholderText('Paste token...')).toHaveValue('');
    const hint = screen.getByText(HINT);
    expect(hint.tagName).toBe('P');
    expect(container.querySelector('form').lastElementChild).toBe(hint);

    rerender(<TokenActivationForm placeholder="Paste token..." />);
    expect(screen.queryByText(HINT)).toBeNull();
    expect(container.querySelector('p')).toBeNull();
  });

  it('enables Activate only while the input holds more than whitespace', async () => {
    const user = userEvent.setup();
    render(<TokenActivationForm placeholder={PLACEHOLDER} />);
    expect(activateButton()).toBeDisabled();

    await user.type(input(), '   ');
    expect(activateButton()).toBeDisabled();
    await user.type(input(), 'x');
    expect(activateButton()).toBeEnabled();
    await user.clear(input());
    expect(activateButton()).toBeDisabled();
  });

  it('sends the trimmed token and spins while the server checks; a yes stores it and shows the shield', async () => {
    const gate = gated(verdict);
    serve(gate.reply);
    const user = userEvent.setup();
    render(<TokenActivationForm placeholder={PLACEHOLDER} />);

    await user.type(input(), '  good  ');
    await user.click(activateButton());
    expect(submitButton()).toBeDisabled();
    expect(submitButton().querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();

    gate.release();
    await waitFor(() => expect(submitButton().querySelector('.lucide-shield-check')).not.toBeNull());
    expect(tokens).toEqual(['good']);
    expect(localStorage.getItem('access_token')).toBe('good');
    expect(authEvents).toBe(1);
  });

  it("shows the server's reason for a refusal, and the next edit clears it", async () => {
    serve();
    const user = userEvent.setup();
    render(<TokenActivationForm placeholder={PLACEHOLDER} />);

    await user.type(input(), 'bad{Enter}');
    expect(await screen.findByText('Token expired')).toBeInTheDocument();
    expect(tokens).toEqual(['bad']);
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(activateButton()).toBeEnabled();

    await user.type(input(), '!');
    expect(screen.queryByText('Token expired')).toBeNull();
    expect(activateButton()).toBeEnabled();
  });

  it('shows the network sentence when the request fails', async () => {
    serve(() => HttpResponse.error());
    const user = userEvent.setup();
    render(<TokenActivationForm placeholder={PLACEHOLDER} />);

    await user.type(input(), 'good{Enter}');
    expect(await screen.findByText('Could not validate token. Try again.')).toBeInTheDocument();
    expect(tokens).toEqual(['good']);
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  it('drops the verdict on a token edited while the server checked it', async () => {
    const gate = gated(verdict);
    serve(gate.reply);
    const user = userEvent.setup();
    render(<TokenActivationForm placeholder={PLACEHOLDER} />);
    await user.type(input(), 'good');
    await user.click(activateButton());
    expect(submitButton()).toBeDisabled();

    await user.type(input(), '!');
    expect(activateButton()).toBeEnabled();

    gate.release();
    await waitFor(() => expect(gate.answered).toBe(true));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(tokens).toEqual(['good']);
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
    expect(activateButton()).toBeEnabled();
  });

  it("goes when the activation lifts its parent's lock, and a re-lock brings back an empty form", async () => {
    serve(() => HttpResponse.json(VALID));
    const token = proToken();
    const user = userEvent.setup();
    render(<Lock />);

    await user.click(screen.getByPlaceholderText('Paste token...'));
    await user.paste(token);
    await user.click(activateButton());
    expect(await screen.findByText('Unlocked')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Paste token...')).toBeNull();
    expect(tokens).toEqual([token]);
    expect(localStorage.getItem('access_token')).toBe(token);

    act(() => clearToken());
    expect(screen.getByPlaceholderText('Paste token...')).toHaveValue('');
    expect(activateButton()).toBeDisabled();
  });
});
