// src/components/position/position.a11y.test.jsx — the position leaves for a screen reader: every reading the colour
// shows is also in the text (a gain or a loss by its sign, the engine's call and the move by their words, each price
// level by its name and price), the icons beside them are decorative, and axe finds nothing in their filled states.
// All pins: these leaves already said everything in text, and PositionAnalysis.test.jsx pins their exact text, so
// none of them changed. Rendered bare: they take props and read no context.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import PnLStat from './PnLStat.js';
import RecommendationBadge from './RecommendationBadge.js';
import DualRecommendationView from './DualRecommendationView.js';
import PriceLevelBar from './PriceLevelBar.js';
import ReasonList from './ReasonList.js';
import PriceDisplay from './PriceDisplay.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

/** The panel's clock, fixed: Friday 2026-09-25, 5:00 PM ET. */
const NOW = Date.parse('2026-09-25T21:00:00Z');

const GAIN = { pct: 11.11, dollars: 100, up: true };
const LOSS = { pct: -9.09, dollars: -100, up: false };

/** A computeRecommendation result: only the fields the badge and the lists read matter. */
const recommendation = (signal, confidence) => ({
  signal, confidence, reasons: ['Spot above max pain', 'Premium traded is call-heavy', 'P/C ratio 0.85 — neutral', 'GEX positioning neutral'],
  pnl: { dollars: 100, percent: 11.11, marketValue: 1000 }, factorsUsed: 5, threshold: 2, score: 0,
});

const LEVELS = [
  { price: 105, label: 'Max Pain', color: 'var(--color-purple)' },
  { price: 90, label: 'Basis', color: 'var(--color-cyan)' },
  { price: 100, label: 'Spot', color: 'var(--color-warn)' },
];

describe('the position leaves', () => {
  it('Pin: a gain carries its plus sign and a loss its minus sign, in both layouts, not only the colour', () => {
    const { container } = render(
      <div>
        <PnLStat pnl={GAIN} layout="block" />
        <PnLStat pnl={LOSS} layout="row" />
      </div>,
    );
    const [block, row] = container.firstChild.children;
    expect(block.textContent).toBe('Unrealized P&L+11.11%+$100.00');
    expect(row.textContent).toBe('Unrealized P&L-9.09%-$100.00');
  });

  it("Pin: the engine's call and its confidence are words; its icons are decorative", () => {
    const { container } = render(
      <RecommendationBadge rec={recommendation('SELL', 'MEDIUM')} isStale lastUpdated="2026-09-25T16:00:00Z" hasWarning now={NOW} />,
    );
    expect(screen.getByText('SELL')).toBeInTheDocument();
    expect(screen.getByText('MEDIUM confidence')).toBeInTheDocument();
    expect(screen.getByText(/^Based on .+ data$/)).toBeInTheDocument();
    const icons = container.querySelectorAll('svg');
    expect(icons).toHaveLength(2); // the warning triangle, the signal's arrow
    for (const icon of icons) expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('Pin: dual mode says which way the price moved in words', () => {
    render(
      <DualRecommendationView
        dualRec={{
          primary: recommendation('BUY', 'HIGH'), secondary: recommendation('HOLD', 'LOW'),
          optionsSnapshotPrice: 100, livePrice: 98, gapPercent: -2, optionsMarketOpen: false,
        }}
        pnl={GAIN}
        livePnl={LOSS}
        hasBasis
        isStale={false}
        lastUpdated="2026-09-25T20:00:00Z"
        now={NOW}
      />,
    );
    expect(screen.getByText('Options market closed — price has moved down 2.0% since the options snapshot')).toBeInTheDocument();
  });

  it('Pin: every price level the bar marks is in its legend by name and price, in price order', () => {
    const { container } = render(<PriceLevelBar levels={LEVELS} />);
    const legend = container.firstChild.lastChild;
    expect([...legend.children].map((row) => row.textContent)).toEqual(['Basis$90.00', 'Spot$100.00', 'Max Pain$105.00']);
  });

  it('Pin: a price change carries its sign, on the live line and on both after-hours lines', () => {
    const quote = { current: 98.5, previousClose: 102, changePercent: -1.5, timestamp: NOW - 120_000, source: 'yahoo-regular' };
    const { container } = render(
      <div>
        <PriceDisplay spotPrice={100} liveQuote={quote} optionsMarketOpen dataProvider="cboe" now={NOW} />
        <PriceDisplay spotPrice={100} liveQuote={{ ...quote, source: 'yahoo-post' }} optionsMarketOpen={false} dataProvider="cboe" now={NOW} />
      </div>,
    );
    const [live, afterHours] = container.firstChild.children;
    expect(live.textContent).toBe('$98.50-1.50%Live · Yahoo2m ago');
    expect([...afterHours.children].map((line) => line.textContent))
      .toEqual(['$100.00-1.96%Options snapshot (CBOE, ~15 min delayed)', '$98.50-1.50%After Hours2m ago']);
  });

  it('Pin: filled, under axe', async () => {
    const { container } = render(
      <div>
        <PriceDisplay spotPrice={100} liveQuote={null} optionsMarketOpen={false} dataProvider="cboe" now={NOW} />
        <PnLStat pnl={GAIN} layout="block" />
        <RecommendationBadge rec={recommendation('BUY', 'HIGH')} now={NOW} />
        <PriceLevelBar levels={LEVELS} />
        <ReasonList reasons={recommendation('BUY', 'HIGH').reasons} columns />
        <DualRecommendationView
          dualRec={{
            primary: recommendation('BUY', 'HIGH'), secondary: recommendation('HOLD', 'LOW'),
            optionsSnapshotPrice: 100, livePrice: 102, gapPercent: 2, optionsMarketOpen: false,
          }}
          pnl={GAIN}
          livePnl={LOSS}
          hasBasis
          isStale
          lastUpdated="2026-09-24T20:00:00Z"
          now={NOW}
        />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
