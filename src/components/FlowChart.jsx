// src/components/FlowChart.jsx
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { formatDollar, formatCompact } from '../lib/format';

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 shadow-lg text-xs">
      <p className="font-semibold text-[var(--color-text-primary)] mb-1">{d?.date}</p>
      <p className="tabular-nums" style={{ color: d?.netPremium >= 0 ? 'var(--color-bull)' : 'var(--color-bear)' }}>
        Daily Net: {formatDollar(d?.netPremium)}
      </p>
      <p className="tabular-nums text-[var(--color-accent)]">
        Cumulative: {formatDollar(d?.cumPremium)}
      </p>
      <div className="flex gap-3 mt-1 text-[var(--color-text-muted)]">
        <span>Calls: {formatCompact(d?.callVolume)}</span>
        <span>Puts: {formatCompact(d?.putVolume)}</span>
      </div>
    </div>
  );
}

export default function FlowChart({ data, loading }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 h-[340px]">
        <div className="skeleton h-4 w-40 mb-4" />
        <div className="skeleton h-[280px] w-full" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 h-[340px] flex items-center justify-center">
        <p className="text-sm text-[var(--color-text-muted)]">No flow history available</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 fade-in">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Net Premium Flow (30d)
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Cumulative institutional premium direction. Trend depends on lookback window.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" /> Cumulative
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[var(--color-bull)]" /> Daily Net
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <defs>
            <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.2} />
              <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-bull)" stopOpacity={0.15} />
              <stop offset="95%" stopColor="var(--color-bull)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border-subtle)"
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
            tickFormatter={(v) => {
              const d = new Date(v);
              return `${d.getMonth() + 1}/${d.getDate()}`;
            }}
            axisLine={{ stroke: 'var(--color-border-subtle)' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
            tickFormatter={formatCompact}
            axisLine={false}
            tickLine={false}
            width={50}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="var(--color-border)" strokeDasharray="3 3" />
          <Area
            type="monotone"
            dataKey="cumPremium"
            stroke="var(--color-accent)"
            fill="url(#cumGrad)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: 'var(--color-accent)', strokeWidth: 0 }}
          />
          <Area
            type="monotone"
            dataKey="netPremium"
            stroke="var(--color-bull)"
            fill="url(#netGrad)"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: 'var(--color-bull)', strokeWidth: 0 }}
            strokeDasharray="4 2"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
