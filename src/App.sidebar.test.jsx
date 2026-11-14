// src/App.sidebar.test.jsx — App's resizable chat sidebar, in the main.jsx tree as App.test.jsx renders it (StrictMode,
// ErrorBoundary and QueryClientProvider around it, MSW answering the functions). The aside is 0 wide while the chat is
// closed, with no resize handle before it; open, it is as wide as the store says (chat_sidebar_w: a number from 280 to
// 640, else the default 384). Dragging the handle moves the width with the pointer, clamped to that range, with the
// aside's transition off, the handle's bar lit and the page's cursor and text selection held for the drag; the
// pointerup stores the width once through the store bus (one store-changed with the preference's detail), keeps it on
// screen through every commit after it and gives the page back; the next drag starts from the stored width; an unmount
// mid-drag gives the page back and stores nothing. Every test is a pin, written against the one-file App.jsx as the
// contract its split into hooks must keep, with mouse events until the handle moved to pointer events: each asserts
// what is shown, stored and dispatched after an event, never how App gets there (the pointerup's store write and the
// drag's end land in one commit in either order, so their order is not pinned). The handle takes the pointer's
// capture, so a browser sends the drag's pointermove and pointerup to it, and the tests fire them there (the capture
// stand-in in src/test/standins.js retargets nothing); after an unmount they go to document. Which pointers start a
// drag, the keyboard and a pointercancel are useResizableSidebar.handle.test.jsx's; the handle's role and value and the
// phone layout, App.phone.test.jsx's. This file runs at src/test/viewport.js's desktop width, where the handle shows.
// No access token: the open chat is its lock screen, which has a 'Close chat' button as the chat's own header does.
// Fake timers run with shouldAdvanceTime from Friday 2026-09-25 at 11:00 ET, as in App.test.jsx.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
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

const tickerOf = (request) => new URL(request.url).searchParams.get('ticker');

