// src/App.jsx
import { useState, useCallback, useEffect, useRef } from 'react';
import { Sparkles, Target, BarChart2 } from 'lucide-react';
import Header from './components/Header';
import KPICards from './components/KPICards';
import CollapsibleSection from './components/CollapsibleSection';
import PositionAnalysis from './components/PositionAnalysis';
import TickerResearch from './components/TickerResearch';
import GexChart from './components/GexChart';
import FlowChart from './components/FlowChart';
import ChatBot from './components/ChatBot';
import PremiumGate from './components/PremiumGate';
import AppSettings from './components/AppSettings';
import LoginForm from './components/LoginForm';
import SyncChoice from './components/SyncChoice';
import { useMarketData } from './hooks/useMarketData';
import { useTickerContext } from './hooks/useTickerContext';
import { useLiveQuote } from './hooks/useLiveQuote';
import { hasValidToken, getTokenTier, daysRemaining, clearToken, verifyStoredToken, AUTH_EVENT } from './lib/auth';
import { getPosition, setPosition as storeSetPosition, getPreference, setPreference, migrateSessionToLocal, setBackend, LocalStorageBackend, emitStoreChanged, subscribeCrossTab } from './lib/store';
import { supabase } from './lib/supabase';
import { SupabaseBackend } from './lib/SupabaseBackend';
import { signOut, claimLocalData } from './lib/session';

const SIDEBAR_DEFAULT = 384;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 640;

