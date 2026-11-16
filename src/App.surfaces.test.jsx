// src/App.surfaces.test.jsx — the ticker row's and the Research panel's failure surfaces driven through the REAL data
// hooks, inside the whole App as main.jsx renders it (StrictMode, ErrorBoundary, QueryClientProvider), with MSW
// answering the functions and fake timers running with shouldAdvanceTime from Friday 2026-09-25 at 11:00 ET, as in
// App.shell.test.jsx. TanStack clears a query's error when a fetch starts for it while it holds no data, and the live
// quote refetches every 60 s: a failure that is still the truth leaves the hooks' results while the next request runs.
// These tests hold the surfaces to what a user meets then: the failure sentence stays, Retry stays where it is with the
// focus, a pressed Retry says how it went (also when the same failure comes back), a silent attempt says nothing, and
// a switch to another ticker forgets the old one's failure.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { queryClient } from './lib/queryClient.js';
import { setToken } from './lib/auth.js';
import { expectNoAxeViolations } from './test/a11y.js';

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

const quote = (ticker) => ({
  ticker, current: 101.5, previousClose: 100, changePercent: 1.5, timestamp: FRIDAY_11_ET.getTime(), source: 'yahoo-regular',
});

/** A getTickerContext body with one company-news item: research to show. */
const tickerContext = (ticker) => ({
  ticker, earnings: null, analysts: null, technicals: null, fundamentals: null, marketNews: [], marketQuotes: null,
  errors: {},
  news: [{ headline: 'Broadcom extends its AI deal', summary: '', source: 'Reuters', url: 'https://example.com/n1', datetime: null, sentiment: null }],
});

const tickerOf = (request) => new URL(request.url).searchParams.get('ticker');

