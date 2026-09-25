// src/components/GexChart.jsx
import { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { formatCompact, formatPrice } from '../lib/format';
import { gexAxisTicks, referenceLevels } from '../lib/gexChartHelpers';

// Line and label style of each reference level (keys from referenceLevels()).
const LEVEL_STYLES = {
  spot: { label: 'SPOT', color: 'var(--color-warn)', dash: '4 3', width: 1.5, position: 'top', fontSize: 10, fontWeight: 600 },
  basis: { label: 'BASIS', color: 'var(--color-cyan)', dash: '4 3', width: 1.5, position: 'top', fontSize: 10, fontWeight: 600 },
  sma50: { label: '50MA', color: 'var(--color-purple)', dash: '6 3', width: 1, position: 'insideTopRight', fontSize: 9, fontWeight: 500 },
  sma200: { label: '200MA', color: 'var(--color-purple)', dash: '2 3', width: 1, position: 'insideTopRight', fontSize: 9, fontWeight: 500 },
};

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

function OffChartHint() {
  return (
    <span className="text-[10px] opacity-70" title="Outside the strike range shown">
      (off-chart)
    </span>
  );
}

export default function GexChart({ data, loading, spotPrice, costBasis, technicals }) {
  const [showMAs, setShowMAs] = useState(true);
  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 h-[340px]">
        <div className="skeleton h-4 w-40 mb-4" />
        <div className="skeleton h-[280px] w-full" />
      </div>
    );
  }

  // Bars sit on a numeric strike axis, so only rows with a finite strike can be placed, and
  // the axis needs two distinct strikes to have any width.
  const rows = Array.isArray(data) ? data.filter((row) => Number.isFinite(row?.strike)) : [];
  const strikes = rows.map((row) => row.strike);
  const minStrike = Math.min(...strikes);
  const maxStrike = Math.max(...strikes);

  if (strikes.length < 2 || minStrike === maxStrike) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 h-[340px] flex items-center justify-center">
        <p className="text-sm text-[var(--color-text-muted)]">No GEX data available</p>
      </div>
    );
  }

  const ticks = gexAxisTicks(strikes);
  const levels = referenceLevels(
    { spotPrice, costBasis, sma50: technicals?.sma50, sma200: technicals?.sma200, showMAs },
    strikes,
  );
  const spotLevel = levels.find((level) => level.key === 'spot');
  const basisLevel = levels.find((level) => level.key === 'basis');
  const maLevels = levels.filter((level) => level.key === 'sma50' || level.key === 'sma200');
  const masOffChart = maLevels.length > 0 && maLevels.every((level) => !level.visible);

  const hasMAs = technicals?.sma50 != null || technicals?.sma200 != null;

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 fade-in">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Gamma Exposure by Strike
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Dealer hedging levels — positive = price magnet
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 whitespace-nowrap text-xs text-[var(--color-text-muted)]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-[var(--color-bull)]" /> Positive net GEX
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-[var(--color-bear)]" /> Negative net GEX
          </span>
          {spotLevel && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-0.5 bg-[var(--color-warn)]" /> Spot
              {!spotLevel.visible && <OffChartHint />}
            </span>
          )}
          {basisLevel && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-0.5 bg-[var(--color-cyan)]" /> Basis
              {!basisLevel.visible && <OffChartHint />}
            </span>
          )}
          {hasMAs && (
            <button
              onClick={() => setShowMAs((v) => !v)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                showMAs ? 'bg-[var(--color-purple-bg)] text-[var(--color-purple)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              }`}
              title={showMAs ? 'Hide moving averages' : 'Show moving averages'}
            >
              <span className="w-2 h-0.5 bg-[var(--color-purple)]" /> MA
              {masOffChart && <OffChartHint />}
            </button>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280} debounce={100}>
        <BarChart data={rows} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border-subtle)"
            vertical={false}
          />
          {/* Numeric axis: bars sit at their strike, so uneven strike spacing stays visible.
              padding="gap" keeps the edge bars inside the plot; ticks are real strikes. */}
          <XAxis
            dataKey="strike"
            type="number"
            domain={[minStrike, maxStrike]}
            ticks={ticks}
            padding="gap"
            tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
            tickFormatter={(v) => `$${v}`}
            axisLine={{ stroke: 'var(--color-border-subtle)' }}
            tickLine={false}
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
          {/* Each level at its exact price; one outside the strike domain is discarded, not
              pinned to the edge (the legend marks it off-chart). */}
          {levels.map(({ key, value }) => {
            const style = LEVEL_STYLES[key];
            return (
              <ReferenceLine
                key={key}
                x={value}
                ifOverflow="discard"
                stroke={style.color}
                strokeDasharray={style.dash}
                strokeWidth={style.width}
                label={{
                  value: style.label,
                  position: style.position,
                  fill: style.color,
                  fontSize: style.fontSize,
                  fontWeight: style.fontWeight,
                }}
              />
            );
          })}
          <Bar dataKey="gex" radius={[3, 3, 0, 0]} maxBarSize={28}>
            {rows.map((entry) => (
              <Cell
                key={entry.strike}
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
