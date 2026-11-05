// src/components/PositionAnalysis.test.jsx — the position panel: unrealised P&L, the recommendation badge and its
// reasons, the price-level legend, dual mode (the live price has moved while the options market is closed), the
// staleness and price-source badges, and the average-cost / shares inputs. Since Phase 5 (c) the panel reads its
// market data from App's MarketContext and takes only the position draft as props, so renderPanel renders it inside
// src/test/contexts.jsx's withContexts; the tests still assert only what it shows and sends, and should pass
// unchanged across the components/position/* decomposition still to come in Phase 5.
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
import { withContexts } from '../test/contexts.jsx';

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
  const { costBasis, shares, onUpdate, spotPrice, kpis, gexByStrike, lastUpdated, dataProvider, ...rest } = {
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
  // The position draft is the panel's props; the rest goes into the context the way App provides it, the payload
  // fields under `data` (dataProvider is data.provider) and loading, the session flags and the live quote beside it.
  const props = { costBasis, shares, onUpdate };
  const market = { ...rest, data: { spotPrice, kpis, gexByStrike, lastUpdated, provider: dataProvider } };
  return { ...render(withContexts(<PositionAnalysis {...props} />, { market })), props };
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

// Pins for what the tests above leave open, appended before the panel's decomposition (Phase 5 (d), PR 4) into a shell
// over components/position/*.tsx and usePositionSignals: the price display's branches and ages, the badge's signal
// styles and dual-mode variants, the level bar's edges, both modes' P&L and reasons, and the inputs' other paths.
// Written against the one-file panel, they assert only what it renders and sends, so the decomposed tree must keep
// them green unchanged. None edits the shares while the cost basis is empty, null or undefined: issue #57 changes what
// that sends, and its regression test comes with the fix.
//
// Their imports and the engine mock sit here so that the file above stays as it was: imports hoist, and Vitest lifts
// vi.hoisted and vi.mock above every import. The engine passes each call through, unless a pin has it drop dual mode's
// live recommendation: no real input gets there (the engine returns none only while the options market is open, and
// the panel splits only while it is closed), but the panel guards for it.
import { act, within } from '@testing-library/react';

const engine = vi.hoisted(() => ({ dropSecondary: false }));
vi.mock('../lib/recommend.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    computeDualRecommendation: (input) => {
      const dual = actual.computeDualRecommendation(input);
      return engine.dropSecondary && dual ? { ...dual, secondary: null } : dual;
    },
  };
});

