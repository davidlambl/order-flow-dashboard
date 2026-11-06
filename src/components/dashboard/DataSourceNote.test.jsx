// src/components/dashboard/DataSourceNote.test.jsx — the note under the charts, rendered bare (the leaf reads no
// context): one sentence for each of its four branches, read whole. Demo mode wins over any provider; Tradier and the
// Tradier sandbox have their own; CBOE's is for the CBOE feed and for anything else, before the first load included.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import DataSourceNote from './DataSourceNote.js';

const DEMO = 'Currently showing simulated demo data. Deploy to Netlify and the CBOE data feed activates automatically — no API key needed.';
const TRADIER = 'Real-time data via Tradier brokerage API. GEX, Max Pain, and P/C Ratio computed from live options chain. '
  + 'Net Premium estimated from daily volume × mid price.';
const SANDBOX = 'Data from Tradier sandbox (delayed). Upgrade to a Tradier brokerage account ($10/mo) for real-time feeds. '
  + 'GEX, Max Pain, P/C Ratio, and Net Premium computed from options chain.';
const CBOE = 'Data from CBOE delayed quotes (~15-min delay). Spot price may differ from Yahoo or broker real-time/closing prices. '
  + 'Add a TRADIER_API_KEY for real-time data ($10/mo). Dark Pool % is a statistical estimate.';

/** The note's one sentence, the element that holds it, and the render's unmount. */
function renderNote(props) {
  const { container, unmount } = render(<DataSourceNote {...props} />);
  const note = container.firstChild;
  expect(note.children).toHaveLength(1);
  return { note, text: note.firstChild.textContent, unmount };
}

describe('DataSourceNote', () => {
  it('says demo data in demo mode, whatever the provider', () => {
    for (const provider of ['mock', 'tradier', 'tradier-sandbox', 'cboe', undefined]) {
      const { text, unmount } = renderNote({ usingMock: true, provider });
      expect([provider, text]).toEqual([provider, DEMO]);
      unmount();
    }
  });

  it("names Tradier's real-time feed and the net-premium estimate", () => {
    const { note, text } = renderNote({ usingMock: false, provider: 'tradier' });
    expect(text).toBe(TRADIER);
    expect(note).toHaveClass('text-xs', 'text-[var(--color-text-muted)]', 'pt-2', 'pb-4');
  });

  it("names the Tradier sandbox's delay and the upgrade", () => {
    expect(renderNote({ usingMock: false, provider: 'tradier-sandbox' }).text).toBe(SANDBOX);
  });

  it("names CBOE's delayed quotes for the CBOE feed and before anything has loaded", () => {
    const cboe = renderNote({ usingMock: false, provider: 'cboe' });
    expect(cboe.text).toBe(CBOE);
    cboe.unmount();
    expect(renderNote({ usingMock: false, provider: undefined }).text).toBe(CBOE);
  });
});
