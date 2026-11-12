// src/components/charts.a11y.test.jsx — the two charts, their panel and its skeleton, for a screen reader. Each plot is
// an image named by a one-line summary of what it draws, computed from the props (the gamma chart: the strikes it
// spans and where the largest positive and negative exposure sit; the flow chart: the trading days it covers and the
// latest day's net premium and cumulative total); the moving-average toggle says whether it is pressed; a chart's
// loading card, and so the skeleton App shows while the panel's chunk loads, is a status that says it is loading;
// axe finds nothing in the loading, empty and filled states.
// recharts draws its plot only once ResponsiveContainer has measured a size, which jsdom never gives it (it has no
// ResizeObserver and every box is 0×0). Here a ResizeObserver that never fires and a container that reports 600×280
// let the plot render as it does in a browser: an svg that recharts makes a Tab stop (tabindex 0) for its own
// arrow-key tooltip, which the image role and name now sit on. App.lazy.test.jsx pins the skeleton's markup against
// the charts' own loading cards.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import GexChart from './GexChart.jsx';
import FlowChart from './FlowChart.jsx';
import ChartsPanel from './dashboard/ChartsPanel.js';
import ChartsSkeleton from './dashboard/ChartsSkeleton.js';
import { expectNoAxeViolations } from '../test/a11y.js';

class StillResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Both go after each test: vitest.config.js sets unstubGlobals and restoreMocks.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StillResizeObserver);
  const measure = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    return this.classList.contains('recharts-responsive-container')
      ? { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 280, width: 600, height: 280, toJSON: () => ({}) }
      : measure.call(this);
  });
});

/** Four strikes: the largest positive exposure at 100, the largest negative at 95. */
const GEX = [
  { strike: 95, callGex: 1_000_000, putGex: -3_000_000, gex: -2_000_000 },
  { strike: 100, callGex: 6_000_000, putGex: -1_000_000, gex: 5_000_000 },
  { strike: 105, callGex: 2_000_000, putGex: -500_000, gex: 1_500_000 },
  { strike: 110, callGex: 300_000, putGex: -800_000, gex: -500_000 },
];
const GEX_NAME = 'Bar chart of net gamma exposure across 4 strikes from $95.00 to $110.00: '
  + 'largest positive 5.0M at $100.00, largest negative -2.0M at $95.00.';

/** Three trading days, the latest 2026-09-25. */
const FLOW = [
  { date: '2026-09-23', netPremium: -400_000, cumPremium: -400_000, callVolume: 40_000, putVolume: 44_000 },
  { date: '2026-09-24', netPremium: 800_000, cumPremium: 400_000, callVolume: 45_000, putVolume: 38_000 },
  { date: '2026-09-25', netPremium: 1_250_000, cumPremium: 1_650_000, callVolume: 50_000, putVolume: 41_000 },
];
const FLOW_NAME = 'Area chart of premium flow over 3 trading days, September 23 to September 25; '
  + 'on the latest day, net premium $1.25M and cumulative premium $1.65M.';

const TECHNICALS = { sma50: 102, sma200: 98 };