describe('PositionAnalysis pins', () => {
  describe('the price display', () => {
    /** The text of the line `text` sits on: the price, its change, its badge and its age, run together. */
    const lineOf = (text) => screen.getByText(text).parentElement.textContent;
    const SNAPSHOT_CBOE = 'Options snapshot (CBOE, ~15 min delayed)';
    /** The classes of the live price's badge, on either display. */
    const LIVE_BADGE =['bg-[var(--color-accent)]/20', 'text-[var(--color-accent)]', 'font-mono'];

    it.each([
      { spot: 'no spot', spotPrice: undefined },
      { spot: 'a zero spot', spotPrice: 0 },
    ])('Pin: with no live quote and $spot there is no price line, nor any price below it', ({ spotPrice }) => {
      renderPanel({ spotPrice });
      expect(screen.queryByText(/delayed|^Spot \(|^Live|^Options snapshot/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^[+-]?\$|^—$/)).not.toBeInTheDocument();
    });

    it.each([
      ['yahoo-regular', 'Live · Yahoo'],
      ['finnhub', 'Finnhub'],
      ['futures-implied', 'Live'], // a source the panel has no name for
    ])('Pin: a %s quote leads the line at its live price, badged "%s" in the accent colour', (source, badge) => {
      renderPanel({ liveQuote: quote(100.25, source) });
      expect(lineOf('$100.25')).toBe(`$100.25${badge}2m ago`);
      expect(screen.getByText(badge)).toHaveClass(...LIVE_BADGE);
    });

    it('Pin: an after-hours quote before the options close keeps to one line, badged After Hours', () => {
      renderPanel({ liveQuote: quote(100.25, 'yahoo-post'), optionsMarketOpen: true });
      expect(lineOf('$100.25')).toBe('$100.25After Hours2m ago');
      expect(screen.queryByText(/^Options snapshot/)).not.toBeInTheDocument();
    });

    it.each([
      { from: 'cboe', dataProvider: 'cboe', feed: 'CBOE' },
      { from: 'tradier-sandbox', dataProvider: 'tradier-sandbox', feed: 'Tradier sandbox' },
      { from: 'no provider', dataProvider: undefined, feed: 'CBOE' },
    ])(
      'Pin: with no live quote, a spot from $from is badged "~15min delayed ($feed)" in the warning colour',
      ({ dataProvider, feed }) => {
        renderPanel({ dataProvider });
        const badge = `~15min delayed (${feed})`;
        expect(lineOf(badge)).toBe(`$100.00${badge}`);
        expect(screen.getByText(badge)).toHaveClass('bg-[var(--color-warn-bg)]', 'text-[var(--color-warn)]');
      },
    );

    it.each([
      { from: 'tradier', dataProvider: 'tradier', feed: 'Tradier' },
      { from: 'mock', dataProvider: 'mock', feed: 'demo data' },
      { from: 'a provider it does not know', dataProvider: 'polygon', feed: 'CBOE' }, // named CBOE, not marked delayed
    ])(
      'Pin: with no live quote, a spot from $from is badged "Spot ($feed)" in the muted colour',
      ({ dataProvider, feed }) => {
        renderPanel({ dataProvider });
        const badge = `Spot (${feed})`;
        expect(lineOf(badge)).toBe(`$100.00${badge}`);
        expect(screen.getByText(badge)).toHaveClass('bg-[var(--color-surface-3)]', 'text-[var(--color-text-muted)]');
      },
    );

    it.each([
      [1.5, '+1.50%', 'var(--color-bull)'],
      [0, '+0.00%', 'var(--color-bull)'],
      [-2.25, '-2.25%', 'var(--color-bear)'],
    ])('Pin: a live change of %s reads %s after the price, in %s', (changePercent, text, color) => {
      renderPanel({ costBasis: null, liveQuote: { ...quote(100.25, 'yahoo-regular'), changePercent } });
      expect(screen.getByText(text)).toHaveStyle({ color });
      expect(lineOf('$100.25')).toBe(`$100.25${text}Live · Yahoo2m ago`);
    });

    it('Pin: a live quote without a change shows none', () => {
      renderPanel({ costBasis: null, liveQuote: { ...quote(100.25, 'yahoo-regular'), changePercent: null } });
      expect(lineOf('$100.25')).toBe('$100.25Live · Yahoo2m ago');
    });

    // After the options close an extended-hours quote splits the price over two lines: the options snapshot's spot,
    // then the live price with its drift from that spot. These pins pass no cost basis, so the panel never splits.
    it.each([
      ['yahoo-post', 'After Hours'],
      ['yahoo-pre', 'Pre-Market'],
    ])(
      'Pin: after the options close a %s quote shows the snapshot spot, then the live price badged %s',
      (source, badge) => {
        renderPanel({ costBasis: null, liveQuote: quote(102, source) });
        expect(lineOf('$100.00')).toBe(`$100.00${SNAPSHOT_CBOE}`);
        expect(lineOf('$102.00')).toBe(`$102.00+2.00%${badge}2m ago`);
        expect(screen.getByText(badge)).toHaveClass(...LIVE_BADGE);
      },
    );

    it.each([
      ['cboe', SNAPSHOT_CBOE, 'text-[var(--color-warn)]'],
      ['tradier', 'Options snapshot (Tradier)', 'text-[var(--color-text-muted)]'],
    ])('Pin: after the options close a %s snapshot is labelled "%s"', (dataProvider, label, colour) => {
      renderPanel({ costBasis: null, dataProvider, liveQuote: quote(102, 'yahoo-post') });
      expect(screen.getByText(label)).toHaveClass(colour);
    });

    it.each([
      [98, '+2.04%', 'var(--color-bull)'], // (100 − 98) / 98
      [104, '-3.85%', 'var(--color-bear)'], // (100 − 104) / 104
      [100, '+0.00%', 'var(--color-bull)'],
    ])('Pin: after a previous close of %s the snapshot spot reads %s', (previousClose, text, color) => {
      renderPanel({ costBasis: null, liveQuote: { ...quote(102, 'yahoo-post'), previousClose } });
      expect(screen.getByText(text)).toHaveStyle({ color });
      expect(lineOf('$100.00')).toBe(`$100.00${text}${SNAPSHOT_CBOE}`);
    });

    it.each([null, 0])('Pin: a previous close of %s gives the snapshot spot no change', (previousClose) => {
      renderPanel({ costBasis: null, liveQuote: { ...quote(102, 'yahoo-post'), previousClose } });
      expect(lineOf('$100.00')).toBe(`$100.00${SNAPSHOT_CBOE}`);
    });

    it.each([
      [102, '+2.00%', 'var(--color-bull)', 'lucide-arrow-up'],
      [99, '-1.00%', 'var(--color-bear)', 'lucide-arrow-down'],
      [100, '+0.00%', 'var(--color-bull)', 'lucide-arrow-up'],
    ])('Pin: a live price of %s drifts %s from the snapshot spot', (current, text, color, arrow) => {
      renderPanel({ costBasis: null, liveQuote: quote(current, 'yahoo-post') });
      const drift = screen.getByText(text);
      expect(drift).toHaveStyle({ color });
      expect(drift.querySelector('svg')).toHaveClass(arrow);
    });

    it('Pin: with no spot an extended-hours quote leads both lines, with no change and no drift', () => {
      const liveQuote = { ...quote(101, 'yahoo-post'), previousClose: 98 };
      renderPanel({ costBasis: null, spotPrice: undefined, liveQuote });
      const [first, second] = screen.getAllByText('$101.00');
      expect(first.parentElement.textContent).toBe(`$101.00${SNAPSHOT_CBOE}`);
      expect(second.parentElement.textContent).toBe('$101.00After Hours2m ago');
    });

    it.each([
      [0, 'just now'],
      [9_999, 'just now'],
      [10_000, '10s ago'],
      [59_999, '59s ago'],
      [60_000, '1m ago'],
      [3_599_999, '59m ago'],
      [3_600_000, '1h ago'],
      [19_800_000, '5h ago'], // 5 h 30 min
      [-30_000, 'just now'], // stamped after now: clock skew
    ])('Pin: a quote stamped %i ms before now is %s', (age, label) => {
      renderPanel({ liveQuote: { ...quote(100.25, 'yahoo-regular'), timestamp: Date.parse(NOW) - age } });
      expect(lineOf('$100.25')).toBe(`$100.25Live · Yahoo${label}`);
    });

    it('Pin: a quote without a time shows no age', () => {
      renderPanel({ liveQuote: { ...quote(100.25, 'finnhub'), timestamp: null } });
      expect(lineOf('$100.25')).toBe('$100.25Finnhub');
    });

    it("Pin: the age moves on when the panel's minute tick fires", () => {
      // Faked again with the intervals too, still at NOW, so the minute useNow waits for can pass at once.
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      renderPanel({ liveQuote: quote(100.25, 'yahoo-regular') });
      expect(screen.getByText('2m ago')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText('3m ago')).toBeInTheDocument();
    });
  });

  describe('the recommendation badge', () => {
    /** A dual-mode recommendation panel, found by its badge's label. */
    const recPanel = (label) => screen.getByText(label).closest('.p-3');

    // Four of five factors bearish (profits to take at +100 %, spot above max pain, negative GEX at spot, put-heavy
    // premium) and one bullish (a low put/call ratio): a SELL with one dissent.
    const SELLING = {
      costBasis: 50,
      kpis: { maxPain: 90, netPremium: -2e6, putCallRatio: 0.5 },
      gexByStrike: [{ strike: 101, gex: -5e8 }],
    };

    it.each([
      ['BUY', 'HIGH', 'bull', 'lucide-trending-up', {}],
      ['HOLD', 'LOW', 'warn', 'lucide-minus', { costBasis: 98, kpis: {}, gexByStrike: [] }], // one factor scored
      ['SELL', 'MEDIUM', 'bear', 'lucide-trending-down', SELLING],
    ])(
      'Pin: %s with %s confidence shows its icon and word in the %s colour on a tinted pill, the confidence pill alike',
      (signal, confidence, tone, icon, inputs) => {
        const engineInput = { costBasis: 90, shares: 10, spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX, ...inputs };
        expect(computeRecommendation(engineInput)).toMatchObject({ signal, confidence });
        renderPanel(inputs);
        const color = `var(--color-${tone})`;
        const [bg, border] = [`var(--color-${tone}-bg)`, `var(--color-${tone}-border-muted)`];
        const word = screen.getByText(signal);
        const pill = word.parentElement;
        expect(word).toHaveStyle({ color });
        expect(pill.querySelector('svg')).toHaveClass(icon);
        expect(pill.querySelector('svg')).toHaveStyle({ color });
        // toHaveStyle cannot read a border-color shorthand holding var(), so the inline values are compared
        expect([pill.style.backgroundColor, pill.style.borderColor]).toEqual([bg, border]);
        const { style } = screen.getByText(`${confidence} confidence`);
        expect([style.color, style.backgroundColor, style.borderColor]).toEqual([color, bg, border]);
      },
    );

    it('Pin: on fresh data the single badge is its pill and confidence pill alone: no label, warning or age', () => {
      const { container } = renderPanel();
      const badge = screen.getByText('BUY').parentElement.parentElement.parentElement;
      expect([...badge.children].map((child) => child.textContent)).toEqual(['BUY', 'HIGH confidence']);
      expect(container.querySelector('.lucide-triangle-alert')).toBeNull();
    });

    it('Pin: on stale data the single badge puts the warning icon before its pill and says how old the data is', () => {
      renderPanel({ lastUpdated: '2026-09-25T16:00:00Z' }); // 12:00 PM ET, five hours before NOW
      const row = screen.getByText('BUY').parentElement.parentElement;
      expect(row.firstElementChild).toHaveClass('lucide-triangle-alert');
      expect([...row.parentElement.children].map((child) => child.textContent))
        .toEqual(['BUY', 'HIGH confidence', 'Based on 12:00 PM data']);
    });

    it('Pin: in dual mode only the snapshot badge is solid and warned; the live one is dashed and smaller', () => {
      renderPanel({ liveQuote: quote(102, 'yahoo-post') });
      const snapshot = recPanel('Options Snapshot (delayed)');
      const live = recPanel('If Live Price Holds');
      const snapshotWord = within(snapshot).getByText('BUY');
      const liveWord = within(live).getByText('BUY');
      expect(snapshotWord).toHaveClass('text-lg');
      expect(snapshotWord.parentElement).not.toHaveClass('border-dashed');
      expect(liveWord).toHaveClass('text-base');
      expect(liveWord.parentElement).toHaveClass('border-dashed');
      expect(screen.getByText('Options Snapshot (delayed)').parentElement).toHaveClass('items-end');
      expect(screen.getByText('If Live Price Holds').parentElement).toHaveClass('items-start');
      expect(snapshot.querySelectorAll('.lucide-triangle-alert')).toHaveLength(1);
      expect(live.querySelector('.lucide-triangle-alert')).toBeNull();
    });

    it('Pin: in dual mode only the snapshot badge says how old its data is, and only once it is stale', () => {
      const { unmount } = renderPanel({ liveQuote: quote(102, 'yahoo-post') }); // an hour old: fresh
      expect(screen.queryByText(/^Based on/)).not.toBeInTheDocument();
      unmount();

      renderPanel({ liveQuote: quote(102, 'yahoo-post'), lastUpdated: '2026-09-25T16:00:00Z' }); // five hours old
      const ages = screen.getAllByText(/^Based on/);
      expect(ages.map((age) => age.textContent)).toEqual(['Based on 12:00 PM data']);
      expect(recPanel('Options Snapshot (delayed)')).toContainElement(ages[0]);
    });
  });

  describe('the price-level bar', () => {
    /** The legend, whose children are its rows, and the bar's ticks above it, after the bar's baseline. */
    const legend = () => screen.getByText('Basis').parentElement.parentElement;
    const ticks = () => [...legend().previousElementSibling.children].slice(1);

    it('Pin: no bar without a cost basis', () => {
      const { container } = renderPanel({ costBasis: null });
      expect(screen.queryByText('Spot')).not.toBeInTheDocument();
      expect(screen.queryByText('Max Pain')).not.toBeInTheDocument();
      expect(container.querySelector('.h-px')).toBeNull(); // the bar's baseline
    });

    it('Pin: two levels are enough for the bar: the basis and the spot alone', () => {
      renderPanel({ kpis: { netPremium: 2e6, putCallRatio: 0.85 }, gexByStrike: [] }); // no max pain, no GEX walls
      expect([...legend().children].map((row) => row.textContent)).toEqual(['Basis$90.00', 'Spot$100.00']);
      expect(ticks()).toHaveLength(2);
    });

    it('Pin: no bar when every level sits at one price', () => {
      const { container } = renderPanel({ costBasis: SPOT, gexByStrike: [] }); // basis, spot and max pain all at 100
      expect(screen.queryByText('Basis')).not.toBeInTheDocument();
      expect(container.querySelector('.h-px')).toBeNull();
    });

    it("Pin: the ticks sit in price order on the padded scale, inside 5-95 %, in their legend rows' colours", () => {
      const gexByStrike = [{ strike: 95, gex: 5e8 }, { strike: 110, gex: 3e8 }]; // a wall below the spot, one above
      renderPanel({ kpis: { ...KPIS, maxPain: 105 }, gexByStrike });
      // 90 to 110 with 8 % of that range added at each end (88.4 to 111.6): 90 sits at 6.9 % and 110 at 93.1 %, so the
      // 5-95 % clamp never engages

      const levels = [
        ['Basis', '$90.00', 'var(--color-cyan)', 6.9],
        ['GEX Support', '$95.00', 'var(--color-bull)', 28.45],
        ['Spot', '$100.00', 'var(--color-warn)', 50],
        ['Max Pain', '$105.00', 'var(--color-purple)', 71.55],
        ['GEX Resist.', '$110.00', 'var(--color-bear)', 93.1],
      ];
      const rows = [...legend().children].map((row) => {
        const [dot, label, price] = row.children;
        return [label.textContent, price.textContent, dot.style.backgroundColor, label.style.color, price.style.color];
      });
      expect(rows).toEqual(levels.map(([label, price, colour]) => [label, price, colour, colour, colour]));
      expect(ticks().map((tick) => [tick.style.backgroundColor, parseFloat(tick.style.left)]))
        .toEqual(levels.map(([, , colour, left]) => [colour, expect.closeTo(left, 2)]));
    });

    it('Pin: the legend prints four-digit prices in full, to the cent', () => {
      renderPanel({ costBasis: 1180.5, spotPrice: 1250, kpis: { ...KPIS, maxPain: 1300 }, gexByStrike: [] });
      expect([...legend().children].map((row) => row.textContent))
        .toEqual(['Basis$1180.50', 'Spot$1250.00', 'Max Pain$1300.00']);
    });
  });

  describe('single mode', () => {
    it.each([null, 0])(
      'Pin: with a cost basis of %s there is no P&L, signal, legend or reasons, only the price',
      (costBasis) => {
        renderPanel({ costBasis });
        expect(screen.getByText('~15min delayed (CBOE)')).toBeInTheDocument();
        expect(screen.queryByText('Unrealized P&L')).not.toBeInTheDocument();
        expect(screen.queryByText(/ confidence$/)).not.toBeInTheDocument();
        expect(screen.queryByText('Spot')).not.toBeInTheDocument(); // the legend
        expect(screen.queryByText(/max pain/)).not.toBeInTheDocument(); // the engine's reasons
      },
    );

    it('Pin: with no spot there is no P&L, signal or legend, even with a live price on the price line', () => {
      renderPanel({ spotPrice: undefined, liveQuote: quote(105, 'yahoo-regular') });
      expect(screen.getByText('$105.00').parentElement.textContent).toBe('$105.00Live · Yahoo2m ago');
      expect(screen.queryByText('Unrealized P&L')).not.toBeInTheDocument();
      expect(screen.queryByText(/ confidence$/)).not.toBeInTheDocument();
      expect(screen.queryByText('Basis')).not.toBeInTheDocument();
    });

    it.each([null, 0])('Pin: with %s shares the P&L shows its percent and no dollars', (shares) => {
      renderPanel({ shares });
      expect(screen.getByText('Unrealized P&L').parentElement.textContent).toBe('Unrealized P&L+11.11%');
    });

    it('Pin: a position at its cost basis breaks even, signed + in the bull colour', () => {
      renderPanel({ costBasis: SPOT });
      expect(screen.getByText('+0.00%')).toHaveStyle({ color: 'var(--color-bull)' });
      expect(screen.getByText('+$0.00')).toHaveStyle({ color: 'var(--color-bull)' });
    });

    it('Pin: every reason gets a chevron row in a grid of up to three columns, none left out', () => {
      renderPanel();
      const rec = computeRecommendation({ costBasis: 90, shares: 10, spotPrice: SPOT, kpis: KPIS, gexByStrike: GEX });
      expect(rec.reasons.length).toBeGreaterThan(3);
      const grid = screen.getByText(rec.reasons[0]).parentElement.parentElement;
      expect(grid).toHaveClass('grid', 'sm:grid-cols-2', 'lg:grid-cols-3');
      expect([...grid.children].map((row) => row.textContent)).toEqual(rec.reasons);
      for (const row of grid.children) expect(row.firstElementChild).toHaveClass('lucide-chevron-right');
    });
  });

  describe('dual mode', () => {
    afterEach(() => {
      engine.dropSecondary = false;
    });

    /** A dual-mode panel, found by its heading or its badge's label. */
    const panel = (text) => screen.getByText(text).closest('.p-3');

    it.each([
      [101.26, 'up'],
      [98.74, 'down'],
    ])('Pin: at a live price of %s the banner says the price has moved %s, to one decimal', (live, direction) => {
      renderPanel({ liveQuote: quote(live, 'yahoo-post') });
      expect(screen.getByText(`Options market closed — price has moved ${direction} 1.3% since the options snapshot`))
        .toBeInTheDocument();
    });

    it('Pin: each P&L panel shows its own percent and dollars, each in its own colour', () => {
      renderPanel({ costBasis: 101, liveQuote: quote(102, 'yahoo-post') }); // a loss at the snapshot, a gain live
      const snapshot = panel('P&L at options snapshot');
      const live = panel('P&L (Live)');
      expect(snapshot.textContent).toBe('P&L at options snapshotUnrealized P&L-0.99%-$10.00');
      expect(live.textContent).toBe('P&L (Live)Unrealized P&L+0.99%+$10.00');
      expect(within(snapshot).getByText('-0.99%')).toHaveStyle({ color: 'var(--color-bear)' });
      expect(within(snapshot).getByText('-$10.00')).toHaveStyle({ color: 'var(--color-bear)' });
      expect(within(live).getByText('+0.99%')).toHaveStyle({ color: 'var(--color-bull)' });
      expect(within(live).getByText('+$10.00')).toHaveStyle({ color: 'var(--color-bull)' });
    });

    it('Pin: without shares each P&L panel shows its percent alone', () => {
      renderPanel({ shares: null, liveQuote: quote(102, 'yahoo-post') });
      expect(panel('P&L at options snapshot').textContent).toBe('P&L at options snapshotUnrealized P&L+11.11%');
      expect(panel('P&L (Live)').textContent).toBe('P&L (Live)Unrealized P&L+13.33%');
    });

    it('Pin: each recommendation panel lists the first three of its own reasons, stacked', () => {
      renderPanel({ liveQuote: quote(102, 'yahoo-post') });
      const position = { costBasis: 90, shares: 10, kpis: KPIS, gexByStrike: GEX };
      for (const [label, spotPrice] of [['Options Snapshot (delayed)', SPOT], ['If Live Price Holds', 102]]) {
        const { reasons } = computeRecommendation({ ...position, spotPrice });
        expect(reasons.length).toBeGreaterThan(3);
        const list = within(panel(label)).getByText(reasons[0]).parentElement.parentElement;
        expect(list).toHaveClass('space-y-1');
        expect([...list.children].map((row) => row.textContent)).toEqual(reasons.slice(0, 3));
      }
    });

    it('Pin: the live panel ends by saying options positioning is unknown until the market reopens', () => {
      renderPanel({ liveQuote: quote(102, 'yahoo-post') });
      expect(panel('If Live Price Holds').lastElementChild)
        .toHaveTextContent(/^Options positioning unknown until market reopens$/);
    });

    it('Pin: without a live recommendation dual mode shows the snapshot panel alone', () => {
      engine.dropSecondary = true;
      renderPanel({ liveQuote: quote(102, 'yahoo-post') });
      expect(screen.getByText(/^Options market closed/)).toBeInTheDocument();
      expect(screen.getByText('Options Snapshot (delayed)')).toBeInTheDocument();
      expect(screen.queryByText('If Live Price Holds')).not.toBeInTheDocument();
      expect(screen.queryByText('Options positioning unknown until market reopens')).not.toBeInTheDocument();
    });
  });

  describe('the inputs', () => {
    const costInput = () => screen.getByPlaceholderText('Avg cost');
    const sharesInput = () => screen.getByPlaceholderText('Shares');

    it('Pin: clearing the shares sends null with the current cost basis', () => {
      const { props } = renderPanel();
      fireEvent.change(sharesInput(), { target: { value: '' } });
      expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(90, null);
    });

    it('Pin: a typed average cost goes out with shares null while there are none', () => {
      const { props } = renderPanel({ shares: null });
      expect(sharesInput()).toHaveValue(null);
      fireEvent.change(costInput(), { target: { value: '95.5' } });
      expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(95.5, null);
    });

    it('Pin: letters typed into the shares are ignored', async () => {
      const user = userEvent.setup();
      const { props } = renderPanel();
      await user.type(sharesInput(), 'abc');
      expect(props.onUpdate).not.toHaveBeenCalled();
      expect(sharesInput()).toHaveValue(10);

      await user.type(sharesInput(), '5'); // a digit does go through: 10 → 105
      expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(90, 105);
    });
  });
});
