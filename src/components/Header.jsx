// src/components/Header.jsx
import { useState, useRef, useEffect } from 'react';
import { Search, RefreshCw, Activity, Wifi, WifiOff, ShieldCheck, LogOut, Settings, Calendar } from 'lucide-react';
import { formatPrice } from '../lib/format';

export default function Header({ ticker, onTickerChange, onRefresh, loading, usingMock, data, isPremium, tokenTier, daysLeft, onLogout, onOpenSettings, earnings, autoRefresh, secondsLeft, optionsMarketOpen, onToggleAutoRefresh, liveQuote, spotPrice }) {
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
    : '\u2014';

  return (
    <header className="flex items-center justify-between px-3 sm:px-5 py-2 sm:py-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
      {/* Logo */}
      <div className="flex items-center gap-2 sm:gap-3">
        <div className="flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-[var(--color-accent)] text-white">
          <Activity size={16} strokeWidth={2.5} className="sm:w-[18px] sm:h-[18px]" />
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
      <div className="flex items-center gap-2 sm:gap-4">
        {/* Compact price — visible to all users */}
        {(() => {
          const liveNum = Number(liveQuote?.current);
          const spotNum = Number(spotPrice);
          const price = Number.isFinite(liveNum) && liveNum > 0 ? liveNum : Number.isFinite(spotNum) && spotNum > 0 ? spotNum : null;
          if (!price) return null;
          const changePct = liveQuote?.changePercent;
          const hasChange = typeof changePct === 'number' && Number.isFinite(changePct);
          const up = hasChange ? changePct >= 0 : null;
          return (
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="text-sm font-bold font-mono tabular-nums text-[var(--color-text-primary)]">
                {formatPrice(price)}
              </span>
              {hasChange && (
                <span
                  className="text-xs font-semibold font-mono tabular-nums"
                  style={{ color: up ? 'var(--color-bull)' : 'var(--color-bear)' }}
                >
                  {up ? '+' : ''}{changePct.toFixed(2)}%
                </span>
              )}
            </div>
          );
        })()}
        <form onSubmit={handleSubmit} className="flex items-center gap-1.5 sm:gap-2">
          <div
            className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-lg border transition-all duration-200 ${
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
              className="w-16 sm:w-20 bg-transparent text-sm font-mono font-semibold text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
              aria-label="Stock ticker symbol"
            />
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="p-1.5 sm:p-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-all duration-200 disabled:opacity-40"
            aria-label="Refresh data"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>

          {/* Auto-refresh toggle */}
          <button
            type="button"
            onClick={onToggleAutoRefresh}
            aria-label={autoRefresh ? 'Disable auto-refresh' : 'Enable auto-refresh'}
            className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1.5 rounded-lg border text-[10px] font-semibold tabular-nums transition-all ${
              autoRefresh && optionsMarketOpen && !usingMock
                ? 'border-[var(--color-bull)]/30 text-[var(--color-bull)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]'
            }`}
            title={
              usingMock ? 'Auto-refresh disabled for demo data'
              : !optionsMarketOpen
                ? 'Options market closed (Mon\u2013Fri 9:30a\u20134:15p ET) \u2014 resumes at open'
              : autoRefresh
                ? `Auto-refreshing every ${data?.provider === 'tradier' ? '30' : '60'}s \u2014 click to pause`
                : 'Enable auto-refresh during options trading hours'
            }
          >
            {autoRefresh && optionsMarketOpen && !usingMock && secondsLeft > 0 ? (
              <>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-bull)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[var(--color-bull)]" />
                </span>
                {secondsLeft}s
              </>
            ) : autoRefresh && !optionsMarketOpen ? (
              'Paused'
            ) : (
              'Auto'
            )}
          </button>
        </form>

        {/* Earnings badge */}
        {earnings?.date && (() => {
          const now = new Date();
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const target = new Date(earnings.date + 'T00:00:00');
          const daysTo = Math.round((target - today) / 86_400_000);
          if (daysTo < 0 || daysTo > 7) return null;
          return (
            <span
              className="hidden lg:flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-[var(--color-warn)]/10 text-[var(--color-warn)] border-[var(--color-warn)]/30"
              title={`Earnings: ${earnings.date}`}
            >
              <Calendar size={10} />
              {daysTo === 0 ? 'Earnings TODAY' : daysTo === 1 ? 'Earnings TOMORROW' : `Earnings in ${daysTo}d`}
            </span>
          );
        })()}
      </div>

      {/* Status */}
      <div className="flex items-center gap-2 sm:gap-3 text-xs text-[var(--color-text-muted)]">
        {isPremium && (
          <div className="flex items-center gap-1.5">
            <span
              className="flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-semibold border"
              style={{
                color: tokenTier === 'pro' ? 'var(--color-accent)' : 'var(--color-purple)',
                backgroundColor: tokenTier === 'pro' ? 'rgba(59,130,246,0.1)' : 'var(--color-purple-bg)',
                borderColor: tokenTier === 'pro' ? 'rgba(59,130,246,0.2)' : 'rgba(168,85,247,0.2)',
              }}
            >
              <ShieldCheck size={10} />
              <span className="hidden sm:inline">{tokenTier === 'pro' ? 'PRO' : `TRIAL${daysLeft ? ` \u00b7 ${daysLeft}d` : ''}`}</span>
            </span>
            <button
              onClick={onLogout}
              className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-bear)] transition-colors"
              title="Sign out"
            >
              <LogOut size={10} />
            </button>
          </div>
        )}
        <span className="hidden md:inline tabular-nums">{timeStr}</span>
        <div className="flex items-center gap-1 sm:gap-1.5" title={usingMock ? 'Using demo data' : `${data?.provider || 'CBOE'} \u2014 ${data?.delay || 'delayed'}`}>
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
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          aria-label="Open settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}
