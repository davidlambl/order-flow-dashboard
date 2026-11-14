// src/App.phone.test.jsx — the chat as App lays it out on each side of Tailwind's `md` breakpoint (48rem, 768 px), in
// the main.jsx tree as App.test.jsx renders it (StrictMode, ErrorBoundary and QueryClientProvider around it, MSW
// answering the functions). The width comes from the matchMedia stand-in (src/test/viewport.js: a desktop at the start
// of every test; setViewportWidth() inside act() once App listens).
// - On a phone the open chat covers the page: it is a modal dialog named "AI Co-Pilot", `main` and the header's wrapper
//   are inert, there is no resize handle, and the account-keyed root, which holds Settings and the sync choice, is never
//   inert (an inert ancestor would leave even a top-layer dialog dead). Closed, the chat is hidden and nothing is inert.
//   Escape closes it from inside; an Escape heard in Settings, or by the context editor, closes those alone.
// - From md up the chat is the complementary landmark named "AI Co-Pilot", nothing is inert, Escape leaves it open, and
//   the handle before it is a vertical separator: focusable, named, controlling the chat, with the width as its value
//   between 280 and 640, a finger's drag not taken for a scroll, and arrow keys that resize it.
// - At every width, closing the chat with focus inside it moves focus to "Open AI Co-Pilot", which mounts as the chat
//   closes; with focus elsewhere, focus stays where it was.
// - Crossing the breakpoint restyles the one chat element: the composer is the same node, with its draft, so ChatBot
//   was not remounted (a remount would cut a streaming reply).
// jsdom has no layout and ignores `inert`: the tests assert the attributes, never what can be seen, focused or clicked;
// the overlay's geometry, the inert page under Tab and a real finger are checked in a browser. Tailwind's classes do
// nothing here either, so the one class asserted (`fixed inset-0`) stands for the overlay the browser check measures.
// The tests with the unlocked chat store a pro access token, which turns research on (getTickerContext) and has
// verifyStoredToken post validateToken; the others leave the chat on its lock screen. Fake timers run with
// shouldAdvanceTime from Friday 2026-09-25 at 11:00 ET, as in App.test.jsx.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import { expectNoAxeViolations } from './test/a11y.js';
import { DESKTOP_WIDTH, PHONE_WIDTH, setViewportWidth } from './test/viewport.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { queryClient } from './lib/queryClient.js';

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');

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
/** A pro token good for 30 days: minted inside a test, after beforeEach has set the clock it expires against. */
const proToken = () => jwt({ sub: 'u1', tier: 'pro', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 });

/**
 * The functions App reaches: market data and the quote; with a token, validateToken (verifyStoredToken posts it at
 * startup, twice under StrictMode) and getTickerContext; and getModels, which the Settings dialog's AI tab requests as
 * it opens. A request with no handler logs an MSW error, which every test's console.error check would catch.
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

/** App rendered with the chat closed and every request answered; with `unlocked`, a pro token stored first. */
async function renderLoaded({ unlocked = false } = {}) {
  if (unlocked) localStorage.setItem('access_token', proToken());
  const view = renderApp();
  await screen.findAllByText('$101.50', {}, { timeout: 5_000 }); // the quote (the Header's, and the position's when unlocked)
  if (unlocked) await screen.findByText('PRO', {}, { timeout: 5_000 });
  await settled();
  return view;
}

const NAME = 'AI Co-Pilot';
const fab = () => screen.getByRole('button', { name: 'Open AI Co-Pilot' });
const openChat = () => fireEvent.click(fab());
/** The open chat on a phone. */
const overlay = () => screen.getByRole('dialog', { name: NAME });
/** The chat from md up. */
const sidebar = () => screen.getByRole('complementary', { name: NAME });
/** The resize handle, by its name: the page has other roles (a status in the header, named sections), never guessed. */
const HANDLE = { name: 'Resize AI Co-Pilot' };
/** The chat's close button, in its header or on its lock screen. */
const closeButton = () => screen.getByRole('button', { name: 'Close chat' });
/**
 * The element that holds the open chat, whatever its role: the pins below find it this way so that they also run where
 * it is a plain `aside` with no name.
 */
const chatHolder = () => closeButton().closest('aside, [role="dialog"], [role="complementary"]');
/** The header's wrapper, which App makes inert: Header's root is the banner. */
const headerWrapper = () => screen.getByRole('banner').parentElement;
/** The unlocked chat's composer. */
const composer = (chat) => within(chat).getByRole('textbox');
/** Escape, where focus is. */
const pressEscape = () => fireEvent.keyDown(document.activeElement, { key: 'Escape' });
/** Focus moved to `el` as a click, a tap or Tab would move it (inside act: the element it leaves may handle its blur). */
const focusOn = (el) => act(() => { el.focus(); });

