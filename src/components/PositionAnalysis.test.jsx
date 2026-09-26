// src/components/PositionAnalysis.test.jsx — the position panel: unrealised P&L, the recommendation badge and its
// reasons, the price-level legend, dual mode (the live price has moved while the options market is closed), the
// staleness and price-source badges, and the average-cost / shares inputs. Phase 5 splits the component into
// components/position/*; these tests render the default export and assert only what it shows and sends, so they
// should pass unchanged across that decomposition.
//
// Not covered here; tracked separately: typing shares while the cost basis is empty. handleSharesChange sends
// `costBasisNum ?? null` with costBasisNum = Number(costBasis), which is never null or undefined, so a null basis
// goes out as 0 (an undefined one as NaN) instead of null.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PositionAnalysis from './PositionAnalysis.jsx';
import { computeRecommendation } from '../lib/recommend.js';
import { GAP_DUAL_REC_THRESHOLD_PCT } from '../../shared/thresholds.js';

// The staleness badge formats with toLocaleTimeString / toLocaleString in the process time zone. Vitest moves
// vi.hoisted above the imports, so the whole file runs on Eastern Time (2026-09-25 is EDT, UTC-4).
const ORIGINAL_TZ = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  return original;
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// Fri 2026-09-25, 5:00 PM ET: after the options close (4:15 PM), an hour after the default snapshot.
const NOW = '2026-09-25T21:00:00Z';

