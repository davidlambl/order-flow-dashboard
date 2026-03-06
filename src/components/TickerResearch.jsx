// src/components/TickerResearch.jsx
import { useState, useEffect } from 'react';
import {
  Newspaper, Calendar, TrendingUp, ChevronDown, ChevronRight,
  ExternalLink, Clock, Globe,
} from 'lucide-react';
import { getPreference, setPreference } from '../lib/store';

function timeAgo(isoDate) {
  if (!isoDate) return '';
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function SentimentDot({ value }) {
  if (value == null) return null;
  const color = value > 0
    ? 'bg-[var(--color-bull)]'
    : value < 0
    ? 'bg-[var(--color-bear)]'
    : 'bg-[var(--color-text-muted)]';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} shrink-0`} />;
}

function LoadingSkeleton({ rows = 3 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-4 w-full rounded" />
      ))}
    </div>
  );
}

function NewsPanel({ news, loading }) {
  if (loading) return <LoadingSkeleton rows={4} />;

  if (!news || news.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] italic">
        No recent news available. Add a Finnhub API key in Settings.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1">
      {news.map((n, i) => (
        <a
          key={i}
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex gap-2 items-start p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <SentimentDot value={n.sentiment} />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-[var(--color-text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--color-accent)] transition-colors">
              {n.headline}
            </p>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--color-text-muted)]">
              <span>{n.source}</span>
              <span className="flex items-center gap-0.5">
                <Clock size={8} />
                {timeAgo(n.datetime)}
              </span>
            </div>
          </div>
          <ExternalLink size={10} className="text-[var(--color-text-muted)] shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>
      ))}
    </div>
  );
}

function EarningsCard({ earnings, loading }) {
  if (loading) return <LoadingSkeleton rows={3} />;

  if (!earnings) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] italic">
        No earnings data available.
      </p>
    );
  }

  const daysTo = earnings.date
    ? (() => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const target = new Date(earnings.date + 'T00:00:00'); // local midnight
        return Math.round((target - today) / 86_400_000);
      })()
    : null;

  const isImminent = daysTo != null && daysTo >= 0 && daysTo <= 7;
  const isPast = daysTo != null && daysTo < 0;

  return (
    <div className="space-y-2">
      <div className={`flex items-center gap-2 p-2.5 rounded-lg border ${
        isImminent
          ? 'bg-[var(--color-warn)]/10 border-[var(--color-warn)]/30'
          : 'bg-[var(--color-surface-2)] border-[var(--color-border-subtle)]'
      }`}>
        <Calendar size={14} className={isImminent ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'} />
        <div>
          <p className="text-xs font-semibold text-[var(--color-text-primary)]">
            {earnings.date || 'TBD'}
          </p>
          <p className={`text-[10px] font-medium ${
            isImminent ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'
          }`}>
            {daysTo === 0
              ? 'Reporting TODAY'
              : daysTo === 1
              ? 'Reporting TOMORROW'
              : daysTo != null && daysTo > 0
              ? `${daysTo} days away`
              : isPast
              ? `Reported ${Math.abs(daysTo)} day${Math.abs(daysTo) !== 1 ? 's' : ''} ago`
              : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {earnings.epsEstimate != null && (
          <div className="p-2 rounded-lg bg-[var(--color-surface-2)]">
            <p className="text-[10px] text-[var(--color-text-muted)]">EPS Est.</p>
            <p className="font-semibold text-[var(--color-text-primary)] tabular-nums">
              ${earnings.epsEstimate.toFixed(2)}
            </p>
            {earnings.epsActual != null && (
              <p className={`text-[10px] font-medium tabular-nums ${
                earnings.epsActual >= earnings.epsEstimate ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'
              }`}>
                Actual: ${earnings.epsActual.toFixed(2)}
              </p>
            )}
          </div>
        )}
        {earnings.revenueEstimate != null && (
          <div className="p-2 rounded-lg bg-[var(--color-surface-2)]">
            <p className="text-[10px] text-[var(--color-text-muted)]">Rev. Est.</p>
            <p className="font-semibold text-[var(--color-text-primary)] tabular-nums">
              ${(earnings.revenueEstimate / 1e9).toFixed(2)}B
            </p>
            {earnings.revenueActual != null && (
              <p className={`text-[10px] font-medium tabular-nums ${
                earnings.revenueActual >= earnings.revenueEstimate ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'
              }`}>
                Actual: ${(earnings.revenueActual / 1e9).toFixed(2)}B
              </p>
            )}
          </div>
        )}
      </div>

      {earnings.surprise != null && (
        <div className={`text-[10px] font-medium px-2 py-1 rounded text-center ${
          earnings.surprise >= 0
            ? 'text-[var(--color-bull)] bg-[var(--color-bull)]/10'
            : 'text-[var(--color-bear)] bg-[var(--color-bear)]/10'
        }`}>
          {earnings.surprise >= 0 ? '+' : '-'}${Math.abs(earnings.surprise).toFixed(2)} {earnings.surprise >= 0 ? 'beat' : 'miss'}
        </div>
      )}
    </div>
  );
}

function RatingBar({ consensus }) {
  const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = consensus || {};
  const total = strongBuy + buy + hold + sell + strongSell;
  if (total === 0) return null;

  const segments = [
    { count: strongBuy, color: 'var(--color-bull)', label: 'Strong Buy' },
    { count: buy, color: 'var(--color-bull)', label: 'Buy', opacity: 0.6 },
    { count: hold, color: 'var(--color-warn)', label: 'Hold' },
    { count: sell, color: 'var(--color-bear)', label: 'Sell', opacity: 0.6 },
    { count: strongSell, color: 'var(--color-bear)', label: 'Strong Sell' },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded-full overflow-hidden">
        {segments.map((s, i) => (
          <div
            key={i}
            className="transition-all duration-300"
            style={{
              width: `${(s.count / total) * 100}%`,
              backgroundColor: s.color,
              opacity: s.opacity || 1,
            }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--color-text-muted)]">
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <span
              className="w-1.5 h-1.5 rounded-sm"
              style={{ backgroundColor: s.color, opacity: s.opacity || 1 }}
            />
            {s.count}
          </span>
        ))}
      </div>
    </div>
  );
}

function AnalystPanel({ analysts, spotPrice, loading }) {
  if (loading) return <LoadingSkeleton rows={3} />;

  if (!analysts) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] italic">
        No analyst data available.
      </p>
    );
  }

  const pt = analysts.priceTarget || {};
  const displayPrice = pt.median ?? pt.mean;
  const hasAnyTarget = pt.mean != null || pt.median != null || pt.high != null || pt.low != null;
  const upside = displayPrice && spotPrice
    ? ((displayPrice - spotPrice) / spotPrice * 100).toFixed(1)
    : null;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
          Ratings
        </div>
        <RatingBar consensus={analysts.consensus} />
      </div>

      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
          Price targets
        </div>
        {hasAnyTarget ? (
          <>
            {displayPrice != null && (
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {pt.median != null ? 'Median' : 'Mean'}
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-bold text-[var(--color-text-primary)] tabular-nums">
                    ${displayPrice.toFixed(2)}
                  </span>
                  {upside != null && spotPrice && (
                    <span className={`text-[10px] font-semibold tabular-nums ${
                      Number(upside) >= 0 ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'
                    }`}>
                      {Number(upside) > 0 ? '+' : ''}{upside}%
                    </span>
                  )}
                </div>
              </div>
            )}
            {pt.mean != null && pt.median != null && (
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Mean: ${pt.mean.toFixed(2)}
            </div>
          )}

          {pt.low != null && pt.high != null && (
            <div className="relative h-2 rounded-full bg-[var(--color-surface-2)]">
              {spotPrice && pt.low != null && pt.high != null && (
                <div
                  className="absolute top-0 h-full w-0.5 bg-[var(--color-warn)] rounded"
                  style={{
                    left: `${Math.max(0, Math.min(100, ((spotPrice - pt.low) / (pt.high - pt.low)) * 100))}%`,
                  }}
                  title={`Spot: $${spotPrice.toFixed(2)}`}
                />
              )}
              <div
                className="absolute top-0 h-full w-1 bg-[var(--color-accent)] rounded"
                style={{
                  left: `${Math.max(0, Math.min(100, (((pt.mean ?? pt.median) - pt.low) / (pt.high - pt.low)) * 100))}%`,
                }}
                title={`${pt.mean != null ? `Mean: $${pt.mean.toFixed(2)}` : ''}${pt.mean != null && pt.median != null ? ' ' : ''}${pt.median != null ? `Median: $${pt.median.toFixed(2)}` : ''}`}
              />
            </div>
          )}

          <div className="flex justify-between text-[10px] text-[var(--color-text-muted)] tabular-nums">
            <span>Low: ${pt.low?.toFixed(2) ?? '—'}</span>
            <span>High: ${pt.high?.toFixed(2) ?? '—'}</span>
          </div>
          </>
        ) : (
          <p className="text-[11px] text-[var(--color-text-muted)] italic">
            No price target data for this symbol.
          </p>
        )}
      </div>
    </div>
  );
}

function MarketIndicesStrip({ quotes }) {
  if (!quotes || Object.keys(quotes).length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(quotes).map(([sym, q]) => {
        const positive = (q.change || 0) >= 0;
        return (
          <div
            key={sym}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]"
          >
            <span className="text-[10px] font-semibold text-[var(--color-text-secondary)]">{sym}</span>
            <span className="text-[10px] font-medium tabular-nums text-[var(--color-text-primary)]">
              {q.price != null ? (sym === 'VIX' ? q.price.toFixed(2) : `$${q.price.toFixed(2)}`) : '—'}
            </span>
            <span className={`text-[9px] font-medium tabular-nums ${positive ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'}`}>
              {positive ? '+' : ''}{(q.changePct || 0).toFixed(2)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MarketHeadlines({ news }) {
  if (!news || news.length === 0) return (
    <p className="text-[11px] text-[var(--color-text-muted)] italic">No market news available</p>
  );
  return (
    <div className="space-y-1.5">
      {news.map((n, i) => (
        <a
          key={i}
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-2 group py-1 first:pt-0"
        >
          <span className="flex-1 text-[11px] text-[var(--color-text-secondary)] leading-snug group-hover:text-[var(--color-text-primary)] transition-colors line-clamp-2">
            {n.headline}
          </span>
          <div className="flex items-center gap-1 shrink-0 pt-0.5">
            {n.datetime && (
              <span className="text-[9px] text-[var(--color-text-muted)]">{timeAgo(n.datetime)}</span>
            )}
            <ExternalLink size={8} className="text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </a>
      ))}
    </div>
  );
}

export default function TickerResearch({ context, loading, spotPrice }) {
  const [open, setOpen] = useState(() => {
    const saved = getPreference('section_research');
    return saved != null ? saved : true;
  });

  useEffect(() => {
    const handler = () => {
      const saved = getPreference('section_research');
      if (saved != null) setOpen(saved);
    };
    window.addEventListener('store-changed', handler);
    return () => window.removeEventListener('store-changed', handler);
  }, []);

  const toggle = () => setOpen((v) => {
    const next = !v;
    setPreference('section_research', next);
    return next;
  });

  const hasTickerData = context && (
    (context.news?.length > 0) || context.earnings || context.analysts
  );
  const hasMarketData = context && (
    context.marketQuotes || (context.marketNews?.length > 0)
  );
  const hasData = hasTickerData || hasMarketData;
  const showEmpty = !loading && !hasData;

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] fade-in">
      <button
        onClick={toggle}
        className="flex items-center gap-2 w-full px-4 py-3 text-left"
      >
        {open
          ? <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
          : <ChevronRight size={14} className="text-[var(--color-text-muted)]" />
        }
        <TrendingUp size={14} className="text-[var(--color-accent)]" />
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Research
        </h3>
        {loading && (
          <span className="text-[10px] text-[var(--color-text-muted)] animate-pulse">
            Loading...
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4">
          {showEmpty ? (
            <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
              Add a Finnhub API key in Settings to see news, earnings, and analyst data.
            </p>
          ) : (<>
            {hasTickerData && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    <Newspaper size={10} />
                    News
                  </div>
                  <NewsPanel news={context?.news} loading={loading} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    <Calendar size={10} />
                    Earnings
                  </div>
                  <EarningsCard earnings={context?.earnings} loading={loading} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    <TrendingUp size={10} />
                    Analyst Consensus
                  </div>
                  <AnalystPanel analysts={context?.analysts} spotPrice={spotPrice} loading={loading} />
                </div>
              </div>
            )}

            {hasMarketData && (
              <>
                {hasTickerData && (
                  <div className="border-t border-[var(--color-border-subtle)] my-3" />
                )}
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    <Globe size={10} />
                    Market Overview
                  </div>
                  <MarketIndicesStrip quotes={context?.marketQuotes} />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                        Market Headlines
                      </div>
                      <MarketHeadlines news={context?.marketNews} />
                    </div>
                  </div>
                </div>
              </>
            )}
          </>)}
        </div>
      )}
    </div>
  );
}
