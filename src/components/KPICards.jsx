// src/components/KPICards.jsx
import { TrendingUp, TrendingDown, Moon, Crosshair, ArrowRightLeft } from 'lucide-react';
import { formatDollar, formatPct, formatRatio, formatPrice, formatCompact } from '../lib/format';

function KPICard({ label, badge, value, icon: Icon, color, bgColor, subtitle, loading }) {
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
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
            {label}
          </span>
          {badge && (
            <span className="text-[9px] font-semibold uppercase leading-none px-1 py-0.5 rounded bg-[var(--color-surface-3)] text-[var(--color-text-muted)]">
              {badge}
            </span>
          )}
        </div>
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
  // Calls minus puts by volume × mid: which side traded more premium, not buy/sell-signed flow.
  const netPrem = Number.isFinite(k.netPremium) ? k.netPremium : null;
  // null = no call volume (ratio undefined); must not fall into the "< 0.7 = bullish" bucket.
  const pc = Number.isFinite(k.putCallRatio) ? k.putCallRatio : null;

  const cards = [
    {
      label: 'Premium Traded',
      badge: 'C \u2212 P',
      value: formatDollar(k.netPremium),
      icon: netPrem != null && netPrem < 0 ? TrendingDown : TrendingUp,
      color: netPrem == null ? 'var(--color-text-muted)' : netPrem >= 0 ? 'var(--color-bull)' : 'var(--color-bear)',
      bgColor: netPrem == null ? 'var(--color-surface-3)' : netPrem >= 0 ? 'var(--color-bull-bg)' : 'var(--color-bear-bg)',
      subtitle: `C ${formatDollar(k.callPremium)} \u00b7 P ${formatDollar(k.putPremium)} \u00b7 vol \u00d7 mid`,
    },
    {
      label: 'Max Pain',
      value: formatPrice(k.maxPain),
      icon: Crosshair,
      color: 'var(--color-cyan)',
      bgColor: 'var(--color-cyan-bg)',
      subtitle: k.maxPainExpiry
        ? `Expiry ${k.maxPainExpiry}`
        : Number.isFinite(k.maxPain) ? 'Nearest open expiry' : 'No open expiry',
    },
    {
      label: 'Dark Pool Vol %',
      badge: 'EST.',
      value: formatPct(k.darkPoolPct),
      icon: Moon,
      color: 'var(--color-purple)',
      bgColor: 'var(--color-purple-bg)',
      subtitle: Number.isFinite(k.darkPoolPct) ? 'Statistical estimate' : 'No data',
    },
    {
      label: 'Put / Call Ratio',
      value: formatRatio(k.putCallRatio),
      icon: ArrowRightLeft,
      color: pc == null ? 'var(--color-text-muted)' : pc > 1 ? 'var(--color-bear)' : pc < 0.7 ? 'var(--color-bull)' : 'var(--color-warn)',
      bgColor: pc == null ? 'var(--color-surface-3)' : pc > 1 ? 'var(--color-bear-bg)' : pc < 0.7 ? 'var(--color-bull-bg)' : 'var(--color-warn-bg)',
      subtitle: `Vol: ${formatCompact((k.callVolume || 0) + (k.putVolume || 0))} \u00b7 Prem: ${formatDollar((k.callPremium || 0) + (k.putPremium || 0))}`,
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
