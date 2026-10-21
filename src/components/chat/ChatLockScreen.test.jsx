// src/components/chat/ChatLockScreen.test.jsx — the chat panel while no premium token is stored, rendered bare (the
// shared form reads no context): the panel's header and its close button, the Premium Feature copy, and the
// access-token form in the lock's width with the chat's placeholder and no hint (TokenActivationForm.test.jsx tests the
// form itself). MSW answers validateToken as the function would ('good…' is valid, any other token has expired), with
// 'down' failing at the network and 'html' a 200 whose body is not JSON; `tokens` keeps the token of every request. The
// network sentence is matched as /Could not validate token/, which held for the lock's own form inside ChatBot too
// (the shared form adds 'Try again.'). src/test/setup.js clears localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup.js';
import { AUTH_EVENT } from '../../lib/auth.js';
import ChatLockScreen from './ChatLockScreen.js';

const FN = 'http://localhost:3000/.netlify/functions';
const VALID = { valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-11-01T00:00:00.000Z', requestId: 'v1' };
const EXPIRED = { valid: false, error: 'Token expired', code: 'TOKEN_EXPIRED', requestId: 'v2' };

let tokens;
let authEvents;
const countAuth = () => { authEvents += 1; };

const input = () => screen.getByPlaceholderText('Paste access token...');
const activateButton = () => screen.getByRole('button', { name: 'Activate' });

describe('ChatLockScreen', () => {
  beforeEach(() => {
    tokens = [];
    authEvents = 0;
    window.addEventListener(AUTH_EVENT, countAuth);
    server.use(http.post(`${FN}/validateToken`, async ({ request }) => {
      const { token } = await request.json();
      tokens.push(token);
      if (token === 'down') return HttpResponse.error();
      if (token === 'html') return new HttpResponse('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      return token.startsWith('good') ? HttpResponse.json(VALID) : HttpResponse.json(EXPIRED, { status: 401 });
    }));
  });

  afterEach(() => {
    window.removeEventListener(AUTH_EVENT, countAuth);
  });

  it("shows the panel's header, and 'Close chat' closes the panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ChatLockScreen onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'AI Co-Pilot' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says what the Co-Pilot is behind the lock', () => {
    render(<ChatLockScreen onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Premium Feature' })).toBeInTheDocument();
    expect(screen.getByText('The AI Co-Pilot provides institutional-grade analysis of options flow and gamma exposure.'))
      .toBeInTheDocument();
  });

  it("holds an empty token form in the lock's width, with the chat's placeholder and no hint", () => {
    render(<ChatLockScreen onClose={vi.fn()} />);
    expect(input()).toHaveValue('');
    expect(input().closest('.max-w-xs')).not.toBeNull();
    expect(input().closest('.max-w-xs')).toHaveClass('w-full');
    expect(activateButton()).toBeDisabled();
    expect(input().closest('form').querySelector('p')).toBeNull();
  });

  it('stores a valid token, trimmed, and announces it with auth-changed', async () => {
    const user = userEvent.setup();
    render(<ChatLockScreen onClose={vi.fn()} />);

    await user.type(input(), ' good ');
    await user.click(activateButton());
    await waitFor(() => expect(localStorage.getItem('access_token')).toBe('good'));
    expect(tokens).toEqual(['good']);
    expect(authEvents).toBe(1);
  });

  it("shows the server's reason for a refused token, and stores nothing", async () => {
    const user = userEvent.setup();
    render(<ChatLockScreen onClose={vi.fn()} />);

    await user.type(input(), 'stale');
    await user.click(activateButton());
    expect(await screen.findByText('Token expired')).toBeInTheDocument();
    expect(tokens).toEqual(['stale']);
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  it('shows the network sentence when the request fails or the reply is not JSON, and stores nothing', async () => {
    const user = userEvent.setup();
    render(<ChatLockScreen onClose={vi.fn()} />);

    await user.type(input(), 'down');
    await user.click(activateButton());
    expect(await screen.findByText(/Could not validate token/)).toBeInTheDocument();

    await user.clear(input());
    expect(screen.queryByText(/Could not validate token/)).toBeNull();
    await user.type(input(), 'html');
    await user.click(activateButton());
    expect(await screen.findByText(/Could not validate token/)).toBeInTheDocument();
    expect(tokens).toEqual(['down', 'html']);
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });
});
