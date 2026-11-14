// src/components/Header.a11y.test.jsx — Header for a screen reader, the keyboard and a phone, rendered alone under the
// two app contexts as Header.test.jsx renders it. First the ticker search, which refuses on submit what every function
// would refuse (src/lib/ticker.ts mirrors the server's rule): the entry is not sent, the field is aria-invalid and keeps
// the focus, and one line (role="alert") under it is the field's description until the next keystroke. Then what a
// screen reader gets at every width: one h1, visually hidden below sm rather than display: none; the data source as a
// status in words, whose text changes only when the source does; the auto-refresh button named by its action and then
// the text it shows (WCAG 2.5.3, which axe's label-content-name-mismatch rule cannot judge under jsdom, so the name is
// asserted directly), its countdown ticking in the name with only the countdown leaf re-rendering; the earnings date as
// text. Last, axe and the label check once per state, and pins of what must not move: the tooltips and the price
// change's sign.
// Tailwind's classes do nothing under jsdom (src/test/a11y.js): where a test is about what a class hides or shows, the
// class is the evidence; what it does on screen is measured in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import Header from './Header.jsx';
import { useMarket } from '../contexts/MarketContext.js';
import { withContexts } from '../test/contexts.jsx';
import { expectLabelledControls, expectNoAxeViolations } from '../test/a11y.js';

// Header is the one caller of useMarket in these renders (its countdown leaf reads no context), so the calls count
// Header's renders. The implementation stays the real one.
vi.mock('../contexts/MarketContext.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarket: vi.fn(actual.useMarket) };
});

/** The market fields the auto-refresh toggle reads, as App provides them in the options session with real data. */
const market = { autoRefresh: true, optionsMarketOpen: true, usingMock: false, refreshMs: 60_000 };

/** Header under both providers: `over` is layered on `market`, `auth` on the free, signed-out defaults. */
const header = (over, auth) => withContexts(<Header onOpenSettings={() => {}} />, { market: { ...market, ...over }, auth });

/** The getMarketData fields Header reads, per source (types/market.ts pairs each provider with its delay). */
const CBOE = { provider: 'cboe', delay: '15-min delayed', fallbackReason: null, spotPrice: 100, lastUpdated: '2026-09-25T14:59:30.000Z' };
const TRADIER = { ...CBOE, provider: 'tradier', delay: 'real-time' };
const SANDBOX = { ...CBOE, provider: 'tradier-sandbox', delay: 'sandbox (delayed)' };
/** generateMockData's provider and delay, shown while usingMock. */
const MOCK = { ...CBOE, provider: 'mock', delay: 'simulated' };

/** The validation line, as written in Header.jsx. */
const TICKER_HINT = 'Use 1 to 10 letters or digits; a dot or a dash may follow the first, as in BRK.B or RDS-A.';

/** The ticker field; re-queried after every change, since a new ticker mounts a new field. */
const field = () => screen.getByRole('textbox', { name: 'Stock ticker symbol' });

/** Types `value` into the field (which upper-cases it, as a keystroke does) and submits the search. */
const submit = (value) => {
  fireEvent.change(field(), { target: { value } });
  fireEvent.submit(field().closest('form'));
};

/**
 * The text a screen reader reads from `el`'s subtree: its text without what aria-hidden or the hidden attribute takes
 * out of the tree, white space collapsed. Unlike textContent, it shows a value read twice.
 */
function spokenText(el) {
  const walk = (node) => [...node.childNodes].map((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.data;
    if (child.nodeType !== Node.ELEMENT_NODE || child.hidden || child.getAttribute('aria-hidden') === 'true') return '';
    return walk(child);
  }).join('');
  return walk(el).replace(/\s+/g, ' ').trim();
}

