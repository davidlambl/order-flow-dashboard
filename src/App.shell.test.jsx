// src/App.shell.test.jsx — what App renders around its panels, and the two context values it hands them. First the
// ticker row: the symbol, IV30 to one decimal (only for loaded data that has one), DEMO DATA, ERROR with the failure
// as its title (a refresh that fails after a success keeps the data, so the badge does show) and the contracts count
// (above 0 only, grouped by toLocaleString); and the footer's one data-source sentence, for CBOE, Tradier, the
// Tradier sandbox and demo data. Then the contexts: an App render that changes nothing in either hands every consumer
// the same two objects, and each value changes with its own inputs (the ticker; the stored access token), so that pin
// cannot pass on a value that never changes. A new value re-renders every consumer, and App also renders on state
// that neither carries: the chat toggle, Settings opening and closing, each mousemove of a sidebar drag.
// App.test.jsx asserts none of this.
// App runs as main.jsx renders it (StrictMode, ErrorBoundary, QueryClientProvider), with MSW answering getMarketData,
// getLiveQuote and, once a test stores a token, getTickerContext; fake timers run with shouldAdvanceTime from Friday
// 2026-09-25 at 11:00 ET, as in App.test.jsx. KPICards is a stand-in that records both context values on every call:
// nothing memoises it, so it runs on each of App's renders (twice under StrictMode), the record grows with App's
// renders, and its last entry is what every consumer saw in the latest commit. Every assertion is on what the page
// shows or what the contexts carry, never on how App computes them.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { setToken } from './lib/auth.js';
import { queryClient } from './lib/queryClient.js';

// The two context values each KPICards call saw, in call order (the real KPICards reads neither: it is pure on its
// props).
const seen = vi.hoisted(() => []);
vi.mock('./components/KPICards.jsx', async () => {
  const { useContext } = await import('react');
  const { MarketContext } = await import('./contexts/MarketContext.js');
  const { AuthContext } = await import('./contexts/AuthContext.js');
  return {
    default: vi.fn(function KPICards() {
      seen.push({ market: useContext(MarketContext), auth: useContext(AuthContext) });
      return null;
    }),
  };
});

const { marketData } = vi.hoisted(() => ({
  /** A complete getMarketData body as the CBOE path sends it (every MarketData field, types/market.ts), `over` on top. */
  marketData: (ticker, over = {}) => ({
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
    ...over,
  }),
}));

// Demo data as the generator shapes it (provider 'mock', no IV30, no trade time or expiries), but fixed: the real one
// is random.
vi.mock('./lib/mockData.js', () => ({
  generateMockData: (ticker) => marketData(ticker, {
    provider: 'mock', delay: 'simulated', iv30: null, lastTradeTime: null, totalOptionsCount: 2_468, expiries: [],
  }),
}));

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');

// The footer's four sentences, word for word.
const NOTE = {
  cboe: 'Data from CBOE delayed quotes (~15-min delay). Spot price may differ from Yahoo or broker real-time/closing prices. Add a TRADIER_API_KEY for real-time data ($10/mo). Dark Pool % is a statistical estimate.',
  tradier: 'Real-time data via Tradier brokerage API. GEX, Max Pain, and P/C Ratio computed from live options chain. Net Premium estimated from daily volume × mid price.',
  sandbox: 'Data from Tradier sandbox (delayed). Upgrade to a Tradier brokerage account ($10/mo) for real-time feeds. GEX, Max Pain, P/C Ratio, and Net Premium computed from options chain.',
  demo: 'Currently showing simulated demo data. Deploy to Netlify and the CBOE data feed activates automatically — no API key needed.',
};

/** A getLiveQuote body as the Yahoo path sends it during the regular session; Header shows `current`. */
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
 * The functions App reaches here: getMarketData answering `body` for the requested ticker, the quote, and
 * getTickerContext, which a stored token turns on. A request with no handler logs an MSW error, which every test's
 * console.error check would catch.
 */
function serveFunctions(body = marketData) {
  server.use(
    http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(body(tickerOf(request)))),
    http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
    http.get(`${FN}/getTickerContext`, ({ request }) => HttpResponse.json(tickerContext(tickerOf(request)))),
  );
}

/** getMarketData failing from here on, as an upstream outage answers it (the newest handler wins). */
const failMarketData = () => server.use(
  http.get(`${FN}/getMarketData`, () => HttpResponse.json({ error: 'Upstream down', code: 'UPSTREAM' }, { status: 502 })),
);

/** getMarketData's next replies held until the returned release() runs, so a load can be looked at while it runs. */
function holdMarketData(body) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  server.use(http.get(`${FN}/getMarketData`, async ({ request }) => {
    await gate;
    return HttpResponse.json(body(tickerOf(request)));
  }));
  return release;
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
 * validateToken POST of verifyStoredToken is not among them: with no token stored at startup it is never sent.
 */
const settled = () => waitFor(() => { expect(queryClient.isFetching()).toBe(0); }, { timeout: 5_000 });

/** App rendered and loaded: the quote is in the Header, and every request has been answered and applied. */
async function renderLoaded() {
  renderApp();
  await screen.findByText('$101.50', {}, { timeout: 5_000 });
  await settled();
}

/** The ticker row, first in <main>: the text of each of its parts in order (the symbol, the badges, the count). */
const tickerRow = () => [...screen.getByRole('main').firstElementChild.querySelectorAll('span')]
  .map((part) => part.textContent);

/** The footer, last in <main>: its one data-source sentence. */
const footer = () => screen.getByRole('main').lastElementChild.textContent;

