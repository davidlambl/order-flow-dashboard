// src/App.auth.test.jsx — App's sign-in wiring in the main.jsx tree, rendered as App.test.jsx renders it (StrictMode,
// ErrorBoundary and QueryClientProvider around it, MSW answering the functions, fake timers with shouldAdvanceTime
// from Friday 2026-09-25 at 11:00 ET): the screen the Supabase session check leads to, the storage backend built for
// the signed-in account (one per account, its hydrate, SyncChoice, the retry when the account cannot be read), an
// account switch, a session refreshed or revoked elsewhere, and the sign-out.
// The client module is mocked: its `supabase` is a getter over `holder`, so App, LoginForm, session.js and
// SupabaseBackend all reach the fake client a test sets before it renders (test/helpers/fakeSupabase.js, whose auth
// delivers its events as supabase-js 2.118 does; emitAuth stands in for another tab, a token refresh or a revocation).
// The real SupabaseBackend runs over jsdom's localStorage, so a test reads back what this browser stores and what the
// fake recorded (reads, upserts).
// Written against the one-file App.jsx as the contract its move into hooks must keep, so every test is a pin, and each
// asserts end states only (what shows, what is stored, what was sent, after a commit, an event or an unmount), never
// how App gets there. Not pinned here, either way: anything typed or saved while a sign-out waits on the network and
// another tab's sign-out (both in App.signout.test.jsx since their fix), the conflict of an account that signs out and
// back in (useSupabaseAuth.test.jsx), an edit made behind SyncChoice, a token still being validated at a sign-out, the order of the auth
// calls, and how often a warning is logged (warnings are asserted by their text; only the account switch's is
// counted, once).
// The store's backend is module state that an unmount leaves in place, so every test ends by setting a fresh
// LocalStorageBackend while App is still mounted: that disposes the test's SupabaseBackend with its listeners and
// timers, which would otherwise take the next test's writes. A test that opens Settings answers getModels (the AI tab
// loads its models on every open) and waits for it.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import KPICards from './components/KPICards.jsx';
import { queryClient } from './lib/queryClient.js';
import { LocalStorageBackend, setBackend } from './lib/store.js';
import { SupabaseBackend } from './lib/SupabaseBackend.js';
import { fakeSupabase, sessionFor } from '../test/helpers/fakeSupabase.js';
import { installFetchRecorder } from '../test/helpers/fetch.js';

const holder = vi.hoisted(() => ({ client: null }));
vi.mock('./lib/supabase.js', () => ({
  get supabase() { return holder.client; },
}));
// App.test.jsx's render counter: App renders it with unchanged props and nothing memoises it, so each call is an App
// render (two per render under StrictMode).
vi.mock('./components/KPICards.jsx', () => ({ default: vi.fn(() => null) }));

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');
const U1 = 'user-1';
const U2 = 'user-2';

// What the sign-in screen and the console say; nothing exports these sentences.
const CHECK_FAILED_NOTICE = 'Could not check your sign-in status. You can retry or continue without signing in.';
const CHECK_FAILED = 'Could not check the sign-in status:';
const HYDRATE_FAILED = 'Supabase hydrate: could not read the account, nothing synced:';
const ACCOUNT_CHANGED = "Signed-in account changed: removing the previous account's data from this browser (API keys kept).";
const CHOICE_FAILED = 'Sync: could not apply the choice:';
const SIGN_OUT_FAILED = 'Supabase sign-out failed; clearing this browser anyway:';
/** A read that failed at the network (postgrest-js: an error without a code), so hydrate() reports 'offline'. */
const OFFLINE = { message: 'Failed to fetch', code: '' };

/** A complete getMarketData body as the CBOE path sends it: every MarketData field (types/market.ts). */
function marketData(ticker) {
  return {
    ticker,
    provider: 'cboe',
    delay: '15-min delayed',
    spotPrice: 100,
    priceChange: 1.25,
    priceChangePct: 1.27,
    kpis: {
      netPremium: 1_250_000, callPremium: 3_500_000, putPremium: 2_250_000, darkPoolPct: 38.5, maxPain: 100,
      putCallRatio: 0.82, maxPainExpiry: '2026-09-25', putCallOIRatio: 0.91,
      callVolume: 50_000, putVolume: 41_000, callOI: 250_000, putOI: 227_500,
    },
    gexByStrike: [
      { strike: 95, callGex: 1_000_000, putGex: -3_000_000, gex: -2_000_000 },
      { strike: 100, callGex: 6_000_000, putGex: -1_000_000, gex: 5_000_000 },
    ],
    lastUpdated: '2026-09-25T14:59:30.000Z',
    flowHistory: [
      { date: '2026-09-24', netPremium: 800_000, cumPremium: 800_000, callVolume: 45_000, putVolume: 38_000 },
      { date: '2026-09-25', netPremium: 1_250_000, cumPremium: 2_050_000, callVolume: 50_000, putVolume: 41_000 },
    ],
    fallbackReason: null,
    iv30: 31.4,
    lastTradeTime: '2026-09-25T10:59:30',
    totalOptionsCount: 420,
    expiries: ['2026-09-25', '2026-10-02'],
  };
}