describe('Header: the ticker search', () => {
  it.each(['../x', 'TOOLONGTICKER', 'A B'])(
    'does not send %s: the field is aria-invalid, keeps the focus and is described by one line under it',
    (entry) => {
      const setTicker = vi.fn();
      render(header({ ticker: 'AVGO', setTicker }));
      field().focus();
      submit(entry);

      expect(setTicker).not.toHaveBeenCalled();
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(field()).toHaveAccessibleDescription(TICKER_HINT);
      expect(field()).toHaveFocus();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(TICKER_HINT);
      // The line belongs to the search: inside its form, and out of the flow (positioned under the header, so the
      // header's height and the buttons beside the field never move; jsdom has no layout, so the class stands in).
      expect(field().closest('form')).toContainElement(alert);
      expect(alert).toHaveClass('absolute', 'top-full');
    },
  );

  it('clears the line and the invalid state on the next keystroke', () => {
    render(header({ ticker: 'AVGO' }));
    submit('../x');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(field(), { target: { value: '../xy' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(field()).toHaveAccessibleDescription('');
  });

  it('drops the line when the ticker changes elsewhere: the field it belongs to remounts', () => {
    const setTicker = vi.fn();
    const { rerender } = render(header({ ticker: 'AVGO', setTicker }));
    submit('A B');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(header({ ticker: 'NVDA', setTicker }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field()).toHaveValue('NVDA');
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(setTicker).not.toHaveBeenCalled();
  });

  it('Pin: sends brk.b as BRK.B, RDS-A as typed and a padded entry trimmed, then lets go of the field', () => {
    const setTicker = vi.fn();
    render(header({ ticker: 'AVGO', setTicker }));
    for (const [entry, sent] of [['brk.b', 'BRK.B'], ['RDS-A', 'RDS-A'], ['  nvda  ', 'NVDA']]) {
      field().focus();
      submit(entry);
      expect(setTicker).toHaveBeenLastCalledWith(sent);
      expect(field()).not.toHaveFocus();
    }
    expect(setTicker).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('Pin: an empty or blank entry sends nothing and shows no line', () => {
    const setTicker = vi.fn();
    render(header({ ticker: 'AVGO', setTicker }));
    submit('');
    submit('   ');
    expect(setTicker).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid');
  });
});

describe('Header: what a screen reader gets at every width', () => {
  it('has exactly one h1, visually hidden below sm and never display: none', () => {
    render(header());
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveAccessibleName('Order Flow');
    // A `hidden` class on it or on an ancestor is display: none below sm, which takes the h1 out of the tree.
    expect(headings[0].closest('.hidden')).toBeNull();
    expect(headings[0].parentElement).toHaveClass('sr-only', 'sm:not-sr-only');
  });

  it.each([
    ['DEMO', 'on demo data', { usingMock: true, data: MOCK }, 'Data source: DEMO, simulated data'],
    ['LIVE', 'from Tradier', { data: TRADIER }, 'Data source: LIVE, Tradier, real-time'],
    ['SANDBOX', "from Tradier's sandbox", { data: SANDBOX }, 'Data source: SANDBOX, Tradier sandbox, delayed'],
    ['CBOE', 'from CBOE', { data: CBOE }, 'Data source: CBOE, 15-min delayed'],
    ['CBOE', 'from CBOE after a fallback', { data: { ...CBOE, fallbackReason: 'tradier-timeout' } },
      'Data source: CBOE, 15-min delayed, fallback: Tradier timed out'],
    ['CBOE', 'before anything has loaded', { data: null }, 'Data source: CBOE, delayed'],
  ])('names the data source as a status in words: %s %s', (label, _when, over, text) => {
    render(header(over));
    const status = screen.getByRole('status');
    expect(spokenText(status)).toBe(text);
    // The sentence is visually hidden at every width, never display: none; the label a mouse user sees (from sm up,
    // with the icon and the tooltip) is out of the tree, so the source is read once, and the tooltip names nothing.
    expect(within(status).getByText(text)).toHaveClass('sr-only');
    expect(within(status).getByText(text).closest('.hidden')).toBeNull();
    expect(within(status).getByText(label).closest('[aria-hidden="true"]')).not.toBeNull();
    expect(status).toHaveAccessibleName('');
  });

  it('leaves the status untouched on a refresh from the same source, and changes it in place when the source changes', () => {
    const { rerender } = render(header({ data: CBOE }));
    const status = screen.getByRole('status');
    const observer = new MutationObserver(() => {});
    observer.observe(status, { subtree: true, childList: true, characterData: true, attributes: true });

    // A background refresh: a new payload from the same source, with a new price and time.
    rerender(header({ data: { ...CBOE, spotPrice: 101.25, lastUpdated: '2026-09-25T15:00:30.000Z' } }));
    expect(observer.takeRecords().map((record) => record.type)).toEqual([]);

    rerender(header({ data: TRADIER }));
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toBe(status); // the same live region, so the change is announced
    expect(spokenText(status)).toBe('Data source: LIVE, Tradier, real-time');
    observer.disconnect();
  });

  it('gives the PRO or TRIAL badge its text at every width', () => {
    const { rerender } = render(header({}, { isPremium: true, tokenTier: 'pro', daysLeft: 30 }));
    expect(screen.getByText('PRO')).toHaveClass('sr-only', 'sm:not-sr-only');
    expect(screen.getByText('PRO').closest('.hidden')).toBeNull();
    rerender(header({}, { isPremium: true, tokenTier: 'trial', daysLeft: 9 }));
    expect(screen.getByText('TRIAL · 9d')).toHaveClass('sr-only', 'sm:not-sr-only');
  });
});

describe('Header: the auto-refresh button', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-25T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The toggle, found by the action its name starts with. */
  const toggle = (action) => screen.getByRole('button', { name: new RegExp(`^${action}`) });

  /** Move the fake clock inside act, so the countdown leaf's once-a-second tick fires there. */
  const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

  // Every row passes a deadline, so Header's own checks pick the text, as in Header.test.jsx.
  it.each([
    ['on, counting down', {}, 'Disable auto-refresh', '60s'],
    ['on, paused while the options market is closed', { optionsMarketOpen: false }, 'Disable auto-refresh', 'Paused'],
    ['off', { autoRefresh: false }, 'Enable auto-refresh', 'Auto'],
    ['on, with demo data', { usingMock: true }, 'Disable auto-refresh', 'Auto'],
  ])('is named by its action and then the text it shows: %s', (_state, over, action, shown) => {
    render(header({ nextRefreshAt: Date.now() + 60_000, ...over }));
    const button = toggle(action);
    expect(button.textContent).toBe(shown);
    expect(button).toHaveAccessibleName(`${action}, ${shown}`);
    expect(button).not.toHaveAttribute('aria-label');
    expect(button).not.toHaveAttribute('aria-pressed');
  });

  it('follows the countdown in its name while only the countdown leaf re-renders', () => {
    render(header({ nextRefreshAt: Date.now() + 60_000 }));
    const renders = useMarket.mock.calls.length;
    advance(5_000);
    expect(toggle('Disable auto-refresh')).toHaveAccessibleName('Disable auto-refresh, 55s');
    expect(useMarket.mock.calls.length).toBe(renders);
  });

  it('Pin: Header does not re-render while the countdown ticks', () => {
    render(header({ nextRefreshAt: Date.now() + 60_000 }));
    const renders = useMarket.mock.calls.length;
    expect(renders).toBeGreaterThan(0);
    for (let second = 1; second <= 5; second += 1) advance(1_000);
    expect(toggle('Disable auto-refresh').textContent).toBe('55s');
    expect(useMarket.mock.calls.length).toBe(renders);
  });
});

describe('Header: the price and the earnings badge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 13, 12)); // Tuesday 13 October 2026, local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A complete getTickerContext body (types/market.ts) whose only research is an earnings date. */
  const research = (date) => ({
    ticker: 'AVGO', news: [], analysts: null, technicals: null, fundamentals: null, marketNews: [], marketQuotes: null,
    errors: {},
    earnings: {
      date, epsEstimate: null, epsActual: null, revenueEstimate: null, revenueActual: null, quarter: null, year: null,
      surprise: null,
    },
  });

  it('Pin: the price change keeps its sign, down as well as up', () => {
    const { rerender } = render(header({ data: { spotPrice: 100 }, liveQuote: { current: 98.8, changePercent: -1.2 } }));
    expect(screen.getByText('-1.20%')).toBeInTheDocument();
    rerender(header({ data: { spotPrice: 100 }, liveQuote: { current: 101.2, changePercent: 1.2 } }));
    expect(screen.getByText('+1.20%')).toBeInTheDocument();
  });

  it('carries the earnings date as text inside the badge, not in its tooltip alone', () => {
    render(header({ tickerContext: research('2026-10-15') }));
    // The badge is the rounded pill; below lg it is display: none, and the date with it.
    const badge = screen.getByTitle('Earnings: 2026-10-15').closest('.rounded-full');
    expect(badge).toHaveTextContent('Earnings in 2d, on Thursday, October 15');
  });
});

describe('Header: tooltips', () => {
  it.each([
    ['on demo data', { usingMock: true, data: MOCK }, 'Using demo data'],
    ['from Tradier', { data: TRADIER }, 'tradier — real-time'],
    ["from Tradier's sandbox", { data: SANDBOX }, 'tradier-sandbox — sandbox (delayed)'],
    ['from CBOE', { data: CBOE }, 'cboe — 15-min delayed'],
    ['from CBOE after a fallback', { data: { ...CBOE, fallbackReason: 'tradier-timeout' } },
      'cboe — 15-min delayed · fallback: Tradier timed out'],
    ['before anything has loaded', { data: null }, 'CBOE — delayed'],
  ])('Pin: the data source keeps its tooltip %s', (_when, over, title) => {
    render(header(over));
    expect(screen.getByTitle(title)).toBeInTheDocument();
  });

  it('Pin: the sign-out button keeps its tooltip', () => {
    render(header({}, { signedIn: true }));
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveAttribute('title', 'Sign out');
  });
});

// One axe run and one label check per state. axe runs under real timers here (src/test/a11y.js).
describe('Header: axe and labels, once per state', () => {
  it.each([
    ['on demo data', { usingMock: true, data: MOCK }, undefined],
    ['on live data', { data: TRADIER }, undefined],
    ['signed in, with a premium token', { data: CBOE }, { isPremium: true, tokenTier: 'pro', daysLeft: 30, signedIn: true }],
  ])('Pin: no axe violation and every control labelled %s', async (_state, over, auth) => {
    const { container } = render(header(over, auth));
    await expectNoAxeViolations(container, { bestPractices: true });
    expectLabelledControls(container);
  });

  it('no axe violation and every control labelled with the validation line showing', async () => {
    const { container } = render(header({ data: CBOE }, { isPremium: true, tokenTier: 'pro', daysLeft: 30, signedIn: true }));
    submit('../x');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await expectNoAxeViolations(container, { bestPractices: true });
    expectLabelledControls(container);
  });
});
