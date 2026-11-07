// src/App.position.test.jsx — App's position draft, in the main.jsx tree as App.test.jsx renders it (StrictMode,
// ErrorBoundary and QueryClientProvider around it, MSW answering the functions). App holds what the position inputs
// show while an edit is typed and writes it to the store once typing pauses (roadmap D10). App.test.jsx's four
// position tests pin the edit across a no-detail store-changed, a ticker switch, a switch back and a preference save;
// these pin the rest: the write waits (nothing 100 ms in, one write per pause, a shares edit carrying the cost typed
// before it); a pagehide and an unmount inside the pause write the edit at once; this ticker's position written
// elsewhere shows when no save waits (another tab's write, which reaches App through subscribeCrossTab) and, when one
// does, the edit is written first and stays shown; a detail for another ticker, for this ticker's chat or for a
// preference changes nothing; after a ticker switch the shown ticker's detail is the one that counts; a cleared field
// is stored as null, and a position with both fields cleared is removed. Every test is a pin, written against the
// one-file App.jsx as the contract its split into hooks must keep: each asserts what is shown and stored after an
// event, never how App gets there.
// The panel is premium, so every test holds an access token. Fake timers run with shouldAdvanceTime from Friday
// 2026-09-25 at 11:00 ET, as in App.test.jsx; the fake clock also moves with real time, so the "not yet" checks sit
// 100 ms into the 300 ms pause rather than just before its end.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw/http';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { queryClient } from './lib/queryClient.js';
import { emitStoreChanged } from './lib/store.js';

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

/** base64url without padding, as JWT segments are written (auth.test.js). */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A header.payload.signature token; nothing client-side checks the signature. */
const jwt = (payload) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;
/** A pro token good for 30 days: minted after beforeEach has set the clock it expires against. */
const proToken = () => jwt({ sub: 'u1', tier: 'pro', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 });

/** A getTickerContext body with nothing in it: every TickerContext field (types/market.ts), empty. */
const tickerContext = (ticker) => ({
  ticker, news: [], earnings: null, analysts: null, technicals: null, fundamentals: null, marketNews: [], marketQuotes: null, errors: {},
});

/**
 * The functions these tests reach: market data and the quote, validateToken (verifyStoredToken POSTs it at startup,
 * twice under StrictMode, so not `.once`) and getTickerContext, which the token enables.
 */
function serveFunctions() {
  server.use(
    http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
    http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
    http.post(`${FN}/validateToken`, () => HttpResponse.json({ valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-10-25T00:00:00.000Z', requestId: 'req-1' })),
    http.get(`${FN}/getTickerContext`, ({ request }) => HttpResponse.json(tickerContext(tickerOf(request)))),
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

// The two inputs as they are now: queried afresh after every step, since a ticker switch renders new ones.
const costField = () => screen.getByPlaceholderText('Avg cost');
const sharesField = () => screen.getByPlaceholderText('Shares');

/** The ticker's stored position as the store wrote it; null while there is none. */
const stored = (ticker = 'AVGO') => JSON.parse(localStorage.getItem(`position_${ticker}`));

/** Every value written under the ticker's position key since `setItem` was spied on, parsed, in order. */
const writesOf = (setItem, ticker = 'AVGO') => setItem.mock.calls
  .filter(([key]) => key === `position_${ticker}`)
  .map(([, value]) => JSON.parse(value));

/** Let `ms` of fake time pass, the timers due in it run inside act(). */
const after = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/**
 * Another tab writes this ticker's position: the value lands in the shared localStorage, and this tab hears of it
 * only through the storage event, which the store re-dispatches as this ticker's store-changed after a macrotask.
 */
async function anotherTabWrites(position) {
  const value = JSON.stringify(position);
  localStorage.setItem('position_AVGO', value);
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'position_AVGO', newValue: value, storageArea: localStorage }));
    await vi.advanceTimersByTimeAsync(10);
  });
}

/** Header's ticker search, submitted. */
function submitTicker(symbol) {
  const search = screen.getByLabelText('Stock ticker symbol');
  fireEvent.change(search, { target: { value: symbol } });
  fireEvent.submit(search.closest('form'));
}