export default function App() {
  // ── Auth state ───────────────────────────────────────────────────────────
  const [authSession, setAuthSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(!!supabase); // only loading if Supabase is configured
  const [authSkipped, setAuthSkipped] = useState(false);

  // Check existing session + listen for auth changes (magic link callback, sign-out)
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAuthSession(session);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Storage backend, keyed on the signed-in account ──────────────────────
  // One SupabaseBackend per account, built when the account changes (StrictMode's second effect run
  // finds the same account and builds nothing); a plain LocalStorageBackend when signed out. Data here
  // that belongs to another account is cleared before the new account's backend exists, and hydrate()
  // never merges on its own: a conflict waits for the user's choice in SyncChoice (roadmap D1, D6).
  const activeUserIdRef = useRef(undefined);
  const backendRef = useRef(null);
  const [syncConflict, setSyncConflict] = useState(null); // { userId, report } from hydrate()
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => {
    migrateSessionToLocal();
    const userId = authSession?.user?.id;
    if (activeUserIdRef.current === userId) return;
    const previous = activeUserIdRef.current;
    activeUserIdRef.current = userId;
    if (!supabase || !userId) {
      backendRef.current = null;
      setBackend(new LocalStorageBackend());
      return;
    }
    // The account changed without a sign-out (a magic link for another user opened in this browser),
    // or this browser still holds the data of an account whose session ended elsewhere: that data must
    // never reach this account, so it is cleared (API keys kept) before this account's backend exists.
    const cleared = claimLocalData(userId, { previousUserId: previous });
    const backend = new SupabaseBackend(new LocalStorageBackend(), userId, supabase);
    setBackend(backend);
    backendRef.current = backend;
    if (cleared) emitStoreChanged();
    backend.hydrate().then((report) => {
      if (activeUserIdRef.current !== userId) return; // signed out or switched while hydrating
      if (report?.status === 'conflict') setSyncConflict({ userId, report });
    });
  }, [authSession]);

  // (No `finally` here: the React Compiler lint skips a whole component that has one.)
  const handleSyncChoice = useCallback(async (choice) => {
    setSyncBusy(true);
    try {
      await backendRef.current?.resolveConflict(choice);
    } catch (err) {
      console.warn('Sync: could not apply the choice:', err?.message ?? err);
    }
    setSyncBusy(false);
    setSyncConflict(null);
  }, []);

  // One sign-out for both logins: Supabase session, access token and this browser's copy of the data.
  const handleSignOut = useCallback(async () => {
    const { signedOut } = await signOut({ client: supabase });
    if (!signedOut) return;
    setSyncConflict(null);
    setAuthSession(null);
    setAuthSkipped(false);
  }, []);

  // Edits made in another tab reach this one as store-changed.
  useEffect(() => subscribeCrossTab(), []);

  const [ticker, setTicker] = useState('AVGO');
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [costBasis, setCostBasis] = useState(null);
  const [shares, setShares] = useState(null);
  const [isPremium, setIsPremium] = useState(() => hasValidToken());
  // Research data needs either an access token or the user's own Finnhub key.
  const [hasFinnhubKey, setHasFinnhubKey] = useState(() => Boolean(getPreference('data_finnhub_key')));
  useEffect(() => {
    const handler = () => setHasFinnhubKey(Boolean(getPreference('data_finnhub_key')));
    window.addEventListener('data-source-changed', handler);
    window.addEventListener('store-changed', handler);
    return () => {
      window.removeEventListener('data-source-changed', handler);
      window.removeEventListener('store-changed', handler);
    };
  }, []);
  const { data, loading, error, usingMock, refresh, autoRefresh, secondsLeft, marketOpen, optionsMarketOpen, toggleAutoRefresh } = useMarketData(ticker);
  const { context: tickerContext, loading: contextLoading } = useTickerContext(ticker, { enabled: isPremium || hasFinnhubKey });
  const { quote: liveQuote, refresh: refreshLiveQuote } = useLiveQuote(ticker);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const n = getPreference('sidebarWidth');
    return typeof n === 'number' && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWRef = useRef(sidebarWidth);
  useEffect(() => { sidebarWRef.current = sidebarWidth; }, [sidebarWidth]);

  const dragCleanupRef = useRef(null);

  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startW = sidebarWRef.current;

    const onMove = (ev) => {
      const delta = startX - ev.clientX;
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + delta)));
    };
    const cleanup = () => {
      setIsResizing(false);
      setPreference('sidebarWidth', sidebarWRef.current);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', cleanup);
  }, []);

  useEffect(() => {
    return () => { if (dragCleanupRef.current) dragCleanupRef.current(); };
  }, []);

  const [tokenTier, setTokenTier] = useState(() => getTokenTier());
  const [daysLeft, setDaysLeft] = useState(() => daysRemaining());

  const refreshAuth = useCallback(() => {
    setIsPremium(hasValidToken());
    setTokenTier(getTokenTier());
    setDaysLeft(daysRemaining());
  }, []);

  // Keep premium state in sync with the stored token: any set/clear (including a
  // server-side rejection during an API call) dispatches AUTH_EVENT. On startup,
  // ask the server whether the stored token is still valid (expired/revoked/re-signed).
  useEffect(() => {
    window.addEventListener(AUTH_EVENT, refreshAuth);
    verifyStoredToken().then(refreshAuth);
    return () => window.removeEventListener(AUTH_EVENT, refreshAuth);
  }, [refreshAuth]);

  const handleLogout = useCallback(() => {
    clearToken();
    setIsPremium(false);
    setTokenTier(null);
    setDaysLeft(null);
  }, []);

  useEffect(() => {
    const saved = getPosition(ticker);
    setCostBasis(saved.costBasis);
    setShares(saved.shares);
  }, [ticker]);

  useEffect(() => {
    const handler = () => {
      const saved = getPosition(ticker);
      setCostBasis(saved.costBasis);
      setShares(saved.shares);
      const w = getPreference('sidebarWidth');
      if (typeof w === 'number' && w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) setSidebarWidth(w);
    };
    window.addEventListener('store-changed', handler);
    return () => window.removeEventListener('store-changed', handler);
  }, [ticker]);

  const updatePosition = useCallback((newCost, newShares) => {
    setCostBasis(newCost);
    setShares(newShares);
    storeSetPosition(ticker, { costBasis: newCost, shares: newShares });
  }, [ticker]);

  const handleTickerChange = useCallback((newTicker) => {
    setTicker(newTicker);
  }, []);

  const handleRefresh = useCallback(() => {
    refresh();
    refreshLiveQuote();
  }, [refresh, refreshLiveQuote]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const dataSource = usingMock ? 'mock' : (data?.provider || 'cboe');

  // Show loading spinner while checking existing session
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-400 border-t-transparent" />
      </div>
    );
  }

  // Show login form if Supabase is available but user hasn't signed in or skipped
  if (supabase && !authSession && !authSkipped) {
    return <LoginForm onSkip={() => setAuthSkipped(true)} />;
  }

  // Keyed on the account: switching accounts without a sign-out remounts everything below, so no
  // component keeps the previous account's data in its state (a streaming reply, an unsaved edit) and
  // writes it through the new account's backend.
  return (
    <div key={authSession?.user?.id ?? 'local'} className="h-full flex flex-col overflow-hidden">
      <Header
        ticker={ticker}
        onTickerChange={handleTickerChange}
        onRefresh={handleRefresh}
        loading={loading}
        usingMock={usingMock}
        data={data}
        isPremium={isPremium}
        tokenTier={tokenTier}
        daysLeft={daysLeft}
        onLogout={handleLogout}
        onOpenSettings={openSettings}
        earnings={tickerContext?.earnings}
        autoRefresh={autoRefresh}
        secondsLeft={secondsLeft}
        optionsMarketOpen={optionsMarketOpen}
        onToggleAutoRefresh={toggleAutoRefresh}
        liveQuote={liveQuote}
        spotPrice={data?.spotPrice}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content */}
        <main
          className="flex-1 overflow-y-auto p-4 md:p-5 space-y-4"
          style={{ overscrollBehavior: 'contain' }}
        >
          {/* Ticker badge */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold font-mono tracking-tight text-[var(--color-text-primary)]">
                {ticker}
              </span>
              {data?.iv30 != null && !loading && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-purple-bg)] text-[var(--color-purple)] border border-[var(--color-purple)]/20 tabular-nums">
                  IV30: {data.iv30.toFixed(1)}%
                </span>
              )}
              {usingMock && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-warn-bg)] text-[var(--color-warn)] border border-[var(--color-warn)]/20">
                  DEMO DATA
                </span>
              )}
              {error && !usingMock && (
                <span title={error} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-bear-bg)] text-[var(--color-bear)] border border-[var(--color-bear)]/20">
                  ERROR
                </span>
              )}
            </div>
            {data?.totalOptionsCount > 0 && !loading && (
              <span className="text-xs text-[var(--color-text-muted)] tabular-nums hidden sm:inline">
                {data.totalOptionsCount.toLocaleString()} contracts analyzed
              </span>
            )}
          </div>

          {/* KPI Cards */}
          <KPICards kpis={data?.kpis} loading={loading} />

          {/* Position Analysis */}
          <CollapsibleSection id="position" title="Position Analysis" icon={Target}>
            <PremiumGate isPremium={isPremium} onUnlock={refreshAuth} featureName="Position Analysis">
              <PositionAnalysis
                costBasis={costBasis}
                shares={shares}
                onUpdate={updatePosition}
                spotPrice={data?.spotPrice}
                kpis={data?.kpis}
                gexByStrike={data?.gexByStrike}
                loading={loading}
                lastUpdated={data?.lastUpdated}
                marketOpen={marketOpen}
                optionsMarketOpen={optionsMarketOpen}
                liveQuote={liveQuote}
                dataProvider={data?.provider}
              />
            </PremiumGate>
          </CollapsibleSection>

          {/* Research */}
          <PremiumGate isPremium={isPremium} onUnlock={refreshAuth} featureName="Ticker Research">
            <TickerResearch context={tickerContext} loading={contextLoading} spotPrice={data?.spotPrice} />
          </PremiumGate>

          {/* Charts */}
          <CollapsibleSection id="charts" title="Charts" icon={BarChart2} noPadding>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 p-4">
              <GexChart data={data?.gexByStrike} loading={loading} spotPrice={data?.spotPrice} costBasis={costBasis} technicals={tickerContext?.technicals} />
              <FlowChart data={data?.flowHistory} loading={loading} />
            </div>
          </CollapsibleSection>

          {/* Info footer */}
          <div className="text-xs text-[var(--color-text-muted)] pt-2 pb-4">
            {usingMock ? (
              <span>
                Currently showing simulated demo data. Deploy to Netlify and the CBOE data feed activates automatically — no API key needed.
              </span>
            ) : data?.provider === 'tradier' ? (
              <span>
                Real-time data via Tradier brokerage API. GEX, Max Pain, and P/C Ratio computed from live options chain.
                Net Premium estimated from daily volume × mid price.
              </span>
            ) : data?.provider === 'tradier-sandbox' ? (
              <span>
                Data from Tradier sandbox (delayed). Upgrade to a Tradier brokerage account ($10/mo) for real-time feeds.
                GEX, Max Pain, P/C Ratio, and Net Premium computed from options chain.
              </span>
            ) : (
              <span>
                Data from CBOE delayed quotes (~15-min delay). Spot price may differ from Yahoo or broker real-time/closing prices.
                Add a TRADIER_API_KEY for real-time data ($10/mo). Dark Pool % is a statistical estimate.
              </span>
            )}
          </div>
        </main>

        {/* Resize handle */}
        {chatOpen && (
          <div
            onMouseDown={handleResizeStart}
            className="relative shrink-0 cursor-col-resize group"
            style={{ width: 5 }}
          >
            <div className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
              isResizing ? 'bg-[var(--color-accent)]' : 'group-hover:bg-[var(--color-text-muted)]'
            }`} />
          </div>
        )}

        {/* Chat Sidebar */}
        <aside
          className={`overflow-hidden shrink-0 ${
            isResizing ? '' : 'transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]'
          }`}
          style={{ width: chatOpen ? sidebarWidth : 0 }}
        >
          <ChatBot
            data={data}
            isOpen={chatOpen}
            onClose={() => setChatOpen(false)}
            costBasis={costBasis}
            shares={shares}
            isPremium={isPremium}
            onUnlock={refreshAuth}
            onOpenSettings={openSettings}
            tickerContext={tickerContext}
            marketOpen={marketOpen}
            optionsMarketOpen={optionsMarketOpen}
            liveQuote={liveQuote}
          />
        </aside>
      </div>

      {/* Chat Toggle FAB */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed bottom-5 right-5 flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-accent)] text-white text-sm font-medium shadow-lg hover:bg-[var(--color-accent-hover)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] z-50"
          aria-label="Open AI Co-Pilot"
        >
          <Sparkles size={16} />
          <span className="hidden sm:inline">AI Co-Pilot</span>
        </button>
      )}

      {/* Global Settings Modal */}
      <AppSettings
        isOpen={settingsOpen}
        onClose={closeSettings}
        onAuthChange={refreshAuth}
        dataSource={dataSource}
        userEmail={authSession?.user?.email}
        onSignOut={handleSignOut}
      />

      {/* Sign-in found different data here and in the account: nothing syncs until the user picks */}
      {syncConflict && syncConflict.userId === authSession?.user?.id && (
        <SyncChoice report={syncConflict.report} busy={syncBusy} onChoose={handleSyncChoice} />
      )}
    </div>
  );
}
