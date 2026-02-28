// src/components/Header.jsx
import { useState, useRef, useEffect } from 'react';
import { Search, RefreshCw, Activity, Wifi, WifiOff } from 'lucide-react';

export default function Header({ ticker, onTickerChange, onRefresh, loading, usingMock, data }) {
  const [input, setInput] = useState(ticker);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setInput(ticker);
  }, [ticker]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const val = input.trim().toUpperCase();
    if (val && val !== ticker) {
      onTickerChange(val);
    }
    inputRef.current?.blur();
  };

  const timeStr = data?.lastUpdated
    ? new Date(data.lastUpdated).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

  const spotPrice = data?.spotPrice;
  const priceChange = data?.priceChange;
  const priceChangePct = data?.priceChangePct;
  const priceUp = (priceChange || 0) >= 0;

  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
      {/* Logo */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--color-accent)] text-white">
          <Activity size={18} strokeWidth={2.5} />
        </div>
        <div className="hidden sm:block">
          <h1 className="text-sm font-semibold tracking-tight text-[var(--color-text-primary)] leading-none">
            Order Flow
          </h1>
          <p className="text-[11px] text-[var(--color-text-muted)] tracking-wide uppercase mt-0.5">
            Institutional Dashboard
          </p>
        </div>
      </div>

      {/* Search + Price */}
      <div className="flex items-center gap-4">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 ${
              focused
                ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] ring-1 ring-[var(--color-accent)]/30'
                : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
            }`}
          >
            <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Ticker"
              spellCheck={false}
              className="w-20 bg-transparent text-sm font-mono font-semibold text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
              aria-label="Stock ticker symbol"
            />
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="p-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-all duration-200 disabled:opacity-40"
            aria-label="Refresh data"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </form>

        {/* Spot price */}
        {spotPrice != null && !loading && (
          <div className="hidden md:flex items-baseline gap-2 tabular-nums">
            <span className="text-base font-bold font-mono text-[var(--color-text-primary)]">
              ${spotPrice.toFixed(2)}
            </span>
            <span
              className={`text-xs font-semibold font-mono ${priceUp ? 'text-[var(--color-bull)]' : 'text-[var(--color-bear)]'}`}
            >
              {priceUp ? '+' : ''}{priceChange?.toFixed(2)} ({priceUp ? '+' : ''}{priceChangePct?.toFixed(2)}%)
            </span>
          </div>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
        <span className="hidden md:inline tabular-nums">{timeStr}</span>
        <div className="flex items-center gap-1.5" title={usingMock ? 'Using demo data' : `${data?.provider || 'CBOE'} — ${data?.delay || 'delayed'}`}>
          {usingMock ? (
            <>
              <WifiOff size={12} className="text-[var(--color-warn)]" />
              <span className="text-[var(--color-warn)] font-medium hidden sm:inline">DEMO</span>
            </>
          ) : data?.provider === 'tradier' ? (
            <>
              <Wifi size={12} className="text-[var(--color-bull)]" />
              <span className="text-[var(--color-bull)] font-medium hidden sm:inline">LIVE</span>
            </>
          ) : data?.provider === 'tradier-sandbox' ? (
            <>
              <Wifi size={12} className="text-[var(--color-cyan)]" />
              <span className="text-[var(--color-cyan)] font-medium hidden sm:inline">SANDBOX</span>
            </>
          ) : (
            <>
              <Wifi size={12} className="text-[var(--color-accent)]" />
              <span className="text-[var(--color-accent)] font-medium hidden sm:inline">CBOE</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
