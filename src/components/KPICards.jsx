// src/components/KPICards.jsx
import { TrendingUp, TrendingDown, Moon, Crosshair, ArrowRightLeft } from 'lucide-react';
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

export default function KPICards({ kpis, loading }) {
  if (!kpis && !loading) return null;

  const k = kpis || {};
  const netPremBullish = (k.netPremium || 0) >= 0;

  const cards = [
    {
      label: 'Net Premium',
      value: formatDollar(k.netPremium),
      icon: netPremBullish ? TrendingUp : TrendingDown,
      color: netPremBullish ? 'var(--color-bull)' : 'var(--color-bear)',
      bgColor: netPremBullish ? 'var(--color-bull-bg)' : 'var(--color-bear-bg)',
      subtitle: `C: ${formatDollar(k.callPremium)} · P: ${formatDollar(k.putPremium)}`,
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
      label: 'Max Pain',
      value: formatPrice(k.maxPain),
      icon: Crosshair,
      color: 'var(--color-cyan)',
      bgColor: 'var(--color-cyan-bg)',
      subtitle: 'Nearest expiry target',
    },
    {
      label: 'Put / Call Ratio',
      value: formatRatio(k.putCallRatio),
      icon: ArrowRightLeft,
      color: k.putCallRatio > 1 ? 'var(--color-bear)' : k.putCallRatio < 0.7 ? 'var(--color-bull)' : 'var(--color-warn)',
      bgColor: k.putCallRatio > 1 ? 'var(--color-bear-bg)' : k.putCallRatio < 0.7 ? 'var(--color-bull-bg)' : 'var(--color-warn-bg)',
      subtitle: `Vol C: ${formatCompact(k.callVolume)} · P: ${formatCompact(k.putVolume)}`,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((card) => (
        <KPICard key={card.label} {...card} loading={loading} />
      ))}
    </div>
  );
}
