// src/components/Header.jsx
// The dashboard's top bar: the title, the ticker search with the refresh and auto-refresh buttons, the price and the
// earnings badge, then the account badges, the data source and Settings. On a narrow screen it wraps rather than
// overflows, and what a screen reader needs is there at every width: where a class hides it below a breakpoint it is
// visually hidden (sr-only) instead of display: none (the title, the page's one h1; the PRO or TRIAL badge's text), and
// the data source, an icon below sm, is a status in words.
import { useId, useRef, useState } from 'react';
import { Search, RefreshCw, Activity, Wifi, WifiOff, ShieldCheck, LogOut, Settings, Calendar } from 'lucide-react';
import { daysUntil, formatPrice } from '../lib/format.js';
import { parseTicker } from '../lib/ticker.js';
import { useCountdown } from '../hooks/useCountdown.js';
import { useNow } from '../hooks/useNow.js';
import { useMarket } from '../contexts/MarketContext.js';
import { useAuth } from '../contexts/AuthContext.js';

// Why getMarketData served CBOE although a Tradier key was available (payload `fallbackReason`).
const FALLBACK_REASON_TEXT = {
  'tradier-timeout': 'Tradier timed out',
  'tradier-error': 'Tradier request failed',
  'tradier-no-spot': 'Tradier returned no spot price',
  'tradier-no-options': 'Tradier returned no options',
};

// The line under the search when it refuses an entry: what a ticker looks like (src/lib/ticker.ts, the server's rule).
const TICKER_HINT = 'Use 1 to 10 letters or digits, like BRK.B or RDS-A.';

/**
 * An earnings date ('YYYY-MM-DD') as a screen reader should say it, 'Thursday, October 15': a fixed date on the local
 * calendar, parsed as daysUntil parses it (a bare date would be UTC midnight); it never reads the clock.
 */
function spokenDate(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// The auto-refresh countdown lives in its own leaf: it re-renders every second, Header and App do not (F12).
function RefreshCountdown({ nextRefreshAt, refreshMs }) {
  const secondsLeft = useCountdown(nextRefreshAt, refreshMs / 1000);
  if (secondsLeft <= 0) return 'Auto';
  return (
    <>
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-bull)] opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[var(--color-bull)]" />
      </span>
      {secondsLeft}s
    </>
  );
}

