// src/components/PositionAnalysis.jsx
import { useMemo } from 'react';
import { DollarSign, Hash, TrendingUp, TrendingDown, Minus, ChevronRight, AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react';
import { computeRecommendation, computeDualRecommendation, extractPriceLevels, GAP_DUAL_REC_THRESHOLD_PCT } from '../lib/recommend';
import { formatDollar, formatPrice } from '../lib/format';

const SIGNAL_STYLES = {
  BUY: { color: 'var(--color-bull)', bg: 'var(--color-bull-bg)', border: 'var(--color-bull)', borderMuted: 'rgba(34, 197, 94, 0.2)' },
  HOLD: { color: 'var(--color-warn)', bg: 'var(--color-warn-bg)', border: 'var(--color-warn)', borderMuted: 'rgba(245, 158, 11, 0.2)' },
  SELL: { color: 'var(--color-bear)', bg: 'var(--color-bear-bg)', border: 'var(--color-bear)', borderMuted: 'rgba(239, 68, 68, 0.2)' },
};

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

export default function PositionAnalysis({ costBasis, shares, onUpdate, spotPrice, kpis, gexByStrike, loading, lastUpdated, marketOpen, optionsMarketOpen, liveQuote }) {
  const showDual = useMemo(() => {
    if (!liveQuote || !spotPrice || !costBasis || !kpis) return false;
    if (optionsMarketOpen) return false;
    // Only show dual display when the gap exceeds the threshold
    const gapPct = Math.abs(((liveQuote.current - spotPrice) / spotPrice) * 100);
    return gapPct >= GAP_DUAL_REC_THRESHOLD_PCT;
  }, [liveQuote, spotPrice, costBasis, kpis, optionsMarketOpen]);

  const dualRec = useMemo(() => {
    if (!showDual || !costBasis || !liveQuote) return null;
    return computeDualRecommendation({
      costBasis,
      shares,
      optionsSnapshotPrice: spotPrice,
      livePrice: liveQuote.current,
      kpis,
      gexByStrike,
      optionsMarketOpen: optionsMarketOpen || false,
    });
  }, [showDual, costBasis, shares, spotPrice, liveQuote, kpis, gexByStrike, optionsMarketOpen]);

  const rec = useMemo(() => {
    if (showDual && dualRec) return null;
    if (!costBasis || !spotPrice) return null;
    return computeRecommendation({ costBasis, shares, spotPrice, kpis, gexByStrike });
  }, [showDual, dualRec, costBasis, shares, spotPrice, kpis, gexByStrike]);

  const levels = useMemo(() => {
    if (!costBasis || !spotPrice) return [];
    return extractPriceLevels({ costBasis, spotPrice, kpis, gexByStrike });
  }, [costBasis, spotPrice, kpis, gexByStrike]);

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

  const hasBasis = costBasis != null && costBasis > 0;
  const hasShares = shares != null && shares > 0;
  
  const pnlPct = hasBasis && spotPrice ? ((spotPrice - costBasis) / costBasis) * 100 : null;
  const pnlDollars = hasBasis && hasShares && spotPrice ? (spotPrice - costBasis) * shares : null;
  const pnlUp = (pnlPct || 0) >= 0;

  const livePnlPct = hasBasis && liveQuote?.current ? ((liveQuote.current - costBasis) / costBasis) * 100 : null;
  const livePnlDollars = hasBasis && hasShares && liveQuote?.current ? (liveQuote.current - costBasis) * shares : null;
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
      {/* Header row: title + inputs + prices + recommendations */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/* Left: Title + inputs */}
        <div className="flex flex-col gap-3">
          <div className="hidden">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Position Analysis
            </h3>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Enter your cost basis for a personalized recommendation
            </p>
          </div>
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
        {hasBasis && spotPrice && !showDual && (
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

          {/* Price Comparison */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Options Snapshot Price (delayed CBOE) */}
            <div className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--color-border)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                  Options Snapshot (delayed)
                </span>
                <span className="text-sm font-mono tabular-nums text-[var(--color-text-secondary)]">
                  {formatPrice(dualRec.optionsSnapshotPrice)}
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

            {/* Live Price */}
            <div className="flex flex-col gap-2 p-3 rounded-lg border-2 border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--color-text-primary)] uppercase tracking-wider">
                    Price (Live)
                  </span>
                  {liveQuote?.source && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)] font-mono">
                      {liveQuote.source === 'yahoo-extended' ? 'Extended Hours' : 
                       liveQuote.source === 'futures-implied' ? 'Futures-Implied' :
                       liveQuote.source === 'yahoo-regular' ? 'Yahoo' : 'Finnhub'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {dualRec.gapPercent < 0 ? (
                    <ArrowDown size={12} className="text-[var(--color-bear)]" />
                  ) : (
                    <ArrowUp size={12} className="text-[var(--color-bull)]" />
                  )}
                  <span className="text-sm font-mono tabular-nums text-[var(--color-text-primary)] font-bold">
                    {formatPrice(dualRec.livePrice)}
                  </span>
                  <span
                    className="text-xs font-mono tabular-nums"
                    style={{ color: dualRec.gapPercent < 0 ? 'var(--color-bear)' : 'var(--color-bull)' }}
                  >
                    ({dualRec.gapPercent > 0 ? '+' : ''}{dualRec.gapPercent.toFixed(1)}%)
                  </span>
                </div>
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
                label="Options Close Snapshot"
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