/** A symbol typed into the Header's search and submitted. */
const submitTicker = (symbol) => {
  const search = screen.getByLabelText('Stock ticker symbol');
  fireEvent.change(search, { target: { value: symbol } });
  fireEvent.submit(search.closest('form'));
};

describe('App: the ticker row, the footer and the two context values', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    seen.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── The ticker row and the footer ──

  it.each([
    [
      'CBOE data: IV30 to one decimal and the count in the row, the CBOE sentence in the footer',
      { iv30: 31.44 },
      ['AVGO', 'IV30: 31.4%', '420 contracts analyzed'],
      NOTE.cboe,
    ],
    [
      'Tradier data without IV30: no IV30 badge, the count grouped, the Tradier sentence',
      { provider: 'tradier', delay: 'real-time', iv30: null, totalOptionsCount: 12_345 },
      ['AVGO', `${(12_345).toLocaleString()} contracts analyzed`],
      NOTE.tradier,
    ],
    [
      'Tradier sandbox data with no contracts: no count, the sandbox sentence',
      { provider: 'tradier-sandbox', delay: 'sandbox (delayed)', totalOptionsCount: 0 },
      ['AVGO', 'IV30: 31.4%'],
      NOTE.sandbox,
    ],
  ])('Pin: %s', async (_label, over, row, note) => {
    const error = vi.spyOn(console, 'error');
    serveFunctions((ticker) => marketData(ticker, over));
    await renderLoaded();

    expect(tickerRow()).toEqual(row);
    expect(footer()).toBe(note);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: demo data (getMarketData failing before anything loaded) shows DEMO DATA, no ERROR, and the demo sentence', async () => {
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveFunctions();
    failMarketData();
    await renderLoaded();

    // The failure is the hook's error here too, but in demo mode DEMO DATA stands for it.
    expect(tickerRow()).toEqual(['AVGO', 'DEMO DATA', `${(2_468).toLocaleString()} contracts analyzed`]);
    expect(footer()).toBe(NOTE.demo);
    expect(warn).toHaveBeenCalledWith('No data loaded for', 'AVGO', '— showing demo data:', 'Upstream down');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: a refresh that fails after a success keeps the data and adds ERROR, with the failure as its title', async () => {
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveFunctions();
    await renderLoaded();
    expect(tickerRow()).toEqual(['AVGO', 'IV30: 31.4%', '420 contracts analyzed']);

    failMarketData();
    fireEvent.click(screen.getByLabelText('Refresh data'));
    await waitFor(() => {
      expect(tickerRow()).toEqual(['AVGO', 'IV30: 31.4%', 'ERROR', '420 contracts analyzed']);
    }, { timeout: 5_000 });
    await settled();
    expect(screen.getByText('ERROR')).toHaveAttribute('title', 'Upstream down');
    expect(footer()).toBe(NOTE.cboe); // still the last good data's source
    expect(warn).toHaveBeenCalledWith('Market data refresh failed; keeping last good data:', 'Upstream down');
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: a ticker switch shows the new symbol at once, and IV30 and the count only once its own data has landed', async () => {
    const error = vi.spyOn(console, 'error');
    serveFunctions();
    await renderLoaded();
    expect(tickerRow()).toEqual(['AVGO', 'IV30: 31.4%', '420 contracts analyzed']);

    const release = holdMarketData((ticker) => marketData(ticker, { iv30: 44.06, totalOptionsCount: 777 }));
    submitTicker('NVDA');
    // NVDA loads in the foreground while the data on hand is still AVGO's, which has both.
    expect(tickerRow()).toEqual(['NVDA']);

    release();
    await waitFor(() => {
      expect(tickerRow()).toEqual(['NVDA', 'IV30: 44.1%', '777 contracts analyzed']);
    }, { timeout: 5_000 });
    await settled();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  // ── The two context values ──

  it('Pin: an App render that changes nothing in either context hands every consumer the same two values', async () => {
    const error = vi.spyOn(console, 'error');
    serveFunctions();
    await renderLoaded();
    const calls = seen.length;
    const { market, auth } = seen.at(-1);

    fireEvent.click(screen.getByLabelText('Open AI Co-Pilot')); // App state that neither context carries
    expect(screen.queryByLabelText('Open AI Co-Pilot')).not.toBeInTheDocument(); // the chat is open
    expect(seen.length).toBeGreaterThan(calls); // App rendered
    expect(seen.at(-1).market).toBe(market);
    expect(seen.at(-1).auth).toBe(auth);
    await settled();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: a ticker switch hands consumers a new market value for the new ticker, and the auth value as it was', async () => {
    const error = vi.spyOn(console, 'error');
    serveFunctions();
    await renderLoaded();
    const { market, auth } = seen.at(-1);

    submitTicker('NVDA');
    expect(seen.at(-1).market).not.toBe(market);
    expect(seen.at(-1).market.ticker).toBe('NVDA');
    await waitFor(() => { expect(seen.at(-1).market.data?.ticker).toBe('NVDA'); }, { timeout: 5_000 });
    await settled();
    // Nothing in it changed across the switch, NVDA's load and its quote.
    expect(seen.at(-1).auth).toBe(auth);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: an access token stored through the auth event hands consumers a new auth value that carries it', async () => {
    const error = vi.spyOn(console, 'error');
    serveFunctions();
    await renderLoaded();
    const { auth } = seen.at(-1);
    expect(auth).toMatchObject({ isPremium: false, tokenTier: null, daysLeft: 0 });

    act(() => { setToken(proToken()); });
    expect(seen.at(-1).auth).not.toBe(auth);
    expect(seen.at(-1).auth).toMatchObject({ isPremium: true, tokenTier: 'pro', daysLeft: 30 });
    await settled(); // the token turns research on: getTickerContext is answered
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
