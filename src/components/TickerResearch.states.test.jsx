// src/components/TickerResearch.states.test.jsx — the research panel's states told apart: off (no access token, no
// Finnhub key), the first load, a failed load, an empty answer, a partial answer (context.errors), a failed refresh
// over research already shown, and loaded; the one status region that carries the failure and partial lines; Retry
// (present only where a retry can help, one refresh per press, aria-disabled while a request runs, focus kept and,
// once it leaves, handed to the section's toggle). Each state is built from the two contexts' values and the stored
// key, as App provides them. TickerResearch.test.jsx holds what the loaded leaves show.
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TickerResearch from './TickerResearch.jsx';
import { setPreference } from '../lib/store.js';
import { withContexts } from '../test/contexts.jsx';
import { expectNoAxeViolations } from '../test/a11y.js';

/** A complete getTickerContext body: every TickerContext field (types/market.ts), empty unless overridden. */
const context = (overrides = {}) => ({
  ticker: 'AVGO', news: [], earnings: null, analysts: null, technicals: null, fundamentals: null, marketNews: [],
  marketQuotes: null, errors: {}, ...overrides,
});

/** One company-news item and one market headline: research to show. */
const someNews = () => [{
  headline: 'Broadcom extends its AI deal', summary: '', source: 'Reuters', url: 'https://example.com/n1',
  datetime: null, sentiment: null,
}];
const someHeadlines = () => [{ headline: 'Stocks rally', source: 'Reuters', url: 'https://example.com/m1', datetime: null }];
const loaded = (overrides = {}) => context({ news: someNews(), marketNews: someHeadlines(), ...overrides });

/**
 * The panel as App provides it. `access`: 'key' stores a Finnhub key (as Settings does), 'token' makes the visitor an
 * access-token holder, 'none' neither. `market` overrides the market context.
 */
const panel = ({ market = {}, access = 'key' } = {}) => withContexts(
  <TickerResearch />,
  { market: { ticker: 'AVGO', data: { spotPrice: 200 }, ...market }, auth: { isPremium: access === 'token' } },
);
function renderPanel({ access = 'key', ...rest } = {}) {
  if (access === 'key') setPreference('data_finnhub_key', 'fh-stored');
  return render(panel({ access, ...rest }));
}

const OFF = 'Research is off. Add a Finnhub API key in Settings, or activate an access token, to see news, earnings '
  + 'and analyst data.';
const EMPTY = 'No news, earnings or analyst data for AVGO right now.';
const failed = (reason) => `Research could not be loaded: ${reason}.`;
const refreshFailed = (reason) => `Research could not be refreshed: ${reason}. Showing the last research loaded.`;
const partial = (list) => `Some sources did not answer: ${list}.`;
const notInPlan = (list) => `Not available on the current data plan: ${list}.`;
const OLD_KEY_ADVICE = /Add a Finnhub API key in Settings to see/;
const CAPTIONS = ['News', 'Earnings', 'Analyst Consensus', 'Market Overview', 'Market Headlines'];

const captions = () => screen.queryAllByText(/^(News|Earnings|Analyst Consensus|Market Overview|Market Headlines)$/)
  .map((el) => el.textContent);
const toggle = () => screen.getByRole('button', { name: /^Research/ });
const retry = () => screen.queryByRole('button', { name: /^Retry/ });
/** The panel's own status region: the first status in the section (a skeleton's come after it, inside the leaves). */
const statusRegion = () => within(screen.getByRole('region', { name: 'Research' })).getAllByRole('status')[0];
/** Every sentence that names a state, so a test can say which of them are absent. */
const STATE_TEXT = /Research is off|No news, earnings or analyst data for|could not be loaded|could not be refreshed|did not answer|current data plan/;
const stateTexts = () => screen.queryAllByText(STATE_TEXT).map((el) => el.textContent);

