// src/App.tsx
// The dashboard: a shell over three hooks and the leaves in components/dashboard/. useSupabaseAuth holds the sign-in,
// the storage backend keyed on the signed-in account, the sync conflict SyncChoice settles and the one sign-out;
// usePositionDraft the position inputs' draft and its debounced save; useResizableSidebar the chat sidebar's width.
// The shell owns the ticker, the chat and Settings toggles and the data hooks, builds the two contexts everything
// below it reads (src/contexts), and renders the spinner while the session is checked, the sign-in screen, or the
// dashboard keyed on the account.
// Three parts load on demand (lazyWithPreload), each in a ChunkBoundary of its own, so that a slow or failed chunk
// costs that part alone: the charts, and recharts with them, only while their section is expanded; the sign-in form
// and the sync choice, which exist only on a build with cloud sign-in and load while the session is checked. Once the
// dashboard shows, the idle preload loads what it may open next, never the charts.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, Sparkles, Target, ChartNoAxesColumn } from 'lucide-react';
import Header from './components/Header.jsx';
import KPICards from './components/KPICards.jsx';
import CollapsibleSection from './components/CollapsibleSection.jsx';
import PositionAnalysis from './components/PositionAnalysis.js';
import TickerResearch from './components/TickerResearch.js';
import ChatBot from './components/ChatBot.js';
import PremiumGate from './components/PremiumGate.js';
import AppSettings from './components/AppSettings.js';
import ChunkBoundary from './components/ChunkBoundary.js';
import TickerSummary from './components/dashboard/TickerSummary.js';
import DataSourceNote from './components/dashboard/DataSourceNote.js';
import ChartsSkeleton from './components/dashboard/ChartsSkeleton.js';
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
import { lazyWithPreload, scheduleIdlePreload } from './lib/lazyWithPreload.js';
import { getPreference, subscribeCrossTab } from './lib/store.js';

// What App reads from the store through useStoreValue. Module level: a snapshot function with a new identity per
// render costs React a passive effect to re-check it.
const readHasFinnhubKey = () => Boolean(getPreference('data_finnhub_key'));

// The parts loaded on demand. recharts is a third of the bundle and only the expanded Charts section draws with it,
// so the charts are fetched when the section renders them, and never ahead. The sign-in form and the sync choice
// exist only on a build with cloud sign-in: App fetches both while the session is checked, and never without it.
const ChartsPanel = lazyWithPreload(() => import('./components/dashboard/ChartsPanel.js'));
const LoginForm = lazyWithPreload(() => import('./components/LoginForm.jsx'));
const SyncChoice = lazyWithPreload(() => import('./components/SyncChoice.jsx'));

// The screen while the session is checked, and the sign-in screen's while its form's module loads: the same markup,
// so a check that ends before the form is in leads to no visible change.
const SPINNER_SCREEN = (
  <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-400 border-t-transparent" />
  </div>
);

/**
 * A copy of ChunkBoundary's failure card, for the two parts that fill the screen themselves. The boundary draws its
 * own card where it sits, so a frame around the boundary would also frame the sign-in form or the sync dialog once
 * loaded; these two frame this copy through the boundary's `failed` instead. App.lazy.test.jsx keeps the two the same.
 */
function ChunkFailureCard({ retry }: { retry: () => void }) {
  return (
    <div
      role="alert"
      className="h-full flex flex-col items-center justify-center gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 text-center"
    >
      <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
        <CircleAlert size={12} className="shrink-0 text-[var(--color-warn)]" />
        This part of the dashboard could not load.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={retry}
          className="rounded-lg px-3 py-1.5 border border-[var(--color-accent)] bg-[var(--color-accent)] text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg px-3 py-1.5 border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-xs font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

/** The sign-in screen when its form's module failed to load: the card where the form would be, on its background. */
function signInFailed({ retry }: { retry: () => void }) {
  return (
    <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <ChunkFailureCard retry={retry} />
      </div>
    </div>
  );
}

/** Moves the focus into the element as it mounts. Module level, so that a re-render does not call it again. */
const focusOnMount = (element: HTMLElement | null) => { element?.focus(); };

/**
 * Where the sync choice shows while its module loads or after it failed to. SyncChoice is blocking on purpose, and so
 * is this: a layer over the whole page, dimmed like the dialog's own, so nothing underneath can be clicked while the
 * conflict waits for a choice. Like the dialog it is modal, named "Sync your data" and takes the focus as it opens,
 * so nothing underneath is typed into either.
 */
function SyncChoiceLayer({ loading = false, children }: { loading?: boolean; children: ReactNode }) {
  return (
    <div
      ref={focusOnMount}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Sync your data"
      aria-busy={loading || undefined}
      className="fixed inset-0 z-[120] flex items-center justify-center outline-none"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-sm mx-4">{children}</div>
    </div>
  );
}

const SYNC_CHOICE_LOADING = (
  <SyncChoiceLayer loading>
    <div className="mx-auto animate-spin rounded-full h-8 w-8 border-2 border-[var(--color-accent)] border-t-transparent" />
  </SyncChoiceLayer>
);

function syncChoiceFailed({ retry }: { retry: () => void }) {
  return (
    <SyncChoiceLayer>
      <ChunkFailureCard retry={retry} />
    </SyncChoiceLayer>
  );
}

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

  // The session check leads to the sign-in form or to the dashboard, where a sync conflict may follow: on a build with
  // cloud sign-in both modules load while it runs, so neither waits on the network when it is needed.
  useEffect(() => {
    if (!configured) return;
    void LoginForm.preload();
    void SyncChoice.preload();
  }, [configured]);

  // Once the dashboard shows, what it may open next loads while the browser is idle (the lazies made with
  // { idle: true }), so its first use shows no fallback; not before, when the session check and then the dashboard's
  // own first requests come first.
  const dashboardShown = screen === 'app';
  useEffect(() => (dashboardShown ? scheduleIdlePreload() : undefined), [dashboardShown]);

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
  if (screen === 'checking') return SPINNER_SCREEN;

  // Show login form if Supabase is available but user hasn't signed in or skipped
  if (screen === 'sign-in') {
    return (
      <ChunkBoundary fallback={SPINNER_SCREEN} failed={signInFailed}>
        <LoginForm onSkip={skipSignIn} notice={notice} />
      </ChunkBoundary>
    );
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

              {/* Charts: rendered, and so fetched, only while the section is expanded. The frame's rows are at least
                  a chart card tall, so a chunk that failed leaves its card at a chart's height, not a strip. */}
              <CollapsibleSection id="charts" title="Charts" icon={ChartNoAxesColumn} badge={null} noPadding>
                <div className="grid auto-rows-[minmax(340px,auto)] p-4">
                  <ChunkBoundary fallback={<ChartsSkeleton />}>
                    <ChartsPanel
                      gexByStrike={data?.gexByStrike}
                      flowHistory={data?.flowHistory}
                      loading={loading}
                      spotPrice={data?.spotPrice}
                      costBasis={costBasis}
                      technicals={tickerContext?.technicals}
                    />
                  </ChunkBoundary>
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
            <ChunkBoundary fallback={SYNC_CHOICE_LOADING} failed={syncChoiceFailed}>
              <SyncChoice report={conflict} busy={syncBusy} onChoose={resolveConflict} />
            </ChunkBoundary>
          )}
        </MarketContext>
      </AuthContext>
    </div>
  );
}