/** The ancestors of `el` that carry `inert`, outermost last. */
function inertAncestors(el) {
  const found = [];
  for (let node = el.parentElement; node; node = node.parentElement) if (node.hasAttribute('inert')) found.push(node);
  return found;
}

/** Every store-changed detail dispatched from now on (null for one without), until the test ends. */
function storeEvents() {
  const details = [];
  const onEvent = (e) => { details.push(e.detail ?? null); };
  window.addEventListener('store-changed', onEvent);
  onTestFinished(() => { window.removeEventListener('store-changed', onEvent); });
  return details;
}

describe('App: the chat on a phone and from md up', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    serveFunctions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── On a phone ──

  it('on a phone the open chat is a modal dialog over an inert page, with no handle; the account root is never inert; closed, it is hidden', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    const { container } = await renderLoaded();
    const root = container.firstElementChild; // the account-keyed root: Settings and the sync choice render in it
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull(); // closed: hidden, not a 0-wide landmark
    expect(screen.queryByRole('complementary', { name: NAME })).toBeNull();
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');

    openChat();
    const chat = overlay();
    expect(chat).toHaveAttribute('aria-modal', 'true');
    expect(chat).toHaveClass('fixed', 'inset-0'); // over the whole viewport, the 100dvh page included
    expect(chat.style.width).toBe(''); // no sidebar width fighting the overlay
    expect(within(chat).getByRole('button', { name: 'Close chat' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: NAME })).toBeNull();
    expect(screen.queryByRole('separator', HANDLE)).toBeNull();
    expect(screen.getByRole('main')).toHaveAttribute('inert');
    expect(headerWrapper()).toHaveAttribute('inert');
    expect(headerWrapper()).not.toBe(root);
    expect(root).not.toHaveAttribute('inert');
    expect(inertAncestors(chat)).toEqual([]);

    fireEvent.click(closeButton());
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull();
    expect(chat).toHaveAttribute('hidden');
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    expect(headerWrapper()).not.toHaveAttribute('inert');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('on a phone Escape inside the chat closes it and puts focus on Open AI Co-Pilot', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = overlay();
    expect(document.activeElement).toBe(composer(chat)); // ChatBot focuses its composer when the chat opens

    expect(pressEscape()).toBe(false); // handled
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull();
    expect(document.activeElement).toBe(fab());
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: on a phone, Escape in Settings opened from the chat closes Settings alone and leaves the chat open', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = chatHolder();
    const draft = composer(chat);
    fireEvent.click(within(chat).getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    // Settings is rendered outside the chat, so no ancestor of it is inert.
    expect(inertAncestors(screen.getByRole('heading', { name: 'Settings' }))).toEqual([]);
    // A modal Settings (showModal()) holds focus inside itself; put it there wherever Settings does not yet.
    focusOn(screen.getByRole('button', { name: 'Close settings' }));

    pressEscape();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(within(chat).getByRole('button', { name: 'Close chat' })).toBeInTheDocument();
    expect(composer(chat)).toBe(draft); // the same chat, still open
    expect(screen.queryByRole('button', { name: 'Open AI Co-Pilot' })).toBeNull();
    await act(async () => {}); // a dialog's `close` event, where Settings is a <dialog>, arrives a microtask later
    expect(within(chat).getByRole('button', { name: 'Close chat' })).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: on a phone, Escape in the context editor opened from the chat closes the editor alone', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = chatHolder();
    fireEvent.click(within(chat).getByRole('button', { name: 'Edit strategic context' }));
    focusOn(screen.getByRole('button', { name: 'Close strategic context editor' }));

    pressEscape();
    expect(screen.queryByRole('heading', { name: 'Strategic Context' })).toBeNull();
    expect(within(chat).getByRole('button', { name: 'Close chat' })).toBeInTheDocument();
    await act(async () => {});
    expect(within(chat).getByRole('button', { name: 'Close chat' })).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('the open chat is one element across the breakpoint: phone, desktop, phone, the composer the same node with its draft', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = overlay();
    const input = composer(chat);
    fireEvent.change(input, { target: { value: 'Where is the gamma flip?' } });

    act(() => { setViewportWidth(DESKTOP_WIDTH); });
    expect(sidebar()).toBe(chat);
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull();
    expect(screen.getByRole('separator', HANDLE)).toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    expect(composer(chat)).toBe(input);
    expect(input).toHaveValue('Where is the gamma flip?');

    act(() => { setViewportWidth(PHONE_WIDTH); });
    expect(overlay()).toBe(chat);
    expect(screen.queryByRole('separator', HANDLE)).toBeNull();
    expect(screen.getByRole('main')).toHaveAttribute('inert');
    expect(composer(chat)).toBe(input);
    expect(input).toHaveValue('Where is the gamma flip?');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // ── From md up ──

  it('from md up nothing is inert, the chat is the complementary landmark, and the handle is a separator with its value', async () => {
    const error = vi.spyOn(console, 'error');
    await renderLoaded();
    openChat();
    const chat = sidebar();
    expect(chat).not.toHaveAttribute('aria-modal');
    expect(chat.style.width).toBe('384px');
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull();
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    expect(headerWrapper()).not.toHaveAttribute('inert');

    const handle = screen.getByRole('separator', HANDLE);
    expect(handle).toBe(chat.previousElementSibling);
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-controls', chat.id);
    expect(chat.id).not.toBe('');
    expect(handle).toHaveAttribute('aria-valuenow', '384');
    expect(handle).toHaveAttribute('aria-valuemin', '280');
    expect(handle).toHaveAttribute('aria-valuemax', '640');
    expect(handle.tabIndex).toBe(0);
    expect(handle.style.touchAction).toBe('none'); // a finger's drag is not taken for a scroll
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: from md up Escape in the chat leaves it open, and focus where it was', async () => {
    const error = vi.spyOn(console, 'error');
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = chatHolder();
    expect(document.activeElement).toBe(composer(chat));

    pressEscape();
    expect(chatHolder()).toBe(chat);
    expect(within(chat).getByRole('button', { name: 'Close chat' })).toBeInTheDocument();
    expect(document.activeElement).toBe(composer(chat));
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('the arrow keys on the handle resize the open chat at once and store the width once, on release', async () => {
    const error = vi.spyOn(console, 'error');
    await renderLoaded();
    openChat();
    const events = storeEvents();
    const handle = screen.getByRole('separator', HANDLE);
    focusOn(handle);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', repeat: true });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', repeat: true });
    expect(sidebar().style.width).toBe('432px');
    expect(handle).toHaveAttribute('aria-valuenow', '432');
    expect(localStorage.getItem('chat_sidebar_w')).toBeNull();
    expect(events).toEqual([]);

    fireEvent.keyUp(handle, { key: 'ArrowLeft' });
    expect(localStorage.getItem('chat_sidebar_w')).toBe('432');
    expect(events).toEqual([{ kind: 'pref', id: 'sidebarWidth' }]);
    expect(sidebar().style.width).toBe('432px');

    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyUp(handle, { key: 'End' });
    expect(sidebar().style.width).toBe('640px');
    expect(localStorage.getItem('chat_sidebar_w')).toBe('640');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // ── At every width ──

  it.each([
    ['a phone', PHONE_WIDTH],
    ['a desktop', DESKTOP_WIDTH],
  ])('on %s, closing the chat with focus inside it puts focus on Open AI Co-Pilot', async (_label, width) => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(width);
    await renderLoaded();
    openChat();
    focusOn(closeButton()); // as a click or a tap focuses it, and Enter or Space on it after Tab

    fireEvent.click(closeButton());
    expect(document.activeElement).toBe(fab());
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: closing the chat with focus outside it leaves focus where it was', async () => {
    const error = vi.spyOn(console, 'error');
    await renderLoaded();
    openChat();
    const search = screen.getByLabelText('Stock ticker symbol');
    focusOn(search);

    fireEvent.click(closeButton()); // a click that does not focus its button, as in Safari
    expect(screen.getByRole('button', { name: 'Open AI Co-Pilot' })).toBeInTheDocument();
    expect(document.activeElement).toBe(search);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // ── axe, one run per state: the whole page, since landmarks, regions and a modal dialog are judged on it ──

  // These runs judge the whole page: the headings in order (the header's h1, a section's or the chat's h2, a card's
  // h3), the chat's role and name, the handle's role and value, and the page made inert around a modal chat.
  it.each([
    // region is off on a desktop: the handle is a named, focusable separator, and it sits between `main` and the
    // chat's landmark, outside both, because the sidebar's layout is pinned (App.sidebar.test.jsx: the handle is the
    // chat's previous sibling). axe exempts a button outside landmarks, not a separator. Below md there is no handle.
    ['a phone', PHONE_WIDTH, []],
    ['a desktop', DESKTOP_WIDTH, ['region']],
  ])('Pin: the page with the chat open on %s has no axe violation', async (_label, width, disable) => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(width);
    const { baseElement } = await renderLoaded();
    openChat();
    await expectNoAxeViolations(baseElement, { bestPractices: true, disable });
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