/** A getLiveQuote body as the Yahoo path sends it during the regular session. */
function quote(ticker) {
  return {
    ticker, current: 101.5, previousClose: 100, changePercent: 1.5, timestamp: FRIDAY_11_ET.getTime(),
    source: 'yahoo-regular',
  };
}

/** A getTickerContext body with nothing in it: every TickerContext field (types/market.ts), empty. */
const tickerContext = (ticker) => ({
  ticker, news: [], earnings: null, analysts: null, technicals: null, fundamentals: null, marketNews: [], marketQuotes: null, errors: {},
});

const tickerOf = (request) => new URL(request.url).searchParams.get('ticker');

/** base64url without padding, as JWT segments are written (auth.test.js). */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A header.payload.signature token; nothing client-side checks the signature. */
const jwt = (payload) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;
/** A pro token good for 30 days (it unlocks the position inputs and the chat): minted inside a test, after the clock is set. */
const proToken = () => jwt({ sub: 'u1', tier: 'pro', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 });

/**
 * The functions these tests reach: market data and the quote; validateToken (verifyStoredToken posts it at startup)
 * and getTickerContext, which a stored token enables; and getModels, which the Settings dialog's AI tab requests on
 * every open (unanswered, MSW logs an error after the test's own console check).
 */
function serveFunctions() {
  server.use(
    http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
    http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
    http.post(`${FN}/validateToken`, () => HttpResponse.json({ valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-10-25T00:00:00.000Z', requestId: 'req-1' })),
    http.get(`${FN}/getTickerContext`, ({ request }) => HttpResponse.json(tickerContext(tickerOf(request)))),
    http.get(`${FN}/getModels`, () => HttpResponse.json({ models: [], provider: 'anthropic', requestId: 'm1' })),
  );
}

const renderApp = () => render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

/** Every TanStack request has been answered and applied, so no query result lands outside act() after this. */
const settled = () => waitFor(() => { expect(queryClient.isFetching()).toBe(0); }, { timeout: 5_000 });

/** PositionAnalysis' cost-basis input, which (behind the gate, with a token) replaces the skeletons once the data lands. */
const costInput = () => screen.findByPlaceholderText('Avg cost', {}, { timeout: 5_000 });

/** Makes `fakeSupabase(options)` the app's client; set before the render, and never changed while App is mounted. */
const setClient = (options) => {
  holder.client = fakeSupabase(options);
  return holder.client;
};

/** An account's position row as the cloud holds it. */
const posRow = (userId, ticker, costBasis, shares) => ({
  user_id: userId, ticker, cost_basis: costBasis, shares, updated_at: '2026-09-20T00:00:00.000Z', deleted_at: null,
});
/** The position upserts the fake received, as [user, ticker, cost basis, shares]; a tombstone has both null. */
const positionUpserts = (client) => client.upserts.filter((u) => u.table === 'positions')
  .map((u) => [u.rows[0].user_id, u.rows[0].ticker, u.rows[0].cost_basis, u.rows[0].shares]);
/** The account's position rows, sorted, as [ticker, cost basis, shares, deleted]. */
const cloudPositions = (client) => client.tables.positions
  .map((r) => [r.ticker, r.cost_basis, r.shares, r.deleted_at != null]).sort();
/** This browser's stored position for `ticker`, or null. */
const stored = (ticker) => JSON.parse(localStorage.getItem(`position_${ticker}`));
/** `n` hydrates have read the account: each reads its three tables. */
const hydrated = (client, n = 1) => waitFor(() => { expect(client.reads).toHaveLength(3 * n); }, { timeout: 5_000 });
/** Moves the fake clock on by `ms`, running what falls due inside act(). */
const after = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Each distinct warning logged, by its first argument. */
const warningsOf = (warn) => [...new Set(warn.mock.calls.map(([message]) => message))].sort();
/** The open Settings dialog. */
const settingsDialog = () => screen.getByRole('dialog', { name: 'Settings' });

/** Holds the client's session check until the returned release is called: a check still running. */
function holdSessionCheck(client) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const check = client.auth.getSession;
  client.auth.getSession = async () => {
    await held;
    return check();
  };
  return release;
}

const encoder = new TextEncoder();
/** One streamed text chunk in Anthropic's SSE form, as askLLM relays it. */
const textEvent = (text) => `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;

/** One askLLM reply the test feeds by hand (ChatBot.history.test.jsx's): chunk(text) streams more of it. */
function liveStream() {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  return {
    response: () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'req-1' },
    }),
    chunk: (text) => controller.enqueue(encoder.encode(textEvent(text))),
  };
}

describe('App: the session, the per-account backend and the sign-out', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
  });

  afterEach(() => {
    holder.client = null;
    setBackend(new LocalStorageBackend());
    vi.useRealTimers();
  });

  describe('the screens', () => {
    it('Pin: nothing but a spinner while the session check runs, then the sign-in screen when there is no session', async () => {
      const error = vi.spyOn(console, 'error');
      serveFunctions();
      const client = setClient();
      const release = holdSessionCheck(client);
      const { container } = renderApp();
      expect(container.textContent).toBe('');
      expect(container.querySelector('.animate-spin')).not.toBeNull();

      await after(50); // the subscription's INITIAL_SESSION has come and gone; the check has not answered
      expect(container.textContent).toBe('');
      expect(container.querySelector('.animate-spin')).not.toBeNull();

      release();
      expect(await screen.findByPlaceholderText('you@example.com', {}, { timeout: 5_000 })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send magic link' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue without signing in' })).toBeInTheDocument();
      expect(screen.queryByRole('status')).toBeNull(); // no notice: the check worked
      expect(screen.queryByLabelText('Open settings')).toBeNull();
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: "Continue without signing in" shows the dashboard and is remembered on this browser', async () => {
      const error = vi.spyOn(console, 'error');
      serveFunctions();
      setClient();
      const first = renderApp();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue without signing in' }, { timeout: 5_000 }));
      expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
      expect(localStorage.getItem('auth_skipped')).toBe('1');
      await settled();
      first.unmount();

      // A reload: the check runs again, and the dashboard follows it with no sign-in screen in between.
      const { container } = renderApp();
      expect(container.textContent).toBe('');
      expect(await screen.findByLabelText('Open settings', {}, { timeout: 5_000 })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('you@example.com')).toBeNull();
      await settled();
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: a session check that rejects leads to the sign-in screen with the notice', async () => {
      const error = vi.spyOn(console, 'error');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serveFunctions();
      setClient({ sessionReject: new Error('storage blocked') });
      renderApp();
      expect(await screen.findByRole('status', {}, { timeout: 5_000 })).toHaveTextContent(CHECK_FAILED_NOTICE);
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue without signing in' })).toBeInTheDocument();
      expect(warn).toHaveBeenCalledWith(CHECK_FAILED, 'storage blocked');
      expect(warningsOf(warn)).toEqual([CHECK_FAILED]);
      expect(error).not.toHaveBeenCalled();
    });

    // supabase-js resolves the check with this error and no session when refreshing an expired session fails at the
    // network; the stored session is kept, so a later refresh can still sign the user back in.
    it('Pin: a session check that fails at the network (AuthRetryableFetchError) shows the notice too', async () => {
      const error = vi.spyOn(console, 'error');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serveFunctions();
      setClient({ sessionError: new AuthRetryableFetchError('Failed to fetch', 0) });
      renderApp();
      expect(await screen.findByRole('status', {}, { timeout: 5_000 })).toHaveTextContent(CHECK_FAILED_NOTICE);
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(warn).toHaveBeenCalledWith(CHECK_FAILED, 'Failed to fetch');
      expect(warningsOf(warn)).toEqual([CHECK_FAILED]);
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: after a failed check, a session from elsewhere shows the app, and when it ends the notice is gone', async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      serveFunctions();
      const client = setClient({ sessionReject: new Error('storage blocked') });
      renderApp();
      expect(await screen.findByRole('status', {}, { timeout: 5_000 })).toHaveTextContent(CHECK_FAILED_NOTICE);

      act(() => { client.emitAuth('SIGNED_IN', sessionFor(U1)); }); // signed in from another tab, or a refresh that worked
      expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
      await hydrated(client);
      await settled();

      act(() => { client.emitAuth('SIGNED_OUT', null); });
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(screen.queryByRole('status')).toBeNull();
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: skipped, then signed in elsewhere, then that session ends: the sign-in screen, not the app in local mode', async () => {
      const error = vi.spyOn(console, 'error');
      localStorage.setItem('auth_skipped', '1');
      serveFunctions();
      const client = setClient();
      renderApp();
      expect(await screen.findByLabelText('Open settings', {}, { timeout: 5_000 })).toBeInTheDocument();

      act(() => { client.emitAuth('SIGNED_IN', sessionFor(U1)); }); // a magic link opened in another tab
      await hydrated(client);
      expect(localStorage.getItem('auth_skipped')).toBeNull();
      await settled();

      act(() => { client.emitAuth('SIGNED_OUT', null); });
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(screen.queryByLabelText('Open settings')).toBeNull();
      expect(error).not.toHaveBeenCalled();
    });

    it(`Pin: the Account tab's "Sign in" from skipped mode closes Settings, shows the sign-in screen and forgets the skip`, async () => {
      const error = vi.spyOn(console, 'error');
      localStorage.setItem('auth_skipped', '1');
      serveFunctions();
      setClient();
      renderApp();
      fireEvent.click(await screen.findByLabelText('Open settings', {}, { timeout: 5_000 }));
      fireEvent.click(within(settingsDialog()).getByRole('tab', { name: 'Account' }));
      fireEvent.click(within(settingsDialog()).getByRole('button', { name: 'Sign in' }));
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(localStorage.getItem('auth_skipped')).toBeNull();

      // Skipped again, the dashboard comes back with Settings closed.
      fireEvent.click(screen.getByRole('button', { name: 'Continue without signing in' }));
      expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
      expect(screen.queryByLabelText('Close settings')).toBeNull();
      await settled();
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: with no Supabase client the dashboard shows at once, and the Account tab offers no "Sign in"', async () => {
      const error = vi.spyOn(console, 'error');
      serveFunctions();
      renderApp();
      fireEvent.click(screen.getByLabelText('Open settings'));
      fireEvent.click(within(settingsDialog()).getByRole('tab', { name: 'Account' }));
      expect(screen.getByText('Not signed in — data is stored locally only.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
      await settled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("the signed-in account's backend", () => {
    it("Pin: a session pulls the account into an empty browser, and the account's position shows", async () => {
      const error = vi.spyOn(console, 'error');
      localStorage.setItem('access_token', proToken());
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'AVGO', 120, 3)] } });
      renderApp();
      await waitFor(() => { expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(120); }, { timeout: 5_000 });
      expect(screen.getByPlaceholderText('Shares')).toHaveValue(3);
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
      expect(stored('AVGO')).toEqual({ costBasis: 120, shares: 3 });
      expect(localStorage.getItem('local_data_owner')).toBe(U1);
      await settled();
      expect(client.upserts).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: StrictMode builds one backend for the account: one hydrate, one auth subscription', async () => {
      const error = vi.spyOn(console, 'error');
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      serveFunctions();
      const client = setClient({ session: sessionFor(U1) });
      renderApp();
      await hydrated(client);
      await settled();
      await after(50);
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(client.reads).toHaveLength(3);
      expect(client.subscribers).toBe(1);
      expect(error).not.toHaveBeenCalled();
    });

    it("Pin: a session pushes this browser's data into an empty account, under the user", async () => {
      const error = vi.spyOn(console, 'error');
      localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 50, shares: 1 })); // used here without signing in
      serveFunctions();
      const client = setClient({ session: sessionFor(U1) });
      renderApp();
      await waitFor(() => { expect(positionUpserts(client)).toEqual([[U1, 'AVGO', 50, 1]]); }, { timeout: 5_000 });
      expect(cloudPositions(client)).toEqual([['AVGO', 50, 1, false]]);
      expect(stored('AVGO')).toEqual({ costBasis: 50, shares: 1 });
      expect(localStorage.getItem('local_data_owner')).toBe(U1);
      await settled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  // This browser holds NVDA from use without signing in; the account holds AVGO and TSLA. Nothing is typed while the
  // dialog is up.
  describe('SyncChoice', () => {
    async function renderConflict() {
      localStorage.setItem('access_token', proToken());
      localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 50, shares: 2 }));
      serveFunctions();
      const client = setClient({
        session: sessionFor(U1),
        tables: { positions: [posRow(U1, 'AVGO', 120, 10), posRow(U1, 'TSLA', 200, 1)] },
      });
      renderApp();
      const dialog = await screen.findByRole('dialog', { name: 'Sync your data' }, { timeout: 5_000 });
      await costInput();
      await settled();
      return { client, dialog };
    }

    const choose = async (dialog, name) => {
      fireEvent.click(within(dialog).getByRole('button', { name }));
      await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Sync your data' })).toBeNull(); });
    };

    it("Pin: a conflict shows SyncChoice with both sides' counts, and nothing is written before a choice", async () => {
      const error = vi.spyOn(console, 'error');
      const { client, dialog } = await renderConflict();
      expect(dialog).toHaveTextContent('This browser: 1 position · 0 chats · 0 settings');
      expect(dialog).toHaveTextContent('Your account: 2 positions · 0 chats · 0 settings');
      await after(400);
      expect(client.upserts).toEqual([]);
      expect(cloudPositions(client)).toEqual([['AVGO', 120, 10, false], ['TSLA', 200, 1, false]]);
      expect(stored('NVDA')).toEqual({ costBasis: 50, shares: 2 });
      expect(stored('AVGO')).toBeNull();
      expect(error).not.toHaveBeenCalled();
    });

    it(`Pin: "Use cloud copy" replaces this browser's data with the account's and closes the dialog`, async () => {
      const error = vi.spyOn(console, 'error');
      const { client, dialog } = await renderConflict();
      await choose(dialog, /Use cloud copy/);
      await waitFor(() => { expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(120); });
      expect(stored('NVDA')).toBeNull();
      expect(stored('AVGO')).toEqual({ costBasis: 120, shares: 10 });
      expect(stored('TSLA')).toEqual({ costBasis: 200, shares: 1 });
      await after(50);
      expect(client.upserts).toEqual([]);
      expect(cloudPositions(client)).toEqual([['AVGO', 120, 10, false], ['TSLA', 200, 1, false]]);
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: "Merge" keeps both sides here and in the account, and closes the dialog', async () => {
      const error = vi.spyOn(console, 'error');
      const { client, dialog } = await renderConflict();
      await choose(dialog, /^Merge/);
      await waitFor(() => { expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(120); });
      expect(stored('NVDA')).toEqual({ costBasis: 50, shares: 2 });
      expect(stored('AVGO')).toEqual({ costBasis: 120, shares: 10 });
      expect(stored('TSLA')).toEqual({ costBasis: 200, shares: 1 });
      await waitFor(() => {
        expect(cloudPositions(client)).toEqual([['AVGO', 120, 10, false], ['NVDA', 50, 2, false], ['TSLA', 200, 1, false]]);
      });
      expect(positionUpserts(client)).toEqual([[U1, 'NVDA', 50, 2]]);
      expect(error).not.toHaveBeenCalled();
    });

    it(`Pin: "Use this browser's copy" replaces the account's data with this browser's and closes the dialog`, async () => {
      const error = vi.spyOn(console, 'error');
      const { client, dialog } = await renderConflict();
      await choose(dialog, /Use this browser/);
      await waitFor(() => {
        expect(cloudPositions(client)).toEqual([['AVGO', null, null, true], ['NVDA', 50, 2, false], ['TSLA', null, null, true]]);
      });
      expect(stored('NVDA')).toEqual({ costBasis: 50, shares: 2 });
      expect(stored('AVGO')).toBeNull();
      expect(stored('TSLA')).toBeNull();
      expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(null);
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: a choice that cannot be applied closes the dialog with a warning', async () => {
      const error = vi.spyOn(console, 'error');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(SupabaseBackend.prototype, 'resolveConflict').mockRejectedValueOnce(new Error('boom'));
      const { dialog } = await renderConflict();
      await choose(dialog, /^Merge/);
      expect(warn).toHaveBeenCalledWith(CHOICE_FAILED, 'boom');
      expect(warningsOf(warn)).toEqual([CHOICE_FAILED]);
      await settled();
      expect(error).not.toHaveBeenCalled();
    });

    it("Pin: one account's unresolved conflict does not show over another account's dashboard", async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { client } = await renderConflict();
      act(() => { client.emitAuth('SIGNED_IN', sessionFor(U2)); }); // another account signed in from another tab
      await hydrated(client, 2);
      await settled();
      expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Sync your data' })).toBeNull();
      expect(error).not.toHaveBeenCalled();
    });
  });

  // hydrate() reports 'offline' when the account cannot be read and writes nothing; it then runs once more when the
  // browser is next online.
  describe('the retry when the account could not be read', () => {
    it('Pin: an account that could not be read is hydrated once more when the browser is next online, and only once', async () => {
      const error = vi.spyOn(console, 'error');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), readError: { positions: OFFLINE } });
      renderApp();
      await hydrated(client);
      await settled();
      await after(50);
      expect(client.reads).toHaveLength(3);

      act(() => { window.dispatchEvent(new Event('online')); });
      await hydrated(client, 2); // the retry, which cannot read the account either
      act(() => { window.dispatchEvent(new Event('online')); });
      await after(50);
      expect(client.reads).toHaveLength(6);
      expect(warn).toHaveBeenCalledWith(HYDRATE_FAILED, OFFLINE.message);
      expect(warningsOf(warn)).toEqual([HYDRATE_FAILED]);
      expect(error).not.toHaveBeenCalled();
    });

    it("Pin: the retry's report is handled like the first: a conflict found once online shows SyncChoice", async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 50, shares: 2 }));
      serveFunctions();
      const readError = { positions: OFFLINE };
      const client = setClient({ session: sessionFor(U1), readError, tables: { positions: [posRow(U1, 'AVGO', 120, 10)] } });
      renderApp();
      await hydrated(client);
      await settled();
      expect(screen.queryByRole('dialog', { name: 'Sync your data' })).toBeNull();

      delete readError.positions; // the network is back
      act(() => { window.dispatchEvent(new Event('online')); });
      const dialog = await screen.findByRole('dialog', { name: 'Sync your data' }, { timeout: 5_000 });
      expect(dialog).toHaveTextContent('This browser: 1 position · 0 chats · 0 settings');
      expect(dialog).toHaveTextContent('Your account: 1 position · 0 chats · 0 settings');
      expect(client.reads).toHaveLength(6);
      expect(client.upserts).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: a retry still waiting is dropped by a sign-out: no hydrate once the browser is online', async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), readError: { positions: OFFLINE } });
      renderApp();
      await hydrated(client);
      await settled();
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByPlaceholderText('you@example.com', {}, { timeout: 5_000 })).toBeInTheDocument();
      await after(50); // the sign-out has finished

      act(() => { window.dispatchEvent(new Event('online')); });
      await after(50);
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(client.reads).toHaveLength(3);
      expect(error).not.toHaveBeenCalled();
    });

    it("Pin: a retry still waiting is dropped by an account switch: only the second account's hydrate runs", async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      serveFunctions();
      const readError = { positions: OFFLINE };
      const client = setClient({ session: sessionFor(U1), readError });
      renderApp();
      await hydrated(client);
      await settled();

      delete readError.positions; // the second account can be read, so it leaves no retry of its own
      act(() => { client.emitAuth('SIGNED_IN', sessionFor(U2)); });
      await hydrated(client, 2);
      await settled();
      act(() => { window.dispatchEvent(new Event('online')); });
      await after(50);
      expect(hydrate).toHaveBeenCalledTimes(2); // the first account's and the second's, never the first's again
      expect(client.reads).toHaveLength(6);
      expect(error).not.toHaveBeenCalled();
    });

    // After an unmount the store keeps the account's backend (nothing replaces it), so a retry left behind would read.
    it('Pin: a retry still waiting is dropped by an unmount: nothing is read once the browser is online', async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), readError: { positions: OFFLINE } });
      const view = renderApp();
      await hydrated(client);
      await settled();
      view.unmount();

      act(() => { window.dispatchEvent(new Event('online')); });
      await after(50);
      expect(client.reads).toHaveLength(3);
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: a hydrate that reports after its session has ended arms no retry', async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
      serveFunctions();
      let release;
      const client = setClient({ session: sessionFor(U1), gate: new Promise((resolve) => { release = resolve; }) });
      renderApp();
      await waitFor(() => { expect(hydrate).toHaveBeenCalledTimes(1); }, { timeout: 5_000 }); // its reads held
      act(() => { client.emitAuth('SIGNED_OUT', null); });
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();

      await act(async () => { release(); await vi.advanceTimersByTimeAsync(20); }); // the reads answer, too late
      expect(client.reads).toHaveLength(3);
      act(() => { window.dispatchEvent(new Event('online')); });
      await after(50);
      expect(hydrate).toHaveBeenCalledTimes(1);
      await settled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  // Another account signs in without a sign-out here: a magic link for another user opened in another tab of this
  // browser, whose client already holds the new session.
  describe('an account switch', () => {
    // Known: the edit is written through the first account's backend, and the switch clears it with that account's
    // queue before it is sent, since the client already holds the second account's session and the write could no
    // longer reach the first account; so it is in neither.
    it('Pin (known): an edit inside its debounce at an account switch reaches neither account', async () => {
      const error = vi.spyOn(console, 'error');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      localStorage.setItem('access_token', proToken());
      localStorage.setItem('ai_key_openai', JSON.stringify('sk-keep'));
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'NVDA', 80, 2)] } });
      renderApp();
      const cost = await costInput();
      await hydrated(client);
      await settled();
      expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 }); // the first account's, pulled
      const settingsButton = screen.getByLabelText('Open settings');

      fireEvent.change(cost, { target: { value: '95' } });
      expect(stored('AVGO')).toBeNull(); // still inside its debounce
      act(() => { client.emitAuth('SIGNED_IN', sessionFor(U2)); });
      await hydrated(client, 2);
      await after(400); // past the 300 ms debounce
      await settled();
      expect(client.upserts).toEqual([]);
      expect(stored('AVGO')).toBeNull();
      expect(stored('NVDA')).toBeNull();
      expect(localStorage.getItem(`sync_outbox_${U1}`)).toBeNull();
      expect(localStorage.getItem(`sync_meta_${U1}`)).toBeNull();
      expect(localStorage.getItem('local_data_owner')).toBe(U2);
      expect(localStorage.getItem('ai_key_openai')).toBe(JSON.stringify('sk-keep'));
      expect(screen.getByLabelText('Open settings')).not.toBe(settingsButton); // everything below App remounted
      expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(null);
      expect(warn.mock.calls.filter(([message]) => message === ACCOUNT_CHANGED)).toHaveLength(1);
      expect(warningsOf(warn)).toEqual([ACCOUNT_CHANGED]);
      expect(error).not.toHaveBeenCalled();
    });

    // The editor saves its pending text as it unmounts with the first account's dashboard, before the second account's
    // backend exists; the switch then clears it with the first account's queue.
    it('Pin: the strategic context typed just before an account switch reaches neither account', async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      serveFunctions();
      const client = setClient({ session: sessionFor(U1) });
      renderApp();
      await hydrated(client);
      await settled();
      fireEvent.click(screen.getByLabelText('Open settings'));
      fireEvent.click(within(settingsDialog()).getByRole('tab', { name: 'Backup' }));
      fireEvent.click(within(settingsDialog()).getByRole('button', { name: /Add strategic context/ }));
      fireEvent.change(await screen.findByPlaceholderText(/^Paste your strategic context here/), { target: { value: "A's private thesis" } });
      expect(localStorage.getItem('strategic_context')).toBeNull(); // still inside the editor's autosave

      act(() => { client.emitAuth('SIGNED_IN', sessionFor(U2)); });
      await hydrated(client, 2);
      await after(1_200); // past the editor's 1 s autosave
      await settled();
      expect(client.upserts).toEqual([]);
      expect(localStorage.getItem('strategic_context')).toBeNull();
      expect(error).not.toHaveBeenCalled();
    });

    // The chat saves a reply still streaming as it unmounts with the first account's dashboard; the switch then clears
    // it with the first account's queue.
    it('Pin: a reply still streaming at an account switch reaches neither account', async () => {
      const error = vi.spyOn(console, 'error');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      localStorage.setItem('access_token', proToken());
      serveFunctions();
      const reply = liveStream();
      const network = globalThis.fetch;
      const recorder = installFetchRecorder();
      onTestFinished(() => recorder.uninstall());
      recorder.setFetch(async (url, init) => (String(url).includes('/askLLM') ? reply.response() : network(url, init)));
      const client = setClient({ session: sessionFor(U1) });
      renderApp();
      await costInput();
      await hydrated(client);
      await settled();

      fireEvent.click(screen.getByLabelText('Open AI Co-Pilot'));
      const box = await screen.findByPlaceholderText('Ask about the flow...');
      fireEvent.change(box, { target: { value: 'A question from the first account' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => { expect(recorder.calls.some(({ url }) => url.includes('/askLLM'))).toBe(true); });
      await act(async () => {
        reply.chunk('A partial answer for the first account');
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByText('A partial answer for the first account')).toBeInTheDocument();
      expect(localStorage.getItem('chat_history_AVGO')).toBeNull(); // a reply is stored when it settles, and this one has not

      act(() => { client.emitAuth('SIGNED_IN', sessionFor(U2)); });
      await hydrated(client, 2);
      await after(400);
      await settled();
      expect(client.upserts).toEqual([]);
      expect(localStorage.getItem('chat_history_AVGO')).toBeNull();
      expect(error).not.toHaveBeenCalled();
    });
  });

  it('Pin: a refreshed session for the same user builds no second backend and remounts nothing: one App render per event', async () => {
    const error = vi.spyOn(console, 'error');
    const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    renderApp();
    await costInput();
    await hydrated(client);
    await settled();
    const settingsButton = screen.getByLabelText('Open settings');

    // Each event carries a new session object for the same user, as supabase-js delivers them.
    let renders = KPICards.mock.calls.length;
    act(() => { client.emitAuth('TOKEN_REFRESHED', sessionFor(U1)); });
    expect(KPICards.mock.calls.length - renders).toBe(2);
    renders = KPICards.mock.calls.length;
    act(() => { client.emitAuth('SIGNED_IN', sessionFor(U1)); }); // a tab focus
    expect(KPICards.mock.calls.length - renders).toBe(2);

    await after(50);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(client.reads).toHaveLength(3);
    expect(screen.getByLabelText('Open settings')).toBe(settingsButton);
    expect(error).not.toHaveBeenCalled();
  });

  // Signed out on another device, which revokes every session: this browser's storage is untouched and still marked as
  // the account's. Its data stays, and an edit still inside its debounce waits in the account's queue for the next
  // sign-in here.
  it("Pin: a session revoked elsewhere shows the sign-in screen and keeps this browser's data for the account", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'NVDA', 80, 2)] } });
    renderApp();
    const cost = await costInput();
    await hydrated(client);
    await settled();

    fireEvent.change(cost, { target: { value: '95' } });
    expect(stored('AVGO')).toBeNull(); // still inside its debounce
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    await after(400);
    expect(client.upserts).toEqual([]);
    expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 });
    expect(stored('AVGO')).toEqual({ costBasis: 95, shares: null });
    expect(localStorage.getItem('local_data_owner')).toBe(U1);
    expect(JSON.parse(localStorage.getItem(`sync_outbox_${U1}`))).toEqual([
      { table: 'positions', key: 'AVGO', op: 'upsert', row: { ticker: 'AVGO', cost_basis: 95, shares: null }, ts: expect.any(Number) },
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it('Pin: the AI and data settings left in sessionStorage move into localStorage, and a session clears auth_skipped', async () => {
    const error = vi.spyOn(console, 'error');
    sessionStorage.setItem('ai_provider', 'openai');
    localStorage.setItem('auth_skipped', '1');
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    renderApp();
    await hydrated(client);
    await settled();
    expect(localStorage.getItem('ai_provider')).toBe(JSON.stringify('openai'));
    expect(sessionStorage.getItem('ai_provider')).toBeNull();
    expect(localStorage.getItem('auth_skipped')).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  describe("the Header's sign-out", () => {
    it('Pin: declined, it ends nothing and keeps the data; an edit typed before it is saved and sent at once', async () => {
      const error = vi.spyOn(console, 'error');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      localStorage.setItem('access_token', proToken());
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'NVDA', 80, 2)] } });
      renderApp();
      const cost = await costInput();
      await hydrated(client);
      await settled();

      fireEvent.change(cost, { target: { value: '95' } });
      expect(stored('AVGO')).toBeNull(); // still inside its debounce
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await after(50); // well inside the 300 ms debounce
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(client.signOuts).toBe(0);
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
      expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 });
      expect(localStorage.getItem('local_data_owner')).toBe(U1);
      expect(localStorage.getItem('access_token')).not.toBeNull();
      expect(stored('AVGO')).toEqual({ costBasis: 95, shares: null });
      expect(positionUpserts(client)).toEqual([[U1, 'AVGO', 95, null]]);
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: confirmed, it sends the pending edit before ending the session, clears this browser and shows the sign-in screen', async () => {
      const error = vi.spyOn(console, 'error');
      const warn = vi.spyOn(console, 'warn');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      localStorage.setItem('access_token', proToken());
      localStorage.setItem('ai_key_openai', JSON.stringify('sk-mine'));
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'NVDA', 80, 2)] } });
      let sentBeforeSignOut = null;
      const endSession = client.auth.signOut;
      client.auth.signOut = () => {
        sentBeforeSignOut = positionUpserts(client);
        return endSession();
      };
      renderApp();
      const cost = await costInput();
      await hydrated(client);
      await settled();

      fireEvent.change(cost, { target: { value: '95' } });
      expect(stored('AVGO')).toBeNull(); // still inside its debounce
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByPlaceholderText('you@example.com', {}, { timeout: 5_000 })).toBeInTheDocument();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(client.signOuts).toBe(1);
      expect(sentBeforeSignOut).toEqual([[U1, 'AVGO', 95, null]]);
      expect(cloudPositions(client)).toEqual([['AVGO', 95, null, false], ['NVDA', 80, 2, false]]); // the account's copy is kept
      await after(400);
      expect(Object.keys(localStorage)).toEqual([]); // data, API key, access token and the owner mark
      expect(positionUpserts(client)).toEqual([[U1, 'AVGO', 95, null]]);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('Pin: when the auth call throws, this browser is cleared anyway and the sign-in screen shows', async () => {
      const error = vi.spyOn(console, 'error');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      localStorage.setItem('access_token', proToken());
      serveFunctions();
      const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'NVDA', 80, 2)] } });
      client.auth.signOut = async () => { throw new Error('fetch failed'); }; // no SIGNED_OUT either
      renderApp();
      await costInput();
      await hydrated(client);
      await settled();

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByPlaceholderText('you@example.com', {}, { timeout: 5_000 })).toBeInTheDocument();
      await after(50);
      expect(Object.keys(localStorage)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(SIGN_OUT_FAILED, 'fetch failed');
      expect(warningsOf(warn)).toEqual([SIGN_OUT_FAILED]);
      expect(error).not.toHaveBeenCalled();
    });
  });
});