describe('GexChart', () => {
  it('is an image named by a summary of its strikes and of where the largest positive and negative exposure sit', () => {
    render(<GexChart data={GEX} loading={false} spotPrice={101} costBasis={null} technicals={null} />);
    const plot = screen.getByRole('img', { name: GEX_NAME });
    expect(plot).toHaveClass('recharts-surface');
  });

  it.each([
    ['no negative exposure', GEX.map((row) => ({ ...row, gex: Math.abs(row.gex) })),
      'largest positive 5.0M at $100.00, no negative exposure.'],
    ['no positive exposure', GEX.map((row) => ({ ...row, gex: -Math.abs(row.gex) })),
      'no positive exposure, largest negative -5.0M at $100.00.'],
  ])('says so when there is %s', (_, data, ending) => {
    render(<GexChart data={data} loading={false} spotPrice={101} costBasis={null} technicals={null} />);
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe(`Bar chart of net gamma exposure across 4 strikes from $95.00 to $110.00: ${ending}`);
  });

  it("Pin: the plot stays recharts' Tab stop for its arrow-key tooltip, with nothing tabbable inside it", () => {
    const { container } = render(<GexChart data={GEX} loading={false} spotPrice={101} costBasis={null} technicals={null} />);
    const plot = container.querySelector('svg.recharts-surface');
    expect(plot).toHaveAttribute('tabindex', '0');
    expect([...plot.querySelectorAll('[tabindex]')].filter((el) => el.tabIndex >= 0)).toEqual([]);
  });

  it('marks the moving-average toggle pressed or not under one name, which expands MA', () => {
    render(<GexChart data={GEX} loading={false} spotPrice={101} costBasis={null} technicals={TECHNICALS} />);
    const toggle = screen.getByRole('button', { name: /^MA\b/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAccessibleName('MA (moving averages)');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAccessibleName('MA (moving averages)');
  });

  it('says it is loading while the market data loads', () => {
    render(<GexChart loading />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Loading…$/);
  });

  it('Pin: with fewer than two strikes it says there is nothing to draw, and draws no image', () => {
    render(<GexChart data={GEX.slice(0, 1)} loading={false} spotPrice={101} costBasis={null} technicals={null} />);
    expect(screen.getByText('No GEX data available')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('Pin: filled, with the moving averages and an off-chart basis, under axe', async () => {
    const { container } = render(
      <GexChart data={GEX} loading={false} spotPrice={101} costBasis={150} technicals={TECHNICALS} />,
    );
    expect(screen.getByText('Basis')).toHaveTextContent(/^Basis\(off-chart\)$/);
    await expectNoAxeViolations(container);
  });
});

describe('FlowChart', () => {
  it('is an image named by a summary of the days it covers and of the latest day', () => {
    render(<FlowChart data={FLOW} loading={false} />);
    expect(screen.getByRole('img', { name: FLOW_NAME })).toHaveClass('recharts-surface');
  });

  it('says one trading day as one', () => {
    render(<FlowChart data={FLOW.slice(2)} loading={false} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Area chart of premium flow over 1 trading day, September 25; net premium $1.25M and cumulative premium $1.65M.',
    );
  });

  it('says it is loading while the market data loads', () => {
    render(<FlowChart loading />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Loading…$/);
  });

  it('Pin: with no history it says so, and draws no image', () => {
    render(<FlowChart data={[]} loading={false} />);
    expect(screen.getByText('No flow history available')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('Pin: filled, under axe', async () => {
    const { container } = render(<FlowChart data={FLOW} loading={false} />);
    await expectNoAxeViolations(container);
  });
});

describe('ChartsPanel and ChartsSkeleton', () => {
  const panel = (loading) => (
    <ChartsPanel gexByStrike={GEX} flowHistory={FLOW} loading={loading} spotPrice={101} costBasis={null} technicals={null} />
  );

  it('the skeleton says, for each chart, that it is loading', async () => {
    const { container } = render(<ChartsSkeleton />);
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toEqual(['Loading…', 'Loading…']);
    await expectNoAxeViolations(container);
  });

  it('the panel says the same while the market data loads, then shows the two images', async () => {
    const { container, rerender } = render(panel(true));
    expect(screen.getAllByRole('status')).toHaveLength(2);
    await expectNoAxeViolations(container);

    rerender(panel(false));
    expect(screen.queryByRole('status')).toBeNull();
    const [gex, flow] = screen.getAllByRole('img');
    expect([gex, flow].map((plot) => plot.getAttribute('aria-label'))).toEqual([GEX_NAME, FLOW_NAME]);
    expect(within(container).getByRole('heading', { level: 3, name: 'Gamma Exposure by Strike' })).toBeInTheDocument();
    expect(within(container).getByRole('heading', { level: 3, name: 'Net Premium Flow (30d)' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
