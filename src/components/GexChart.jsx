// src/components/GexChart.jsx
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { formatCompact, formatPrice } from '../lib/format';

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 shadow-lg text-xs">
      <p className="font-semibold text-[var(--color-text-primary)] mb-1">
        Strike: {formatPrice(d?.strike)}
      </p>
      <p className="tabular-nums" style={{ color: d?.gex >= 0 ? 'var(--color-bull)' : 'var(--color-bear)' }}>
        Net GEX: {formatCompact(d?.gex)}
      </p>
      <div className="flex gap-3 mt-1 text-[var(--color-text-muted)]">
        <span>Call: {formatCompact(d?.callGex)}</span>
        <span>Put: {formatCompact(d?.putGex)}</span>
      </div>
    </div>
  );
}

export default function GexChart({ data, loading, spotPrice, costBasis }) {
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
        <p className="text-sm text-[var(--color-text-muted)]">No GEX data available</p>
      </div>
    );
  }

  const spotStrike = spotPrice
    ? data.reduce((closest, s) =>
        Math.abs(s.strike - spotPrice) < Math.abs(closest.strike - spotPrice) ? s : closest
      ).strike
    : null;

  const basisStrike = costBasis
    ? data.reduce((closest, s) =>
        Math.abs(s.strike - costBasis) < Math.abs(closest.strike - costBasis) ? s : closest
      ).strike
    : null;

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 fade-in">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Gamma Exposure by Strike
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Dealer hedging levels — positive = price magnet
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-[var(--color-bull)]" /> Calls
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-[var(--color-bear)]" /> Puts
          </span>
          {spotPrice && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-0.5 bg-[var(--color-warn)]" /> Spot
            </span>
          )}
          {costBasis && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-0.5 bg-[var(--color-cyan)]" /> Basis
            </span>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border-subtle)"
            vertical={false}
          />
          <XAxis
            dataKey="strike"
            tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
            tickFormatter={(v) => `$${v}`}
            axisLine={{ stroke: 'var(--color-border-subtle)' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
            tickFormatter={formatCompact}
            axisLine={false}
            tickLine={false}
            width={55}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
          <ReferenceLine y={0} stroke="var(--color-border)" strokeWidth={1} />
          {spotStrike && (
            <ReferenceLine
              x={spotStrike}
              stroke="var(--color-warn)"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{
                value: 'SPOT',
                position: 'top',
                fill: 'var(--color-warn)',
                fontSize: 10,
                fontWeight: 600,
              }}
            />
          )}
          {basisStrike && basisStrike !== spotStrike && (
            <ReferenceLine
              x={basisStrike}
              stroke="var(--color-cyan)"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{
                value: 'BASIS',
                position: 'top',
                fill: 'var(--color-cyan)',
                fontSize: 10,
                fontWeight: 600,
              }}
            />
          )}
          <Bar dataKey="gex" radius={[3, 3, 0, 0]} maxBarSize={28}>
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={entry.gex >= 0 ? 'var(--color-bull)' : 'var(--color-bear)'}
                fillOpacity={0.8}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
