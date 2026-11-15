// src/components/dashboard/TickerSummary.failures.test.jsx — what the ticker row says when something failed, rendered
// bare (the row is a prop leaf). Each failure is a sentence in words under the row, the reason included, inside ONE
// role="status" region that is in the tree from the first render (empty and sr-only while there is nothing to say) and
// stays the same node; an identical failure arriving again changes nothing in it, so nothing is announced again. The
// failures are App's kept ones (useLastFailure), so a load under way never clears them here. Retry is a real button
// outside the region, named "Retry market data", shown only while there is a failure to retry: one onRetry per press;
// while the market data or the live quote loads it is aria-disabled (never disabled, which would drop focus), ignores
// a press and keeps focus; a press says "Retrying..." in the region while its load runs; when it leaves with focus, the
// focus goes to the row, not to the body. No information sits in a title attribute alone. App.surfaces.test.jsx drives
// the same row through the real hooks. Tailwind's classes do nothing under jsdom: where a test is about sr-only, the
// class is the evidence.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import TickerSummary from './TickerSummary.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

/** A CBOE payload as getMarketData sends it; the row reads its iv30 and totalOptionsCount. */
const payload = (over = {}) => ({
  ticker: 'AVGO', provider: 'cboe', delay: '15-min delayed', spotPrice: 100, priceChange: 1, priceChangePct: 1,
  kpis: {
    netPremium: 1, callPremium: 1, putPremium: 1, darkPoolPct: 30, maxPain: 100, putCallRatio: 0.8,
    maxPainExpiry: '2026-09-25', putCallOIRatio: 0.9, callVolume: 10, putVolume: 8, callOI: 20, putOI: 18,
  },
  gexByStrike: [], lastUpdated: '2026-09-25T14:59:30.000Z', flowHistory: [], fallbackReason: null,
  iv30: 31.4, lastTradeTime: null, totalOptionsCount: 420, expiries: [],
  ...over,
});

/** Demo data as generateMockData shapes it. */
const demo = payload({ provider: 'mock', delay: 'simulated', iv30: null, totalOptionsCount: 2468 });

const BASE = {
  ticker: 'AVGO', data: payload(), loading: false, usingMock: false, error: null, quoteError: null,
  quoteLoading: false, liveQuoteShown: false,
};

/** The row with nothing failed; `props` (and rerender's) override any of it. */
function renderRow(props = {}) {
  const ui = (next) => <TickerSummary {...BASE} onRetry={() => {}} {...next} />;
  const view = render(ui(props));
  return { ...view, rerender: (next) => view.rerender(ui(next)) };
}

const region = () => screen.getByRole('status');
const retry = () => screen.queryByRole('button', { name: /^Retry/ });

// The sentences, one wording per state.
const REFRESH = 'Options data could not be refreshed: Upstream down. The last data loaded is shown.';
const DEMO = 'Options data could not be loaded: Upstream down. Demo data is shown instead.';
const QUOTE = 'The live price could not be loaded: Yahoo is not answering. Prices come from the options snapshot.';
const QUOTE_KEPT = 'The live price could not be refreshed: Yahoo is not answering. The last live price is shown.';