beforeEach(() => {
  // Only Date is faked (useNow reads it); React, user-event and useNow's interval keep real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

const SPOT = 100;
const KPIS = { maxPain: 100, netPremium: 2e6, putCallRatio: 0.85 };
const GEX = [{ strike: 95, gex: 5e8 }];
const QUOTE_TIME = Date.parse('2026-09-25T20:58:00Z'); // two minutes before NOW

function renderPanel(overrides = {}) {
  const props = {
    costBasis: 90,
    shares: 10,
    spotPrice: SPOT,
    kpis: KPIS,
    gexByStrike: GEX,
    lastUpdated: '2026-09-25T20:00:00Z', // 4:00 PM ET
    optionsMarketOpen: false,
    marketOpen: false,
    dataProvider: 'cboe',
    onUpdate: vi.fn(),
    loading: false,
    ...overrides,
  };
  return { ...render(<PositionAnalysis {...props} />), props };
}

/** A live quote at `current` from `source`, stamped two minutes before NOW. */
const quote = (current, source) => ({ current, source, timestamp: QUOTE_TIME });

/** How far (percent) a live price is from the options snapshot spot, as dual mode measures it. */
const gapPct = (live) => Math.abs(((live - SPOT) / SPOT) * 100);

/** Single mode: one P&L and the price-level legend; neither the dual-mode banner nor its panels. */
function expectSingleMode() {
  expect(screen.getAllByText('Unrealized P&L')).toHaveLength(1);
  expect(screen.getByText('Basis')).toBeInTheDocument();
  expect(screen.queryByText(/^Options market closed/)).not.toBeInTheDocument();
  expect(screen.queryByText('If Live Price Holds')).not.toBeInTheDocument();
}

describe('PositionAnalysis', () => {
  it('shows three skeleton blocks and no inputs while loading', () => {
    const { container } = renderPanel({ loading: true });
    expect(container.querySelectorAll('.skeleton')).toHaveLength(3);
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryByText('Unrealized P&L')).not.toBeInTheDocument();
  });

  describe('single mode', () => {
    it('shows the unrealised P&L in percent and dollars, in the bull colour above the basis', () => {
      renderPanel();
      // (100 − 90) / 90 = +11.11 %; (100 − 90) × 10 shares = +$100.00
      expectSingleMode();
      expect(screen.getByText('+11.11%')).toHaveStyle({ color: 'var(--color-bull)' });
      expect(screen.getByText('+$100.00')).toHaveStyle({ color: 'var(--color-bull)' });
    });

    it('shows a loss in the bear colour below the basis', () => {
      renderPanel({ costBasis: 110 });
      // (100 − 110) / 110 = −9.09 %; (100 − 110) × 10 shares = −$100.00
      expect(screen.getByText('-9.09%')).toHaveStyle({ color: 'var(--color-bear)' });
      expect(screen.getByText('-$100.00')).toHaveStyle({ color: 'var(--color-bear)' });
    });

    it('shows the signal computeRecommendation gives for the same inputs, with one row per reason', () => {
      renderPanel();
      const rec = computeRecommendation({ costBasis: 90, shares: 10, spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX });
      expect(screen.getByText(rec.signal)).toBeInTheDocument();
      expect(screen.getByText(`${rec.confidence} confidence`)).toBeInTheDocument();
      const reasonRows = screen.getByText(rec.reasons[0]).parentElement.parentElement.children;
      expect([...reasonRows].map((row) => row.textContent)).toEqual(rec.reasons);
    });

    it('shows the price-level legend in price order', () => {
      renderPanel({ kpis: { ...KPIS, maxPain: 105 } }); // off spot, so no two levels tie
      const legendRows = screen.getByText('Basis').parentElement.parentElement.children;
      expect([...legendRows].map((row) => [...row.querySelectorAll('span')].map((span) => span.textContent))).toEqual([
        ['Basis', '$90.00'],
        ['GEX Support', '$95.00'], // the positive-GEX strike below spot
        ['Spot', '$100.00'],
        ['Max Pain', '$105.00'],
      ]);
    });
  });

  describe('dual mode', () => {
    it('splits into snapshot and live panels once the live price has moved past the threshold', () => {
      expect(gapPct(102)).toBeGreaterThanOrEqual(GAP_DUAL_REC_THRESHOLD_PCT);
      renderPanel({ liveQuote: quote(102, 'yahoo-post') });

      expect(screen.getByText('Options market closed — price has moved up 2.0% since the options snapshot'))
        .toBeInTheDocument();
      expect(screen.getByText('P&L at options snapshot')).toBeInTheDocument();
      expect(screen.getByText('+11.11%')).toBeInTheDocument(); // at the 100 snapshot
      expect(screen.getByText('P&L (Live)')).toBeInTheDocument();
      expect(screen.getByText('+13.33%')).toBeInTheDocument(); // at the 102 live price
      expect(screen.getByText('Options Snapshot (delayed)')).toBeInTheDocument();
      expect(screen.getByText('If Live Price Holds')).toBeInTheDocument();
      expect(screen.queryByText('Basis')).not.toBeInTheDocument(); // no single-mode legend
    });

    it('says "down" when the live price has fallen', () => {
      renderPanel({ liveQuote: quote(98, 'yahoo-post') });
      expect(screen.getByText('Options market closed — price has moved down 2.0% since the options snapshot'))
        .toBeInTheDocument();
    });

    it('stays single below the threshold', () => {
      expect(gapPct(100.25)).toBeLessThan(GAP_DUAL_REC_THRESHOLD_PCT);
      renderPanel({ liveQuote: quote(100.25, 'yahoo-post') });
      expectSingleMode();
    });

    it('stays single while the options market is open, whatever the gap', () => {
      renderPanel({ liveQuote: quote(102, 'yahoo-regular'), optionsMarketOpen: true, marketOpen: true });
      expectSingleMode();
    });
  });

  describe('staleness badge', () => {
    it('shows the snapshot time once options data is over an hour old during the session', () => {
      vi.setSystemTime(new Date('2026-09-25T18:00:00Z')); // 2:00 PM ET
      renderPanel({ lastUpdated: '2026-09-25T16:45:00Z', optionsMarketOpen: true, marketOpen: true }); // 12:45 PM ET
      expect(screen.getByText('Based on 12:45 PM data')).toBeInTheDocument();
    });

    it('names the weekday once the data is more than a day old', () => {
      renderPanel({ lastUpdated: '2026-09-24T20:00:00Z' }); // Thu 4:00 PM ET, 25 h before NOW
      expect(screen.getByText('Based on Thu 4:00 PM data')).toBeInTheDocument();
    });

    it('shows no snapshot time while the data is fresh', () => {
      renderPanel(); // an hour old with both sessions closed, where the bar is four hours
      expect(screen.queryByText(/^Based on/)).not.toBeInTheDocument();
    });
  });

  describe('price source badge', () => {
    it('marks the options feed spot as delayed without a live quote', () => {
      renderPanel();
      expect(screen.getByText('~15min delayed (CBOE)')).toBeInTheDocument();
    });

    it('labels a live quote by its source, never as delayed', () => {
      renderPanel({ liveQuote: quote(100.25, 'yahoo-regular') });
      expect(screen.getByText('Live · Yahoo')).toBeInTheDocument();
      expect(screen.getByText('$100.25')).toBeInTheDocument();
      expect(screen.getByText('2m ago')).toBeInTheDocument();
      expect(screen.queryByText(/delayed/)).not.toBeInTheDocument();
    });
  });

  describe('inputs', () => {
    const costInput = () => screen.getByPlaceholderText('Avg cost');
    const sharesInput = () => screen.getByPlaceholderText('Shares');

    it('shows the position being analysed', () => {
      renderPanel();
      expect(costInput()).toHaveValue(90);
      expect(sharesInput()).toHaveValue(10);
    });

    it('sends a typed average cost with the current shares', () => {
      const { props } = renderPanel();
      fireEvent.change(costInput(), { target: { value: '95.5' } });
      expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(95.5, 10);
    });

    it('sends null when the average cost is cleared', () => {
      const { props } = renderPanel();
      fireEvent.change(costInput(), { target: { value: '' } });
      expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(null, 10);
    });

    it('ignores letters typed into the average cost', async () => {
      // Typed, not fireEvent.change: a number input never reports 'abc' (jsdom, like a browser, sanitises the value
      // to '', which the handler takes for a cleared field), and user-event drops the letters as Chrome does.
      const user = userEvent.setup();
      const { props } = renderPanel();
      await user.type(costInput(), 'abc');
      expect(props.onUpdate).not.toHaveBeenCalled();
      expect(costInput()).toHaveValue(90);

      await user.type(costInput(), '5'); // a digit does go through: 90 → 905
      expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(905, 10);
    });

    it('sends typed shares with the current cost basis', () => {
      const { props } = renderPanel();
      fireEvent.change(sharesInput(), { target: { value: '12' } });
      expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(90, 12);
    });
  });
});
