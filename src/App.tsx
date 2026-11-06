// src/App.tsx
// The dashboard: a shell over three hooks and the two leaves in components/dashboard/. useSupabaseAuth holds the
// sign-in, the storage backend keyed on the signed-in account, the sync conflict SyncChoice settles and the one
// sign-out; usePositionDraft the position inputs' draft and its debounced save; useResizableSidebar the chat sidebar's
// width. The shell owns the ticker, the chat and Settings toggles and the data hooks, builds the two contexts
// everything below it reads (src/contexts), and renders the spinner while the session is checked, the sign-in screen,
// or the dashboard keyed on the account.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Target, ChartNoAxesColumn } from 'lucide-react';
import Header from './components/Header.jsx';
import KPICards from './components/KPICards.jsx';
import CollapsibleSection from './components/CollapsibleSection.jsx';
import PositionAnalysis from './components/PositionAnalysis.js';
import TickerResearch from './components/TickerResearch.js';
import GexChart from './components/GexChart.jsx';
import FlowChart from './components/FlowChart.jsx';
import ChatBot from './components/ChatBot.js';
import PremiumGate from './components/PremiumGate.js';
import AppSettings from './components/AppSettings.js';
import LoginForm from './components/LoginForm.jsx';
import SyncChoice from './components/SyncChoice.jsx';
import TickerSummary from './components/dashboard/TickerSummary.js';
import DataSourceNote from './components/dashboard/DataSourceNote.js';
import { AuthContext } from './contexts/AuthContext.js';
import type { AuthValue } from './contexts/AuthContext.js';
import { MarketContext } from './contexts/MarketContext.js';
import type { MarketValue } from './contexts/MarketContext.js';
import { useMarketData } from './hooks/useMarketData.js';
import { useTickerContext } from './hooks/useTickerContext.js';
import { useLiveQuote } from './hooks/useLiveQuote.js';
import { usePremiumStatus } from './hooks/usePremiumStatus.js';
import { useStoreValue } from './hooks/useStoreValue.js';
import { usePositionDraft } from './hooks/usePositionDraft.js';
import { useSupabaseAuth } from './hooks/useSupabaseAuth.js';
import { useResizableSidebar } from './hooks/useResizableSidebar.js';
import { verifyStoredToken } from './lib/auth.js';
import { getPreference, subscribeCrossTab } from './lib/store.js';

// What App reads from the store through useStoreValue. Module level: a snapshot function with a new identity per
// render costs React a passive effect to re-check it.
const readHasFinnhubKey = () => Boolean(getPreference('data_finnhub_key'));

