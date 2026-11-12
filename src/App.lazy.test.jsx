// src/App.lazy.test.jsx — the three parts App loads on demand, each import held by hand: this file opts out of the
// setup's preload (src/test/lazy.js), so every lazy starts each test unloaded, and an importGate holds each import of
// the charts panel, the sign-in form and the sync choice until the test settles it.
// The charts: the skeleton in the Charts section while the panel loads, the rest of the dashboard shown, then the
// charts; a panel that arrives while the market data still loads draws exactly the skeleton, whose two cards are the
// ones GexChart and FlowChart draw while loading; a collapsed section never asks for the panel, the idle preload
// included, and expanding it does; a panel that cannot load leaves the boundary's card in the section, everything
// else in place, and Try again loads it. The sign-in form: fetched with the sync choice while the session is checked,
// the check's spinner left as it is until the form is in; a form that cannot load leaves the boundary's card on the
// sign-in background, and Try again loads it. The sync choice: a modal layer over the dashboard while it loads, then
// the dialog; one that cannot load leaves the card in the same layer, and Try again loads it. Without cloud sign-in
// neither module is requested. The idle preload: scheduled once the dashboard shows, never before, cancelled at unmount.
// App runs as main.jsx renders it (StrictMode, ErrorBoundary, QueryClientProvider), with MSW answering getMarketData
// and getLiveQuote. The client module is mocked as in App.auth.test.jsx: a getter over `holder`, null for a build
// without cloud sign-in, otherwise the fake client of test/helpers/fakeSupabase.js. Fake timers run with
// shouldAdvanceTime from Friday 2026-09-25 at 11:00 ET, as in App.test.jsx. A test that fails an import silences
// console.error, where React reports what a boundary caught.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from './test/setup.js';
import { importGate, skipLazyPreload } from './test/lazy.js';
import { isOpenModal } from './test/standins.js';
import App from './App.jsx';
import ChunkBoundary from './components/ChunkBoundary.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import FlowChart from './components/FlowChart.jsx';
import GexChart from './components/GexChart.jsx';
import ChartsSkeleton from './components/dashboard/ChartsSkeleton.js';
import { ChunkLoadError, isChunkLoadError } from './lib/lazyWithPreload.js';
import { queryClient } from './lib/queryClient.js';
import { LocalStorageBackend, setBackend } from './lib/store.js';
import { fakeSupabase, sessionFor } from '../test/helpers/fakeSupabase.js';

skipLazyPreload();

const holder = vi.hoisted(() => ({ client: null }));
vi.mock('./lib/supabase.js', () => ({
  get supabase() { return holder.client; },
}));

const FN = 'http://localhost:3000/.netlify/functions';
const FRIDAY_11_ET = new Date('2026-09-25T15:00:00Z');
const U1 = 'user-1';
/** How the import of a chunk the browser could not fetch fails. */
const OFFLINE = 'Failed to fetch dynamically imported module: /assets/Part-1a2b3c.js';

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

/** The functions App reaches with no token and no research key: market data and the quote. */
function serveFunctions() {
  server.use(
    http.get(`${FN}/getMarketData`, ({ request }) => HttpResponse.json(marketData(tickerOf(request)))),
    http.get(`${FN}/getLiveQuote`, ({ request }) => HttpResponse.json(quote(tickerOf(request)))),
  );
}

