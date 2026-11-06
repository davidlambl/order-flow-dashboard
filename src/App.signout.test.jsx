// src/App.signout.test.jsx — what a sign-out leaves in this browser, App rendered as App.auth.test.jsx renders it
// (StrictMode, ErrorBoundary and QueryClientProvider around it, MSW answering the functions, fake timers with
// shouldAdvanceTime from Friday 2026-09-25 at 11:00 ET, the client module mocked so that App, LoginForm, session.js and
// SupabaseBackend reach the fake client of test/helpers/fakeSupabase.js, over the real SupabaseBackend).
// A sign-out removes this browser's copy of the account's data and the mark of whose it is, and the next account to
// sign in here takes whatever unmarked data it finds as this browser's and uploads it. So nothing written after that
// clear may outlive it: an edit typed while the sign-out waits on the network, whether its request then succeeds or
// throws; what the dashboard saves as it unmounts (the strategic-context editor's pending text, a key typed in
// Settings); and, when another tab of this browser signs out, what this tab writes through the account's backend into
// the storage that tab has just emptied: its pending edit, whether the storage event or SIGNED_OUT reaches it first, a
// reply it was still streaming, and the account's cloud copy, which a hydrate still reading pulls in. Those cross-tab
// tests hold for a tab that already SEES the emptied storage when it handles the event. A real browser can deliver the
// other tab's SIGNED_OUT first (two Chromium tabs did, every time), and that order is pinned as a known gap: the
// pending edit stays, and the next account uploads it. What is someone's stays: after a session revoked on another
// device the data is still marked as the account's, and a sign-out this tab hears of late (frozen in the background
// meanwhile) can find the browser in use without an account, or marked as the next account's.
// The store's backend is module state that an unmount leaves in place, so every test ends by setting a fresh
// LocalStorageBackend while App is still mounted (App.auth.test.jsx says why).
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { setToken } from './lib/auth.js';
import { queryClient } from './lib/queryClient.js';
import { LocalStorageBackend, setBackend } from './lib/store.js';
import { SupabaseBackend } from './lib/SupabaseBackend.js';
import { fakeSupabase, sessionFor } from '../test/helpers/fakeSupabase.js';
import { installFetchRecorder } from '../test/helpers/fetch.js';

const holder = vi.hoisted(() => ({ client: null }));
vi.mock('./lib/supabase.js', () => ({
  get supabase() { return holder.client; },
}));

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');
const U1 = 'user-1';
const U2 = 'user-2';

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
/** The position upserts the fake received, as [user, ticker, cost basis, shares]. */
const positionUpserts = (client) => client.upserts.filter((u) => u.table === 'positions')
  .map((u) => [u.rows[0].user_id, u.rows[0].ticker, u.rows[0].cost_basis, u.rows[0].shares]);
/** Every upsert sent under `userId`, whatever its table. */
const upsertsFor = (client, userId) => client.upserts.filter((u) => u.rows[0].user_id === userId);
/** This browser's stored position for `ticker`, or null. */
const stored = (ticker) => JSON.parse(localStorage.getItem(`position_${ticker}`));
/** What this browser keeps of an account: positions, chats, and the account's queued writes and sync dates. */
const accountKeys = () => Object.keys(localStorage)
  .filter((key) => /^(position_|chat_history_|sync_outbox_|sync_meta_)/.test(key)).sort();
/** `n` hydrates have read the account: each reads its three tables. */
const hydrated = (client, n = 1) => waitFor(() => { expect(client.reads).toHaveLength(3 * n); }, { timeout: 5_000 });
/** Moves the fake clock on by `ms`, running what falls due inside act(). */
const after = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** The open Settings dialog. */
const settingsDialog = () => screen.getByRole('heading', { name: 'Settings' }).closest('div.fixed');
/** The sign-in screen. */
const signInShown = () => screen.queryByPlaceholderText('you@example.com') !== null;

/**
 * Holds the client's sign-out at its request to the server (supabase-js's POST /logout) until release() is called;
 * requests() counts the calls that reached it. With `fails`, the released call throws it and no SIGNED_OUT arrives, so
 * only the hook's own sign-out ends the session in this tab.
 */
