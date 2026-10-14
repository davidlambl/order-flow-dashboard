// src/components/AppSettings.test.jsx — the settings dialog's shell and its Account tab, through the whole
// dialog: every open starts on the AI tab under the four tab buttons, which show one tab at a time; Escape, the
// backdrop and "Close settings" close it without losing a key edit still in its 800 ms debounce, and Sign out never
// runs with one pending; the Account tab shows the session block (signed out, with Sign in only while cloud sign-in
// is configured, or signed in, with the e-mail and Sign out), then the premium block (tier, days left, Remove access
// token) or the Activate form against validateToken, and the request-access form. Written against the one-file
// dialog before settings/ existed, as the contract its decomposition (a dialog that mounts one tab at a time) must
// keep, so every test is a pin, and none asserts what the two designs do differently. A close is driven through a
// host that flips isOpen, as App does, and only its end state is asserted: the one-file dialog flushes the key edits
// and then calls onClose, the decomposed one calls onClose and its tabs flush as they unmount. No getModels request
// is counted: the one-file dialog sends two per open and one per keystroke, the decomposed one sends one per provider
// and saved key. Nothing is asserted across a tab switch, nor about when a switch saves an edit: each tab is to be
// born fresh on every switch. The auth value is static here, so an activation shows in the stored token and its
// auth-changed event, never in the premium block.
// Every test answers getModels, because an open loads the AI tab's model list whatever the test is about
// (unanswered, MSW logs an error and its sentence shows in the model area), and waits for the list before it moves
// on. The pin files share one timer recipe, fake timers with shouldAdvanceTime, which keep waitFor and MSW running; a
// key edit that must still be pending is a fireEvent change followed by synchronous steps only, so the debounce
// cannot run before the close or the Sign out that must save it.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import AppSettings from './AppSettings.jsx';
import { server } from '../test/setup.js';
import { withContexts } from '../test/contexts.jsx';

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [
  { id: 'claude-a', name: 'Claude A', provider: 'anthropic' },
  { id: 'claude-b', name: 'Claude B', provider: 'anthropic' },
];

/** Every getModels request of the test; this file reads none (the two designs send different counts). */
let requests;

/** getModels for the test: `reply` answers it, else the two Anthropic models. */
const serveModels = (reply) => server.use(http.get(`${FN}/getModels`, ({ request }) => {
  requests.push(request);
  return reply ? reply(request) : HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' });
}));

