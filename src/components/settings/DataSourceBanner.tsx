// src/components/settings/DataSourceBanner.tsx
// The Data tab's banner: where the options data comes from, in that source's colours, and what that means for it.

interface DataSourceBannerProps {
  /** MarketContext's dataSource: 'tradier', 'tradier-sandbox' or 'mock'; any other value reads as CBOE. */
  dataSource: string;
}

export default function DataSourceBanner({ dataSource }: DataSourceBannerProps) {
  return (
    <div className={`p-4 rounded-lg border ${
      dataSource === 'tradier'
        ? 'border-[var(--color-bull)]/30 bg-[var(--color-bull-bg)]'
        : dataSource === 'tradier-sandbox'
          ? 'border-[var(--color-cyan)]/30 bg-[var(--color-cyan-bg)]'
          : dataSource === 'mock'
            ? 'border-[var(--color-warn-border-muted)] bg-[var(--color-warn-bg)]'
            : 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5'
    }`}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
          dataSource === 'tradier' ? 'bg-[var(--color-bull)]'
            : dataSource === 'tradier-sandbox' ? 'bg-[var(--color-cyan)]'
            : dataSource === 'mock' ? 'bg-[var(--color-warn)]'
            : 'bg-[var(--color-accent)]'
        }`} />
        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
          {dataSource === 'tradier' ? 'Tradier Real-Time'
            : dataSource === 'tradier-sandbox' ? 'Tradier Sandbox'
            : dataSource === 'mock' ? 'Demo Data'
            : 'CBOE Delayed Quotes'}
        </span>
      </div>
      <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed pl-5">
        {dataSource === 'tradier'
          ? 'Live options chain data via Tradier brokerage API. GEX, Max Pain, and all metrics are real-time.'
          : dataSource === 'tradier-sandbox'
            ? 'Delayed data from Tradier sandbox. Upgrade to a brokerage account for real-time feeds.'
            : dataSource === 'mock'
              ? 'Simulated data for demonstration. Deploy to Netlify for live CBOE data.'
              : 'Options data is ~15 minutes delayed. Add a Tradier API key below for real-time data.'}
      </p>
    </div>
  );
}
