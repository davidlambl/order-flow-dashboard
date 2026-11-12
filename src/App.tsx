// src/App.tsx
// The dashboard: a shell over three hooks and the leaves in components/dashboard/. useSupabaseAuth holds the sign-in,
// the storage backend keyed on the signed-in account, the sync conflict SyncChoice settles and the one sign-out;
// usePositionDraft the position inputs' draft and its debounced save; useResizableSidebar the chat sidebar's width and
// its resize handle.
// The shell owns the ticker, the chat and Settings toggles and the data hooks, builds the two contexts everything
// below it reads (src/contexts), and renders the spinner while the session is checked, the sign-in screen, or the
// dashboard keyed on the account.
// Three parts load on demand (lazyWithPreload), each in a ChunkBoundary of its own, so that a slow or failed chunk
// costs that part alone: the charts, and recharts with them, only while their section is expanded; the sign-in form
// and the sync choice, which exist only on a build with cloud sign-in and load while the session is checked. Once the
// dashboard shows, the idle preload loads what it may open next, never the charts.
// The chat is ONE element, always mounted and restyled at Tailwind's `md` (useMediaQuery, with a query equivalent to
// the CSS's): from md up a sidebar beside `main`, the complementary landmark while open, with the resize handle on its
// left edge; below md, while open, a modal dialog over the whole page, with `main` and the header inert, which Escape
// closes. ChatBot never remounts across the breakpoint, so a reply keeps streaming (ChatBot.tsx's header). Settings
// and the sync choice render beside it, in the account-keyed root, which is never inert: an inert ancestor would leave
// even a dialog in the top layer dead.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Target, ChartNoAxesColumn } from 'lucide-react';
import Header from './components/Header.jsx';
import KPICards from './components/KPICards.jsx';
import CollapsibleSection from './components/CollapsibleSection.jsx';
import PositionAnalysis from './components/PositionAnalysis.js';
import TickerResearch from './components/TickerResearch.js';
import ChatBot from './components/ChatBot.js';
import PremiumGate from './components/PremiumGate.js';
import AppSettings from './components/AppSettings.js';
import ChunkBoundary from './components/ChunkBoundary.js';
import ChunkFailureCard from './components/ChunkFailureCard.js';
import TickerSummary from './components/dashboard/TickerSummary.js';
import DataSourceNote from './components/dashboard/DataSourceNote.js';
import ChartsSkeleton from './components/dashboard/ChartsSkeleton.js';
import SyncChoiceLayer from './components/dashboard/SyncChoiceLayer.js';
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
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { verifyStoredToken } from './lib/auth.js';
import { lazyWithPreload, scheduleIdlePreload } from './lib/lazyWithPreload.js';
import { getPreference, subscribeCrossTab } from './lib/store.js';

// What App reads from the store through useStoreValue. Module level: a snapshot function with a new identity per
// render costs React a passive effect to re-check it.
const readHasFinnhubKey = () => Boolean(getPreference('data_finnhub_key'));

/**
 * Tailwind's `md` breakpoint: the sidebar layout from here up. The stylesheet's `md:` variant compiles to
 * `@media (width >= 48rem)`; this is the equivalent `min-width` form, the one the tests' matchMedia stand-in parses
 * (src/test/viewport.js). The two would part if `--breakpoint-md` were ever themed.
 */
const MD_UP = '(min-width: 48rem)';
/** The chat's accessible name: its landmark's from md up, its dialog's below. */
const CHAT_NAME = 'AI Co-Pilot';

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
 * The sign-in screen when its form's module failed to load: the failure card where the form would be, on the screen's
 * own background. The form lays out the whole screen itself, so a frame around its boundary would frame the loaded
 * form too; the card is framed here, through the boundary's `failed`.
 */
