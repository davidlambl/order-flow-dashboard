// src/App.retry.test.jsx — the ticker row's failure line and its Retry inside the whole App, as main.jsx renders it
// (StrictMode, ErrorBoundary, QueryClientProvider), with MSW answering getMarketData and getLiveQuote and fake timers
// running with shouldAdvanceTime from Friday 2026-09-25 at 11:00 ET, as in App.shell.test.jsx. A failing live quote is
// said in the row, in words, and marked on the header's snapshot price; Retry asks both functions once more, as the
// header's Refresh does, and the focus stays on Retry.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { queryClient } from './lib/queryClient.js';

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');

/** A complete getMarketData body as the CBOE path sends it (every MarketData field, types/market.ts). */
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

/** Requests answered so far, per function. */
const asked = { market: 0, quote: 0 };

/** getMarketData answering, getLiveQuote failing as an upstream outage answers it. */
function serveWithQuoteFailing() {
  server.use(
    http.get(`${FN}/getMarketData`, ({ request }) => {
      asked.market += 1;
      return HttpResponse.json(marketData(tickerOf(request)));
    }),
    http.get(`${FN}/getLiveQuote`, () => {
      asked.quote += 1;
      return HttpResponse.json({ error: 'Yahoo is not answering', code: 'UPSTREAM' }, { status: 502 });
    }),
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

/** Every TanStack request has been answered and applied. */
const settled = () => waitFor(() => { expect(queryClient.isFetching()).toBe(0); }, { timeout: 5_000 });

/** The ticker row's status region: the row is <main>'s first child. */
const rowStatus = () => within(screen.getByRole('main').firstElementChild).getByRole('status');

const QUOTE = 'The live price could not be loaded: Yahoo is not answering. Prices come from the options snapshot.';

describe('App: a failed live quote in the ticker row, and Retry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    asked.market = 0;
    asked.quote = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says the live quote failed, marks the snapshot price, and Retry asks both functions once more', async () => {
    const error = vi.spyOn(console, 'error');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveWithQuoteFailing();
    renderApp();

    await waitFor(() => { expect(rowStatus().textContent).toBe(QUOTE); }, { timeout: 5_000 });
    await settled();
    const status = rowStatus();
    // The header prints the snapshot's price, and says so.
    expect(within(screen.getByRole('banner')).getByText('$100.00').parentElement)
      .toHaveTextContent('$100.00from the options snapshot');

    const before = { ...asked };
    const retry = screen.getByRole('button', { name: /^Retry/ });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => {
      expect(asked).toEqual({ market: before.market + 1, quote: before.quote + 1 });
    }, { timeout: 5_000 });
    await settled();
    await waitFor(() => { expect(rowStatus().textContent).toBe(QUOTE); }, { timeout: 5_000 }); // it failed again
    expect(rowStatus()).toBe(status); // the same region throughout
    expect(asked).toEqual({ market: before.market + 1, quote: before.quote + 1 });
    expect(screen.getByRole('button', { name: /^Retry/ })).toBe(retry);
    expect(retry).toHaveFocus();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