/** base64url without padding, as JWT segments are written (auth.test.js). */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A pro token good for 30 days, as App.shell.test.jsx mints it: nothing client-side checks the signature. */
const proToken = () => {
  const part = (value) => b64url(JSON.stringify(value));
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'u1', tier: 'pro', exp: Math.floor(Date.now() / 1000) + 30 * 86_400 })}.sig`;
};

const fail = (error) => HttpResponse.json({ error, code: 'UPSTREAM' }, { status: 502 });

/** A promise and the function that settles it: a request held until the test lets it go. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
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

/** The ticker row: <main>'s first child. */
const row = () => screen.getByRole('main').firstElementChild;
const rowStatus = () => within(row()).getByRole('status');
const rowRetry = () => within(row()).queryByRole('button', { name: /^Retry/ });

/** The Research section's own region and, inside it, its status region (the first: skeletons' come later). */
const research = () => screen.getByRole('region', { name: 'Research' });
const researchStatus = () => within(research()).getAllByRole('status')[0];
const researchRetry = () => within(research()).queryByRole('button', { name: /^Retry/ });
const researchToggle = () => screen.getByRole('button', { name: /^Research/ });

/**
 * Records each text a node shows after a change in it, consecutive repeats folded: what a status region announces.
 * stop() delivers what is pending and returns the list.
 */
function watchText(node) {
  const texts = [];
  const note = () => {
    const text = node.textContent;
    if (texts.at(-1) !== text) texts.push(text);
  };
  const observer = new MutationObserver(note);
  observer.observe(node, { childList: true, subtree: true, characterData: true });
  return {
    texts,
    stop: async () => {
      await act(async () => {}); // a MutationObserver delivers in a microtask
      observer.disconnect();
      return texts;
    },
  };
}

const QUOTE = 'The live price could not be loaded: Yahoo is not answering. Prices come from the options snapshot.';
const RESEARCH_FAILED = 'Research could not be loaded: Finnhub is not answering.';

describe('App: the failure surfaces through the real hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a live quote that never loaded keeps its sentence, its Retry and the focus across the 60 s silent refetch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    let quotes = 0;
    let held = null;
    server.use(
      http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
      http.get(`${FN}/getLiveQuote`, async () => {
        quotes += 1;
        if (held) await held.promise;
        return fail('Yahoo is not answering');
      }),
    );
    renderApp();
    await waitFor(() => { expect(rowStatus().textContent).toBe(QUOTE); }, { timeout: 5_000 });
    await settled();
    const region = rowStatus();
    const retry = rowRetry();
    retry.focus();
    const marker = () => within(screen.getByRole('banner')).getByText('$100.00').parentElement.textContent;
    expect(marker()).toBe('$100.00from the options snapshot');
    const watch = watchText(region);

    held = gate();
    const before = quotes;
    // The silent refetch falls due and is held (inside act: the header's countdown ticks meanwhile).
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(quotes).toBe(before + 1);
    // While it runs: the same sentence, the same button, busy and focused, the header's marker kept.
    expect(region.textContent).toBe(QUOTE);
    expect(rowRetry()).toBe(retry);
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveFocus();
    expect(marker()).toBe('$100.00from the options snapshot');

    held.open();
    await settled();
    expect(quotes).toBe(before + 1);
    expect(rowStatus()).toBe(region);
    expect(rowRetry()).toBe(retry);
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute('aria-disabled');
    expect(marker()).toBe('$100.00from the options snapshot');
    expect(await watch.stop()).toEqual([]); // nothing to announce: the region never changed
    expect(error).not.toHaveBeenCalled();
  }, 20_000);

  it('a quote-only Retry whose answer comes 400 ms after the market data keeps Retry, focused, at every sample', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    let quotes = 0;
    let delay = false;
    server.use(
      http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
      http.get(`${FN}/getLiveQuote`, async () => {
        quotes += 1;
        if (delay) await new Promise((resolve) => { setTimeout(resolve, 400); });
        return fail('Yahoo is not answering');
      }),
    );
    renderApp();
    await waitFor(() => { expect(rowStatus().textContent).toBe(QUOTE); }, { timeout: 5_000 });
    await settled();
    const region = rowStatus();
    const retry = rowRetry();
    retry.focus();
    const watch = watchText(region);

    const samples = [];
    const sample = () => {
      const now = rowRetry();
      samples.push(now === retry && retry === document.activeElement ? 'R' : now ? 'r' : '-');
    };
    delay = true;
    const before = quotes;
    const timer = setInterval(sample, 20);
    fireEvent.click(retry);
    sample();
    try {
      await waitFor(() => { expect(quotes).toBe(before + 1); }, { timeout: 5_000 });
      await settled();
    } finally {
      clearInterval(timer);
    }
    sample();
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.join('')).toMatch(/^R+$/);
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute('aria-disabled');
    expect(rowStatus()).toBe(region);
    // Said twice: the retry under way, then the same failure, now a change.
    expect(await watch.stop()).toEqual(['Retrying...', QUOTE]);
    expect(error).not.toHaveBeenCalled();
  }, 20_000);

  it('a pressed Retry: "Retrying..." visible in the region while it runs, then "Market data loaded." once it worked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    let quotes = 0;
    let held = null;
    server.use(
      http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
      http.get(`${FN}/getLiveQuote`, async ({ request }) => {
        quotes += 1;
        if (!held) return fail('Yahoo is not answering');
        await held.promise;
        return HttpResponse.json(quote(tickerOf(request)));
      }),
    );
    const { baseElement } = renderApp();
    await waitFor(() => { expect(rowStatus().textContent).toBe(QUOTE); }, { timeout: 5_000 });
    await settled();
    const region = rowStatus();
    const retry = rowRetry();
    expect(retry).toHaveAccessibleName('Retry market data');
    retry.focus();
    const watch = watchText(region);

    held = gate();
    const before = quotes;
    fireEvent.click(retry);
    await waitFor(() => { expect(quotes).toBe(before + 1); }, { timeout: 5_000 });
    expect(region.textContent).toBe('Retrying...');
    expect(region).not.toHaveClass('sr-only');
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveFocus();
    await expectNoAxeViolations(baseElement);

    held.open();
    await settled();
    await screen.findByText('$101.50', {}, { timeout: 5_000 });
    expect(rowRetry()).toBeNull();
    expect(rowStatus()).toBe(region);
    expect(region.textContent).toBe('Market data loaded.');
    expect(region).toHaveClass('sr-only');
    expect(row()).toHaveFocus(); // Retry left with the focus: the row takes it
    expect(await watch.stop()).toEqual(['Retrying...', 'Market data loaded.']);
    await expectNoAxeViolations(baseElement);
    expect(error).not.toHaveBeenCalled();
  }, 20_000);

  it('a switch to another ticker after a failure: no Retry and an empty region while the new ticker loads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    const held = gate();
    server.use(
      http.get(`${FN}/getMarketData`, async ({ request }) => {
        if (tickerOf(request) === 'AVGO') return fail('Upstream down');
        await held.promise;
        return HttpResponse.json(marketData(tickerOf(request)));
      }),
      http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
    );
    renderApp();
    await waitFor(() => { expect(rowStatus().textContent).toMatch(/^Options data could not be loaded: Upstream down\./); }, { timeout: 5_000 });
    await settled();
    expect(rowRetry()).not.toBeNull();

    const search = screen.getByLabelText('Stock ticker symbol');
    fireEvent.change(search, { target: { value: 'NVDA' } });
    fireEvent.submit(search.closest('form'));
    await waitFor(() => { expect(queryClient.isFetching()).toBeGreaterThan(0); });
    expect(within(row()).getByText('NVDA')).toBeInTheDocument();
    expect(rowRetry()).toBeNull();
    expect(rowStatus().textContent).toBe('');

    held.open();
    await settled();
    expect(rowRetry()).toBeNull();
    expect(rowStatus().textContent).toBe('');
    expect(error).not.toHaveBeenCalled();
  }, 20_000);

  it('Research Retry on a failed first load: busy and focused while it runs, the sentence back after a second failure, the toggle focused once it worked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    let asked = 0;
    let held = null;
    let answer = 'fail';
    server.use(
      http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
      http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
      http.get(`${FN}/getTickerContext`, async ({ request }) => {
        asked += 1;
        if (held) await held.promise;
        return answer === 'fail' ? fail('Finnhub is not answering') : HttpResponse.json(tickerContext(tickerOf(request)));
      }),
    );
    const { baseElement } = renderApp();
    await settled();
    act(() => { setToken(proToken()); }); // the Research panel unlocks and research is on: its first load fails
    await waitFor(() => { expect(researchStatus().textContent).toBe(RESEARCH_FAILED); }, { timeout: 5_000 });
    await settled();
    const region = researchStatus();
    const retry = researchRetry();
    expect(retry).toHaveAccessibleName('Retry research');
    retry.focus();
    const watch = watchText(region);

    // The first retry, held, then failing the same way.
    held = gate();
    let before = asked;
    fireEvent.click(retry);
    await waitFor(() => { expect(asked).toBe(before + 1); }, { timeout: 5_000 });
    expect(researchRetry()).toBe(retry);
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveFocus();
    expect(region.textContent).toBe('Retrying...');
    expect(region).not.toHaveClass('sr-only');
    expect(screen.queryByText(/No news, earnings or analyst data/)).toBeNull();
    await expectNoAxeViolations(baseElement);

    held.open();
    await settled();
    expect(researchStatus()).toBe(region);
    expect(region.textContent).toBe(RESEARCH_FAILED);
    expect(researchRetry()).toBe(retry);
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute('aria-disabled');
    expect(watch.texts).toEqual(['Retrying...', RESEARCH_FAILED]);

    // The second retry works.
    held = gate();
    answer = 'ok';
    before = asked;
    fireEvent.click(retry);
    await waitFor(() => { expect(asked).toBe(before + 1); }, { timeout: 5_000 });
    expect(region.textContent).toBe('Retrying...');
    held.open();
    await settled();
    await within(research()).findByText('Broadcom extends its AI deal', {}, { timeout: 5_000 });
    expect(researchRetry()).toBeNull();
    expect(researchToggle()).toHaveFocus();
    expect(researchStatus()).toBe(region);
    expect(region.textContent).toBe('Research loaded.');
    expect(region).toHaveClass('sr-only');
    expect(await watch.stop()).toEqual(['Retrying...', RESEARCH_FAILED, 'Retrying...', 'Research loaded.']);
    await expectNoAxeViolations(baseElement);
    expect(error).not.toHaveBeenCalled();
  }, 20_000);

  it('Research: a reload no press started that fails again says nothing, and keeps Retry and the focus', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    let asked = 0;
    let held = null;
    server.use(
      http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
      http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
      http.get(`${FN}/getTickerContext`, async () => {
        asked += 1;
        if (held) await held.promise;
        return fail('Finnhub is not answering');
      }),
    );
    renderApp();
    await settled();
    act(() => { setToken(proToken()); });
    await waitFor(() => { expect(researchStatus().textContent).toBe(RESEARCH_FAILED); }, { timeout: 5_000 });
    await settled();
    const region = researchStatus();
    const retry = researchRetry();
    retry.focus();
    const watch = watchText(region);

    // A data key saved in Settings refetches the research, with nobody pressing anything.
    held = gate();
    const before = asked;
    act(() => { window.dispatchEvent(new Event('data-source-changed')); });
    await waitFor(() => { expect(asked).toBe(before + 1); }, { timeout: 5_000 });
    expect(region.textContent).toBe(RESEARCH_FAILED);
    expect(researchRetry()).toBe(retry);
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveFocus();

    held.open();
    await settled();
    expect(researchStatus()).toBe(region);
    expect(region.textContent).toBe(RESEARCH_FAILED);
    expect(researchRetry()).toBe(retry);
    expect(retry).toHaveFocus();
    expect(await watch.stop()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  }, 20_000);
});