function signInFailed({ retry }: { retry: () => void }) {
  return (
    <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <ChunkFailureCard retry={retry} />
      </div>
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

  // The chat sidebar's width: the stored one, or the handle's while a drag or the arrow keys move it.
  const { width, isResizing, handleProps } = useResizableSidebar();

  // From md up the chat is a sidebar; below md, while open, it covers the page. Neither the media query's answer nor
  // anything derived from it goes into a context: the chat's layout is App's alone.
  const wide = useMediaQuery(MD_UP);
  const chatCovers = chatOpen && !wide;
  const chatId = useId();
  const chatRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  // Set when the chat closes with focus inside it, or on the body while it covered the page (a disabled composer, an
  // unmounted button or a narrowed window leaves focus there): the close takes what held focus off the page, or left
  // it nowhere, and the chat toggle that the same commit mounts takes focus instead. Focus anywhere else stays where
  // it is, and from md up focus on the body stays there too.
  const refocusToggleRef = useRef(false);

  const closeChat = useCallback(() => {
    const active = document.activeElement;
    refocusToggleRef.current = (chatRef.current?.contains(active) ?? false) || (chatCovers && active === document.body);
    setChatOpen(false);
  }, [chatCovers]);

  useLayoutEffect(() => {
    if (chatOpen || !refocusToggleRef.current) return;
    refocusToggleRef.current = false;
    fabRef.current?.focus();
  }, [chatOpen]);

  // Escape closes the chat while it covers the page, when the key comes from inside the chat or from the body, where
  // focus often is while the chat covers the page. Heard on document, in the bubble phase, while the chat covers the
  // page: React runs the chat's own handlers at its root, below document, so a key one of them handled already, like
  // a key that composes text, arrives prevented and is left alone. A key from anywhere else is not the chat's. While
  // a <dialog> is open (Settings, the context editor) the key is that dialog's wherever focus is: Settings hears
  // Escape on window, after document, so one Escape on the body would otherwise close the chat and Settings both. The
  // sidebar ignores Escape, as it always has.
  useEffect(() => {
    if (!chatCovers) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('dialog[open]')) return;
      const { target } = e;
      const fromChat = target instanceof Node && (chatRef.current?.contains(target) ?? false);
      if (!fromChat && target !== document.body) return;
      e.preventDefault();
      closeChat();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [chatCovers, closeChat]);

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
          {/* A wrapper for `inert` alone (Header's own root is the banner landmark): inert, with main, while the chat
              covers the page. A plain block that clips nothing: the header's ticker message hangs below its box. */}
          <div inert={chatCovers}>
            <Header onOpenSettings={openSettings} />
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Main Content */}
            <main
              inert={chatCovers}
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

            {/* The resize handle, from md up while the chat is open: a separator on the sidebar's left edge that a
                pointer drags (touch-action none, so a finger's drag is not taken for a scroll) and the arrow keys
                step; its value is the sidebar's width, in pixels and in words. The box is 5 px wide, its 1 px line
                centred; a transparent ::before, stacked above the chat, widens what a pointer can press by 12 px to
                the right only, over the chat's own left padding, where nothing the chat draws is interactive (to the
                left is main's scrollbar). A pseudo-element is hit-tested as its element, touch-action included. */}
            {chatOpen && wide && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${CHAT_NAME}`}
                aria-controls={chatId}
                tabIndex={0}
                {...handleProps}
                className="relative z-10 shrink-0 cursor-col-resize group before:absolute before:inset-y-0 before:left-0 before:-right-3 before:content-['']"
                style={{ width: 5, touchAction: 'none' }}
              >
                <div className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
                  isResizing ? 'bg-[var(--color-accent)]' : 'group-hover:bg-[var(--color-text-muted)]'
                }`} />
              </div>
            )}

            {/* The chat, one element at every width (the header says why). From md up: the sidebar, as wide as the
                store says; open, the complementary landmark; closed, a 0 px element with nothing in it and neither
                role nor name, so that no empty landmark stays in a screen reader's list. Below md: open, a modal
                dialog fixed over the whole viewport (the page's 100dvh included), above the page (the header's ticker
                message at z-10, the chat toggle at z-50) and below Settings, the context editor and the sync choice,
                closed by Escape through the document listener above; closed, hidden, so that no empty dialog stays in
                the accessibility tree. Not an <aside>, which may not take the dialog role. */}
            <div
              ref={chatRef}
              id={chatId}
              role={wide ? (chatOpen ? 'complementary' : undefined) : 'dialog'}
              aria-modal={wide ? undefined : true}
              aria-label={wide && !chatOpen ? undefined : CHAT_NAME}
              hidden={!wide && !chatOpen}
              className={wide
                ? `overflow-hidden shrink-0 ${isResizing ? '' : 'transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]'}`
                : 'fixed inset-0 z-[60] overflow-hidden'}
              style={wide ? { width: chatOpen ? width : 0 } : undefined}
            >
              <ChatBot
                isOpen={chatOpen}
                onClose={closeChat}
                onOpenSettings={openSettings}
                costBasis={costBasis}
                shares={shares}
              />
            </div>
          </div>

          {/* Chat Toggle FAB */}
          {!chatOpen && (
            <button
              ref={fabRef}
              onClick={() => setChatOpen(true)}
              className="fixed bottom-5 right-5 flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-accent-solid)] text-white text-sm font-medium shadow-lg hover:bg-[var(--color-accent-solid-hover)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] z-50"
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
