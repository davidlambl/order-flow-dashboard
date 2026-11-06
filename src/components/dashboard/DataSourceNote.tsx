// src/components/dashboard/DataSourceNote.tsx
// The note under the charts: where the dashboard's numbers come from and what each feed's figures mean. Demo data
// comes first, whatever the provider says; Tradier and its sandbox have a sentence each; anything else, the provider
// not yet known before the first load included, reads as CBOE's delayed quotes.

import type { MarketData } from '../../../types/market.js';

interface DataSourceNoteProps {
  /** useMarketData's usingMock: the dashboard shows demo data. */
  usingMock: boolean;
  /** data?.provider: the feed the payload came from; undefined before anything has loaded. */
  provider: MarketData['provider'] | undefined;
}

export default function DataSourceNote({ usingMock, provider }: DataSourceNoteProps) {
  return (
    <div className="text-xs text-[var(--color-text-muted)] pt-2 pb-4">
      {usingMock ? (
        <span>
          Currently showing simulated demo data. Deploy to Netlify and the CBOE data feed activates automatically — no API key needed.
        </span>
      ) : provider === 'tradier' ? (
        <span>
          Real-time data via Tradier brokerage API. GEX, Max Pain, and P/C Ratio computed from live options chain.
          Net Premium estimated from daily volume × mid price.
        </span>
      ) : provider === 'tradier-sandbox' ? (
        <span>
          Data from Tradier sandbox (delayed). Upgrade to a Tradier brokerage account ($10/mo) for real-time feeds.
          GEX, Max Pain, P/C Ratio, and Net Premium computed from options chain.
        </span>
      ) : (
        <span>
          Data from CBOE delayed quotes (~15-min delay). Spot price may differ from Yahoo or broker real-time/closing prices.
          Add a TRADIER_API_KEY for real-time data ($10/mo). Dark Pool % is a statistical estimate.
        </span>
      )}
    </div>
  );
}
