// src/components/FlowChart.jsx
// The daily and cumulative premium flow over the history's trading days. For a screen reader the plot is an image
// named by a one-line summary (flowSummary), and the loading card is a status.
import { useId } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { formatDollar, formatCompact, formatShortDate } from '../lib/format';

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 shadow-lg text-xs">
      <p className="font-semibold text-[var(--color-text-primary)] mb-1">{formatShortDate(d?.date)}</p>
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

/**
 * A day as a screen reader should say it: 'September 25' from the digits of 'YYYY-MM-DD', in UTC so the viewer's
 * time zone cannot move it a day (formatShortDate's rule); anything else as the axis prints it.
 */
const SPOKEN_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
function spokenDate(isoDate) {
  const match = typeof isoDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate) : null;
  if (!match) return String(formatShortDate(isoDate));
  return SPOKEN_DAY.format(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/**
 * The plot's text alternative, one sentence from the rows it draws (a trading day each, oldest first): the days it
 * covers, then the latest day's net premium and the cumulative total it brings, in the tooltip's formats.
 */
function flowSummary(data) {
  const first = data[0];
  const last = data[data.length - 1];
  const latest = `net premium ${formatDollar(last.netPremium)} and cumulative premium ${formatDollar(last.cumPremium)}`;
  if (data.length === 1) {
    return `Area chart of premium flow over 1 trading day, ${spokenDate(first.date)}; ${latest}.`;
  }
  return `Area chart of premium flow over ${data.length} trading days, ${spokenDate(first.date)} to `
    + `${spokenDate(last.date)}; on the latest day, ${latest}.`;
}

export default function FlowChart({ data, loading }) {
  const gradId = useId();
  if (loading) {
    // ChartsSkeleton draws this same card while the charts' chunk loads (App.lazy.test.jsx compares the two).
    return (
      <div role="status" className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 h-[340px]">
        <span className="sr-only">Loading…</span>
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
            Cumulative premium traded (calls − puts, volume × mid). Trend depends on lookback window.
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
        {/* On recharts' plot svg, the Tab stop of its arrow-key tooltip: GexChart.jsx says why not on a wrapper. */}
        <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }} role="img" aria-label={flowSummary(data)}>
          <defs>
            <linearGradient id={`cumGrad${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.2} />
              <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`netGrad${gradId}`} x1="0" y1="0" x2="0" y2="1">
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
            tickFormatter={formatShortDate}
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
            fill={`url(#cumGrad${gradId})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: 'var(--color-accent)', strokeWidth: 0 }}
          />
          <Area
            type="monotone"
            dataKey="netPremium"
            stroke="var(--color-bull)"
            fill={`url(#netGrad${gradId})`}
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
