// src/components/KPICards.jsx
import { TrendingUp, TrendingDown, Moon, Crosshair, ArrowRightLeft, DollarSign } from 'lucide-react';
import { formatDollar, formatPct, formatRatio, formatPrice, formatCompact } from '../lib/format';

function KPICard({ label, value, icon: Icon, color, bgColor, subtitle, loading }) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
        <div className="skeleton h-3 w-20" />
        <div className="skeleton h-6 w-28" />
        <div className="skeleton h-3 w-16" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] hover:border-[var(--color-border)] transition-colors duration-200 fade-in">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
          {label}
        </span>
        <div
          className="flex items-center justify-center w-7 h-7 rounded-lg"
          style={{ backgroundColor: bgColor }}
        >
          <Icon size={14} style={{ color }} />
        </div>
      </div>
      <p
        className="text-xl font-bold tabular-nums tracking-tight leading-tight"
        style={{ color }}
      >
        {value}
      </p>
      {subtitle && (
        <p className="text-xs text-[var(--color-text-muted)] tabular-nums">{subtitle}</p>
      )}
    </div>
  );
}

/**
 * Derive a human-readable source label from the live quote source field.
 */
function quoteSourceLabel(source) {
  if (!source) return '';
  if (source === 'yahoo-extended') return 'After Hours';
  if (source === 'futures-implied') return 'Futures-Implied';
  if (source === 'finnhub') return 'Finnhub';
  return 'Live';
}

/**
 * Format a relative time string from a timestamp, e.g. "2m ago", "just now".
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

export default function KPICards({ kpis, liveQuote, loading }) {
  if (!kpis && !liveQuote && !loading) return null;

  const k = kpis || {};
  const netPremBullish = (k.netPremium || 0) >= 0;

  // Build the price card from liveQuote data
  const q = liveQuote || {};
  const priceUp = (q.changePercent || 0) >= 0;
  const sourceLabel = quoteSourceLabel(q.source);
  const changePctStr = q.changePercent != null ? `${priceUp ? '+' : ''}${q.changePercent.toFixed(2)}%` : '';
  const priceSubtitle = [sourceLabel, changePctStr, relativeTime(q.timestamp)].filter(Boolean).join(' \u00b7 ');

  const cards = [
    {
      label: 'Price',
      value: q.current ? formatPrice(q.current) : '\u2014',
      icon: DollarSign,
      color: q.current ? (priceUp ? 'var(--color-bull)' : 'var(--color-bear)') : 'var(--color-text-muted)',
      bgColor: q.current ? (priceUp ? 'var(--color-bull-bg)' : 'var(--color-bear-bg)') : 'var(--color-surface)',
      subtitle: priceSubtitle || null,
    },
    {
      label: 'Net Premium',
      value: formatDollar(k.netPremium),
      icon: netPremBullish ? TrendingUp : TrendingDown,
      color: netPremBullish ? 'var(--color-bull)' : 'var(--color-bear)',
      bgColor: netPremBullish ? 'var(--color-bull-bg)' : 'var(--color-bear-bg)',
      subtitle: `C: ${formatDollar(k.callPremium)} \u00b7 P: ${formatDollar(k.putPremium)}`,
    },
    {
      label: 'Max Pain',
      value: formatPrice(k.maxPain),
      icon: Crosshair,
      color: 'var(--color-cyan)',
      bgColor: 'var(--color-cyan-bg)',
      subtitle: 'Nearest expiry target',
    },
    {
      label: 'Dark Pool Vol %',
      value: formatPct(k.darkPoolPct),
      icon: Moon,
      color: 'var(--color-purple)',
      bgColor: 'var(--color-purple-bg)',
      subtitle: k.darkPoolPct > 40 ? 'Above average' : k.darkPoolPct < 30 ? 'Below average' : 'Normal range',
    },
    {
      label: 'Put / Call Ratio',
      value: formatRatio(k.putCallRatio),
      icon: ArrowRightLeft,
      color: k.putCallRatio > 1 ? 'var(--color-bear)' : k.putCallRatio < 0.7 ? 'var(--color-bull)' : 'var(--color-warn)',
      bgColor: k.putCallRatio > 1 ? 'var(--color-bear-bg)' : k.putCallRatio < 0.7 ? 'var(--color-bull-bg)' : 'var(--color-warn-bg)',
      subtitle: `Vol C: ${formatCompact(k.callVolume)} \u00b7 P: ${formatCompact(k.putVolume)}`,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      {cards.map((card) => (
        <KPICard key={card.label} {...card} loading={loading} />
      ))}
    </div>
  );
}
