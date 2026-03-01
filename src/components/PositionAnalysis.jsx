// src/components/PositionAnalysis.jsx
import { useMemo } from 'react';
import { DollarSign, Hash, TrendingUp, TrendingDown, Minus, ChevronRight } from 'lucide-react';
import { computeRecommendation, extractPriceLevels } from '../lib/recommend';
import { formatDollar, formatPrice } from '../lib/format';

const SIGNAL_STYLES = {
  BUY: { color: 'var(--color-bull)', bg: 'var(--color-bull-bg)', border: 'var(--color-bull)' },
  HOLD: { color: 'var(--color-warn)', bg: 'var(--color-warn-bg)', border: 'var(--color-warn)' },
  SELL: { color: 'var(--color-bear)', bg: 'var(--color-bear-bg)', border: 'var(--color-bear)' },
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
    .sort((a, b) => a.pct - b.pct);

  const MIN_GAP = 10;
  let lastTopPct = -Infinity;
  for (const item of positioned) {
    if (item.pct - lastTopPct < MIN_GAP) {
      item.below = true;
    } else {
      item.below = false;
      lastTopPct = item.pct;
    }
  }

  const barY = 40;

  return (
    <div className="relative mt-2 mb-1" style={{ height: 88 }}>
      <div className="absolute left-0 right-0 h-px bg-[var(--color-border)]" style={{ top: barY }} />
      {positioned.map((level) => {
        if (level.below) {
          return (
            <div
              key={level.label}
              className="absolute flex flex-col items-center -translate-x-1/2"
              style={{ left: `${level.pct}%`, top: barY - 16 }}
            >
              <div className="w-0.5 h-4 rounded-full" style={{ backgroundColor: level.color }} />
              <span className="text-[10px] font-mono tabular-nums whitespace-nowrap mt-0.5" style={{ color: level.color }}>
                {formatPrice(level.price)}
              </span>
              <span className="text-[9px] font-semibold whitespace-nowrap" style={{ color: level.color }}>
                {level.label}
              </span>
            </div>
          );
        }
        return (
          <div
            key={level.label}
            className="absolute flex flex-col items-center -translate-x-1/2"
            style={{ left: `${level.pct}%`, top: 0 }}
          >
            <span className="text-[9px] font-semibold whitespace-nowrap mb-0.5" style={{ color: level.color }}>
              {level.label}
            </span>
            <span className="text-[10px] font-mono tabular-nums whitespace-nowrap mb-1" style={{ color: level.color }}>
              {formatPrice(level.price)}
            </span>
            <div className="w-0.5 h-4 rounded-full" style={{ backgroundColor: level.color }} />
          </div>
        );
      })}
    </div>
  );
}

function RecommendationBadge({ rec }) {
  if (!rec) return null;
  const style = SIGNAL_STYLES[rec.signal];

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border"
        style={{ backgroundColor: style.bg, borderColor: `${style.border}33` }}
      >
        {rec.signal === 'BUY' ? <TrendingUp size={16} style={{ color: style.color }} /> :
         rec.signal === 'SELL' ? <TrendingDown size={16} style={{ color: style.color }} /> :
         <Minus size={16} style={{ color: style.color }} />}
        <span className="text-lg font-bold tracking-tight" style={{ color: style.color }}>
          {rec.signal}
        </span>
      </div>
      <span
        className="text-[10px] font-medium px-2 py-0.5 rounded-full border"
        style={{ color: style.color, backgroundColor: style.bg, borderColor: `${style.border}33` }}
      >
        {rec.confidence} confidence
      </span>
    </div>
  );
}

export default function PositionAnalysis({ costBasis, shares, onUpdate, spotPrice, kpis, gexByStrike, loading }) {
  const rec = useMemo(() => {
    if (!costBasis || !spotPrice) return null;
    return computeRecommendation({ costBasis, shares, spotPrice, kpis, gexByStrike });
  }, [costBasis, shares, spotPrice, kpis, gexByStrike]);

  const levels = useMemo(() => {
    if (!costBasis || !spotPrice) return [];
    return extractPriceLevels({ costBasis, spotPrice, kpis, gexByStrike });
  }, [costBasis, spotPrice, kpis, gexByStrike]);

  const hasBasis = costBasis != null && costBasis > 0;
  const hasShares = shares != null && shares > 0;
  const pnlPct = hasBasis && spotPrice ? ((spotPrice - costBasis) / costBasis) * 100 : null;
  const pnlDollars = hasBasis && hasShares && spotPrice ? (spotPrice - costBasis) * shares : null;
  const pnlUp = (pnlPct || 0) >= 0;

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
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 fade-in">
      {/* Header row: title + inputs + P&L + recommendation */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/* Left: Title + inputs */}
        <div className="flex flex-col gap-3">
          <div>
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

        {/* Center: P&L */}
        {hasBasis && spotPrice && (
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

        {/* Right: Recommendation */}
        <RecommendationBadge rec={rec} />
      </div>

      {/* Price levels chart */}
      {levels.length >= 2 && <PriceLevelBar levels={levels} />}

      {/* Reasons */}
      {rec && (
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