describe('TickerSummary: failures in words, with Retry', () => {
  it.each([
    ['a refresh failed over real data', { error: 'Upstream down' }, REFRESH],
    ['demo data stands in, with the reason', { data: demo, usingMock: true, error: 'Upstream down' }, DEMO],
    ['the live quote failed, the snapshot price shown', { quoteError: 'Yahoo is not answering' }, QUOTE],
    ['the live quote failed, an older live price kept', { quoteError: 'Yahoo is not answering', liveQuoteShown: true }, QUOTE_KEPT],
    ['a refresh and the live quote failed at once', { error: 'Upstream down', quoteError: 'Yahoo is not answering' }, `${REFRESH} ${QUOTE}`],
    ['demo data and the live quote failed at once', { data: demo, usingMock: true, error: 'Upstream down', quoteError: 'Yahoo is not answering' }, `${DEMO} ${QUOTE}`],
  ])('%s: the sentence is visible text in the status region, with ONE Retry and no title', async (_label, props, text) => {
    const { container } = renderRow(props);
    expect(region()).toHaveTextContent(text, { normalizeWhitespace: true });
    expect(region().textContent).toBe(text);
    expect(region()).not.toHaveClass('sr-only');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(retry()).toBeInTheDocument();
    expect(region()).not.toContainElement(retry()); // outside the region: its name is not part of the status
    expect(container.querySelector('[title]')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('keeps DEMO DATA in demo mode, and says nothing more while the hook holds no reason', async () => {
    // useMarketData clears the error while a demo-mode ticker reloads; DEMO DATA stays.
    const { container } = renderRow({ data: demo, usingMock: true, error: null, loading: true });
    expect(screen.getByText('DEMO DATA')).toBeInTheDocument();
    expect(region().textContent).toBe('');
    expect(region()).toHaveClass('sr-only');
    expect(retry()).toHaveAttribute('aria-disabled', 'true'); // the reload is the retry under way
    await expectNoAxeViolations(container);
  });

  it('keeps the ERROR badge beside a failed refresh, with no title', () => {
    renderRow({ error: 'Upstream down' });
    expect(screen.getByText('ERROR')).not.toHaveAttribute('title');
  });

  it('fills and empties the same status node, which is in the tree, empty and sr-only, from the first render', async () => {
    const { container, rerender } = renderRow();
    const node = region();
    expect(node.textContent).toBe('');
    expect(node).toHaveClass('sr-only');
    expect(retry()).toBeNull();
    await expectNoAxeViolations(container);

    rerender({ error: 'Upstream down' });
    expect(region()).toBe(node);
    expect(node.textContent).toBe(REFRESH);

    rerender({ error: 'Upstream down', quoteError: 'Yahoo is not answering' });
    expect(region()).toBe(node);
    expect(node.textContent).toBe(`${REFRESH} ${QUOTE}`);

    rerender({});
    expect(region()).toBe(node);
    expect(node.textContent).toBe('');
    expect(node).toHaveClass('sr-only');
    expect(retry()).toBeNull();
  });

  it('changes nothing in the region when an identical failure arrives again', async () => {
    const { rerender } = renderRow({ error: 'Upstream down', quoteError: 'Yahoo is not answering' });
    const node = region();
    const records = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });

    // The next refresh fails the same way, through a foreground load and a silent one.
    rerender({ error: 'Upstream down', quoteError: 'Yahoo is not answering', loading: true });
    rerender({ error: `Upstream ${'down'}`, quoteError: 'Yahoo is not answering' });
    await act(async () => {}); // MutationObserver delivers in a microtask
    observer.disconnect();
    expect(records).toEqual([]);
    expect(region()).toBe(node);
  });

  it('calls onRetry once per press', () => {
    const onRetry = vi.fn();
    renderRow({ error: 'Upstream down', onRetry });
    fireEvent.click(retry());
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(retry());
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('during a foreground load Retry is aria-disabled, not disabled, ignores a press and keeps focus', () => {
    const onRetry = vi.fn();
    const { rerender } = renderRow({ error: 'Upstream down', onRetry });
    const button = retry();
    button.focus();
    expect(button).not.toHaveAttribute('aria-disabled');

    rerender({ error: 'Upstream down', onRetry, loading: true });
    expect(retry()).toBe(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleName(/^Retry/);
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    expect(button).toHaveFocus();

    rerender({ error: 'Upstream down', onRetry }); // it failed again
    expect(retry()).toBe(button);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('keeps Retry, focused and busy, through a live-quote retry that outlasts the market data, and says so', () => {
    const { rerender } = renderRow({ quoteError: 'Yahoo is not answering' });
    const button = retry();
    button.focus();
    fireEvent.click(button);

    // App's handleRefresh: both reload; App keeps the quote's failure while its request runs.
    rerender({ quoteError: 'Yahoo is not answering', loading: true, quoteLoading: true });
    expect(retry()).toBe(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    expect(region().textContent).toBe('Retrying...');
    expect(region()).not.toHaveClass('sr-only');

    rerender({ quoteError: 'Yahoo is not answering', quoteLoading: true }); // the market data landed first
    expect(retry()).toBe(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    expect(region().textContent).toBe('Retrying...');

    rerender({ quoteError: 'Yahoo is not answering' }); // the quote failed again
    expect(retry()).toBe(button);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(region().textContent).toBe(QUOTE);
  });

  it("the live quote's own attempt while none ever loaded keeps Retry busy and the sentence unchanged", () => {
    const onRetry = vi.fn();
    const { rerender } = renderRow({ quoteError: 'Yahoo is not answering', onRetry });
    const button = retry();
    button.focus();
    rerender({ quoteError: 'Yahoo is not answering', quoteLoading: true, onRetry });
    expect(retry()).toBe(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    expect(region().textContent).toBe(QUOTE); // nobody pressed: nothing new to say
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a retry that worked says "Market data loaded." in the same region, visually hidden', async () => {
    const { container, rerender } = renderRow({ error: 'Upstream down' });
    const node = region();
    fireEvent.click(retry());
    rerender({ error: 'Upstream down', loading: true });
    expect(node.textContent).toBe('Retrying...');
    await expectNoAxeViolations(container);
    rerender({});
    expect(region()).toBe(node);
    expect(node.textContent).toBe('Market data loaded.');
    expect(node).toHaveClass('sr-only');
    expect(retry()).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("Retry's accessible name is \"Retry market data\", starting with the word it shows", () => {
    renderRow({ error: 'Upstream down' });
    expect(retry()).toHaveAccessibleName('Retry market data');
    const hidden = retry().querySelector('.sr-only');
    expect(hidden.textContent).toBe('market data');
    const shown = retry().textContent.replace(hidden.textContent, '').trim();
    expect(shown).toBe('Retry');
    expect(retry()).toHaveAccessibleName(new RegExp(`^${shown}\\b`));
  });

  it('a switch to another ticker forgets a pressed Retry: the new ticker\'s load says nothing', () => {
    const { rerender } = renderRow({ error: 'Upstream down' });
    fireEvent.click(retry());
    rerender({ error: 'Upstream down', loading: true });
    expect(region().textContent).toBe('Retrying...');
    rerender({ ticker: 'NVDA', loading: true }); // App's kept failures are forgotten with the ticker
    expect(region().textContent).toBe('');
    expect(retry()).toBeNull();
  });

  it('when a retry succeeds Retry leaves, and the focus goes to the row, not to the body', () => {
    const { container, rerender } = renderRow({ error: 'Upstream down' });
    retry().focus();

    rerender({ error: 'Upstream down', loading: true });
    rerender({}); // success
    expect(retry()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(container.firstElementChild);
    expect(container.firstElementChild).toHaveAttribute('tabindex', '-1');
  });

  it('Pin: the row does not take the focus when a failure clears while Retry was not focused', () => {
    const { rerender } = renderRow({ error: 'Upstream down' });
    rerender({});
    expect(document.activeElement).toBe(document.body);
  });

  it('Pin: no Retry during a foreground load that follows no failure', () => {
    renderRow({ loading: true });
    expect(retry()).toBeNull();
  });

  it('Pin: all is well: the row is what it was, with no button and no visible sentence', () => {
    const { container } = renderRow();
    // The row is the element holding the ticker's group, on both trees.
    const row = screen.getByText('AVGO').parentElement.parentElement;
    expect(row.outerHTML).toBe(
      '<div class="flex items-center justify-between"><div class="flex items-center gap-3">'
      + '<span class="text-lg font-bold font-mono tracking-tight text-[var(--color-text-primary)]">AVGO</span>'
      + '<span class="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-purple-bg)] text-[var(--color-purple-text)] border border-[var(--color-purple)]/20 tabular-nums">IV30: 31.4%</span>'
      + '</div><span class="text-xs text-[var(--color-text-muted)] tabular-nums hidden sm:inline">420 contracts analyzed</span></div>',
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toBe('AVGOIV30: 31.4%420 contracts analyzed');
  });
});
