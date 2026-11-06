// src/App.wiring.test.jsx — two pieces of App's wiring that a user meets at once and no other App test asserts: the
// Settings dialog closes again (App owns its open state and hands the dialog its onClose), and the Header's refresh
// button refreshes the live quote together with the market data (App's handleRefresh calls both hooks' refresh).
// App runs as main.jsx renders it (StrictMode, ErrorBoundary, QueryClientProvider), with MSW answering getMarketData,
// getLiveQuote and getModels (the Settings dialog opens on its AI tab, which asks for the model list); fake timers run
// with shouldAdvanceTime from Friday 2026-09-25 at 11:00 ET, as in App.test.jsx.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { queryClient } from './lib/queryClient.js';

vi.mock('./components/KPICards.jsx', () => ({ default: () => null }));

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');

/** A complete getMarketData body as the CBOE path sends it (types/market.ts). */
const marketData = (ticker) => ({
  ticker, provider: 'cboe', delay: '15-min delayed', spotPrice: 100, priceChange: 1.25, priceChangePct: 1.27,
  kpis: {
    netPremium: 1_250_000, callPremium: 3_500_000, putPremium: 2_250_000, darkPoolPct: 38.5, maxPain: 100,
    putCallRatio: 0.82, maxPainExpiry: '2026-09-25', putCallOIRatio: 0.91,
    callVolume: 50_000, putVolume: 41_000, callOI: 250_000, putOI: 227_500,
  },
  gexByStrike: [{ strike: 100, callGex: 6_000_000, putGex: -1_000_000, gex: 5_000_000 }],
  lastUpdated: '2026-09-25T14:59:30.000Z',
  flowHistory: [{ date: '2026-09-25', netPremium: 1_250_000, cumPremium: 1_250_000, callVolume: 50_000, putVolume: 41_000 }],
  fallbackReason: null, iv30: 31.4, lastTradeTime: '2026-09-25T10:59:30', totalOptionsCount: 420,
  expiries: ['2026-09-25'],
});

const tickerOf = (request) => new URL(request.url).searchParams.get('ticker');

/** Serves the three functions and counts the requests for the first two. */
function serveFunctions() {
  const requests = { market: 0, quote: 0 };
  server.use(
    http.get(`${FN}/getMarketData`, ({ request }) => {
      requests.market += 1;
      return HttpResponse.json(marketData(tickerOf(request)));
    }),
    http.get(`${FN}/getLiveQuote`, ({ request }) => {
      requests.quote += 1;
      return HttpResponse.json({
        ticker: tickerOf(request), current: 101.5, previousClose: 100, changePercent: 1.5,
        timestamp: FRIDAY_11_ET.getTime(), source: 'yahoo-regular',
      });
    }),
    http.get(`${FN}/getModels`, () => HttpResponse.json({ models: [], provider: 'anthropic', requestId: 'm1' })),
  );
  return requests;
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

/** Nothing is in flight: every request a test started has landed. */
const settled = () => waitFor(() => { expect(queryClient.isFetching()).toBe(0); }, { timeout: 5_000 });

describe('App: Settings closing and the refresh button', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Pin: Settings opens from the Header and closes again from its own button', async () => {
    const error = vi.spyOn(console, 'error');
    serveFunctions();
    renderApp();
    await screen.findByText('$101.50', {}, { timeout: 5_000 });
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Open settings'));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await settled(); // the AI tab's model list

    fireEvent.click(screen.getByLabelText('Close settings'));
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  it('Pin: the refresh button asks for the market data and the live quote again', async () => {
    const error = vi.spyOn(console, 'error');
    const requests = serveFunctions();
    renderApp();
    await screen.findByText('$101.50', {}, { timeout: 5_000 });
    await settled();
    const before = { ...requests };

    fireEvent.click(screen.getByLabelText('Refresh data'));
    await waitFor(() => {
      expect(requests.market).toBe(before.market + 1);
      expect(requests.quote).toBe(before.quote + 1);
    }, { timeout: 5_000 });
    await settled();
    expect(error).not.toHaveBeenCalled();
  });
});
