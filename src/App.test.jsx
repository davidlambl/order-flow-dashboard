// src/App.test.jsx — App in the main.jsx tree (StrictMode, ErrorBoundary and QueryClientProvider around it), with MSW
// answering getMarketData and getLiveQuote (and, where a test holds an access token, validateToken and
// getTickerContext). It pins the F12 wiring: App hands useMarketData's nextRefreshAt and refreshMs to Header, whose
// countdown leaf ticks every second while App itself does not re-render. KPICards is a counting stand-in: App renders
// it with unchanged props and nothing memoises it, so each call is an App render (two per render under StrictMode).
// The tests after it pin what App reads through the store and auth events (Phase 5 (c)): the PRO badge following the
// token, a position edit across an external store-changed, a ticker switch and a switch back, research turning on
// with a Finnhub key, (a regression against the unscoped design) an unrelated preference save costing no App
// render, and the chat's model label following the store.
// Fake timers run with shouldAdvanceTime so waitFor and MSW keep working; the clock starts on Friday 2026-09-25 at
// 11:00 ET, in the regular session.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import KPICards from './components/KPICards.jsx';
import { clearToken } from './lib/auth.js';
import { queryClient } from './lib/queryClient.js';
import { emitStoreChanged } from './lib/store.js';
import { savePreference } from './lib/storeEvents.js';

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

  // ── What App reads through the store and auth events. The helpers serve the tests below; the F12 test above keeps
  // its own handlers. ──

  /** base64url without padding, as JWT segments are written (auth.test.js). */
  const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  /** A header.payload.signature token; nothing client-side checks the signature. */
  const jwt = (payload) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;
  /** A pro token good for 30 days: minted inside a test, after beforeEach has set the clock it expires against. */
  const proToken = () => jwt({ sub: 'u1', tier: 'pro', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 });

  /** A getTickerContext body with nothing in it: every TickerContext field (types/market.ts), empty. */
  const tickerContext = (ticker) => ({
    ticker, news: [], earnings: null, analysts: null, technicals: null, fundamentals: null, marketNews: [], marketQuotes: null, errors: {},
  });

  /**
   * The functions these tests reach: market data and the quote as above, validateToken (verifyStoredToken POSTs it at
   * startup, twice under StrictMode, so not `.once`) and getTickerContext, which a token or a Finnhub key enables;
   * each research request's ticker is pushed to `contextRequests`. A missing handler only logs an MSW error, which is
   * why the premium tests watch console.error.
   */
  function serveFunctions(contextRequests = []) {
    server.use(
      http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
      http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
      http.post(`${FN}/validateToken`, () => HttpResponse.json({ valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-10-25T00:00:00.000Z', requestId: 'req-1' })),
      http.get(`${FN}/getTickerContext`, ({ request }) => {
        contextRequests.push(tickerOf(request));
        return HttpResponse.json(tickerContext(tickerOf(request)));
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

  /**
   * Every TanStack request has been answered and applied, so no query result lands outside act() after this. The
   * validateToken POST of verifyStoredToken is a plain fetch, not counted: answered valid, its continuation sets no
   * state.
   */
  const settled = () => waitFor(() => { expect(queryClient.isFetching()).toBe(0); }, { timeout: 5_000 });

  /** PositionAnalysis' cost-basis input, which (behind the gate, with a token) replaces the skeletons once the data lands. */
  const costInput = () => screen.findByPlaceholderText('Avg cost', {}, { timeout: 5_000 });

  // The badge is Header's: a closed AppSettings renders null.
  it('Pin: the PRO badge follows the access token (F11)', async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    renderApp();
    expect(await screen.findByText('PRO', {}, { timeout: 5_000 })).toBeInTheDocument();
    await settled();

    act(() => { clearToken(); });
    expect(screen.queryByText('PRO')).not.toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: an edit inside its debounce survives an external store-changed and is written first', async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    renderApp();
    const cost = await costInput();
    await settled();
    fireEvent.change(cost, { target: { value: '95' } });
    expect(cost).toHaveValue(95);
    expect(localStorage.getItem('position_AVGO')).toBeNull(); // still inside the debounce

    // Another writer (an import, a cloud pull, another tab) rewrites the store and says so without a detail.
    localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 50, shares: 1 }));
    act(() => { window.dispatchEvent(new Event('store-changed')); });
    expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(95);
    expect(JSON.parse(localStorage.getItem('position_AVGO'))).toEqual({ costBasis: 95, shares: null });
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it("Pin: switching tickers shows the new ticker's stored position and flushes the old edit", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 80, shares: 2 }));
    serveFunctions();
    renderApp();
    const cost = await costInput();
    await settled();
    fireEvent.change(cost, { target: { value: '95' } });

    const search = screen.getByLabelText('Stock ticker symbol');
    fireEvent.change(search, { target: { value: 'NVDA' } });
    fireEvent.submit(search.closest('form'));
    expect(JSON.parse(localStorage.getItem('position_AVGO'))).toEqual({ costBasis: 95, shares: null });
    // NVDA loads behind the skeletons; its inputs then show its stored position, never AVGO's edit.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(80);
      expect(screen.getByPlaceholderText('Shares')).toHaveValue(2);
    }, { timeout: 5_000 });
    await settled();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // The key is written through the store bus (savePreference): what is pinned is App's flag following the store, not
  // the Settings form, whose key saves move onto this path in their own commit (Phase 5 (c)).
  it('Pin: saving a Finnhub key turns research on', async () => {
    const error = vi.spyOn(console, 'error');
    const contextRequests = [];
    serveFunctions(contextRequests);
    renderApp();
    await waitFor(() => { expect(toggle().textContent).toBe('60s'); }, { timeout: 5_000 });
    await settled();
    expect(contextRequests).toEqual([]); // no token and no key: nothing to research with

    act(() => { savePreference('data_finnhub_key', 'fh'); });
    await waitFor(() => { expect(contextRequests).toContain('AVGO'); }, { timeout: 5_000 });
    await settled();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // Regression (decision 10, against the unscoped design): with one global store version, or a listener that cleared
  // the edit on every event, each preference save re-rendered the whole App (KPICards counts its renders), and with
  // the edit cleared but this ticker's position not re-read the inputs jumped back to the stored value. Red on the
  // pre-5 (c) App as well, at the store assertion: its store-changed handler flushed the pending edit on every event,
  // a preference save included, so the store held 95 before the debounce ran (the divergence the PR body lists). So
  // the test pins decision 10 and that divergence together.
  it('Regression (against the unscoped design): an unrelated preference save neither re-renders App nor disturbs a pending edit', async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 50, shares: 1 }));
    serveFunctions();
    renderApp();
    const cost = await costInput();
    await settled();
    expect(cost).toHaveValue(50);
    fireEvent.change(cost, { target: { value: '95' } });
    const appRenders = KPICards.mock.calls.length;

    act(() => { savePreference('section_charts', false); }); // a preference App does not read
    expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(95);
    expect(KPICards.mock.calls.length).toBe(appRenders);
    expect(JSON.parse(localStorage.getItem('position_AVGO'))).toEqual({ costBasis: 50, shares: 1 }); // the debounce has not run

    await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // App's position debounce
    expect(JSON.parse(localStorage.getItem('position_AVGO'))).toEqual({ costBasis: 95, shares: 1 });
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // Shown red with handleTickerChange's setEdit(null) removed: the edit typed for AVGO then outlives the switch to
  // NVDA (hidden by the edit.ticker === ticker guard) and shows again over the position AVGO got in the meantime.
  it('Pin: an edit for one ticker does not reappear over a change made to it while another ticker was shown', async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 80, shares: 2 }));
    serveFunctions();
    renderApp();
    const cost = await costInput();
    await settled();
    fireEvent.change(cost, { target: { value: '95' } });

    const submitTicker = (symbol) => {
      const search = screen.getByLabelText('Stock ticker symbol');
      fireEvent.change(search, { target: { value: symbol } });
      fireEvent.submit(search.closest('form'));
    };
    submitTicker('NVDA');
    await waitFor(() => { expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(80); }, { timeout: 5_000 });
    await settled();

    // Another tab changes AVGO's position while NVDA is shown: a detail for an item App does not read right now.
    localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 70, shares: 3 }));
    act(() => { emitStoreChanged({ kind: 'position', id: 'AVGO' }); });
    submitTicker('AVGO');
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(70);
      expect(screen.getByPlaceholderText('Shares')).toHaveValue(3);
    }, { timeout: 5_000 });
    await settled();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // Regression: the pre-5 (c) ChatBot kept the model name in state and moved it on 'ai-settings-changed' only, an
  // event importAll no longer dispatches and the Settings form stops dispatching in its own commit; a name written
  // through the store bus (savePreference, as Settings writes it from then on) left the label at its mount-time
  // value. Red there at the second label assertion, green with the label read through useStoreValue. The label is
  // the premium panel's, so the token and the handlers are those of the tests above.
  it("Regression: the chat's model label follows the store", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    serveFunctions();
    renderApp();
    await costInput();
    await settled();

    fireEvent.click(screen.getByLabelText('Open AI Co-Pilot'));
    expect(await screen.findByText(/Default · AVGO context/)).toBeInTheDocument();

    act(() => { savePreference('ai_model_name', 'Claude X'); });
    expect(await screen.findByText(/Claude X · AVGO context/)).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // Regression (PR #70 review): a value outside the string contract under ai_model_name (importAll writes any JSON
  // under a known name; a cloud row is applied as it is) reads as the default. Red on an unguarded read: the object is
  // a fresh reference per read, useSyncExternalStore loops until React throws, and since ChatBot is mounted with the
  // chat closed the whole dashboard fell into the ErrorBoundary at load (before the PR the same value broke only the
  // opened chat).
  it("Regression: a non-string ai_model_name reads as Default instead of taking the dashboard down at load", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('access_token', proToken());
    localStorage.setItem('ai_model_name', JSON.stringify({ a: 1 }));
    serveFunctions();
    renderApp();
    await costInput();
    await settled();

    fireEvent.click(screen.getByLabelText('Open AI Co-Pilot'));
    expect(await screen.findByText(/Default · AVGO context/)).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