/** The functions App reaches with no token and no research key: market data and the quote. */
function serveFunctions() {
  server.use(
    http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
    http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
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

/**
 * The chat sidebar: the last child of the row it shares with main. Not by its role: closed, it is no landmark
 * (App.sidebar.landmark.test.jsx), and these pins read its width closed as well as open.
 */
const aside = () => screen.getByRole('main').parentElement.lastElementChild;
/** What comes right before the aside: the resize handle while the chat is open, the dashboard's main otherwise. */
const beforeAside = () => aside().previousElementSibling;
const openChat = () => fireEvent.click(screen.getByLabelText('Open AI Co-Pilot'));
const closeChat = () => fireEvent.click(screen.getByLabelText('Close chat'));
/** The class that lights the handle's bar while a drag is under way. */
const LIT = 'bg-[var(--color-accent)]';

/** Every value written under chat_sidebar_w since `setItem` was spied on, in order. */
const widthWrites = (setItem) => setItem.mock.calls.filter(([key]) => key === 'chat_sidebar_w').map(([, value]) => value);

/** Every store-changed detail dispatched from now on (null for one without), until the test ends. */
function storeEvents() {
  const details = [];
  const onEvent = (e) => { details.push(e.detail ?? null); };
  window.addEventListener('store-changed', onEvent);
  onTestFinished(() => { window.removeEventListener('store-changed', onEvent); });
  return details;
}

/**
 * Every width `el`'s inline style has held from now on, the current one last. The observer keeps the style
 * attribute's value from before each change, so a commit that showed another width in between is in the list even
 * when a later one put the width back.
 */
function widthsShown(el) {
  const records = [];
  const observer = new MutationObserver((batch) => { records.push(...batch); });
  observer.observe(el, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  onTestFinished(() => { observer.disconnect(); });
  const widthIn = (style) => /width:\s*([^;]+)/.exec(style ?? '')?.[1].trim() ?? '';
  return () => {
    records.push(...observer.takeRecords());
    return [...records.map((record) => widthIn(record.oldValue)), el.style.width];
  };
}

describe('App: the resizable chat sidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    serveFunctions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Pin: closed, the aside is 0 wide with no handle; open, 384 by default with the handle before it; closed again, 0', async () => {
    const error = vi.spyOn(console, 'error');
    const { container } = renderApp();
    await settled();
    expect(aside().style.width).toBe('0px');
    expect(beforeAside().tagName).toBe('MAIN');
    expect(container.querySelector('.cursor-col-resize')).toBeNull();

    openChat();
    expect(aside().style.width).toBe('384px');
    expect(beforeAside()).toHaveClass('cursor-col-resize');
    expect(aside()).toHaveClass('transition-all');

    closeChat();
    expect(aside().style.width).toBe('0px');
    expect(beforeAside().tagName).toBe('MAIN');
    expect(container.querySelector('.cursor-col-resize')).toBeNull();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it.each([
    { stored: null, what: 'nothing', width: '384px' },
    { stored: '500', what: '500', width: '500px' },
    { stored: '280', what: '280 (the minimum)', width: '280px' },
    { stored: '640', what: '640 (the maximum)', width: '640px' },
    { stored: '279', what: '279 (under the minimum)', width: '384px' },
    { stored: '641', what: '641 (over the maximum)', width: '384px' },
    { stored: '"500"', what: '"500" (a string)', width: '384px' },
    { stored: '{"a":1}', what: '{"a":1} (an object)', width: '384px' },
    { stored: 'abc', what: 'abc (not JSON)', width: '384px' },
  ])('Pin: with $what stored, the chat opens $width wide, and is 0 wide while closed', async ({ stored, width }) => {
    const error = vi.spyOn(console, 'error');
    if (stored !== null) localStorage.setItem('chat_sidebar_w', stored);
    renderApp();
    await settled();
    expect(aside().style.width).toBe('0px');

    openChat();
    expect(aside().style.width).toBe(width);
    expect(localStorage.getItem('chat_sidebar_w')).toBe(stored); // read as it is, never written back
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: a drag moves the width with the pointer, clamped to 280-640, with the transition off, the bar lit and the page held', async () => {
    const error = vi.spyOn(console, 'error');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderApp();
    await settled();
    openChat();
    const events = storeEvents();
    const handle = beforeAside();

    // Cancelled: the browser starts no text selection or native drag from the handle.
    expect(fireEvent.pointerDown(handle, { clientX: 1000 })).toBe(false);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    expect(aside()).not.toHaveClass('transition-all');
    expect(handle.firstChild).toHaveClass(LIT);
    expect(aside().style.width).toBe('384px');

    fireEvent.pointerMove(handle, { clientX: 900 }); // 100 px to the left: 100 px wider
    expect(aside().style.width).toBe('484px');
    fireEvent.pointerMove(handle, { clientX: 0 });
    expect(aside().style.width).toBe('640px');
    fireEvent.pointerMove(handle, { clientX: 2000 });
    expect(aside().style.width).toBe('280px');
    fireEvent.pointerMove(handle, { clientX: 950 });
    expect(aside().style.width).toBe('434px');
    expect(aside()).not.toHaveClass('transition-all');
    expect(widthWrites(setItem)).toEqual([]);
    expect(events).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: the pointerup stores the width once through the store bus, keeps it on screen and ends the drag; later pointer events change nothing', async () => {
    const error = vi.spyOn(console, 'error');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderApp();
    await settled();
    openChat();
    const events = storeEvents();
    const handle = beforeAside();
    fireEvent.pointerDown(handle, { clientX: 1000 });
    fireEvent.pointerMove(handle, { clientX: 950 });
    const widths = widthsShown(aside());

    fireEvent.pointerUp(handle);
    expect(aside().style.width).toBe('434px');
    expect(widths()).toEqual(['434px']); // no commit after the pointerup showed another width
    expect(widthWrites(setItem)).toEqual(['434']);
    expect(events).toEqual([{ kind: 'pref', id: 'sidebarWidth' }]);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(aside()).toHaveClass('transition-all');
    expect(handle.firstChild).not.toHaveClass(LIT);

    fireEvent.pointerMove(handle, { clientX: 500 });
    fireEvent.pointerUp(handle);
    expect(aside().style.width).toBe('434px');
    expect(widths()).toEqual(['434px']);
    expect(widthWrites(setItem)).toEqual(['434']);
    expect(events).toEqual([{ kind: 'pref', id: 'sidebarWidth' }]);
    expect(document.body.style.cursor).toBe('');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: the next drag starts from the width the last one stored, and the chat reopens at it', async () => {
    const error = vi.spyOn(console, 'error');
    renderApp();
    await settled();
    openChat();
    fireEvent.pointerDown(beforeAside(), { clientX: 1000 });
    fireEvent.pointerMove(beforeAside(), { clientX: 950 });
    fireEvent.pointerUp(beforeAside());
    expect(aside().style.width).toBe('434px');

    fireEvent.pointerDown(beforeAside(), { clientX: 700 });
    fireEvent.pointerMove(beforeAside(), { clientX: 600 });
    expect(aside().style.width).toBe('534px');
    fireEvent.pointerUp(beforeAside());
    expect(localStorage.getItem('chat_sidebar_w')).toBe('534');

    closeChat();
    expect(aside().style.width).toBe('0px');
    openChat();
    expect(aside().style.width).toBe('534px');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: an unmount mid-drag gives the page back and stores nothing; later pointer events reach nothing', async () => {
    const error = vi.spyOn(console, 'error');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderApp();
    await settled();
    openChat();
    const events = storeEvents();
    fireEvent.pointerDown(beforeAside(), { clientX: 1000 });
    fireEvent.pointerMove(beforeAside(), { clientX: 900 });
    expect(aside().style.width).toBe('484px');

    view.unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    fireEvent.pointerMove(document, { clientX: 800 });
    fireEvent.pointerUp(document);
    expect(widthWrites(setItem)).toEqual([]);
    expect(events).toEqual([]);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