function holdSignOut(client, { fails = null } = {}) {
  let release;
  let requests = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const endSession = client.auth.signOut;
  client.auth.signOut = async () => {
    requests += 1;
    await held;
    if (fails) throw fails;
    return endSession();
  };
  return { release, requests: () => requests };
}

/**
 * Another tab of this browser signs the account out: its sign-out has emptied the storage both tabs share (jsdom sends
 * this tab no storage event for it), and its SIGNED_OUT then reaches this tab.
 */
function signedOutInAnotherTab(client) {
  localStorage.clear();
  act(() => { client.emitAuth('SIGNED_OUT', null); });
}

/**
 * The same sign-out heard first through the storage: the emptied storage, the storage event a clear sends the other
 * tabs (jsdom sends none, so the test does), and the store-changed this tab turns it into a macrotask later. The
 * SIGNED_OUT that follows is the test's.
 */
async function storageClearedInAnotherTab() {
  localStorage.clear();
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })); });
  await after(20);
}

/** The next account signs in from another tab, and its hydrate reads; the debounces and autosaves then run out. */
async function nextAccountSignsIn(client) {
  act(() => { client.emitAuth('SIGNED_IN', sessionFor(U2)); });
  await hydrated(client, 2);
  await after(1_200);
  await settled();
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

describe('App: nothing written after a sign-out outlives it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
  });

  afterEach(() => {
    holder.client = null;
    setBackend(new LocalStorageBackend());
    vi.useRealTimers();
  });

  it('an edit typed while the sign-out waits on the network is gone after it, and never reaches the next account', async () => {
    const error = vi.spyOn(console, 'error');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    const signOut = holdSignOut(client);
    renderApp();
    await costInput();
    await hydrated(client);
    await settled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await after(10);
    expect(signOut.requests()).toBe(1); // the queued writes are sent; the request to end the session is out
    fireEvent.change(screen.getByPlaceholderText('Avg cost'), { target: { value: '95' } }); // the dashboard is still up
    await act(async () => {
      signOut.release();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(signInShown()).toBe(true);
    await after(400); // past the 300 ms debounce
    expect(stored('AVGO')).toBeNull();
    expect(localStorage.getItem('local_data_owner')).toBeNull();

    await nextAccountSignsIn(client);
    expect(upsertsFor(client, U2)).toEqual([]);
    expect(client.upserts).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  // supabase-js delivers no SIGNED_OUT when its sign-out throws. session.js clears this browser anyway, and the session
  // here ends through the hook's own sign-out.
  it('an edit typed while a sign-out waits on a request that then throws is gone after it, and never reaches the next account', async () => {
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    const signOut = holdSignOut(client, { fails: new Error('fetch failed') });
    renderApp();
    await costInput();
    await hydrated(client);
    await settled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await after(10);
    expect(signOut.requests()).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Avg cost'), { target: { value: '95' } });
    await act(async () => {
      signOut.release();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(signInShown()).toBe(true);
    expect(warn).toHaveBeenCalledWith('Supabase sign-out failed; clearing this browser anyway:', 'fetch failed');
    await after(400); // past the 300 ms debounce
    expect(accountKeys()).toEqual([]);
    expect(localStorage.getItem('local_data_owner')).toBeNull();

    await nextAccountSignsIn(client);
    expect(upsertsFor(client, U2)).toEqual([]);
    expect(client.upserts).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  // The editor saves its pending text as it unmounts with the dashboard, which happens after the sign-out's clear.
  it('the strategic context typed just before a sign-out is gone after it, and never reaches the next account', async () => {
    const error = vi.spyOn(console, 'error');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    renderApp();
    await hydrated(client);
    await settled();
    fireEvent.click(screen.getByLabelText('Open settings'));
    fireEvent.click(within(settingsDialog()).getByRole('button', { name: 'Backup' }));
    fireEvent.click(within(settingsDialog()).getByRole('button', { name: /Add strategic context/ }));
    fireEvent.change(await screen.findByPlaceholderText(/^Paste your strategic context here/), { target: { value: "A's private thesis" } });
    expect(localStorage.getItem('strategic_context')).toBeNull(); // still inside the editor's autosave

    fireEvent.click(screen.getByLabelText('Sign out'));
    await waitFor(() => { expect(signInShown()).toBe(true); }, { timeout: 5_000 });
    await after(1_200); // past the editor's 1 s autosave
    expect(localStorage.getItem('strategic_context')).toBeNull();
    expect(localStorage.getItem('local_data_owner')).toBeNull();

    await nextAccountSignsIn(client);
    expect(upsertsFor(client, U2)).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  // API keys never leave this browser, so one left behind is not uploaded: it is handed to the next person here.
  it('a Finnhub key typed just before a sign-out is gone after it, so the next account does not get it', async () => {
    const error = vi.spyOn(console, 'error');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    renderApp();
    await hydrated(client);
    await settled();
    fireEvent.click(screen.getByLabelText('Open settings'));
    fireEvent.click(within(settingsDialog()).getByRole('button', { name: 'Data' }));
    fireEvent.change(within(settingsDialog()).getByPlaceholderText('Paste for news, earnings, analyst data...'), { target: { value: 'fh-typed-by-the-first-account' } });
    expect(localStorage.getItem('data_finnhub_key')).toBeNull(); // still inside the tab's autosave

    fireEvent.click(screen.getByLabelText('Sign out'));
    await waitFor(() => { expect(signInShown()).toBe(true); }, { timeout: 5_000 });
    await after(1_200); // past the tab's 800 ms autosave
    expect(localStorage.getItem('data_finnhub_key')).toBeNull();

    await nextAccountSignsIn(client);
    expect(localStorage.getItem('data_finnhub_key')).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  // This tab flushes its pending edit as the session's end switches the backend, through the account's backend, which
  // also queues it for the account and dates it, into the storage the other tab has emptied.
  it("another tab's sign-out leaves nothing of the account here: not the edit pending in this tab", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'NVDA', 80, 2)] } });
    renderApp();
    const cost = await costInput();
    await hydrated(client);
    await settled();
    expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 }); // the account's, pulled

    fireEvent.change(cost, { target: { value: '95' } });
    expect(stored('AVGO')).toBeNull(); // still inside its debounce
    signedOutInAnotherTab(client);
    expect(signInShown()).toBe(true);
    await after(400);
    expect(accountKeys()).toEqual([]);
    expect(localStorage.getItem('local_data_owner')).toBeNull();

    await nextAccountSignsIn(client);
    expect(upsertsFor(client, U2)).toEqual([]);
    expect(client.upserts).toEqual([]);

    // The other tab's sign-out took the access token too; with the next account's own, the inputs show its position,
    // not the edit typed for the first.
    act(() => { setToken(proToken()); });
    expect(await costInput()).toHaveValue(null);
    await settled();
    expect(error).not.toHaveBeenCalled();
  });

  // Heard first through the storage, the other tab's clear is a whole-store change, at which the draft writes its
  // pending edit through the account's backend, before this tab knows the session has ended.
  it("another tab's sign-out heard first through the storage leaves nothing here: not the edit written at that event", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    renderApp();
    const cost = await costInput();
    await hydrated(client);
    await settled();

    fireEvent.change(cost, { target: { value: '95' } });
    expect(stored('AVGO')).toBeNull(); // still inside its debounce
    await storageClearedInAnotherTab();
    expect(stored('AVGO')).toEqual({ costBasis: 95, shares: null }); // written into the emptied storage
    expect(localStorage.getItem('local_data_owner')).toBeNull();
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    expect(signInShown()).toBe(true);
    await after(400);
    expect(accountKeys()).toEqual([]);

    await nextAccountSignsIn(client);
    expect(upsertsFor(client, U2)).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  // The chat saves a reply still streaming as it unmounts with the dashboard, through the account's backend.
  it("another tab's sign-out leaves nothing of a reply this tab was still streaming", async () => {
    const error = vi.spyOn(console, 'error');
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

    signedOutInAnotherTab(client);
    expect(signInShown()).toBe(true);
    await after(400);
    expect(accountKeys()).toEqual([]);

    await nextAccountSignsIn(client);
    expect(upsertsFor(client, U2)).toEqual([]);
    expect(client.upserts).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  // Heard first through the storage, the clear is a whole-store change, at which the chat drops the reply unstored.
  it("Pin: another tab's sign-out heard first through the storage leaves nothing of a reply this tab was still streaming", async () => {
    const error = vi.spyOn(console, 'error');
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

    await storageClearedInAnotherTab();
    expect(screen.queryByText('A partial answer for the first account')).toBeNull();
    expect(accountKeys()).toEqual([]);
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    expect(signInShown()).toBe(true);
    await after(400);
    expect(accountKeys()).toEqual([]);

    await nextAccountSignsIn(client);
    expect(client.upserts).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  // This tab's hydrate is still reading the account when another tab signs it out: its reads answer after that tab
  // has emptied the storage and before its SIGNED_OUT reaches this one, so the hydrate pulls the account's cloud copy
  // into the emptied storage.
  it("another tab's sign-out while this tab's hydrate reads leaves nothing here: not the account's copy it pulled", async () => {
    const error = vi.spyOn(console, 'error');
    const hydrate = vi.spyOn(SupabaseBackend.prototype, 'hydrate');
    serveFunctions();
    let release;
    const client = setClient({
      session: sessionFor(U1),
      tables: { positions: [posRow(U1, 'NVDA', 80, 2)] },
      gate: new Promise((resolve) => { release = resolve; }),
    });
    renderApp();
    await waitFor(() => { expect(hydrate).toHaveBeenCalledTimes(1); }, { timeout: 5_000 }); // its reads held
    await settled();
    expect(client.reads).toEqual([]);
    expect(localStorage.getItem('local_data_owner')).toBe(U1);

    localStorage.clear(); // the other tab's sign-out
    await act(async () => {
      release();
      await hydrate.mock.results[0].value;
    });
    expect(client.reads).toHaveLength(3);
    expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 }); // the account's copy, pulled into the emptied storage
    expect(localStorage.getItem('local_data_owner')).toBeNull();
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    expect(signInShown()).toBe(true);
    await after(400);
    expect(accountKeys()).toEqual([]);

    await nextAccountSignsIn(client);
    expect(upsertsFor(client, U2)).toEqual([]);
    expect(client.upserts).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  // What a real browser does, measured with two Chromium tabs and the real supabase-js: the other tab's SIGNED_OUT
  // broadcast reaches this tab a few milliseconds BEFORE this tab's view of the storage shows that tab's clear. The
  // owner mark still reads as the account's, so the session's end looks like a revoke: the pending edit is written
  // (into storage the other tab has in fact emptied) and nothing clears it. Closing this takes more than the owner
  // mark read at the event, such as watching for the mark's removal afterwards.
  it("Pin (known gap): another tab's sign-out heard before its clear shows here leaves the pending edit, and the next account uploads it", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    renderApp();
    const cost = await costInput();
    await hydrated(client);
    await settled();

    fireEvent.change(cost, { target: { value: '95' } });
    localStorage.clear(); // the other tab's clear, already done...
    const getItem = Storage.prototype.getItem;
    const staleMark = vi.spyOn(Storage.prototype, 'getItem') // ...but not yet visible to this tab's reads of the mark
      .mockImplementation(function read(key) { return key === 'local_data_owner' ? U1 : getItem.call(this, key); });
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    staleMark.mockRestore();
    expect(signInShown()).toBe(true);
    await after(400);
    expect(accountKeys()).toEqual(['position_AVGO', 'sync_meta_user-1', 'sync_outbox_user-1']);
    expect(localStorage.getItem('local_data_owner')).toBeNull();

    await nextAccountSignsIn(client);
    expect(positionUpserts(client)).toEqual([[U2, 'AVGO', 95, null]]);
    expect(error).not.toHaveBeenCalled();
  });

  // Signed out on another device, which revokes every session: this browser's storage is untouched and still marked as
  // the account's, so nothing here belongs to nobody.
  it('Pin: a session revoked elsewhere clears nothing, and the edit queued for the account reaches it at its next sign-in here', async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U1, 'NVDA', 80, 2)] } });
    renderApp();
    const cost = await costInput();
    await hydrated(client);
    await settled();

    fireEvent.change(cost, { target: { value: '95' } });
    const details = [];
    const onStoreChanged = (e) => { details.push(e.detail ?? null); };
    window.addEventListener('store-changed', onStoreChanged);
    onTestFinished(() => window.removeEventListener('store-changed', onStoreChanged));
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    expect(signInShown()).toBe(true);
    await after(400);
    expect(details).toEqual([]); // nothing was cleared, so the store's readers are not told to re-read
    expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 });
    expect(stored('AVGO')).toEqual({ costBasis: 95, shares: null });
    expect(localStorage.getItem('local_data_owner')).toBe(U1);
    expect(accountKeys()).toEqual(['position_AVGO', 'position_NVDA', `sync_meta_${U1}`, `sync_outbox_${U1}`]);
    expect(client.upserts).toEqual([]);

    act(() => { client.emitAuth('SIGNED_IN', sessionFor(U1)); });
    await hydrated(client, 2);
    await after(400);
    await settled();
    expect(positionUpserts(client)).toEqual([[U1, 'AVGO', 95, null]]);
    expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 });
    expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(95);
    expect(error).not.toHaveBeenCalled();
  });

  // Another tab signed the account out a while ago, and the browser has been used without an account since, while this
  // tab sat frozen in the background; it hears of the sign-out only now. What the browser holds is that use's data.
  it("Pin: a sign-out heard of late, once the browser is in use without an account, leaves that use's data alone", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    const client = setClient({ session: sessionFor(U1) });
    renderApp();
    await costInput();
    await hydrated(client);
    await settled();

    localStorage.clear(); // the other tab's sign-out
    localStorage.setItem('auth_skipped', '1'); // then "Continue without signing in"
    localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 50, shares: 2 }));
    localStorage.setItem('ai_key_openai', JSON.stringify('sk-local'));
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    expect(signInShown()).toBe(true);
    await after(400);
    expect(Object.keys(localStorage).sort()).toEqual(['ai_key_openai', 'auth_skipped', 'position_NVDA']);
    expect(stored('NVDA')).toEqual({ costBasis: 50, shares: 2 });
    expect(localStorage.getItem('ai_key_openai')).toBe(JSON.stringify('sk-local'));
    expect(error).not.toHaveBeenCalled();
  });

  // As above, but the next account signed in there after the sign-out: the browser's data is marked as that account's,
  // and this tab hears of both events late, in order.
  it("Pin: a sign-out heard of late, once another account has signed in here, leaves that account's data alone", async () => {
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    serveFunctions();
    const client = setClient({ session: sessionFor(U1), tables: { positions: [posRow(U2, 'NVDA', 50, 2)] } });
    renderApp();
    await hydrated(client);
    await settled();

    localStorage.clear(); // the other tab's sign-out
    localStorage.setItem('local_data_owner', U2); // then the next account's sign-in there, which pulled its data
    localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 50, shares: 2 }));
    localStorage.setItem('ai_key_openai', JSON.stringify('sk-second'));
    act(() => { client.emitAuth('SIGNED_OUT', null); });
    expect(signInShown()).toBe(true);
    await after(400);
    expect(stored('NVDA')).toEqual({ costBasis: 50, shares: 2 });
    expect(localStorage.getItem('ai_key_openai')).toBe(JSON.stringify('sk-second'));

    act(() => { client.emitAuth('SIGNED_IN', sessionFor(U2)); });
    await hydrated(client, 2);
    await settled();
    expect(stored('NVDA')).toEqual({ costBasis: 50, shares: 2 });
    expect(localStorage.getItem('ai_key_openai')).toBe(JSON.stringify('sk-second'));
    expect(localStorage.getItem('local_data_owner')).toBe(U2);
    expect(client.upserts).toEqual([]);
    expect(warn).not.toHaveBeenCalled(); // nothing of another account was found to clear
    expect(error).not.toHaveBeenCalled();
  });
});
