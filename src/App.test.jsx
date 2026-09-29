// src/App.test.jsx — App in the main.jsx tree (StrictMode, ErrorBoundary and QueryClientProvider around it), with MSW
// answering getMarketData and getLiveQuote. It pins the F12 wiring: App hands useMarketData's nextRefreshAt and
// refreshMs to Header, whose countdown leaf ticks every second while App itself does not re-render. KPICards is a
// counting stand-in: App renders it with unchanged props and nothing memoises it, so each call is an App render (two
// per render under StrictMode).
// Fake timers run with shouldAdvanceTime so waitFor and MSW keep working; the clock starts on Friday 2026-09-25 at
// 11:00 ET, in the regular session.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import KPICards from './components/KPICards.jsx';
import { queryClient } from './lib/queryClient.js';

vi.mock('./components/KPICards.jsx', () => ({ default: vi.fn(() => null) }));

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

/** A getLiveQuote body as the Yahoo path sends it during the regular session; Header shows `current`. */
function quote(ticker) {
  return {
    ticker, current: 101.5, previousClose: 100, changePercent: 1.5, timestamp: FRIDAY_11_ET.getTime(),
    source: 'yahoo-regular',
  };
}

const tickerOf = (request) => new URL(request.url).searchParams.get('ticker');

/** Header's auto-refresh toggle while auto-refresh is on: the countdown, 'Auto' or 'Paused'. */
const toggle = () => screen.getByLabelText('Disable auto-refresh');

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression (F12, PR #64 review finding 3): the pre-PR App re-rendered every second. Also red when App hands Header
  // the old secondsLeft or swaps nextRefreshAt and refreshMs ('Auto', and a NaN or epoch-sized interval in the
  // tooltip), or gains a per-second state such as useNow(1000); '55s' shows the countdown leaf still ticks.
  it('the Header countdown ticks every second without re-rendering App', async () => {
    server.use(
      http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
      http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
    );
    render(
      <StrictMode>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </ErrorBoundary>
      </StrictMode>,
    );

    // Loaded: the countdown starts at 60 and the live quote is in the Header, so nothing is left to land.
    await waitFor(() => {
      expect(toggle().textContent).toBe('60s');
      expect(screen.getByText('$101.50')).toBeInTheDocument();
    }, { timeout: 5_000 });
    expect(toggle()).toHaveAttribute('title', expect.stringContaining('every 60s'));
    const appRenders = KPICards.mock.calls.length;
    expect(appRenders).toBeGreaterThan(0);

    for (let second = 1; second <= 5; second += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    }
    expect(toggle().textContent).toBe('55s');
    expect(KPICards.mock.calls.length).toBe(appRenders);
  }, 15_000);
});
