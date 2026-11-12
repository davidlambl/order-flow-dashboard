// src/components/KPICards.a11y.test.jsx — the KPI cards for a screen reader. Where a card's colour (and its icon) was
// the only sign of a reading, the word is now in the card, beside the value, in the chat context's words
// (financialContext.ts): the put/call ratio's band (bullish, neutral, bearish on PUT_CALL's cut-offs) and the side the
// premium leans to (call-heavy at or above zero, put-heavy below). The EST. and C − P badges carry their expansion, as
// a title for a pointer and as text for a screen reader, which no longer hears the abbreviation. axe finds nothing
// loading or filled. Rendered bare: KPICards is a pure leaf on its data props (the App tests replace it with a
// counting stand-in). Tailwind's sr-only does nothing under jsdom, so visually hidden text counts in textContent.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import KPICards from './KPICards.jsx';
import { PUT_CALL } from '../../shared/thresholds.js';
import { expectNoAxeViolations } from '../test/a11y.js';

/** A complete MarketKpis (types/market.ts) as the CBOE path sends it. */
const KPIS = {
  netPremium: 1_250_000, callPremium: 3_500_000, putPremium: 2_250_000, darkPoolPct: 38.5, maxPain: 100,
  putCallRatio: 0.82, maxPainExpiry: '2026-09-25', putCallOIRatio: 0.91,
  callVolume: 50_000, putVolume: 41_000, callOI: 250_000, putOI: 227_500,
};

/** A card's value line, the card found by its label: everything a screen reader hears of the reading itself. */
const valueOf = (label) => screen.getByText(label).closest('.rounded-xl').querySelector('p');

/** A card's label row: the label, then its badge. */
const labelRowOf = (label) => screen.getByText(label).parentElement;

describe('KPICards', () => {
  it.each([
    [0.5, '0.50, bullish'],
    [PUT_CALL.bullishBelow, '0.70, neutral'],
    [0.82, '0.82, neutral'],
    [PUT_CALL.bearishAbove, '1.00, neutral'],
    [1.2, '1.20, bearish'],
  ])('says the band of a put/call ratio of %s in words: %s', (putCallRatio, text) => {
    render(<KPICards kpis={{ ...KPIS, putCallRatio }} loading={false} />);
    expect(valueOf('Put / Call Ratio').textContent).toBe(text);
  });

  it.each([
    [1_250_000, '$1.25M, call-heavy'],
    [0, '$0.00, call-heavy'], // the bull colour, as the chat context's call-heavy, takes zero
    [-2_000_000, '-$2.00M, put-heavy'],
  ])('says which side premium of %s leans to in words: %s', (netPremium, text) => {
    render(<KPICards kpis={{ ...KPIS, netPremium }} loading={false} />);
    expect(valueOf('Premium Traded').textContent).toBe(text);
  });

  it('Pin: a reading with no value has no word: no put/call band without call volume, no side without premium', () => {
    render(<KPICards kpis={{ ...KPIS, putCallRatio: null, netPremium: null }} loading={false} />);
    expect(valueOf('Put / Call Ratio').textContent).toBe('—');
    expect(valueOf('Premium Traded').textContent).toBe('—');
  });

  it('expands the EST. and C − P badges: a title for a pointer, the words for a screen reader', () => {
    render(<KPICards kpis={KPIS} loading={false} />);
    for (const [label, abbreviation, expansion] of [
      ['Premium Traded', 'C − P', 'Calls minus puts'],
      ['Dark Pool Vol %', 'EST.', 'Estimate'],
    ]) {
      const badge = screen.getByTitle(expansion);
      expect(badge).toHaveTextContent(abbreviation);
      expect(badge).toHaveAttribute('aria-hidden', 'true'); // read as the expansion, never as "E S T" or "C minus P"
      expect(labelRowOf(label).textContent).toBe(`${label}${abbreviation}${expansion}`);
    }
  });

  it('Pin: each card still shows its label, its value as the text of its own line, and its subtitle', () => {
    render(<KPICards kpis={KPIS} loading={false} />);
    for (const [label, value, subtitle] of [
      ['Premium Traded', '$1.25M', 'C $3.50M · P $2.25M · vol × mid'],
      ['Max Pain', '$100.00', 'Expiry 2026-09-25'],
      ['Dark Pool Vol %', '38.5%', 'Statistical estimate'],
      ['Put / Call Ratio', '0.82', 'Vol: 91.0K · Prem: $5.75M'],
    ]) {
      const line = screen.getByText(value);
      expect(line).toBe(valueOf(label));
      expect(line.nextElementSibling).toHaveTextContent(subtitle);
    }
  });

  it('Pin: loading, under axe', async () => {
    const { container } = render(<KPICards kpis={null} loading />);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(12);
    await expectNoAxeViolations(container);
  });

  it('Pin: filled, under axe', async () => {
    const { container } = render(<KPICards kpis={KPIS} loading={false} />);
    await expectNoAxeViolations(container);
  });
});
