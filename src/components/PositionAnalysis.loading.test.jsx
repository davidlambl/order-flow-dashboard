// src/components/PositionAnalysis.loading.test.jsx — the position panel while a foreground load is under way (the
// first load, a ticker switch, a manual Refresh): the average-cost and shares inputs stay in the tree as the same DOM
// nodes, enabled, so focus and a value typed meanwhile survive the load; everything derived from the market data (the
// price, the P&L, the recommendation in either mode, the level bar and the reasons) gives way to skeleton blocks that
// say nothing to a screen reader, even while the previous load's data is still in the context. The loaded panel is
// pinned leaf by leaf here only once; PositionAnalysis.test.jsx pins the rest.
// The panel renders through a stateful host, as App's usePositionDraft holds the draft: an edit comes back as props.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PositionAnalysis from './PositionAnalysis.jsx';
import { computeRecommendation } from '../lib/recommend.js';
import { expectLabelledControls, expectNoAxeViolations } from '../test/a11y.js';
import { withContexts } from '../test/contexts.jsx';

// Fri 2026-09-25, 5:00 PM ET: both sessions closed, ten minutes after the snapshot, so nothing is stale.
const NOW = '2026-09-25T21:00:00Z';

beforeEach(() => {
  // Only Date is faked (useNow reads it); React, user-event and axe keep real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

const SPOT = 100;
const KPIS = { maxPain: 105, netPremium: 2e6, putCallRatio: 0.85 };
const GEX = [{ strike: 95, gex: 5e8 }];
const DATA = { spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX, lastUpdated: '2026-09-25T20:50:00Z', provider: 'cboe' };
const REC = computeRecommendation({ costBasis: 90, shares: 10, spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX });

/** A live quote 2 % above the snapshot while the options market is closed: dual mode once loaded. */
const DUAL_QUOTE = { current: 102, source: 'yahoo-post', timestamp: Date.parse('2026-09-25T20:58:00Z') };

/** The market context: the previous load's data stays in it while the next one runs, as it does in App. */
const market = (loading, extra = {}) => ({
  data: DATA, loading, marketOpen: false, optionsMarketOpen: false, ...extra,
});

/** Holds the draft as App's usePositionDraft does, and reports every onUpdate to the test's spy. */
function Host({ loading, onUpdate, initial = { costBasis: 90, shares: 10 }, extra }) {
  const [draft, setDraft] = useState(initial);
  const update = (costBasis, shares) => {
    onUpdate(costBasis, shares);
    setDraft({ costBasis, shares });
  };
  return withContexts(
    <PositionAnalysis costBasis={draft.costBasis} shares={draft.shares} onUpdate={update} />,
    { market: market(loading, extra) },
  );
}

const costInput = () => screen.getByRole('spinbutton', { name: 'Average cost per share' });
const sharesInput = () => screen.getByRole('spinbutton', { name: 'Number of shares' });

/** What the loaded single-mode panel shows of each leaf: the price, the P&L, the call, the levels, a reason. */
function expectLoadedSingle() {
  expect(screen.getByText('~15min delayed (CBOE)')).toBeInTheDocument(); // PriceDisplay
  expect(screen.getByText('Unrealized P&L')).toBeInTheDocument(); // PnLStat
  expect(screen.getByText(REC.signal)).toBeInTheDocument(); // RecommendationBadge
  expect(screen.getByText('Basis')).toBeInTheDocument(); // PriceLevelBar's legend
  expect(screen.getByText(REC.reasons[0])).toBeInTheDocument(); // ReasonList
}

/** Nothing derived from the market data is on screen: no price, P&L, call, level or reason, in either mode. */
function expectNothingDerived() {
  expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument(); // no price, P&L in dollars or level
  expect(screen.queryByText(/%/)).not.toBeInTheDocument(); // no P&L or change in percent
  expect(screen.queryByText(/delayed|^Spot \(|^Live|^Options snapshot/)).not.toBeInTheDocument();
  expect(screen.queryByText(/P&L/)).not.toBeInTheDocument();
  expect(screen.queryByText(REC.signal)).not.toBeInTheDocument();
  expect(screen.queryByText(/confidence$/)).not.toBeInTheDocument();
  expect(screen.queryByText('Basis')).not.toBeInTheDocument();
  expect(screen.queryByText(REC.reasons[0])).not.toBeInTheDocument();
  expect(screen.queryByText(/^Options market closed/)).not.toBeInTheDocument();
  expect(screen.queryByText('If Live Price Holds')).not.toBeInTheDocument();
}

describe('PositionAnalysis while loading', () => {
  it('keeps both inputs, enabled, as the same nodes across loading, loaded and loading again', () => {
    const onUpdate = vi.fn();
    const { rerender } = render(<Host loading onUpdate={onUpdate} />);
    const cost = costInput();
    const shares = sharesInput();
    expect(cost).toBeEnabled();
    expect(shares).toBeEnabled();
    expect(cost).toHaveValue(90);
    expect(shares).toHaveValue(10);

    rerender(<Host loading={false} onUpdate={onUpdate} />);
    expectLoadedSingle();
    expect(costInput()).toBe(cost);
    expect(sharesInput()).toBe(shares);

    rerender(<Host loading onUpdate={onUpdate} />);
    expect(costInput()).toBe(cost);
    expect(sharesInput()).toBe(shares);
    expect(cost).toBeEnabled();
    expect(shares).toBeEnabled();
  });

  it('sends a cost typed during the load with the shares, and the field keeps focus as the load ends', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const { rerender } = render(<Host loading onUpdate={onUpdate} initial={{ costBasis: null, shares: 10 }} />);

    await user.type(costInput(), '95');
    expect(onUpdate).toHaveBeenLastCalledWith(95, 10);
    expect(costInput()).toHaveFocus();

    rerender(<Host loading={false} onUpdate={onUpdate} initial={{ costBasis: null, shares: 10 }} />);
    expect(costInput()).toHaveFocus();
    expect(costInput()).toHaveValue(95);
    expect(screen.getByText('Unrealized P&L')).toBeInTheDocument(); // the loaded panel reads the typed basis

    await user.keyboard('1'); // no click: the key goes to the field that kept focus, after its last digit
    expect(onUpdate).toHaveBeenLastCalledWith(951, 10);
  });

  it('sends shares typed during the load with the basis, or null while there is none', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<Host loading onUpdate={onUpdate} initial={{ costBasis: null, shares: null }} />);

    await user.type(sharesInput(), '3');
    expect(onUpdate).toHaveBeenLastCalledWith(null, 3);

    await user.type(costInput(), '90');
    await user.type(sharesInput(), '0');
    expect(onUpdate).toHaveBeenLastCalledWith(90, 30);
  });

  it('Pin: shows no price, P&L, recommendation, level or reason in single mode, with a position stored', () => {
    const { rerender } = render(<Host loading={false} onUpdate={vi.fn()} />);
    expectLoadedSingle(); // the same props, loaded, show every one of them

    rerender(<Host loading onUpdate={vi.fn()} />);
    expectNothingDerived();
  });

  it('Pin: shows neither dual panel nor its banner while loading', () => {
    const { rerender } = render(<Host loading={false} onUpdate={vi.fn()} extra={{ liveQuote: DUAL_QUOTE }} />);
    expect(screen.getByText(/^Options market closed/)).toBeInTheDocument();
    expect(screen.getByText('P&L (Live)')).toBeInTheDocument();
    expect(screen.getByText('If Live Price Holds')).toBeInTheDocument();

    rerender(<Host loading onUpdate={vi.fn()} extra={{ liveQuote: DUAL_QUOTE }} />);
    expectNothingDerived();
  });

  it('draws its placeholders as decoration, the two inputs labelled, with nothing missing for axe', async () => {
    const { container } = render(<Host loading onUpdate={vi.fn()} />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
    const blocks = [...container.querySelectorAll('.skeleton')];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toHaveAttribute('aria-hidden', 'true');
      expect(block).not.toHaveAttribute('role');
      expect(block).toHaveTextContent('');
    }
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expectLabelledControls(container);
    await expectNoAxeViolations(container);
  });
});