describe('App: the position draft', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    localStorage.setItem('access_token', proToken());
    serveFunctions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Pin: the edit is written once typing pauses: nothing 100 ms in, one write per pause, the shares edit carrying the cost', async () => {
    const error = vi.spyOn(console, 'error');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderApp();
    await costInput();
    await settled();

    fireEvent.change(costField(), { target: { value: '9' } });
    fireEvent.change(costField(), { target: { value: '95' } });
    await after(100);
    expect(stored()).toBeNull();
    expect(costField()).toHaveValue(95);
    await after(250);
    expect(stored()).toEqual({ costBasis: 95, shares: null });

    fireEvent.change(sharesField(), { target: { value: '10' } });
    await after(100);
    expect(stored()).toEqual({ costBasis: 95, shares: null });
    await after(250);
    expect(stored()).toEqual({ costBasis: 95, shares: 10 });
    // Three keystrokes, two pauses: the load wrote nothing, and each pause wrote the edit as it stood.
    expect(writesOf(setItem)).toEqual([{ costBasis: 95, shares: null }, { costBasis: 95, shares: 10 }]);
    expect(costField()).toHaveValue(95);
    expect(sharesField()).toHaveValue(10);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: a pagehide inside the pause writes the edit at once, and the pause then writes nothing more', async () => {
    const error = vi.spyOn(console, 'error');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderApp();
    await costInput();
    await settled();

    fireEvent.change(costField(), { target: { value: '95' } });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(stored()).toEqual({ costBasis: 95, shares: null });
    expect(costField()).toHaveValue(95);

    await after(350);
    expect(writesOf(setItem)).toEqual([{ costBasis: 95, shares: null }]);
    expect(costField()).toHaveValue(95);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: an unmount inside the pause writes the edit', async () => {
    const error = vi.spyOn(console, 'error');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderApp();
    await costInput();
    await settled();

    fireEvent.change(costField(), { target: { value: '95' } });
    view.unmount();
    expect(stored()).toEqual({ costBasis: 95, shares: null });

    await after(350); // nothing is left to fire
    expect(writesOf(setItem)).toEqual([{ costBasis: 95, shares: null }]);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it("Pin: this ticker's position written in another tab shows while no save waits, before an edit and after one was written", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 50, shares: 1 }));
    renderApp();
    await costInput();
    await settled();
    expect(costField()).toHaveValue(50);

    await anotherTabWrites({ costBasis: 60, shares: 2 });
    expect(costField()).toHaveValue(60);
    expect(sharesField()).toHaveValue(2);

    // An edit whose pause has run: the inputs still show it, until this ticker's position changes again elsewhere.
    fireEvent.change(costField(), { target: { value: '95' } });
    await after(350);
    expect(stored()).toEqual({ costBasis: 95, shares: 2 });
    await anotherTabWrites({ costBasis: 70, shares: 3 });
    expect(costField()).toHaveValue(70);
    expect(sharesField()).toHaveValue(3);
    expect(stored()).toEqual({ costBasis: 70, shares: 3 });
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it("Pin: this ticker's position changed elsewhere while an edit waits: the edit is written first and stays shown", async () => {
    const error = vi.spyOn(console, 'error');
    renderApp();
    await costInput();
    await settled();

    fireEvent.change(costField(), { target: { value: '95' } });
    localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 70, shares: 3 }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => { emitStoreChanged({ kind: 'position', id: 'AVGO' }); });
    expect(stored()).toEqual({ costBasis: 95, shares: null });
    expect(costField()).toHaveValue(95);
    expect(sharesField()).toHaveValue(null);

    await after(350);
    expect(writesOf(setItem)).toEqual([{ costBasis: 95, shares: null }]);
    expect(costField()).toHaveValue(95);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it("Pin: a detail for another ticker, for this ticker's chat or for a preference leaves the edit shown and unwritten", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 50, shares: 1 }));
    renderApp();
    await costInput();
    await settled();

    fireEvent.change(costField(), { target: { value: '95' } });
    for (const detail of [{ kind: 'position', id: 'NVDA' }, { kind: 'chat', id: 'AVGO' }, { kind: 'pref', id: 'AVGO' }]) {
      act(() => { emitStoreChanged(detail); });
      expect({ detail, shown: costField().valueAsNumber, stored: stored() })
        .toEqual({ detail, shown: 95, stored: { costBasis: 50, shares: 1 } });
    }

    await after(350);
    expect(stored()).toEqual({ costBasis: 95, shares: 1 });
    expect(costField()).toHaveValue(95);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it("Pin: after a ticker switch the shown ticker's detail is the one that writes its edit first", async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 80, shares: 2 }));
    renderApp();
    await costInput();
    await settled();

    submitTicker('NVDA');
    await waitFor(() => { expect(costField()).toHaveValue(80); }, { timeout: 5_000 });
    await settled();

    fireEvent.change(costField(), { target: { value: '85' } });
    act(() => { emitStoreChanged({ kind: 'position', id: 'AVGO' }); }); // the ticker no longer shown
    expect(costField()).toHaveValue(85);
    expect(stored('NVDA')).toEqual({ costBasis: 80, shares: 2 });

    act(() => { emitStoreChanged({ kind: 'position', id: 'NVDA' }); });
    expect(stored('NVDA')).toEqual({ costBasis: 85, shares: 2 });
    expect(costField()).toHaveValue(85);
    expect(sharesField()).toHaveValue(2);
    expect(stored('AVGO')).toBeNull();
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  it('Pin: a cleared field shows empty and is stored as null; both cleared removes the position', async () => {
    const error = vi.spyOn(console, 'error');
    localStorage.setItem('position_AVGO', JSON.stringify({ costBasis: 50, shares: 1 }));
    renderApp();
    await costInput();
    await settled();

    fireEvent.change(costField(), { target: { value: '' } });
    expect(costField()).toHaveValue(null);
    await after(350);
    expect(stored()).toEqual({ costBasis: null, shares: 1 });

    fireEvent.change(sharesField(), { target: { value: '' } });
    expect(sharesField()).toHaveValue(null);
    await after(350);
    expect(localStorage.getItem('position_AVGO')).toBeNull();
    expect(costField()).toHaveValue(null);
    expect(sharesField()).toHaveValue(null);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);
});