describe('TickerResearch states', () => {
  it('Off: with no access token and no Finnhub key it says how to turn research on, and offers no Retry', async () => {
    const { container } = renderPanel({ access: 'none' });
    expect(screen.getByText(OFF)).toBeInTheDocument();
    expect(stateTexts()).toEqual([OFF]);
    expect(retry()).toBeNull();
    expect(statusRegion()).toHaveTextContent(/^$/);
    await expectNoAxeViolations(container);
  });

  it('Empty: a key holder whose answer came back empty is told there is nothing for the ticker, not to add a key', async () => {
    const { container, rerender } = renderPanel({ market: { tickerContext: context() } });
    expect(stateTexts()).toEqual([EMPTY]);
    expect(screen.queryByText(OLD_KEY_ADVICE)).not.toBeInTheDocument();
    expect(retry()).toBeNull();
    await expectNoAxeViolations(container);

    // No answer held and nothing in flight reads the same.
    rerender(panel({ market: { tickerContext: null } }));
    expect(stateTexts()).toEqual([EMPTY]);
  });

  it('Empty: an access-token holder, with no key, is never asked for one', () => {
    renderPanel({ access: 'token', market: { tickerContext: context() } });
    expect(stateTexts()).toEqual([EMPTY]);
    expect(screen.queryByText(/Finnhub/)).not.toBeInTheDocument();
  });

  it('First load: the badge and an empty body, no sentence and no Retry, the status region empty', async () => {
    const { container } = renderPanel({ market: { contextLoading: true } });
    expect(within(toggle()).getByText('Loading...')).toBeInTheDocument();
    expect(stateTexts()).toEqual([]);
    expect(captions()).toEqual([]);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
    expect(retry()).toBeNull();
    expect(statusRegion()).toHaveTextContent(/^$/);
    expect(statusRegion()).toHaveClass('sr-only');
    await expectNoAxeViolations(container);
  });

  it('Failed: a key holder whose request failed is told why, with Retry, and neither the off nor the empty sentence', async () => {
    const { container } = renderPanel({ market: { contextError: 'Finnhub rejected the API key' } });
    expect(statusRegion()).toHaveTextContent(failed('Finnhub rejected the API key'));
    expect(statusRegion()).not.toHaveClass('sr-only');
    expect(stateTexts()).toEqual([failed('Finnhub rejected the API key')]);
    expect(screen.queryByText(OLD_KEY_ADVICE)).not.toBeInTheDocument();
    expect(retry()).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('Failed: a reason that ends its own sentence is not given a second full stop', () => {
    renderPanel({ access: 'token', market: { contextError: 'Too many requests.' } });
    expect(statusRegion()).toHaveTextContent(/^Research could not be loaded: Too many requests\.$/);
  });

  it('Partial: what arrived shows, with one line naming the sources that did not answer, and Retry', async () => {
    const { container } = renderPanel({
      market: { tickerContext: loaded({ errors: { priceTarget: 'HTTP 500', news: 'timeout' } }) },
    });
    expect(captions()).toEqual(CAPTIONS);
    expect(statusRegion()).toHaveTextContent(partial('company news and price targets'));
    expect(stateTexts()).toEqual([partial('company news and price targets')]);
    expect(retry()).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('Partial: every source the function can name has a word a user knows, and the line lists exactly the failed', () => {
    const words = {
      news: 'company news',
      marketNews: 'market headlines',
      marketQuotes: 'market indices',
      earnings: 'earnings results',
      earningsCalendar: 'the earnings calendar',
      recommendation: 'analyst ratings',
      priceTarget: 'price targets',
      metrics: 'fundamentals',
      candles: 'price history',
    };
    const { rerender } = renderPanel({ market: { tickerContext: loaded() } });
    for (const [section, word] of Object.entries(words)) {
      rerender(panel({ market: { tickerContext: loaded({ errors: { [section]: 'timeout' } }) } }));
      expect(statusRegion()).toHaveTextContent(new RegExp(`^${partial(word).replace('.', '\\.')}$`));
    }
    rerender(panel({ market: { tickerContext: loaded({ errors: { news: 'error', metrics: 'HTTP 502', candles: 'timeout' } }) } }));
    expect(statusRegion()).toHaveTextContent(/^Some sources did not answer: company news, fundamentals, and price history\.$/);
  });

  it('Partial: a source the data plan does not include is said apart, and alone earns no Retry', () => {
    const { rerender } = renderPanel({ market: { tickerContext: loaded({ errors: { candles: 'HTTP 403' } }) } });
    expect(statusRegion()).toHaveTextContent(/^Not available on the current data plan: price history\.$/);
    expect(retry()).toBeNull();

    rerender(panel({ market: { tickerContext: loaded({ errors: { candles: 'HTTP 403', news: 'timeout' } }) } }));
    expect(stateTexts()).toEqual([partial('company news'), notInPlan('price history')]);
    expect(retry()).toBeInTheDocument();
  });

  it('Partial: nothing to show but some sources failed: the line, then the empty sentence, with Retry', () => {
    renderPanel({ market: { tickerContext: context({ errors: { news: 'timeout' } }) } });
    expect(stateTexts()).toEqual([partial('company news'), EMPTY]);
    expect(retry()).toBeInTheDocument();
  });

  it('Refresh failed: the research stays, with one line that the refresh failed and why, and Retry', async () => {
    const { container } = renderPanel({ market: { tickerContext: loaded(), contextError: 'Network error: Failed to fetch' } });
    expect(captions()).toEqual(CAPTIONS);
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(stateTexts()).toEqual([refreshFailed('Network error: Failed to fetch')]);
    expect(retry()).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('Refresh failed over a partial answer: both lines', () => {
    renderPanel({
      market: { tickerContext: loaded({ errors: { recommendation: 'timeout' } }), contextError: 'Ticker context unavailable for AVGO' },
    });
    expect(stateTexts()).toEqual([refreshFailed('Ticker context unavailable for AVGO'), partial('analyst ratings')]);
  });

  it('Pin: Loaded renders the leaves it rendered before, with no state sentence and no Retry', async () => {
    const { container } = renderPanel({ market: { tickerContext: loaded() } });
    expect(captions()).toEqual(CAPTIONS);
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(stateTexts()).toEqual([]);
    expect(retry()).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('a loaded answer with no company news says so, with no advice to add a key', () => {
    renderPanel({ market: { tickerContext: context({ earnings: { date: null, epsEstimate: null, epsActual: null,
      revenueEstimate: null, revenueActual: null, quarter: null, year: null, surprise: null } }) } });
    expect(screen.getByText('No recent news available.')).toBeInTheDocument();
    expect(screen.queryByText(/Finnhub/)).not.toBeInTheDocument();
  });

  it('the status region is the same node, sr-only while empty, across a failure arriving and clearing', () => {
    const { rerender } = renderPanel({ market: { tickerContext: loaded() } });
    const region = statusRegion();
    expect(region).toHaveTextContent(/^$/);
    expect(region).toHaveClass('sr-only');

    rerender(panel({ market: { tickerContext: loaded(), contextError: 'timeout' } }));
    expect(statusRegion()).toBe(region);
    expect(region).toHaveTextContent(refreshFailed('timeout'));
    expect(region).not.toHaveClass('sr-only');

    rerender(panel({ market: { tickerContext: loaded({ errors: { news: 'timeout' } }) } }));
    expect(statusRegion()).toBe(region);
    expect(region).toHaveTextContent(partial('company news'));

    rerender(panel({ market: { tickerContext: loaded() } }));
    expect(statusRegion()).toBe(region);
    expect(region).toHaveTextContent(/^$/);
    expect(region).toHaveClass('sr-only');

    // From nothing to show to a failed load and back to research: still the one node.
    rerender(panel({ market: { tickerContext: null, contextError: 'timeout' } }));
    expect(statusRegion()).toBe(region);
    expect(region).toHaveTextContent(failed('timeout'));
  });

  it('Retry lives outside the status region, is named "Retry research" and is at least 24 px by its classes', () => {
    renderPanel({ market: { contextError: 'timeout' } });
    expect(retry()).toHaveAccessibleName('Retry research');
    expect(statusRegion()).not.toContainElement(retry());
    expect(retry()).toHaveClass('min-h-6', 'min-w-6');
  });

  it('Retry calls refreshContext once per press, by pointer and by keyboard', async () => {
    const user = userEvent.setup();
    const refreshContext = vi.fn();
    renderPanel({ market: { contextError: 'timeout', refreshContext } });
    await user.click(retry());
    expect(refreshContext).toHaveBeenCalledTimes(1);
    retry().focus();
    await user.keyboard('{Enter}');
    expect(refreshContext).toHaveBeenCalledTimes(2);
    await user.keyboard(' ');
    expect(refreshContext).toHaveBeenCalledTimes(3);
  });

  it('while a pressed retry runs Retry is aria-disabled, never disabled, ignores a press, keeps the focus, and the region says "Retrying..."', async () => {
    // App keeps the failed first load's message (useLastFailure) while the retry's request runs: the hook alone clears
    // its error at that request's start, since its query holds no data.
    const user = userEvent.setup();
    const refreshContext = vi.fn();
    const { rerender } = renderPanel({ market: { contextError: 'timeout', refreshContext } });
    await user.click(retry());
    expect(retry()).toHaveFocus();

    rerender(panel({ market: { contextError: 'timeout', refreshContext, contextLoading: true } }));
    expect(retry()).toHaveFocus();
    expect(retry()).toHaveAttribute('aria-disabled', 'true');
    expect(retry()).not.toBeDisabled();
    expect(retry()).toHaveAccessibleName(/^Retry/);
    expect(statusRegion()).toHaveTextContent(/^Retrying\.\.\.$/);
    expect(statusRegion()).not.toHaveClass('sr-only');
    expect(stateTexts()).toEqual([]); // neither the empty sentence nor the failure while it runs
    await user.click(retry());
    await user.keyboard('{Enter}');
    expect(refreshContext).toHaveBeenCalledTimes(1);
    expect(retry()).toHaveFocus();

    // The retry failed again: the button is back in service, focus still on it, the failure said again.
    rerender(panel({ market: { contextError: 'timeout', refreshContext } }));
    expect(retry()).toHaveFocus();
    expect(retry()).not.toHaveAttribute('aria-disabled');
    expect(statusRegion()).toHaveTextContent(failed('timeout'));
  });

  it('a retry that succeeds hands the focus to the section toggle, never to the page body', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel({ market: { contextError: 'timeout' } });
    await user.click(retry());
    rerender(panel({ market: { contextError: 'timeout', contextLoading: true } }));
    expect(retry()).toHaveFocus();

    await act(async () => { rerender(panel({ market: { tickerContext: loaded() } })); });
    expect(retry()).toBeNull();
    expect(toggle()).toHaveFocus();
    expect(statusRegion()).toHaveTextContent(/^Research loaded\.$/);
    expect(statusRegion()).toHaveClass('sr-only');
  });

  it('Pin: Retry leaving while the focus is elsewhere moves nothing', async () => {
    const { rerender } = renderPanel({ market: { contextError: 'timeout' } });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await act(async () => { rerender(panel({ market: { tickerContext: loaded() } })); });
    expect(outside).toHaveFocus();
    outside.remove();
  });

  // The header's "Loading..." is 10 px text in the muted colour. A pulse faded it to half strength and back, and
  // mid-fade it measured 3.93:1 in Chromium, under the 4.5:1 floor. jsdom computes no colour, so the class is asserted.
  it('the "Loading..." badge keeps its colour: no pulse fades the text under the contrast floor', () => {
    renderPanel({ market: { contextLoading: true } });
    expect(within(toggle()).getByText('Loading...')).not.toHaveClass('animate-pulse');
  });
});
