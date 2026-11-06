// src/components/dashboard/TickerSummary.test.jsx — the ticker row, rendered bare (the leaf reads no context): the
// ticker, always; IV30 to one decimal whenever the payload carries one, a zero included, but not during a foreground
// load; DEMO DATA in demo mode; ERROR, with the failure's message as its title, over real data only; and the contract
// count, grouped as the locale groups it, only when there is one and nothing is loading. The count is written with
// toLocaleString here too, so the test holds in any locale.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TickerSummary from './TickerSummary.js';

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

/** The row for AVGO over a loaded CBOE payload with nothing failed; `props` overrides any of it, as does rerender's. */
function renderRow(props = {}) {
  const ui = (next) => (
    <TickerSummary ticker="AVGO" data={payload()} loading={false} usingMock={false} error={null} {...next} />
  );
  const view = render(ui(props));
  return { ...view, rerender: (next) => view.rerender(ui(next)) };
}

const iv30Badge = () => screen.queryByText(/^IV30:/);
const count = () => screen.queryByText(/contracts analyzed$/);
const contracts = (n) => `${n.toLocaleString()} contracts analyzed`;

describe('TickerSummary', () => {
  it('shows the ticker, IV30 to one decimal and the contract count over a loaded payload, and no badge', () => {
    renderRow({ data: payload({ iv30: 27.06 }) });
    expect(screen.getByText('AVGO')).toHaveClass('font-mono', 'font-bold');
    expect(screen.getByText('IV30: 27.1%')).toHaveClass('bg-[var(--color-purple-bg)]', 'text-[var(--color-purple)]');
    expect(screen.getByText('420 contracts analyzed')).toHaveClass('hidden', 'sm:inline'); // not at a phone's width
    expect(screen.queryByText('DEMO DATA')).toBeNull();
    expect(screen.queryByText('ERROR')).toBeNull();
  });

  it('shows an IV30 of zero, and no IV30 without one in the payload or without a payload', () => {
    const { container, rerender } = renderRow({ data: payload({ iv30: 0 }) });
    expect(screen.getByText('IV30: 0.0%')).toBeInTheDocument();

    rerender({ data: payload({ iv30: null }) }); // Tradier sends none
    expect(iv30Badge()).toBeNull();
    expect(screen.getByText('420 contracts analyzed')).toBeInTheDocument();

    rerender({ data: null }); // nothing has loaded
    expect(iv30Badge()).toBeNull();
    expect(count()).toBeNull();
    expect(container.textContent).toBe('AVGO');
  });

  it('holds IV30 and the count back during a foreground load, and shows them once it ends', () => {
    // A new ticker shows the previous ticker's payload until its own lands.
    const { rerender } = renderRow({ ticker: 'NVDA', loading: true });
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(iv30Badge()).toBeNull();
    expect(count()).toBeNull();

    rerender({ ticker: 'NVDA', loading: false });
    expect(screen.getByText('IV30: 31.4%')).toBeInTheDocument();
    expect(screen.getByText('420 contracts analyzed')).toBeInTheDocument();
  });

  it('shows DEMO DATA in demo mode, and no ERROR beside it whatever the error', () => {
    const demo = payload({ provider: 'mock', delay: 'simulated', iv30: null, totalOptionsCount: 2468 });
    const { rerender } = renderRow({ data: demo, usingMock: true, error: 'Upstream down' });
    expect(screen.getByText('DEMO DATA')).toHaveClass('bg-[var(--color-warn-bg)]', 'text-[var(--color-warn)]');
    expect(screen.queryByText('ERROR')).toBeNull();
    expect(screen.getByText(contracts(2468))).toBeInTheDocument();

    rerender({ data: demo, usingMock: true, error: null }); // a reload of a ticker in demo mode clears the error
    expect(screen.getByText('DEMO DATA')).toBeInTheDocument();
    expect(screen.queryByText('ERROR')).toBeNull();
  });

  it("shows ERROR over real data with the failure's message as its title, and the data's figures beside it", () => {
    // A refresh that fails after a success keeps the last good payload.
    const { rerender } = renderRow({ error: 'Market data unavailable (502)' });
    const badge = screen.getByText('ERROR');
    expect(badge).toHaveAttribute('title', 'Market data unavailable (502)');
    expect(badge).toHaveClass('bg-[var(--color-bear-bg)]', 'text-[var(--color-bear)]');
    expect(screen.queryByText('DEMO DATA')).toBeNull();
    expect(screen.getByText('IV30: 31.4%')).toBeInTheDocument();
    expect(screen.getByText('420 contracts analyzed')).toBeInTheDocument();

    rerender({ error: null }); // the next success clears it
    expect(screen.queryByText('ERROR')).toBeNull();
  });

  it('shows the contract count grouped as the locale groups it, and none at zero', () => {
    const { rerender } = renderRow({ data: payload({ totalOptionsCount: 12345 }) });
    expect(screen.getByText(contracts(12345))).toBeInTheDocument();

    rerender({ data: payload({ totalOptionsCount: 0 }) });
    expect(count()).toBeNull();
    expect(screen.getByText('IV30: 31.4%')).toBeInTheDocument();
  });
});