// The ticker field, keyed on the ticker by Header (<TickerSearch key={ticker}>): a new ticker, from a submit here or
// a change elsewhere, mounts a fresh field seeded with it, so nothing syncs the input state in an effect after the
// fact, and a refusal's line cannot outlive the ticker it was about. Only the input group, its form and that line are
// in here; the refresh and auto-refresh buttons sit beside it in Header, where the remount never reaches them or the
// countdown.
// A submit is checked against the server's rule (parseTicker): an entry every function would refuse is not sent; the
// field turns aria-invalid, keeps the focus, and is described by one line (role="alert") until the next keystroke. An
// empty entry does nothing. The line is positioned against the header (the nearest positioned ancestor: the form and
// the groups around it are static): below the header's bottom edge, even when it has wrapped onto two rows, and from
// the field's left edge (its static position), as wide as it needs up to the header's right edge, wrapping past it. So
// it never moves the header's height, the buttons beside the field or the page below, and is never cut off.
function TickerSearch({ ticker, setTicker }) {
  const [input, setInput] = useState(ticker);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef(null);
  const hintId = useId();

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim()) {
      const next = parseTicker(input);
      if (!next) {
        setInvalid(true); // not sent; the focus stays in the field, to correct the entry
        return;
      }
      if (next !== ticker) setTicker(next);
    }
    inputRef.current?.blur();
  };

  return (
    <form onSubmit={handleSubmit}>
      <div
        className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 rounded-lg border transition-all duration-200 ${
          focused
            ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] ring-1 ring-[var(--color-accent)]/30'
            : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
        }`}
      >
        <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
        {/* py-0.5 makes the field a 24 px target; the group's py-1 (was py-1.5) keeps the group's height. */}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value.toUpperCase());
            setInvalid(false);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Ticker"
          spellCheck={false}
          className="w-16 sm:w-20 py-0.5 bg-transparent text-sm font-mono font-semibold text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
          aria-label="Stock ticker symbol"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? hintId : undefined}
        />
      </div>
      {invalid && (
        <p
          id={hintId}
          role="alert"
          className="absolute top-full z-10 mt-1 mr-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[11px] text-[var(--color-bear-text)] shadow-lg"
        >
          {TICKER_HINT}
        </p>
      )}
    </form>
  );
}

export default function Header({ onOpenSettings }) {
  const {
    ticker, setTicker, refresh, loading, usingMock, data, tickerContext, autoRefresh, nextRefreshAt, refreshMs,
    optionsMarketOpen, toggleAutoRefresh, liveQuote,
  } = useMarket();
  const { isPremium, tokenTier, daysLeft, signedIn, signOut } = useAuth();
  // The earnings badge counts days on this clock rather than a Date read during render, so render stays pure and the
  // count turns over within a minute of midnight while the page sits idle; the tick re-renders Header, not App.
  const now = useNow(60_000);
  const toggleId = useId();
  const toggleActionId = useId();
  const earnings = tickerContext?.earnings;
  const spotPrice = data?.spotPrice;

  const timeStr = data?.lastUpdated
    ? new Date(data.lastUpdated).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '\u2014';

  const fallbackText = !usingMock && data?.fallbackReason
    ? FALLBACK_REASON_TEXT[data.fallbackReason] || data.fallbackReason
    : null;
  const cboeColorClass = fallbackText ? 'text-[var(--color-warn)]' : 'text-[var(--color-accent)]';
  // The data source as one sentence for a screen reader, at every width: the label shown from sm up, then what its
  // tooltip says, in words ("Data source: CBOE, 15-min delayed, fallback: Tradier timed out"). `data` keeps the last
  // good payload through a background refresh and a ticker switch (useMarketData), so the sentence changes only when the
  // source does, and the status speaks only then.
  const [sourceLabel, sourceWords] = usingMock ? ['DEMO', 'simulated data']
    : data?.provider === 'tradier' ? ['LIVE', 'Tradier, real-time']
      : data?.provider === 'tradier-sandbox' ? ['SANDBOX', 'Tradier sandbox, delayed']
        : ['CBOE', data?.delay || 'delayed'];
  const sourceSentence = `Data source: ${sourceLabel}, ${sourceWords}${fallbackText ? `, fallback: ${fallbackText}` : ''}`;

  return (
    // Three groups that wrap onto a second row instead of overflowing. No column gap, so a row wraps only where its
    // groups would otherwise not fit; the two auto margins share the free space as justify-between did on one row, and
    // keep the last group at the right on a row of its own. `relative` positions the search's validation line.
    <header className="relative flex flex-wrap items-center gap-y-2 px-3 sm:px-5 py-2 sm:py-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
      {/* Logo */}
      <div className="flex items-center gap-2 sm:gap-3">
        <div className="flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-[var(--color-accent)] text-white">
          <Activity size={16} strokeWidth={2.5} className="sm:w-[18px] sm:h-[18px]" />
        </div>
        {/* The page's one h1 at every width: visually hidden below sm, not display: none. */}
        <div className="sr-only sm:not-sr-only">
          <h1 className="text-sm font-semibold tracking-tight text-[var(--color-text-primary)] leading-none">
            Order Flow
          </h1>
          <p className="text-[11px] text-[var(--color-text-muted)] tracking-wide uppercase mt-0.5">
            Institutional Dashboard
          </p>
        </div>
      </div>

      {/* Search + Price */}
      <div className="ml-auto flex items-center gap-2 sm:gap-4">
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
        {/* The search is keyed on the ticker (TickerSearch); the two buttons beside it outlive a ticker change. */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <TickerSearch key={ticker} ticker={ticker} setTicker={setTicker} />
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="p-1.5 sm:p-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-all duration-200 disabled:opacity-40"
            aria-label="Refresh data"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>

          {/* Auto-refresh toggle. Its name is its action, then the text it shows ("Disable auto-refresh, 42s",
              "…, Paused", "Enable auto-refresh, Auto"), so someone who says what they see can press it (WCAG 2.5.3):
              aria-labelledby reads the hidden action phrase, then the button itself, whose content gives the text
              (the countdown leaf's included, with no render here). No aria-pressed: the name states the action. */}
          <span id={toggleActionId} hidden>
            {autoRefresh ? 'Disable auto-refresh,' : 'Enable auto-refresh,'}
          </span>
          <button
            id={toggleId}
            type="button"
            onClick={toggleAutoRefresh}
            aria-labelledby={`${toggleActionId} ${toggleId}`}
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
                ? `Auto-refreshing every ${Math.round(refreshMs / 1000)}s \u2014 click to pause`
                : 'Enable auto-refresh during options trading hours'
            }
          >
            {autoRefresh && optionsMarketOpen && !usingMock && nextRefreshAt != null ? (
              <RefreshCountdown nextRefreshAt={nextRefreshAt} refreshMs={refreshMs} />
            ) : autoRefresh && !optionsMarketOpen ? (
              'Paused'
            ) : (
              'Auto'
            )}
          </button>
        </div>

        {/* Earnings badge */}
        {earnings?.date && (() => {
          const daysTo = daysUntil(earnings.date, now);
          if (daysTo == null || daysTo < 0 || daysTo > 7) return null;
          // The date is text inside the badge (hidden with it below lg), not in the tooltip alone. The tooltip sits on
          // the icon and the label, the badge's text as before.
          return (
            <span
              className="hidden lg:flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-[var(--color-warn)]/10 text-[var(--color-warn)] border-[var(--color-warn)]/30"
            >
              <span className="flex items-center gap-1" title={`Earnings: ${earnings.date}`}>
                <Calendar size={10} />
                {daysTo === 0 ? 'Earnings TODAY' : daysTo === 1 ? 'Earnings TOMORROW' : `Earnings in ${daysTo}d`}
              </span>
              <span className="sr-only">{`, on ${spokenDate(earnings.date)}`}</span>
            </span>
          );
        })()}
      </div>

      {/* Status */}
      <div className="ml-auto flex items-center gap-2 sm:gap-3 text-xs text-[var(--color-text-muted)]">
        {(isPremium || signedIn) && (
          <div className="flex items-center gap-1.5">
            {isPremium && (
              <span
                className="flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-semibold border"
                style={{
                  color: tokenTier === 'pro' ? 'var(--color-accent-text)' : 'var(--color-purple-text)',
                  backgroundColor: tokenTier === 'pro' ? 'rgba(59,130,246,0.1)' : 'var(--color-purple-bg)',
                  borderColor: tokenTier === 'pro' ? 'rgba(59,130,246,0.2)' : 'rgba(168,85,247,0.2)',
                }}
              >
                <ShieldCheck size={10} />
                <span className="sr-only sm:not-sr-only">{tokenTier === 'pro' ? 'PRO' : `TRIAL${daysLeft ? ` \u00b7 ${daysLeft}d` : ''}`}</span>
              </span>
            )}
            {/* The one sign-out (account, access token and this browser's data); the token alone is
                removed from the Account tab in Settings. 7 px of padding around the 10 px icon: a 24 px target. */}
            {signedIn && (
              <button
                type="button"
                onClick={signOut}
                className="p-[7px] rounded text-[var(--color-text-muted)] hover:text-[var(--color-bear)] transition-colors"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={10} />
              </button>
            )}
          </div>
        )}
        <span className="hidden md:inline tabular-nums">{timeStr}</span>
        {/* The data source, a status that a screen reader reads as one sentence at every width, visually hidden. What a
            mouse user sees and hovers (the icon, the label from sm up, the tooltip) is aria-hidden: the sentence says
            the same, so nothing is read twice, and the tooltip is not the status's name (a status named by its title
            would be read with it). The time above stays out of the status: it changes on every refresh, and a status
            speaks whenever its text changes. */}
        <div role="status" className="flex items-center">
          <span
            aria-hidden="true"
            className="flex items-center gap-1 sm:gap-1.5"
            title={usingMock
              ? 'Using demo data'
              : `${data?.provider || 'CBOE'} \u2014 ${data?.delay || 'delayed'}${fallbackText ? ` \u00b7 fallback: ${fallbackText}` : ''}`}
          >
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
                <Wifi size={12} className={cboeColorClass} />
                <span className={`${cboeColorClass} font-medium hidden sm:inline`}>CBOE</span>
              </>
            )}
          </span>
          <span className="sr-only">{sourceSentence}</span>
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
