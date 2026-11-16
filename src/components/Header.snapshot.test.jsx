// src/components/Header.snapshot.test.jsx — the header's compact price when the live quote has failed. With no live
// quote shown, the price printed is the options snapshot's (data.spotPrice): a short visible marker says so, and the
// price's text for a screen reader says where it comes from; in demo mode the price is the demo data's, and both say
// so instead. A failed refresh that keeps an older live quote shown,
// and a quote that has not landed yet, print no marker. Rendered alone under the two app contexts, as Header.test.jsx
// renders it. Tailwind's classes do nothing under jsdom: what sr-only hides is read from the class.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Header from './Header.jsx';
import { withContexts } from '../test/contexts.jsx';
import { expectNoAxeViolations } from '../test/a11y.js';

const CBOE = { provider: 'cboe', delay: '15-min delayed', fallbackReason: null, spotPrice: 100, lastUpdated: '2026-09-25T14:59:30.000Z' };

const header = (market) => withContexts(<Header onOpenSettings={() => {}} />, {
  market: { autoRefresh: true, optionsMarketOpen: true, data: CBOE, ...market },
});

/** The text under `el`, without what `skip` drops; white space collapsed. */
function textOf(el, skip) {
  const walk = (node) => [...node.childNodes].map((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.data;
    if (child.nodeType !== Node.ELEMENT_NODE || skip(child)) return '';
    return ` ${walk(child)} `; // an element's edges separate words, as a block or a gap does
  }).join('');
  return walk(el).replace(/\s+/g, ' ').trim();
}
const hiddenFromReader = (el) => el.hidden || el.getAttribute('aria-hidden') === 'true';
/** What a screen reader reads from the price block. */
const spoken = (el) => textOf(el, hiddenFromReader);
/** What the eye reads from it: sr-only text out. */
const seen = (el) => textOf(el, (child) => hiddenFromReader(child) || child.classList.contains('sr-only'));

/** The compact price block: the element around the printed price. */
const priceBlock = (price) => screen.getByText(price).parentElement;

describe('Header: the compact price after a failed live quote', () => {
  it('marks the snapshot price with a visible word, and says where it comes from to a screen reader', async () => {
    const { container } = render(header({ liveQuote: null, quoteError: 'Yahoo is not answering' }));
    const block = priceBlock('$100.00');
    expect(seen(block)).toBe('$100.00 snapshot');
    expect(spoken(block)).toBe('$100.00 from the options snapshot');
    expect(block.querySelector('[title]')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('Pin: no marker while an older live quote is still shown after a failed refresh', () => {
    render(header({ liveQuote: { current: 101.5, changePercent: 1.5 }, quoteError: 'Yahoo is not answering' }));
    expect(seen(priceBlock('$101.50'))).toBe('$101.50 +1.50%');
    expect(screen.queryByText(/snapshot/)).toBeNull();
  });

  it('Pin: no marker on the snapshot price while the live quote has not landed and nothing failed', () => {
    render(header({ liveQuote: null, quoteError: null }));
    expect(seen(priceBlock('$100.00'))).toBe('$100.00');
    expect(screen.queryByText(/snapshot/)).toBeNull();
  });

  // In demo mode the price printed is the demo payload's, made up: "snapshot" would name a source never loaded.
  it('in demo mode marks the price as demo data, not as the options snapshot', async () => {
    const { container } = render(header({
      usingMock: true, data: { ...CBOE, provider: 'mock', delay: 'simulated' }, liveQuote: null,
      quoteError: 'Yahoo is not answering',
    }));
    const block = priceBlock('$100.00');
    expect(seen(block)).toBe('$100.00 demo');
    expect(spoken(block)).toBe('$100.00 from the demo data');
    expect(screen.queryByText(/snapshot/)).toBeNull();
    await expectNoAxeViolations(container);
  });
});
