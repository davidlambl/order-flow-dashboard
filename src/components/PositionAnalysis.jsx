// src/components/PositionAnalysis.jsx
import { useMemo } from 'react';
import { DollarSign, Hash, TrendingUp, TrendingDown, Minus, ChevronRight, AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react';
import { computeRecommendation, computeDualRecommendation, extractPriceLevels, GAP_DUAL_REC_THRESHOLD_PCT } from '../lib/recommend';
import { formatDollar, formatPrice } from '../lib/format';

const SIGNAL_STYLES = {
  BUY: {
    color: 'var(--color-bull)',
    bg: 'var(--color-bull-bg)',
    borderMuted: 'var(--color-bull-border-muted)',
  },
  HOLD: {
    color: 'var(--color-warn)',
    bg: 'var(--color-warn-bg)',
    borderMuted: 'var(--color-warn-border-muted)',
  },
  SELL: {
    color: 'var(--color-bear)',
    bg: 'var(--color-bear-bg)',
    borderMuted: 'var(--color-bear-border-muted)',
  },
};

/**
 * Human-readable source label for liveQuote.source.
 */
function quoteSourceLabel(source) {
  if (!source) return '';
  if (source === 'yahoo-post') return 'After Hours';
  if (source === 'yahoo-pre') return 'Pre-Market';
  if (source === 'yahoo-extended') return 'Extended Hours'; // legacy fallback
  if (source === 'futures-implied') return 'Futures-Implied';
  if (source === 'finnhub') return 'Finnhub';
  return 'Live';
}

/**
 * Relative time string from a millisecond timestamp, e.g. "2m ago".
 */
function relativeTime(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

function PriceLevelBar({ levels }) {
  if (levels.length < 2) return null;

  const prices = levels.map((l) => l.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  if (range === 0) return null;

  const pad = range * 0.08;
  const scaleMin = min - pad;
  const scaleMax = max + pad;
  const scaleRange = scaleMax - scaleMin;
  const toPercent = (price) => ((price - scaleMin) / scaleRange) * 100;

  const positioned = levels
    .map((l) => ({ ...l, pct: Math.max(5, Math.min(95, toPercent(l.price))) }))
    .sort((a, b) => a.price - b.price);

  return (
    <div className="mt-3 mb-2 space-y-2">
      {/* Bar with tick marks only */}
      <div className="relative h-6">
        <div className="absolute left-0 right-0 h-px bg-[var(--color-border)]" style={{ top: 12 }} />
        {positioned.map((level) => (
          <div
            key={level.label}
            className="absolute w-0.5 h-4 rounded-full -translate-x-1/2"
            style={{
              left: `${level.pct}%`,
              top: 8,
              backgroundColor: level.color,
            }}
          />
        ))}
      </div>

      {/* Legend grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {positioned.map((level) => (
          <div key={level.label} className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: level.color }}
            />
            <span className="text-[10px] font-semibold whitespace-nowrap" style={{ color: level.color }}>
              {level.label}
            </span>
            <span className="text-[10px] font-mono tabular-nums" style={{ color: level.color }}>
              {formatPrice(level.price)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecommendationBadge({ rec, isStale, lastUpdated, label, isSecondary, hasWarning }) {
  if (!rec) return null;
  const style = SIGNAL_STYLES[rec.signal];

  let timeAgo = '';
  if (isStale && lastUpdated) {
    const d = new Date(lastUpdated);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours < 24) {
      timeAgo = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } else {
      timeAgo = d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    }
  }

  return (
    <div className={`flex flex-col gap-1.5 ${isSecondary ? 'items-start' : 'items-end'}`}>
      {label && (
        <span className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
          {label}
        </span>
      )}
      <div className="flex items-center gap-2">
        {hasWarning && (
          <AlertTriangle size={14} className="text-[var(--color-warn)] shrink-0" />
        )}
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${isSecondary ? 'border-dashed' : ''}`}
          style={{ 
            backgroundColor: style.bg, 
            borderColor: style.borderMuted 
          }}
        >
          {rec.signal === 'BUY' ? <TrendingUp size={16} style={{ color: style.color }} /> :
           rec.signal === 'SELL' ? <TrendingDown size={16} style={{ color: style.color }} /> :
           <Minus size={16} style={{ color: style.color }} />}
          <span className={`${isSecondary ? 'text-base' : 'text-lg'} font-bold tracking-tight`} style={{ color: style.color }}>
            {rec.signal}
          </span>
        </div>
      </div>
      <span
        className="text-[10px] font-medium px-2 py-0.5 rounded-full border"
        style={{ 
          color: style.color, 
          backgroundColor: style.bg, 
          borderColor: style.borderMuted 
        }}
      >
        {rec.confidence} confidence
      </span>
      {isStale && timeAgo && (
        <span className="text-[9px] text-[var(--color-text-muted)]">
          Based on {timeAgo} data
        </span>
      )}
    </div>
  );
}

/**
 * Yahoo-style price display: shows closing price + after-hours drift when
 * market is closed, or the live price during market hours when available.
 * NOTE: Currently rendered inside PositionAnalysis (premium-gated).
 */
function PriceDisplay({ spotPrice, liveQuote, optionsMarketOpen, dataProvider }) {
  const isDelayed = !dataProvider || dataProvider === 'cboe' || dataProvider === 'tradier-sandbox';
  const closeLabelText = isDelayed ? 'CBOE ~15min delayed' : 'At close';
  const spotNum = Number(spotPrice);
  const hasSpot = Number.isFinite(spotNum) && spotNum > 0;
  const q = liveQuote || {};
  const liveNum = Number(q.current);
  const hasLive = Number.isFinite(liveNum) && liveNum > 0;

  if (!hasSpot && !hasLive) return null;

  const isExtended = q.source === 'yahoo-post' || q.source === 'yahoo-pre' || q.source === 'yahoo-extended' || q.source === 'futures-implied';
  const sourceLabel = quoteSourceLabel(q.source);

  // During market hours (or no extended data): show spot/live as primary price
  if (optionsMarketOpen || !isExtended) {
    const displayPrice = hasLive ? liveNum : spotNum;
    const changePct = q.changePercent;
    const priceUp = (changePct || 0) >= 0;

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
        {isDelayed && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-warn-bg)] text-[var(--color-warn)] font-medium">
            ~15min delayed
          </span>
        )}
        <span className="text-xs text-[var(--color-text-muted)]">
          {relativeTime(q.timestamp)}
        </span>
      </div>
    );
  }

  // After hours: Yahoo-style — close price primary, extended price secondary with drift
  const closePrevClose = q.previousClose;
  const hasCloseChange = Number.isFinite(closePrevClose) && closePrevClose > 0 && hasSpot;
  const closeChangePct = hasCloseChange ? ((spotNum - closePrevClose) / closePrevClose) * 100 : null;
  const closeUp = (closeChangePct || 0) >= 0;

  // Drift = extended price vs close price
  const drift = hasSpot && hasLive ? ((liveNum - spotNum) / spotNum) * 100 : null;
  const driftUp = (drift || 0) >= 0;

  return (
    <div className="flex flex-col gap-1">
      {/* Primary: Close price */}
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-2xl font-bold font-mono tabular-nums text-[var(--color-text-primary)]">
          {formatPrice(spotNum)}
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
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)] font-mono">
          {sourceLabel}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {relativeTime(q.timestamp)}
        </span>
      </div>
    </div>
  );
}

