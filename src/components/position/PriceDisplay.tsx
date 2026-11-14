// src/components/position/PriceDisplay.tsx
// The position panel's price line. The feed names, the quote-source labels and the relative time stay module-local
// (a component file exports only its component: react-refresh). relativeTime is not format.ts's timeAgo, which the
// news lists use: it takes the quote's epoch-ms timestamp rather than an ISO string, reads 'just now' and then seconds
// under a minute, and stops at hours, where timeAgo starts at '0m ago' and goes on to days; folding the two would
// change the quote's label.

import { ArrowDown, ArrowUp } from 'lucide-react';
import { formatPrice } from '../../lib/format.js';
import type { LiveQuote, LiveQuoteSource, MarketProvider } from '../../../types/market.js';

/** Options feed names for the snapshot badges, keyed by data.provider (anything else is CBOE). */
const FEED_NAMES: Record<MarketProvider, string> = {
  cboe: 'CBOE', tradier: 'Tradier', 'tradier-sandbox': 'Tradier sandbox', mock: 'demo data',
};

/**
 * Human-readable label for liveQuote.source, which the server emits as
 * 'yahoo-regular' | 'yahoo-post' | 'yahoo-pre' | 'finnhub'.
 */
function quoteSourceLabel(source: LiveQuoteSource | undefined): string {
  if (!source) return '';
  if (source === 'yahoo-post') return 'After Hours';
  if (source === 'yahoo-pre') return 'Pre-Market';
  if (source === 'finnhub') return 'Finnhub';
  return 'Live';
}

/**
 * Relative time string from a millisecond timestamp, e.g. "2m ago". `now` (epoch ms) comes from
 * useNow, so render never reads the clock and the label keeps moving while the page is idle.
 */
function relativeTime(ts: number | null | undefined, now: number): string {
  if (!ts || !Number.isFinite(now)) return '';
  const diffMs = Math.max(0, now - ts);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

interface PriceDisplayProps {
  /** data.spotPrice: the options feed's latest quote; undefined before the first data. */
  spotPrice: number | undefined;
  /** useLiveQuote's quote, or null until one lands. */
  liveQuote: LiveQuote | null;
  /** The options session is open: the live (or spot) price leads, whatever session the quote is from. */
  optionsMarketOpen: boolean;
  /** data.provider: names the options feed and says whether its prices are delayed. */
  dataProvider: MarketProvider | undefined;
  /** Epoch ms from the panel's clock (useNow): the quote's age follows it, and render never reads the clock. */
  now: number;
}

/**
 * Yahoo-style price display: shows a reference/spot price + after-hours drift
 * when market is closed, or the live price during market hours when available.
 * NOTE: spotPrice is the data provider's latest quote (CBOE delayed or Tradier
 * real-time), not necessarily the official closing price. Each badge describes the
 * price beside it: the live quote's source, or the options feed's delay.
 */
export default function PriceDisplay({
  spotPrice, liveQuote, optionsMarketOpen, dataProvider, now,
}: PriceDisplayProps) {
  const isDelayed = !dataProvider || dataProvider === 'cboe' || dataProvider === 'tradier-sandbox';
  const feedName = (dataProvider && FEED_NAMES[dataProvider]) || 'CBOE';
  const closeLabelText = isDelayed ? `Options snapshot (${feedName}, ~15 min delayed)` : `Options snapshot (${feedName})`;
  const spotNum = Number(spotPrice);
  const hasSpot = Number.isFinite(spotNum) && spotNum > 0;
  const q: Partial<LiveQuote> = liveQuote || {};
  const liveNum = Number(q.current);
  const hasLive = Number.isFinite(liveNum) && liveNum > 0;

  if (!hasSpot && !hasLive) return null;

  const isExtended = q.source === 'yahoo-post' || q.source === 'yahoo-pre';
  const sourceLabel = quoteSourceLabel(q.source);

  // During market hours (or no extended data): show spot/live as primary price
  if (optionsMarketOpen || !isExtended) {
    const displayPrice = hasLive ? liveNum : spotNum;
    const changePct = q.changePercent;
    const priceUp = (changePct || 0) >= 0;
    // The badge labels the price shown: a live quote is never "delayed", whatever the options feed is.
    const badge = hasLive
      ? { text: q.source === 'yahoo-regular' ? 'Live · Yahoo' : sourceLabel, className: 'bg-[var(--color-accent)]/20 text-[var(--color-accent-text)] font-mono' }
      : isDelayed
        ? { text: `~15min delayed (${feedName})`, className: 'bg-[var(--color-warn-bg)] text-[var(--color-warn)] font-medium' }
        : { text: `Spot (${feedName})`, className: 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)] font-medium' };

    return (
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-2xl font-bold font-mono tabular-nums text-[var(--color-text-primary)]">
          {formatPrice(displayPrice)}
        </span>
        {changePct != null && (
          <span
            className="text-sm font-semibold font-mono tabular-nums"
            style={{ color: priceUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
          >
            {priceUp ? '+' : ''}{changePct.toFixed(2)}%
          </span>
        )}
        {badge.text && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.className}`}>
            {badge.text}
          </span>
        )}
        <span className="text-xs text-[var(--color-text-muted)]">
          {relativeTime(q.timestamp, now)}
        </span>
      </div>
    );
  }

  // After hours: Yahoo-style — close price primary, extended price secondary with drift
  // If we have no spot price but do have a live extended price, show the live price as primary
  const primaryPrice = hasSpot ? spotNum : liveNum;
  const closePrevClose = q.previousClose;
  const hasCloseChange = closePrevClose != null && Number.isFinite(closePrevClose) && closePrevClose > 0 && hasSpot;
  const closeChangePct = hasCloseChange ? ((spotNum - closePrevClose) / closePrevClose) * 100 : null;
  const closeUp = (closeChangePct || 0) >= 0;

  // Drift = extended price vs close price (only meaningful when we have both)
  const drift = hasSpot && hasLive ? ((liveNum - spotNum) / spotNum) * 100 : null;
  const driftUp = (drift || 0) >= 0;

  return (
    <div className="flex flex-col gap-1">
      {/* Primary: Close/spot price (falls back to live price if spot unavailable) */}
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-2xl font-bold font-mono tabular-nums text-[var(--color-text-primary)]">
          {formatPrice(primaryPrice)}
        </span>
        {closeChangePct != null && (
          <span
            className="text-sm font-semibold font-mono tabular-nums"
            style={{ color: closeUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
          >
            {closeUp ? '+' : ''}{closeChangePct.toFixed(2)}%
          </span>
        )}
        <span className={`text-xs ${isDelayed ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'}`}>
          {closeLabelText}
        </span>
      </div>

      {/* Secondary: After-hours / extended price with drift */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-base font-bold font-mono tabular-nums text-[var(--color-text-secondary)]">
          {formatPrice(liveNum)}
        </span>
        {drift != null && (
          <span
            className="text-xs font-semibold font-mono tabular-nums flex items-center gap-0.5"
            style={{ color: driftUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
          >
            {driftUp ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
            {driftUp ? '+' : ''}{drift.toFixed(2)}%
          </span>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent-text)] font-mono">
          {sourceLabel}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {relativeTime(q.timestamp, now)}
        </span>
      </div>
    </div>
  );
}
