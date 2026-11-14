// src/App.phone.escape.test.jsx — Escape and the chat that covers the page on a phone, wherever focus fell. While the
// chat covers the page focus is often on the body, not in the chat: the composer is disabled while a reply streams, a
// suggestion's button unmounts once picked, the locked chat focuses nothing, and a window narrowed under md with the
// chat open removes the resize handle (or makes the header inert) under focus. Escape closes the chat from there too,
// and focus goes to "Open AI Co-Pilot", as from inside the chat; App hears it on document, so a handler inside the chat
// that took the key first (or a key composing text) still keeps it. An open <dialog> (Settings, the context editor)
// owns Escape wherever focus is: Settings' listener is on window in the bubble phase, after document, so without
// App's check one Escape on the body would close the chat and then Settings. From md up the sidebar ignores Escape, as
// it always has. The tree, the stand-ins and the fixtures are App.phone.test.jsx's (StrictMode, ErrorBoundary and
// QueryClientProvider around App, MSW answering the functions, the matchMedia stand-in at a desktop width until a test
// narrows it). jsdom moves focus to the body when the focused element is removed or blurred, as a browser does.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
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

/** The functions App reaches, with or without a token, and getModels for the Settings dialog's AI tab. */
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
  await screen.findAllByText('$101.50', {}, { timeout: 5_000 });
  if (unlocked) await screen.findByText('PRO', {}, { timeout: 5_000 });
  await settled();
  return view;
}

const NAME = 'AI Co-Pilot';
const fab = () => screen.getByRole('button', { name: 'Open AI Co-Pilot' });
const openChat = () => fireEvent.click(fab());
/** The chat, open, on a phone. */
const overlay = () => screen.getByRole('dialog', { name: NAME });
/** The chat, open, from md up. */
const sidebar = () => screen.getByRole('complementary', { name: NAME });
/** The unlocked chat's composer. */
const composer = (chat) => within(chat).getByRole('textbox');
/** Focus taken off whatever holds it, to the body, as a disabled composer or an unmounted button leaves it. */
const focusToBody = () => act(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});
/** Escape on the body. Returns false when something prevented the key's default. */
const escapeOnBody = (init = {}) => fireEvent.keyDown(document.body, { key: 'Escape', ...init });

describe('App: Escape and the chat that covers the page, wherever focus is', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    serveFunctions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on a phone, Escape with focus on the body closes the chat and puts focus on Open AI Co-Pilot', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    overlay();
    focusToBody();
    expect(document.activeElement).toBe(document.body);

    expect(escapeOnBody()).toBe(false); // handled
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull();
    expect(document.activeElement).toBe(fab());
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('on a phone, the locked chat closes on Escape with focus on the body', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded();
    openChat();
    expect(within(overlay()).getByRole('button', { name: 'Activate' })).toBeInTheDocument(); // the lock screen
    focusToBody();

    escapeOnBody();
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull();
    expect(document.activeElement).toBe(fab());
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('a window narrowed under md with the chat open and the handle focused: Escape on the body closes the chat', async () => {
    const error = vi.spyOn(console, 'error');
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = sidebar();
    act(() => { screen.getByRole('separator', { name: `Resize ${NAME}` }).focus(); });

    act(() => { setViewportWidth(PHONE_WIDTH); }); // the handle unmounts under focus
    expect(overlay()).toBe(chat);
    expect(document.activeElement).toBe(document.body);

    escapeOnBody();
    expect(screen.queryByRole('dialog', { name: NAME })).toBeNull();
    expect(document.activeElement).toBe(fab());
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // Green on the code before the document listener, where nothing heard an Escape on the body at all; red on the
  // listener without its `dialog[open]` check (the chat closed with Settings: two layers for one key).
  it('Pin: on a phone, Escape on the body under Settings opened from the chat closes Settings alone', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = overlay();
    const draft = composer(chat);
    fireEvent.click(within(chat).getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    focusToBody();

    escapeOnBody();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    await act(async () => {}); // the dialog's `close` event arrives a microtask later
    expect(overlay()).toBe(chat);
    expect(composer(chat)).toBe(draft); // the same chat, still open
    expect(screen.queryByRole('button', { name: 'Open AI Co-Pilot' })).toBeNull();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: from md up, Escape on the body leaves the sidebar open', async () => {
    const error = vi.spyOn(console, 'error');
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = sidebar();
    focusToBody();

    expect(escapeOnBody()).toBe(true); // nothing prevented it
    expect(sidebar()).toBe(chat);
    expect(within(chat).getByRole('button', { name: 'Close chat' })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: on a phone, an Escape that composes text in the chat is left alone', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = overlay();
    const input = composer(chat);
    expect(document.activeElement).toBe(input);

    expect(fireEvent.keyDown(input, { key: 'Escape', isComposing: true })).toBe(true);
    expect(overlay()).toBe(chat);
    expect(document.activeElement).toBe(input);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: on a phone, an Escape that something inside the chat has handled already is left alone', async () => {
    const error = vi.spyOn(console, 'error');
    setViewportWidth(PHONE_WIDTH);
    await renderLoaded({ unlocked: true });
    openChat();
    const chat = overlay();
    const input = composer(chat);
    // A handler on the composer itself, which runs before anything at React's root or on document.
    const takeEscape = (e) => { if (e.key === 'Escape') e.preventDefault(); };
    input.addEventListener('keydown', takeEscape);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(overlay()).toBe(chat);
    expect(document.activeElement).toBe(input);
    input.removeEventListener('keydown', takeEscape);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
