// src/components/PremiumGate.test.jsx — the lock in front of a premium feature, under the two app contexts with the
// auth value each test sets (src/test/contexts.jsx). Three pins: the feature as it is while the token is premium;
// while locked, the feature's name, an empty token form (TokenActivationForm.test.jsx tests the form itself) and the
// link that opens the request form; a valid token stored and announced with auth-changed, the fixed auth value
// keeping the lock up, so it shows the shield. Then two regressions: a re-lock starts clean, an empty input with
// Activate and the request form closed. The gate that kept the form's state above its early return came back with
// the old token and its shield, and both are red on it: the first moves the auth value by hand, the second runs
// App's wiring (AuthContext from usePremiumStatus, under StrictMode) from a real activation to clearToken().
// MSW answers validateToken as the function would: 'good' is valid unless a test names another token, any other has
// expired. src/test/setup.js clears localStorage.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { withContexts } from '../test/contexts.jsx';
import { AUTH_EVENT, clearToken } from '../lib/auth.js';
import { usePremiumStatus } from '../hooks/usePremiumStatus.js';
import PremiumGate from './PremiumGate.js';

const FN = 'http://localhost:3000/.netlify/functions';
const VALID = { valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-11-01T00:00:00.000Z', requestId: 'v1' };
const EXPIRED = { valid: false, error: 'Token expired', code: 'TOKEN_EXPIRED', requestId: 'v2' };

let tokens;
let authEvents;
const countAuth = () => { authEvents += 1; };

/** Answer validateToken: `valid` is valid, any other has expired (a 401 with the reason); `tokens` keeps each. */
function serveValidate(valid = 'good') {
  server.use(http.post(`${FN}/validateToken`, async ({ request }) => {
    const { token } = await request.json();
    tokens.push(token);
    return token === valid ? HttpResponse.json(VALID) : HttpResponse.json(EXPIRED, { status: 401 });
  }));
}

/** The gate around a stand-in feature, under the auth value's `isPremium`. */
const gate = (isPremium, featureName = 'Ticker Research') => withContexts(
  <PremiumGate featureName={featureName}><p>The feature</p></PremiumGate>,
  { auth: { isPremium } },
);

/** App's wiring: the auth value's isPremium from usePremiumStatus, which follows auth-changed. */
function Wired() {
  const { isPremium } = usePremiumStatus();
  return gate(isPremium);
}

const tokenInput = () => screen.getByPlaceholderText('Paste token...');
const activateButton = () => screen.getByRole('button', { name: 'Activate' });
/** The form's submit button in any state: while it spins or shows the shield, its only content is an icon. */
const submitButton = () => tokenInput().closest('form').querySelector('button[type="submit"]');
const shield = () => submitButton().querySelector('.lucide-shield-check');
const requestLink = () => screen.queryByRole('button', { name: /Request access/ });

/** base64url without padding, as JWT segments are written. */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A pro token 30 days from expiry, which describeToken reads as premium; nothing client-side checks the signature. */
const proToken = () => [{ alg: 'HS256', typ: 'JWT' }, { tier: 'pro', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 }]
  .map((part) => b64url(JSON.stringify(part)))
  .concat('sig')
  .join('.');

describe('PremiumGate', () => {
  beforeEach(() => {
    tokens = [];
    authEvents = 0;
    window.addEventListener(AUTH_EVENT, countAuth);
  });

  afterEach(() => {
    window.removeEventListener(AUTH_EVENT, countAuth);
  });

  it('Pin: renders the feature as it is, and no lock, while the token is premium', () => {
    const { container } = render(gate(true));
    expect(container.innerHTML).toBe('<p>The feature</p>');
  });

  it("Pin: while locked, shows the feature's name, an empty token form and the link that opens the request form", async () => {
    const user = userEvent.setup();
    const { rerender } = render(gate(false));
    expect(screen.queryByText('The feature')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Ticker Research' })).toBeInTheDocument();
    expect(screen.getByText('Enter your access token to unlock')).toBeInTheDocument();
    expect(tokenInput()).toHaveValue('');
    expect(activateButton()).toBeDisabled();
    expect(tokenInput().closest('form').querySelector('p')).toBeNull(); // no hint under the gate's form

    await user.click(requestLink());
    expect(requestLink()).toBeNull();
    expect(screen.getByText('or')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('your@email.com')).toBeInTheDocument();

    rerender(withContexts(<PremiumGate><p>The feature</p></PremiumGate>, { auth: { isPremium: false } }));
    expect(screen.getByRole('heading', { name: 'Premium Feature' })).toBeInTheDocument();
  });

  it('Pin: a valid token is stored and announced with auth-changed', async () => {
    serveValidate();
    const user = userEvent.setup();
    render(gate(false));

    await user.type(tokenInput(), 'good');
    await user.click(activateButton());
    await waitFor(() => expect(shield()).not.toBeNull());
    expect(tokens).toEqual(['good']);
    expect(localStorage.getItem('access_token')).toBe('good');
    expect(authEvents).toBe(1);
  });

  it('Regression: a re-lock starts clean, with an empty input, Activate and the request form closed', async () => {
    serveValidate();
    const user = userEvent.setup();
    const { rerender } = render(gate(false));
    await user.type(tokenInput(), 'good');
    await user.click(activateButton());
    await waitFor(() => expect(shield()).not.toBeNull());
    await user.click(requestLink());
    expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument();

    // The stored token lifts the gate (App's auth value follows auth-changed), and clearing it locks the gate again.
    rerender(gate(true));
    expect(screen.getByText('The feature')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Paste token...')).toBeNull();
    rerender(gate(false));

    expect(tokenInput()).toHaveValue('');
    expect(activateButton()).toBeDisabled();
    expect(shield()).toBeNull();
    expect(requestLink()).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Your name')).toBeNull();
  });

  it("Regression (App's wiring, under StrictMode): a valid token lifts the gate, and clearToken() brings back an empty lock", async () => {
    const error = vi.spyOn(console, 'error');
    const token = proToken();
    serveValidate(token);
    const user = userEvent.setup();
    render(<StrictMode><Wired /></StrictMode>);

    await user.click(tokenInput());
    await user.paste(token);
    await user.click(activateButton());
    expect(await screen.findByText('The feature')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Paste token...')).toBeNull();
    expect(tokens).toEqual([token]);
    expect(localStorage.getItem('access_token')).toBe(token);

    act(() => clearToken());
    expect(screen.queryByText('The feature')).toBeNull();
    expect(tokenInput()).toHaveValue('');
    expect(activateButton()).toBeDisabled();
    expect(error).not.toHaveBeenCalled();
  });
});
