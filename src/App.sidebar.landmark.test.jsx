// src/App.sidebar.landmark.test.jsx — the chat sidebar from md up as a landmark, and its resize handle's hit area.
// - Closed, the sidebar is a 0 px element with nothing in it: no landmark (no role, no name), so a screen reader's
//   landmark list offers no empty "AI Co-Pilot" on every page load (the chat is closed by default). Open, it is the
//   complementary landmark named "AI Co-Pilot". It is the SAME element closed, open and closed again: the width
//   transition and a streaming reply depend on it never remounting.
// - The handle stays a 5 px box, so the layout does not move, and a transparent ::before widens what a pointer can
//   press by 12 px to the right only, over the chat's own left padding (to its left is main's scrollbar), stacked
//   above the chat. Tailwind's classes do nothing under jsdom, so the classes asserted stand for the hit area that a
//   browser measures.
// The tree is App.sidebar.test.jsx's (StrictMode, ErrorBoundary and QueryClientProvider around App, MSW answering the
// functions, no access token, the matchMedia stand-in at its desktop width). Fake timers run with shouldAdvanceTime
// from Friday 2026-09-25 at 11:00 ET, as in App.test.jsx.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const NAME = 'AI Co-Pilot';
/** The chat from md up: the last child of the row it shares with main, open or closed. */
const chatElement = () => screen.getByRole('main').parentElement.lastElementChild;
/** Every element named "AI Co-Pilot" by an aria-label (the open button is "Open AI Co-Pilot"). */
const namedChat = (container) => container.querySelectorAll(`[aria-label="${NAME}"]`);

describe('App: the chat sidebar as a landmark, and its handle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    serveFunctions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('from md up the closed sidebar is no landmark; open, it is the complementary "AI Co-Pilot"; one element throughout', async () => {
    const error = vi.spyOn(console, 'error');
    const { container } = renderApp();
    await settled();
    const chat = chatElement();
    expect(chat.style.width).toBe('0px'); // the sidebar, closed
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(chat).not.toHaveAttribute('role');
    expect(chat).not.toHaveAttribute('aria-label');
    expect(namedChat(container)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Open AI Co-Pilot' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open AI Co-Pilot' }));
    expect(screen.getByRole('complementary', { name: NAME })).toBe(chat);
    expect(chat.style.width).toBe('384px');

    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(chatElement()).toBe(chat);
    expect(chat.style.width).toBe('0px');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(chat).not.toHaveAttribute('role');
    expect(namedChat(container)).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('the handle stays 5 px wide, with a ::before that reaches 12 px to its right only, stacked above the chat', async () => {
    const error = vi.spyOn(console, 'error');
    renderApp();
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Open AI Co-Pilot' }));
    const handle = screen.getByRole('separator', { name: `Resize ${NAME}` });

    expect(handle.style.width).toBe('5px');
    expect(handle.style.touchAction).toBe('none'); // the pseudo-element is hit-tested as the handle
    expect(handle).toHaveClass(
      'relative', 'z-10',
      'before:absolute', 'before:inset-y-0', 'before:left-0', 'before:-right-3', "before:content-['']",
    );
    // Never to the left, where main's scrollbar is.
    expect([...handle.classList].filter((c) => /^before:-(left|inset)/.test(c))).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