/** validateToken as the function answers it: 'good' is a pro token, any other the 401 of an expired one. */
const serveTokens = () => server.use(http.post(`${FN}/validateToken`, async ({ request }) => (
  (await request.json()).token === 'good'
    ? HttpResponse.json({ valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-11-01T00:00:00.000Z', requestId: 'v1' })
    : HttpResponse.json(
      { valid: false, error: 'Token expired', code: 'TOKEN_EXPIRED', requestId: 'v2' },
      { status: 401 },
    )
)));

/** The dialog under both providers, as App renders it; `auth` is layered on the free, signed-out defaults. */
const dialog = ({ isOpen = true, auth } = {}) => withContexts(
  <AppSettings isOpen={isOpen} onClose={() => {}} />,
  { auth },
);

/** App's shape: onClose flips the isOpen it passes down, so a close unmounts whatever the open dialog mounted. */
function Stateful({ onClosed }) {
  const [open, setOpen] = useState(true);
  return <AppSettings isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />;
}

/** Renders `ui` and waits for the AI tab's model list, so no getModels reply lands after the test has moved on. */
async function open(ui) {
  const view = render(ui);
  await screen.findByRole('combobox');
  return view;
}

const TABS = ['AI', 'Data', 'Account', 'Backup'];

const tab = (name) => screen.getByRole('button', { name });

/** The tab buttons' labels, in document order. */
const tabBar = () => screen.getAllByRole('button')
  .map((button) => button.textContent)
  .filter((label) => TABS.includes(label));

/** A field or a button that only that tab shows (on the free tier, with no provider chosen). */
const ONLY_IN = {
  AI: () => screen.queryByPlaceholderText('sk-ant-...'),
  Data: () => screen.queryByPlaceholderText('Paste for real-time data...'),
  Account: () => screen.queryByPlaceholderText('Paste access token...'),
  Backup: () => screen.queryByRole('button', { name: 'Reset all settings' }),
};

/** The tabs on screen. */
const shownTabs = () => TABS.filter((name) => ONLY_IN[name]() !== null);

/** Opens the dialog and, once the AI tab's model list has landed, shows its Account tab. */
async function openAccount(auth) {
  const view = await open(dialog({ auth }));
  fireEvent.click(tab('Account'));
  return view;
}

/** A preference as the store keeps it (JSON in localStorage); null while there is none. */
const stored = (name) => JSON.parse(localStorage.getItem(name));

/** Types into a key field in one synchronous change, which starts its 800 ms debounce. */
const typeKey = (placeholder, value) => {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
};

const SIGNED_OUT = 'Not signed in — data is stored locally only.';

let authEvents;
const onAuth = () => { authEvents += 1; };

describe('AppSettings', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    requests = [];
    authEvents = 0;
    window.addEventListener('auth-changed', onAuth);
  });

  afterEach(() => {
    window.removeEventListener('auth-changed', onAuth);
    vi.useRealTimers();
  });

  it('Pin: every open starts on the AI tab, under the four tab buttons', async () => {
    serveModels();
    const { container, rerender } = await open(dialog());
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(tabBar()).toEqual(TABS);
    expect(shownTabs()).toEqual(['AI']);

    fireEvent.click(tab('Account'));
    expect(shownTabs()).toEqual(['Account']);
    rerender(dialog({ isOpen: false }));
    expect(container).toBeEmptyDOMElement();

    // Reopened, as App does: back on the AI tab, whichever tab was shown when it closed.
    rerender(dialog());
    await waitFor(() => expect(screen.queryByText('Fetching available models...')).toBeNull());
    expect(shownTabs()).toEqual(['AI']);
  });

  it('Pin: the tab bar shows one tab at a time, the one last clicked', async () => {
    serveModels();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await open(dialog());
    for (const name of ['Data', 'Account', 'Backup', 'AI']) {
      await user.click(tab(name));
      expect(shownTabs()).toEqual([name]);
    }
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['the backdrop', () => fireEvent.click(document.querySelector('.backdrop-blur-sm'))],
    ['"Close settings"', () => fireEvent.click(screen.getByLabelText('Close settings'))],
  ])('Pin: %s closes it, and a pending key edit is in the store once it has closed', async (_, close) => {
    serveModels();
    const onClosed = vi.fn();
    const { container } = await open(withContexts(<Stateful onClosed={onClosed} />));
    typeKey('sk-ant-...', 'sk-ant-typed');
    expect(stored('ai_key_anthropic')).toBeNull();

    close();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
    expect(stored('ai_key_anthropic')).toBe('sk-ant-typed');
  });

  it('Pin: signed out, the Account tab says so and offers Sign in only while cloud sign-in is configured', async () => {
    serveModels();
    const { rerender } = await openAccount();
    expect(screen.getByText(SIGNED_OUT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();

    const signIn = vi.fn();
    rerender(dialog({ auth: { signIn } }));
    expect(screen.getByText(SIGNED_OUT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('Pin: signed in, the Account tab shows the e-mail, and Sign out calls signOut', async () => {
    serveModels();
    const signOut = vi.fn(async () => {});
    // Cloud sign-in configured, as it is for every signed-in user: Sign in still does not show.
    await openAccount({ userEmail: 'a@b.c', signedIn: true, signOut, signIn: vi.fn() });
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText('a@b.c')).toBeInTheDocument();
    expect(screen.queryByText(SIGNED_OUT)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  // The sign-out clears every preference: a key edit saved after it would write the key back into the browser it was
  // meant to leave. Only the store at the moment signOut runs is asserted, never when the edits were saved.
  it('Pin: key edits pending on the AI and Data tabs are in the store when Sign out calls signOut', async () => {
    serveModels();
    const keysAtSignOut = [];
    const signOut = vi.fn(async () => {
      keysAtSignOut.push(['ai_key_anthropic', 'data_tradier_key', 'data_finnhub_key'].map(stored));
    });
    await open(dialog({ auth: { userEmail: 'a@b.c', signedIn: true, signOut } }));
    typeKey('sk-ant-...', 'sk-ant-typed');
    expect(stored('ai_key_anthropic')).toBeNull();
    fireEvent.click(tab('Data'));
    typeKey('Paste for real-time data...', 'tradier-typed');
    typeKey('Paste for news, earnings, analyst data...', 'finnhub-typed');
    expect([stored('data_tradier_key'), stored('data_finnhub_key')]).toEqual([null, null]);

    fireEvent.click(tab('Account'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(keysAtSignOut).toEqual([['sk-ant-typed', 'tradier-typed', 'finnhub-typed']]);
  });

  it('Pin: with a token, the premium block shows the tier and the days left instead of the Activate form', async () => {
    serveModels();
    const { rerender } = await openAccount({ isPremium: true, tokenTier: 'pro', daysLeft: 12 });
    expect(screen.getByText('PRO')).toBeInTheDocument();
    expect(screen.getByText('12 days remaining')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Paste access token...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request' })).not.toBeInTheDocument();

    rerender(dialog({ auth: { isPremium: true, tokenTier: 'trial', daysLeft: 1 } }));
    expect(screen.getByText('TRIAL')).toBeInTheDocument();
    expect(screen.getByText('1 day remaining')).toBeInTheDocument();
    expect(screen.queryByText('PRO')).not.toBeInTheDocument();
  });

  it('Pin: Remove access token deletes the stored token and dispatches auth-changed', async () => {
    serveModels();
    localStorage.setItem('access_token', 'header.payload.signature');
    await openAccount({ isPremium: true, tokenTier: 'pro', daysLeft: 12 });
    expect(authEvents).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Remove access token' }));
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(1);
  });

  it('Pin: Activate stores the trimmed token once validateToken accepts it, and dispatches auth-changed', async () => {
    serveModels();
    serveTokens();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openAccount();
    await user.type(screen.getByPlaceholderText('Paste access token...'), '  good  ');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(localStorage.getItem('access_token')).toBe('good'));
    expect(authEvents).toBe(1);
  });

  it('Pin: Activate shows why validateToken rejected a token, and stores nothing', async () => {
    serveModels();
    serveTokens();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openAccount();
    await user.type(screen.getByPlaceholderText('Paste access token...'), 'stale');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Token expired')).toBeInTheDocument();
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  // Matched by its stem: the activation form the dialog is to share with PremiumGate adds "Try again.".
  it('Pin: Activate says it could not validate the token when the request fails, and stores nothing', async () => {
    serveModels();
    server.use(http.post(`${FN}/validateToken`, () => HttpResponse.error()));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openAccount();
    await user.type(screen.getByPlaceholderText('Paste access token...'), 'good');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/Could not validate token/)).toBeInTheDocument();
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authEvents).toBe(0);
  });

  it('Pin: Request swaps the offer for the request-access form', async () => {
    serveModels();
    await openAccount();
    expect(screen.getByText("Don't have a token?")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Your name')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('your@email.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request Access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request' })).not.toBeInTheDocument();
  });
});