export default function App() {
  const [ticker, setTicker] = useState('AVGO');
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The draft first, since the sign-in takes its flush: an edit still inside its debounce is written through the
  // backend in use before an account switch or a sign-out changes it.
  const { costBasis, shares, update, flush, settle } = usePositionDraft(ticker);
  const { screen, notice, accountKey, signedIn, userEmail, configured, skipSignIn, showSignIn, signOut, conflict, syncBusy, resolveConflict } = useSupabaseAuth({ flushPendingEdits: flush });

  // Edits made in another tab reach this one as store-changed.
  useEffect(() => subscribeCrossTab(), []);

  // The stored access token's status, following every set and clear through the auth event (F11). On startup the
  // server is asked whether the stored token is still valid (expired, revoked, re-signed): a rejection clears it,
  // and that clear arrives through the same event.
  const { isPremium, tokenTier, daysLeft } = usePremiumStatus();
  useEffect(() => { void verifyStoredToken(); }, []);

  // Research data needs either an access token or the user's own Finnhub key.
  const hasFinnhubKey = useStoreValue(readHasFinnhubKey);
  const { data, loading, error, usingMock, refresh, autoRefresh, nextRefreshAt, refreshMs, marketOpen, optionsMarketOpen, toggleAutoRefresh } = useMarketData(ticker);
  const { context: tickerContext, loading: contextLoading } = useTickerContext(ticker, { enabled: isPremium || hasFinnhubKey });
  const { quote: liveQuote, refresh: refreshLiveQuote } = useLiveQuote(ticker);

  // The chat sidebar's width: the stored one, or the mouse's while the handle is dragged.
  const { width, isResizing, onResizeStart } = useResizableSidebar();

  const handleTickerChange = useCallback((newTicker: string) => {
    settle(); // the old ticker's edit is stored before the new ticker's position shows
    setTicker(newTicker);
  }, [settle]);

  const handleRefresh = useCallback(() => {
    refresh();
    refreshLiveQuote();
  }, [refresh, refreshLiveQuote]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // The Account tab's "Sign in": Settings closes and the sign-in screen shows (it can still be skipped), in one render.
  const handleSignIn = useCallback(() => {
    setSettingsOpen(false);
    showSignIn();
  }, [showSignIn]);

  const dataSource = usingMock ? 'mock' : (data?.provider || 'cboe');

  // The two contexts everything below App reads (src/contexts): one value each, memoised on its fields (the
  // exhaustive-deps rule), so a consumer sees a new value only when something in it changed.
  const market = useMemo<MarketValue>(() => ({
    ticker, setTicker: handleTickerChange, data, loading, error, usingMock, refresh: handleRefresh, autoRefresh,
    toggleAutoRefresh, nextRefreshAt, refreshMs, marketOpen, optionsMarketOpen, liveQuote, tickerContext,
    contextLoading, dataSource,
  }), [
    ticker, handleTickerChange, data, loading, error, usingMock, handleRefresh, autoRefresh, toggleAutoRefresh,
    nextRefreshAt, refreshMs, marketOpen, optionsMarketOpen, liveQuote, tickerContext, contextLoading, dataSource,
  ]);
  const auth = useMemo<AuthValue>(() => ({
    isPremium, tokenTier, daysLeft, signedIn, userEmail, signOut, signIn: configured ? handleSignIn : undefined,
  }), [isPremium, tokenTier, daysLeft, signedIn, userEmail, signOut, configured, handleSignIn]);

  // Show loading spinner while checking existing session
  if (screen === 'checking') {
    return (
      <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-400 border-t-transparent" />
      </div>
    );
  }

  // Show login form if Supabase is available but user hasn't signed in or skipped
  if (screen === 'sign-in') {
    return <LoginForm onSkip={skipSignIn} notice={notice} />;
  }

  // Keyed on the account: switching accounts without a sign-out remounts everything below, so no
  // component keeps the previous account's data in its state (a streaming reply, an unsaved edit) and
  // writes it through the new account's backend.
  return (
    <div key={accountKey} className="h-full flex flex-col overflow-hidden">
      <AuthContext value={auth}>
        <MarketContext value={market}>
          <Header onOpenSettings={openSettings} />

          <div className="flex-1 flex overflow-hidden">
            {/* Main Content */}
            <main
              className="flex-1 overflow-y-auto p-4 md:p-5 space-y-4"
              style={{ overscrollBehavior: 'contain' }}
            >
              {/* Ticker badge */}
              <TickerSummary ticker={ticker} data={data} loading={loading} usingMock={usingMock} error={error} />

              {/* KPI Cards */}
              <KPICards kpis={data?.kpis} loading={loading} />

              {/* Position Analysis */}
              <CollapsibleSection id="position" title="Position Analysis" icon={Target} badge={null}>
                <PremiumGate featureName="Position Analysis">
                  <PositionAnalysis costBasis={costBasis} shares={shares} onUpdate={update} />
                </PremiumGate>
              </CollapsibleSection>

              {/* Research */}
              <PremiumGate featureName="Ticker Research">
                <TickerResearch />
              </PremiumGate>

              {/* Charts */}
              <CollapsibleSection id="charts" title="Charts" icon={ChartNoAxesColumn} badge={null} noPadding>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 p-4">
                  <GexChart data={data?.gexByStrike} loading={loading} spotPrice={data?.spotPrice} costBasis={costBasis} technicals={tickerContext?.technicals} />
                  <FlowChart data={data?.flowHistory} loading={loading} />
                </div>
              </CollapsibleSection>

              {/* Info footer */}
              <DataSourceNote usingMock={usingMock} provider={data?.provider} />
            </main>

            {/* Resize handle */}
            {chatOpen && (
              <div
                onMouseDown={onResizeStart}
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
              style={{ width: chatOpen ? width : 0 }}
            >
              <ChatBot
                isOpen={chatOpen}
                onClose={() => setChatOpen(false)}
                onOpenSettings={openSettings}
                costBasis={costBasis}
                shares={shares}
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
          <AppSettings isOpen={settingsOpen} onClose={closeSettings} />

          {/* Sign-in found different data here and in the account: nothing syncs until the user picks */}
          {conflict && (
            <SyncChoice report={conflict} busy={syncBusy} onChoose={resolveConflict} />
          )}
        </MarketContext>
      </AuthContext>
    </div>
  );
}