/** getMarketData's replies held until the returned release() runs, so the market data loads meanwhile. */
function holdMarketData() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  server.use(http.get(`${FN}/getMarketData`, async ({ request }) => {
    await gate;
    return HttpResponse.json(marketData(tickerOf(request)));
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

/** Every TanStack request has been answered and applied, so no query result lands outside act() after this. */
const settled = () => waitFor(() => { expect(queryClient.isFetching()).toBe(0); }, { timeout: 5_000 });

/** Moves the fake clock on by `ms`, running what falls due inside act(). */
const after = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** App rendered and loaded: the quote is in the Header, and every request has been answered and applied. */
async function renderLoaded() {
  const view = renderApp();
  await screen.findByText('$101.50', {}, { timeout: 5_000 });
  await settled();
  return view;
}

/** What `ui` renders on its own, as markup. */
function markupOf(ui) {
  const { container, unmount } = render(ui);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

/** The Charts section: its heading, which holds the toggle, then, while it is expanded, its content. */
const chartsSection = () => screen.getByRole('heading', { name: 'Charts' }).parentElement;
/** The expanded section's content: the panel, its skeleton or the failure card, in the section's frame. */
const chartsContent = () => screen.getByRole('region', { name: 'Charts' }).firstElementChild;

/** The dashboard around the Charts section, which the section's loading or failing leaves as it is. */
function expectTheRestOfTheDashboard() {
  expect(screen.getByLabelText('Open settings')).toBeVisible(); // the Header
  expect(screen.getByText('Premium Traded')).toBeVisible(); // the KPI cards
  expect(screen.getByRole('button', { name: 'Position Analysis' })).toBeVisible();
  expect(screen.getByText(/^Data from CBOE delayed quotes/)).toBeVisible(); // the footer
  expect(screen.getByLabelText('Open AI Co-Pilot')).toBeVisible(); // the chat toggle
  expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull(); // not the root ErrorBoundary
}

/** A part whose module could not be fetched. */
function Unloadable() {
  throw new ChunkLoadError(new TypeError(OFFLINE));
}

/** The card ChunkBoundary itself draws in a failed part's place, as markup: what every failure card App draws is. */
const boundaryCard = () => markupOf(<ChunkBoundary fallback={null}><Unloadable /></ChunkBoundary>);

/** The classes that place an element over the page: the layer must cover what the sync dialog covers. */
const placement = (element) => element.className.split(/\s+/).filter((name) => /^(fixed|inset-|z-)/.test(name));

/**
 * requestIdleCallback and cancelIdleCallback on window, where the idle preload looks first: each call is recorded,
 * as 'idle <handle>' and 'cancel <handle>', and no callback runs until run() calls those still scheduled.
 */
function stubIdle() {
  const calls = [];
  const scheduled = new Map();
  let handles = 0;
  vi.stubGlobal('requestIdleCallback', (callback) => {
    handles += 1;
    scheduled.set(handles, callback);
    calls.push(`idle ${handles}`);
    return handles;
  });
  vi.stubGlobal('cancelIdleCallback', (handle) => {
    scheduled.delete(handle);
    calls.push(`cancel ${handle}`);
  });
  return {
    calls: () => [...calls],
    run: () => {
      for (const callback of scheduled.values()) callback();
      scheduled.clear();
    },
  };
}

/** Makes `fakeSupabase(options)` the app's client: a build with cloud sign-in. Set before the render. */
const setClient = (options) => {
  holder.client = fakeSupabase(options);
  return holder.client;
};

/** Holds the client's session check until the returned release is called: a check still running. */
function holdSessionCheck(client) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const check = client.auth.getSession;
  client.auth.getSession = async () => {
    await held;
    return check();
  };
  return release;
}

/** An account's position row as the cloud holds it. */
const posRow = (userId, ticker, costBasis, shares) => ({
  user_id: userId, ticker, cost_basis: costBasis, shares, updated_at: '2026-09-20T00:00:00.000Z', deleted_at: null,
});

/** Signed in, with NVDA in this browser and AVGO and TSLA in the account: the sign-in's hydrate finds a conflict. */
function renderConflict() {
  localStorage.setItem('position_NVDA', JSON.stringify({ costBasis: 50, shares: 2 }));
  serveFunctions();
  const client = setClient({
    session: sessionFor(U1),
    tables: { positions: [posRow(U1, 'AVGO', 120, 10), posRow(U1, 'TSLA', 200, 1)] },
  });
  renderApp();
  return client;
}

/** The sync choice as it shows, loading, failed or loaded: the one dialog named for it. */
const syncDialog = () => screen.findByRole('dialog', { name: 'Sync your data' }, { timeout: 5_000 });

/**
 * An importGate holding this test's imports of the module at `path` (as seen from this file). resolve() and reject()
 * settle the next import inside act, once it has reached the gate: they wait for it outside act, so that a test whose
 * import never comes fails there, rather than leaving an act open that would break every test after it. release()
 * answers each import the test left held with the real module. Every one must be answered: an import held past its
 * test keeps Vitest 5's mocker inside the gate's factory, and the module's later imports then bypass the next test's
 * gate. App leaves some held on purpose (the preloads, the charts of a dashboard a test does not look at).
 */
function gateFor(path) {
  const gate = importGate();
  vi.doMock(path, gate.factory);
  let settled = 0;
  const settleNext = async (settle) => {
    await waitFor(() => { expect(gate.imports).toBeGreaterThan(settled); }, { timeout: 5_000 });
    settled += 1;
    await act(settle);
  };
  return {
    get imports() {
      return gate.imports;
    },
    resolve: (module) => settleNext(() => gate.resolve(module)),
    reject: (error) => settleNext(() => gate.reject(error)),
    async release() {
      await new Promise((resolve) => { setTimeout(resolve, 0); }); // an import reaches the factory a macrotask late
      while (settled < gate.imports) {
        settled += 1;
        await gate.resolve();
      }
    },
  };
}

let panel;
let login;
let sync;

describe('App: the parts it loads on demand', () => {
  beforeEach(async ({ onTestFinished }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FRIDAY_11_ET);
    panel = gateFor('./components/dashboard/ChartsPanel.js');
    login = gateFor('./components/LoginForm.jsx');
    sync = gateFor('./components/SyncChoice.jsx');
    // After the afterEach hooks: App is unmounted and every lazy reset, so an answered import changes nothing.
    onTestFinished(() => Promise.all([panel, login, sync].map((gate) => gate.release())));
    // vi.doMock registers its mocks at the next import, and two imports at that moment race (Vitest 5): the one that
    // takes the queue registers them while the other reads the registry first, finding the previous test's mock and
    // its gate. App starts two at once (the preloads), so one awaited import here registers all three first.
    await import('./test/lazy.js');
  });

  // The store's backend is module state that an unmount leaves in place: a fresh one disposes a test's
  // SupabaseBackend while App is still mounted (App.auth.test.jsx says why).
  afterEach(() => {
    holder.client = null;
    setBackend(new LocalStorageBackend());
    vi.useRealTimers();
  });

  describe('the charts', () => {
    it('shows the skeleton in the Charts section while the panel loads, and the rest of the dashboard; then the charts', async () => {
      const error = vi.spyOn(console, 'error');
      const skeleton = markupOf(<ChartsSkeleton />);
      serveFunctions();
      await renderLoaded();

      expect(chartsContent().innerHTML).toBe(skeleton);
      expect(panel.imports).toBe(1);
      expectTheRestOfTheDashboard();

      await panel.resolve();
      expect(within(chartsContent()).getByText('Gamma Exposure by Strike')).toBeInTheDocument();
      expect(within(chartsContent()).getByText('Net Premium Flow (30d)')).toBeInTheDocument();
      expect(panel.imports).toBe(1);
      expect(error).not.toHaveBeenCalled();
    }, 15_000);

    it('changes nothing on screen when the panel arrives while the market data still loads: the charts draw the skeleton', async () => {
      const error = vi.spyOn(console, 'error');
      const skeleton = markupOf(<ChartsSkeleton />);
      serveFunctions();
      const release = holdMarketData();
      renderApp();
      await screen.findByText('$101.50', {}, { timeout: 5_000 }); // the Header is up; the market data is held
      expect(chartsContent().innerHTML).toBe(skeleton);

      await panel.resolve();
      expect(chartsContent().innerHTML).toBe(skeleton);

      release();
      expect(await within(chartsContent()).findByText('Gamma Exposure by Strike', {}, { timeout: 5_000 })).toBeInTheDocument();
      await settled();
      expect(error).not.toHaveBeenCalled();
    }, 15_000);

    it('draws each skeleton card as GexChart and FlowChart draw theirs while the market data loads', () => {
      const { container } = render(<ChartsSkeleton />);
      const [first, second] = container.firstChild.children;
      expect(first.outerHTML).toBe(markupOf(<GexChart loading />));
      expect(second.outerHTML).toBe(markupOf(<FlowChart loading />));
    });

    it('never asks for the panel while the section is collapsed, the idle preload included; expanding it does', async () => {
      const error = vi.spyOn(console, 'error');
      localStorage.setItem('section_charts', 'false');
      const idle = stubIdle();
      const skeleton = markupOf(<ChartsSkeleton />);
      serveFunctions();
      await renderLoaded();
      expect(chartsSection().children).toHaveLength(1); // the toggle alone

      idle.run();
      await after(50); // a mocked import reaches its factory a macrotask after it is asked for
      expect(panel.imports).toBe(0);

      fireEvent.click(screen.getByRole('button', { name: 'Charts' }));
      expect(chartsContent().innerHTML).toBe(skeleton);
      await panel.resolve();
      expect(within(chartsContent()).getByText('Gamma Exposure by Strike')).toBeInTheDocument();
      expect(panel.imports).toBe(1);
      expect(error).not.toHaveBeenCalled();
    }, 15_000);

    it("leaves the boundary's card in the section when the panel cannot load, the rest of the dashboard in place; Try again loads it", async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const skeleton = markupOf(<ChartsSkeleton />);
      serveFunctions();
      await renderLoaded();

      await panel.reject(new TypeError(OFFLINE));
      const card = within(chartsContent()).getByRole('alert');
      expect(card).toHaveTextContent('This part of the dashboard could not load.');
      expect([...chartsContent().children]).toEqual([card]);
      expectTheRestOfTheDashboard();
      expect(error.mock.calls.flat().some(isChunkLoadError)).toBe(true); // React's report of what the boundary caught
      expect(error).not.toHaveBeenCalledWith('ErrorBoundary caught:', expect.anything(), expect.anything());

      fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
      expect(chartsContent().innerHTML).toBe(skeleton);
      await panel.resolve();
      expect(within(chartsContent()).getByText('Gamma Exposure by Strike')).toBeInTheDocument();
      expect(panel.imports).toBe(2);
    }, 15_000);
  });

  describe('the sign-in form', () => {
    it("is fetched with the sync choice while the session is checked, and the check's spinner stays until it is in; then the form", async () => {
      const error = vi.spyOn(console, 'error');
      serveFunctions();
      const release = holdSessionCheck(setClient());
      const { container } = renderApp();
      await after(50); // the check has not answered
      const checking = container.innerHTML;
      expect(container.querySelector('.animate-spin')).not.toBeNull();
      expect(container.textContent).toBe('');
      expect([login.imports, sync.imports]).toEqual([1, 1]);

      release();
      await after(50); // no session: the sign-in screen, whose form is still loading
      expect(container.innerHTML).toBe(checking);

      await login.resolve();
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue without signing in' })).toBeInTheDocument();
      expect([login.imports, sync.imports]).toEqual([1, 1]);
      expect(error).not.toHaveBeenCalled();
    });

    it("leaves the boundary's card centred on the sign-in background when the form cannot load; Try again loads it", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const card = boundaryCard();
      serveFunctions();
      setClient();
      const { container } = renderApp();
      await after(50); // the check has answered: the sign-in screen waits on the form's import

      await login.reject(new TypeError(OFFLINE));
      const alert = screen.getByRole('alert');
      expect(alert.outerHTML).toBe(card);
      // Where the form's column would be, on the sign-in screen's own full-height background.
      expect(alert.parentElement).toHaveClass('w-full', 'max-w-sm');
      expect(alert.parentElement.parentElement).toBe(container.firstChild);
      expect(container.firstChild).toHaveClass('min-h-screen', 'bg-[#0a0e17]', 'flex', 'items-center', 'justify-center');
      expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull();

      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(container.querySelector('.animate-spin')).not.toBeNull();
      expect(container.textContent).toBe('');
      await login.resolve();
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(login.imports).toBe(2);
    });
  });

  // Nothing may be edited underneath while a conflict waits for a choice, so the layer that stands in for the dialog
  // blocks the page as the dialog does.
  describe('the sync choice', () => {
    it('stands in as a modal layer over the dashboard while the dialog loads, then shows the dialog; nothing is written', async () => {
      const error = vi.spyOn(console, 'error');
      const client = renderConflict();
      const layer = await syncDialog();
      expect(layer).toBeInstanceOf(HTMLDialogElement);
      expect(isOpenModal(layer)).toBe(true);
      expect(layer).toHaveAttribute('aria-busy', 'true');
      expect(layer).toHaveFocus();
      expect(layer.querySelector('.animate-spin')).not.toBeNull();
      expect(within(layer).queryAllByRole('button')).toEqual([]);
      await after(400);
      expect(client.upserts).toEqual([]);
      expect(sync.imports).toBe(1); // the import started while the session was checked

      await sync.resolve();
      const dialog = screen.getByRole('dialog', { name: 'Sync your data' });
      expect(dialog).not.toBe(layer);
      expect(placement(layer)).toEqual(placement(dialog));
      expect(dialog).toHaveTextContent('This browser: 1 position · 0 chats · 0 settings');
      expect(within(dialog).getByRole('button', { name: /^Merge/ })).toHaveFocus();
      expect(client.upserts).toEqual([]);
      expect(sync.imports).toBe(1);
      expect(error).not.toHaveBeenCalled();
    }, 15_000);

    it("keeps the layer up with the boundary's card in it when the dialog cannot load; Try again loads the dialog", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const card = boundaryCard();
      const client = renderConflict();
      const loading = await syncDialog();

      await sync.reject(new TypeError(OFFLINE));
      const layer = screen.getByRole('dialog', { name: 'Sync your data' });
      expect(layer).toBeInstanceOf(HTMLDialogElement);
      expect(isOpenModal(layer)).toBe(true);
      expect(layer).not.toHaveAttribute('aria-busy');
      expect(placement(layer)).toEqual(placement(loading));
      expect(layer).toHaveFocus();
      expect(within(layer).getByRole('alert').outerHTML).toBe(card);
      expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull();

      fireEvent.click(within(layer).getByRole('button', { name: 'Try again' }));
      expect(screen.getByRole('dialog', { name: 'Sync your data' })).toHaveAttribute('aria-busy', 'true');
      await sync.resolve();
      const dialog = screen.getByRole('dialog', { name: 'Sync your data' });
      expect(within(dialog).getByRole('button', { name: /^Merge/ })).toHaveFocus();
      expect(sync.imports).toBe(2);
      expect(client.upserts).toEqual([]);
    }, 15_000);
  });

  it('requests neither the sign-in form nor the sync choice without cloud sign-in, the idle preload included', async () => {
    const error = vi.spyOn(console, 'error');
    const idle = stubIdle();
    serveFunctions();
    await renderLoaded();

    idle.run();
    await after(50);
    expect([login.imports, sync.imports]).toEqual([0, 0]);
    expect(error).not.toHaveBeenCalled();
  }, 15_000);

  describe('the idle preload', () => {
    it('is scheduled once the dashboard shows and cancelled when App unmounts', async () => {
      const idle = stubIdle();
      serveFunctions();
      const view = await renderLoaded();
      // StrictMode runs App's effects twice as it mounts: the first schedule is cancelled at once, and the second
      // stands through every render the load caused.
      expect(idle.calls()).toEqual(['idle 1', 'cancel 1', 'idle 2']);

      view.unmount();
      expect(idle.calls()).toEqual(['idle 1', 'cancel 1', 'idle 2', 'cancel 2']);
    }, 15_000);

    it('waits for the dashboard on a build with cloud sign-in: nothing while the session is checked or on the sign-in screen', async () => {
      const error = vi.spyOn(console, 'error');
      const idle = stubIdle();
      serveFunctions();
      const release = holdSessionCheck(setClient());
      renderApp();
      await after(50);
      expect(idle.calls()).toEqual([]); // the session is checked

      release();
      await after(50);
      await login.resolve();
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(idle.calls()).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Continue without signing in' }));
      expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
      expect(idle.calls()).toEqual(['idle 1']);
      await settled();
      expect(error).not.toHaveBeenCalled();
    }, 15_000);
  });
});