export default function PositionAnalysis({ costBasis, shares, onUpdate, spotPrice, kpis, gexByStrike, loading, lastUpdated, marketOpen, optionsMarketOpen, liveQuote, dataProvider }) {
  // Normalize inputs once so all downstream logic (showDual, hasBasis, P&L) uses consistent numeric values
  const costBasisNum = Number(costBasis);
  const spotNum = Number(spotPrice);
  const liveNum = Number(liveQuote?.current);

  const showDual = useMemo(() => {
    if (!liveQuote || !kpis) return false;
    if (optionsMarketOpen) return false;
    if (!Number.isFinite(costBasisNum) || costBasisNum <= 0) return false;
    if (!Number.isFinite(spotNum) || spotNum <= 0) return false;
    if (!Number.isFinite(liveNum) || liveNum <= 0) return false;
    // Only show dual display when the gap exceeds the threshold
    const gapPct = Math.abs(((liveNum - spotNum) / spotNum) * 100);
    return gapPct >= GAP_DUAL_REC_THRESHOLD_PCT;
  }, [liveQuote, costBasisNum, spotNum, liveNum, kpis, optionsMarketOpen]);

  const dualRec = useMemo(() => {
    if (!showDual) return null;
    return computeDualRecommendation({
      costBasis: costBasisNum,
      shares,
      optionsSnapshotPrice: spotNum,
      livePrice: liveNum,
      kpis,
      gexByStrike,
      optionsMarketOpen: optionsMarketOpen || false,
    });
  }, [showDual, costBasisNum, shares, spotNum, liveNum, kpis, gexByStrike, optionsMarketOpen]);

  const rec = useMemo(() => {
    if (showDual && dualRec) return null;
    if (!Number.isFinite(costBasisNum) || costBasisNum <= 0 || !Number.isFinite(spotNum) || spotNum <= 0) return null;
    return computeRecommendation({ costBasis: costBasisNum, shares, spotPrice: spotNum, kpis, gexByStrike });
  }, [showDual, dualRec, costBasisNum, shares, spotNum, kpis, gexByStrike]);

  const levels = useMemo(() => {
    if (!Number.isFinite(costBasisNum) || costBasisNum <= 0 || !Number.isFinite(spotNum) || spotNum <= 0) return [];
    return extractPriceLevels({ costBasis: costBasisNum, spotPrice: spotNum, kpis, gexByStrike });
  }, [costBasisNum, spotNum, kpis, gexByStrike]);

  const isStale = useMemo(() => {
    if (!lastUpdated) return false;
    const diffMs = Date.now() - new Date(lastUpdated).getTime();
    const diffMinutes = diffMs / (1000 * 60);
    
    // Use optionsMarketOpen since options data updates until 4:15 PM ET
    if (optionsMarketOpen || marketOpen) {
      return diffMinutes > 60;
    } else {
      return diffMinutes > 240;
    }
  }, [lastUpdated, optionsMarketOpen, marketOpen]);

  const hasBasis = Number.isFinite(costBasisNum) && costBasisNum > 0;
  const hasShares = shares != null && shares > 0;
  const hasSpotPrice = Number.isFinite(spotNum) && spotNum > 0;
  const hasLiveQuote = Number.isFinite(liveNum) && liveNum > 0;
  
  const pnlPct = hasBasis && hasSpotPrice ? ((spotNum - costBasisNum) / costBasisNum) * 100 : null;
  const pnlDollars = hasBasis && hasShares && hasSpotPrice ? (spotNum - costBasisNum) * shares : null;
  const pnlUp = (pnlPct || 0) >= 0;

  const livePnlPct = hasBasis && hasLiveQuote ? ((liveNum - costBasisNum) / costBasisNum) * 100 : null;
  const livePnlDollars = hasBasis && hasShares && hasLiveQuote ? (liveNum - costBasisNum) * shares : null;
  const livePnlUp = (livePnlPct || 0) >= 0;

  const handleCostChange = (e) => {
    const val = e.target.value === '' ? null : parseFloat(e.target.value);
    if (val !== null && isNaN(val)) return;
    onUpdate(val, shares);
  };

  const handleSharesChange = (e) => {
    const val = e.target.value === '' ? null : parseFloat(e.target.value);
    if (val !== null && isNaN(val)) return;
    onUpdate(costBasis, val);
  };

  if (loading) return null;

  return (
    <div>
      {/* Price Display */}
      <PriceDisplay
        spotPrice={spotPrice}
        liveQuote={liveQuote}
        optionsMarketOpen={optionsMarketOpen}
        dataProvider={dataProvider}
      />

      {/* Header row: inputs + P&L + recommendation */}
      <div className="flex flex-wrap items-start justify-between gap-4 mt-4">
        {/* Left: Inputs */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]">
              <DollarSign size={12} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                type="number"
                value={costBasis ?? ''}
                onChange={handleCostChange}
                placeholder="Avg cost"
                step="0.01"
                min="0"
                className="w-24 bg-transparent text-sm font-mono tabular-nums text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
              />
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]">
              <Hash size={12} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                type="number"
                value={shares ?? ''}
                onChange={handleSharesChange}
                placeholder="Shares"
                step="any"
                min="0"
                className="w-20 bg-transparent text-sm font-mono tabular-nums text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
              />
            </div>
          </div>
        </div>

        {/* Center: P&L (single or dual) */}
        {hasBasis && hasSpotPrice && !showDual && (
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              Unrealized P&L
            </span>
            <span
              className="text-xl font-bold tabular-nums font-mono"
              style={{ color: pnlUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
            >
              {pnlUp ? '+' : ''}{pnlPct.toFixed(2)}%
            </span>
            {pnlDollars != null && (
              <span
                className="text-xs tabular-nums font-mono"
                style={{ color: pnlUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
              >
                {pnlUp ? '+' : ''}{formatDollar(pnlDollars)}
              </span>
            )}
          </div>
        )}

        {/* Right: Recommendation (single) */}
        {!showDual && (
          <RecommendationBadge rec={rec} isStale={isStale} lastUpdated={lastUpdated} hasWarning={isStale} />
        )}
      </div>

      {/* Dual Price Display when options market closed and gap > 0.5% */}
      {showDual && dualRec && (
        <div className="mt-4 space-y-4">
          {/* Market Status Warning */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-warn-bg)] border border-[var(--color-warn)]/20">
            <AlertTriangle size={14} className="text-[var(--color-warn)] shrink-0" />
            <span className="text-xs text-[var(--color-warn)] font-medium">
              Options market closed — price has moved {dualRec.gapPercent > 0 ? 'up' : 'down'} {Math.abs(dualRec.gapPercent).toFixed(1)}% since last close
            </span>
          </div>

          {/* P&L Comparison */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Options Snapshot P&L */}
            <div className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--color-border)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                  P&L at Close
                </span>
              </div>
              {hasBasis && (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--color-text-muted)]">
                    Unrealized P&L
                  </span>
                  <div className="flex flex-col items-end">
                    <span
                      className="text-base font-bold tabular-nums font-mono"
                      style={{ color: pnlUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
                    >
                      {pnlUp ? '+' : ''}{pnlPct?.toFixed(2)}%
                    </span>
                    {pnlDollars != null && (
                      <span
                        className="text-xs tabular-nums font-mono"
                        style={{ color: pnlUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
                      >
                        {pnlUp ? '+' : ''}{formatDollar(pnlDollars)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Live P&L */}
            <div className="flex flex-col gap-2 p-3 rounded-lg border-2 border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--color-text-primary)] uppercase tracking-wider">
                  P&L (Live)
                </span>
              </div>
              {hasBasis && (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--color-text-muted)]">
                    Unrealized P&L
                  </span>
                  <div className="flex flex-col items-end">
                    <span
                      className="text-base font-bold tabular-nums font-mono"
                      style={{ color: livePnlUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
                    >
                      {livePnlUp ? '+' : ''}{livePnlPct?.toFixed(2)}%
                    </span>
                    {livePnlDollars != null && (
                      <span
                        className="text-xs tabular-nums font-mono"
                        style={{ color: livePnlUp ? 'var(--color-bull)' : 'var(--color-bear)' }}
                      >
                        {livePnlUp ? '+' : ''}{formatDollar(livePnlDollars)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Dual Recommendations */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Primary: Based on Options Data */}
            <div className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--color-border)]">
              <RecommendationBadge
                rec={dualRec.primary}
                isStale={isStale}
                lastUpdated={lastUpdated}
                label="Options Snapshot (delayed)"
                hasWarning={true}
              />
              {dualRec.primary && (
                <div className="mt-2 space-y-1">
                  {dualRec.primary.reasons.slice(0, 3).map((reason, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]">
                      <ChevronRight size={10} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
                      <span>{reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Secondary: If Live Price Holds */}
            {dualRec.secondary && (
              <div className="flex flex-col gap-2 p-3 rounded-lg border border-dashed border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5">
                <RecommendationBadge
                  rec={dualRec.secondary}
                  label="If Live Price Holds"
                  isSecondary={true}
                />
                {dualRec.secondary && (
                  <div className="mt-2 space-y-1">
                    {dualRec.secondary.reasons.slice(0, 3).map((reason, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]">
                        <ChevronRight size={10} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
                        <span>{reason}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[10px] text-[var(--color-text-muted)] italic">
                  Options positioning unknown until market reopens
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Price levels chart */}
      {!showDual && levels.length >= 2 && <PriceLevelBar levels={levels} />}

      {/* Reasons (single mode only) */}
      {!showDual && rec && (
        <div className="mt-3 pt-3 border-t border-[var(--color-border-subtle)]">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
            {rec.reasons.map((reason, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]">
                <ChevronRight size={10} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
                <span>{reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
