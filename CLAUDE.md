# CLAUDE.md — working notes for AI sessions in this repo

## What this is
Institutional order-flow dashboard: React 19 + Vite + Tailwind 4 + Recharts 3 + TanStack Query 5 frontend, Netlify
Functions backend in TypeScript (Tradier → CBOE market data with validated fallback, mock data only client-side; multi-provider LLM proxy; Yahoo live quotes;
Finnhub / Alpha Vantage ticker context; nightly flow-history collector), Supabase for auth + persistence.

## Roadmap-driven work
`docs/ROADMAP.md` is the source of truth for the current modernization effort. Each phase is a GitHub
issue labelled `roadmap` and nested under the parent "Roadmap" issue. A fresh session implementing a phase
should:
1. Read `docs/ROADMAP.md` (the "Findings" section has file:line evidence; the "Proposed roadmap" section
   has the steps) and the phase's issue.
2. Work on a branch named `roadmap/phase-<n>-<slug>`, one PR per phase (split large phases as the
   issue suggests). Reference the issue in the PR body (`Closes #<n>`).
3. Keep each PR minimal to its phase; don't pull later-phase work forward.
4. Plan in Fable, implement with Opus agents **in parallel** (owner's standing rule, 2026-09-26): partition the
   phase into independent units by the files they touch, give each unit its own agent in a git worktree
   (`git worktree add <path> <branch tip>`; the Agent tool's worktree isolation starts from `main`, so reset it to
   the branch tip first), have each commit in its worktree, then cherry-pick in the planned order and re-run the
   gate after each. Only units that share `package.json`/the lockfile or the same source files run sequentially.
5. Before pushing: `npm run check` (lint, typecheck, test, build and the bundle budget, each blocking) and
   `npm audit --omit=dev --audit-level=high`.
6. Line numbers in the roadmap were taken at commit `9cf9ccd` + the Phase 0 merge; re-grep before editing.

## Commands
- `npm install` then `npm run dev` — Vite on :5173 with **mock data** (no functions).
- `npx netlify dev` — functions on :8888 + Vite proxy (`vite.config.js`); needs a `.env` from `.env.example`.
- `npm run build` — must pass; it writes the entry chunk, Rolldown's runtime chunk, five vendor chunks (`react`, `query`,
  `supabase`, `recharts`, `markdown`: `output.codeSplitting.groups` in `vite.config.js`), one chunk per lazily loaded
  part, a chunk for what two of those share (`useAutoSave`) and `dist/.vite/manifest.json` (Netlify does not publish
  the dot-directory). `ANALYZE=1 npm run build` also writes `dist/stats.html`.
- `npm run check:bundle` — `scripts/check-bundle.js` on the built `dist/`: the entry chunk at most 350 kB, initial JS
  (the entry and everything it imports statically, read from the manifest and compared with `index.html`'s preloads) at
  most 700 kB, and no `recharts` or `markdown` chunk on that startup path. Exit 1 over budget, 2 when the build cannot
  be measured; the limits are the constants at its top. Part of `npm run check` and a CI step after the build. One
  static import of a chart, of `ChatMarkdown` or of a package only recharts or the markdown graph uses (`clsx`, `react-is`,
  `d3-*`, `unist-util-*`…) from an eagerly loaded module puts that whole vendor chunk back at startup: this is what
  notices.
- `npm run lint` — must be clean (0 errors, 0 warnings): the Phase 5 (c) baseline of four
  `react-hooks` and `react-refresh` findings closed with the AppSettings decomposition (Phase 5 (d), #75), and lint
  has been blocking in CI's required build job and in `npm run check` since. `.remember` (the remember plugin's scratch
  folder in this checkout) is in the config's global ignores.
- `npm run typecheck` — `tsc -p tsconfig.json` (browser program: `src/`, `shared/`, `types/`; DOM lib and only Vite's
  and Vitest's ambient types, so Node globals do not typecheck in `src/`) then `tsc -p tsconfig.functions.json` (Node
  program: `netlify/`, `shared/`, `types/`, `scripts/`; `@types/node`, no DOM; `erasableSyntaxOnly`, which refuses what
  Node's own type stripping cannot erase: an enum, a namespace, a parameter property). Every function and `lib/` module
  is TypeScript, so that program checks them whole. `allowJs` with `checkJs: false`: the remaining JS is parsed, never
  checked. Blocking in CI (inside the required build job) and part of `npm run check`.
- `npm run types:supabase` — rewrites `types/supabase.ts` from the project's schema (`npx supabase@3 gen types
  typescript`, the project id in the script; it needs `npx supabase@3 login` or `SUPABASE_ACCESS_TOKEN`, which is why
  the output is committed). Run it after a new migration and commit the file as generated: a header added by hand is
  gone at the next run. The script replaces the file only once the generator has succeeded, so a run without a login
  leaves it as it was.
- `npm test` — Vitest (`vitest.config.js`, two projects). `node`: `netlify/functions/__tests__/*.test.js` (every
  function driven in-process with the recording `fetch` stub and helpers in `test/helpers/functions.js`),
  `shared/*.test.js`, `scripts/**/*.test.js`, and `src/**/*.node.test.js` (pure `src/lib` modules loaded under Node with the browser-global
  stand-ins in `test/helpers/globals.js` — `memoryStorage`, `withGlobals`, `fakeWindow`, `settle`, `fakeClock` — and
  the recording fake supabase-js client in `test/helpers/fakeSupabase.js`, whose `auth` is timed like supabase-js: the
  App and `useSupabaseAuth` tests under `dom` drive it too, and `supabaseClient.node.test.js` pins those timings on the
  real client). `dom`: `src/**/*.test.{js,jsx}` under
  jsdom with Testing Library and an MSW server (`src/test/setup.js`; handlers target
  `http://localhost:3000/.netlify/functions/…`, relative URLs are resolved there). The same setup makes TanStack
  Query's notifications synchronous (`notifyManager.setScheduler`, so a hook's new result lands inside `act`) and
  clears the shared `queryClient` after every test; hooks take the client as `useQuery`'s second argument, so hook
  tests render them bare, with no provider. A component that reads the contexts renders inside them with
  `src/test/contexts.jsx` (`marketValue(overrides)`, `authValue(overrides)`, `withContexts(ui, { market, auth })`),
  which replaced the props those tests used to pass. The setup also loads every lazily loaded component
  (`lazyWithPreload`) before a file's first test, so a lazy part renders inside `render()`'s act like an eager one and
  the test files need not know which parts are lazy. A file that tests a lazy part's pending, failed and retried paths
  opts out with a top-level `skipLazyPreload()` and holds the import with `importGate()` (`src/test/lazy.js`, whose
  header has the recipe and its three traps: await one import at the end of `beforeEach` when the code starts two at
  once; answer every import a test leaves held; wait for an import to arrive before settling it inside `act`).
  The setup also installs what jsdom 30 lacks, each only where the environment has none (`src/test/standins.test.jsx`
  fails once a jsdom brings its own, so dropping one is a decision). `src/test/standins.js`: `<dialog>`'s `showModal()`,
  `show()` and `close()` (`showModal()` throws on a dialog already open, as older engines do: open with
  `if (!dialog.open)`; `close` fires a microtask later: `await act(async () => {})` before asserting on it); pointer
  capture (one element per pointer id, nothing retargeted: a test fires the later events on the capturing element);
  `requestDialogClose(dialog, { cancelable? })`, which stands for Escape (`cancelable: false` is Chromium's second
  Escape, whose `cancel` no `preventDefault()` stops); and `isOpenModal(dialog)`, true only for a dialog open through
  `showModal()`, which `dialog.open` cannot tell from `show()` or the bare attribute (a test that a layer is modal
  asserts this, not `.open`). Not emulated, so never asserted: the top layer, `::backdrop`,
  the inert page and the focus trap (Tab is not simulated). `src/test/viewport.js`: `matchMedia` over an emulated
  width, a desktop (`DESKTOP_WIDTH`, 1280 px) that the setup restores after every test, dropping every listener;
  `setViewportWidth(px)` (`PHONE_WIDTH` is 375), inside `act()` once a component listens, fires `change` on each list
  whose answer flipped. It answers `(min-width: N)` and `(max-width: N)` in px, rem or em, joined by `and`, and nothing
  else (a range such as `(width >= 48rem)` is false); `window.innerWidth` stays 1024 and no `resize` fires.
  Accessibility is asserted with `src/test/a11y.js`. `expectNoAxeViolations(container, { bestPractices?, disable? })`
  runs axe-core's WCAG 2.0, 2.1 and 2.2 A and AA rules (its best-practice rules on request: heading order, landmarks,
  regions) and fails with each rule and node; `expectLabelledControls(container)` fails unless every input, select and
  textarea has a label that is not its placeholder (a `<label>`, `aria-labelledby` or `aria-label` with text), since
  axe's own `label` rule accepts a placeholder. Six rules are off at every call, jsdom having no layout, no computed
  colours and no canvas: `color-contrast`, `label-content-name-mismatch`, `target-size`, `link-in-text-block`,
  `scrollable-region-focusable`, `skip-link`. A clean run says nothing about them: a test that needs one asserts the
  property itself. One axe call per rendered state, not per test. The container must be attached, and it decides what
  is judged: Testing Library's `container` for a component; `baseElement` for a dialog, a portal or a whole page (axe
  judges `region` from `document.body` only); `document.documentElement` for the page rules (`page-has-heading-one`,
  `landmark-one-main`), with `document-title` and `html-has-lang` in `disable`, which jsdom's blank page fails. A rule
  a call disables has its reason in a comment beside it. The call refuses fake timers that do not advance by
  themselves (axe waits on `setTimeout`): `vi.useFakeTimers({ shouldAdvanceTime: true })` works. Tailwind's classes
  hide nothing under jsdom, which loads no stylesheet: `hidden`, `sr-only`, `md:…` and the opacity classes leave an
  element in axe's tree and in a role query's. Only the `hidden` attribute, `aria-hidden`, an inline style, a closed
  `<dialog>` and, for axe alone, `inert` hide anything (Testing Library's queries and jsdom's `focus()` ignore
  `inert`); `expectLabelledControls` checks a hidden control too.
  `npm run test:watch`, `npm run test:coverage` (CI), `npm run check` = lint + typecheck + test + build + check:bundle,
  each blocking.
  Function tests live in `__tests__/` because Netlify deploys every top-level file of `netlify/functions/`. `vi.mock`
  only at file top level; never enable fake timers globally; time-dependent code takes an injectable `now` (and the
  saver injectable timers), so tests never depend on the wall clock.
  Under the `dom` project Vite rewrites `new URL('./x.js', import.meta.url)` to the served `http://localhost:3000/…`
  URL, so a test that reads a source file uses `path.join(import.meta.dirname, 'x.js')`; the `node` project is not
  rewritten. Fixtures that must reach a stub, not MSW, install `installFetchRecorder()` (`test/helpers/fetch.js`)
  per test and uninstall it after. `src/lib/__snapshots__/financialContext.node.test.js.snap` is committed: regenerate it
  with `npx vitest run -u src/lib/financialContext.node.test.js` only after an intended change (CI never writes a
  snapshot: a missing one fails as mismatched, an obsolete one fails the file).
- `npm audit --omit=dev --audit-level=high` — must stay clean (CI `audit` job).
- `node scripts/generate-token.js` — mint premium JWTs (`TOKEN_SECRET`). Plain Node, 22.18 or newer (the `engines`
  floor): the script imports `netlify/functions/lib/auth.ts` by its real name, because Node maps no `.js` specifier
  to a `.ts` file, and Node strips the types itself. `lib/auth.ts` therefore keeps to erasable syntax and has a
  relative import only as `import type { … }` or a dynamic one, as its header says; `scripts/generate-token.test.js`
  runs the script under plain Node, which is what fails if it stops loading.

## Layout
- `src/lib/` pure helpers + storage (`store.ts` localStorage backend with the `StoreBackend` interface and the typed
  `PrefName`/`PreferenceValues` preferences, `SupabaseBackend.js` cloud sync with an injectable client, `syncOutbox.js`
  its persistent write queue, `supabase.ts` the typed, Node-safe client factory, `session.js` the one sign-out plus the
  `local_data_owner` and `auth_skipped` device flags, `debouncedSaver.js` baseline-compared debounce behind
  `useAutoSave`, `deepEqual.js`, `api.ts` fetchers incl. SSE streaming, `sse.ts` stream framing/events, `recommend.ts`,
  `ticker.ts` (`TICKER_RE` and `parseTicker`, the functions' ticker rule, which Header's search applies on submit: a
  copy, since app code in `src/` never imports `netlify/`; `ticker.node.test.js` imports
  `netlify/functions/lib/ticker.ts` and fails when the two patterns or the two `parseTicker`s differ),
  `lazyWithPreload.ts` (code-split components: see Conventions),
  `format.ts` (numbers and dates, incl. `timeAgo` / `daysUntil` on a caller's `now`), `mockData.ts` (a complete `MarketData`), `staleness.js`, `retry.js`, `gexChartHelpers.js`, `auth.ts` JWT
  client side with `describeToken` and `subscribeAuth`, `storeEvents.ts` the subscription side of `store-changed` (one
  permanent window listener, versions scoped by the event's detail, `savePreference` for UI writes), `queryClient.ts`
  the one TanStack Query client and the per-hook key families, `marketHours.ts` the refresh cadence with its backoff and
  the ET session state, pure; `aiSettings.ts` the AI provider table (`AI_PROVIDERS`, `providerMeta`, `KEY_PREF`) and the
  string-guarded preference readers `getAISettings` / `readAiModelName` that ChatBot and the Settings AI tab share; `financialContext.ts` the chat's context builder, pure with the clock injected
  (`buildFinancialContext(input)` with `now` required; golden snapshots under 'UTC' and 'America/New_York', the committed
  `.snap` in `__snapshots__/` beside its node test); `chatMessages.ts` the chat's pure message helpers — `stopMarker`, `settleReply`,
  `conversationWindow`, `storableMessages`, `appendReplyText`, `withBufferedText`, the `isTurn` guard and
  `CONTEXT_UPDATE_PROMPT`; `positionSignals.ts` the position panel's pure derivation (`derivePositionSignals(input)`: dual
  mode, the two recommendations, the price levels, staleness and both P&Ls, `now` injected)). Modules the
  `node` test project loads use explicit `.js` relative imports (Vite resolves both) and no top-level
  `window`/`localStorage` access. A `.js` or `.jsx` specifier also resolves to a renamed `.ts`/`.tsx` module
  (Vite 8, both Vitest projects and Netlify's functions bundler), so converting a module never touches its importers;
  only a test that reads the source by path (`sse.test.js`, `recommend.node.test.js`, `askLLM.test.js`,
  `collectFlowHistory.test.js`) moves its path in the same commit. Plain Node maps nothing: a script it runs names the
  `.ts` file (`scripts/generate-token.js`).
- `src/hooks/` the data hooks on TanStack Query, all `.ts`: `useMarketData` (its own silent-refresh timer, whose fetch
  carries `fetchMeta` `{ silent: true }`; returns the deadline `nextRefreshAt` and `refreshMs` instead of a per-second
  counter), `useLiveQuote` (60 s `staleTime` and `refetchInterval`), `useTickerContext` (15 min `staleTime`,
  `enabled`); `useMarketClock` (the ET session flags, re-checked every 30 s), `useCountdown` (Header's 1 Hz countdown
  leaf, F12), `useNow`, `useAutoSave(saveFn, delay, initialValue?)` → `{ prime, schedule, flush, saved }` (prime with the
  loaded value or pass it as the third argument at creation, schedule from `onChange`; it flushes in its unmount cleanup
  and on `pagehide`, so a tab mounted only while shown needs no close handler); `useAIModels(provider, key)` →
  `{ models, loading, error, refresh }` (the `['models', provider, key]` family on `keys.models`, 5 min `staleTime`; on
  `auth-changed` the unobserved entries are removed and a shown one reset and refetched; one request per saved key), `useKeyTester()` (the AI tab's Test: a fetch-id guard,
  and a success seeds the trimmed key's query), `useTokenActivation()` → `{ status, error, activate, reset }`
  (`validateToken` then `setToken`; `TokenActivationForm` is its leaf for Settings, PremiumGate and the chat's lock screen); `useChatStream()` →
  `{ sending, start, stop, detach, live, bufferedText }` (the chat's streaming machine: `start` is synchronous and returns
  false while a reply is in flight, the shell hands it per-call sinks, it registers no effect of its own; `live` and
  `bufferedText` read refs — handlers and effects only) and `useChatHistory(ticker, controls)` → `{ messages, setMessages,
  setMessagesAndPersist, deleteMessage, clearHistory }` (the chat's one writer: the persist points, the ticker-change effect
  declared before the persist effect, the `subscribeStore` listener keyed on a live reply, the pagehide save (the reply runs on) and the unmount save, which comes
  before the detach); `usePositionSignals({ costBasis, shares })` → `{ signals, loading, spotPrice, liveQuote,
  optionsMarketOpen, dataProvider, lastUpdated, now }` (one memo of `derivePositionSignals` over `useMarket()` and
  `useNow(60_000)`); the store readers on
  `useSyncExternalStore` in `useStoreValue.ts`
  (`useStoreValue(read)` for a primitive, `useStoreObject(read, key, kind, id)` for an object such as `getPosition`,
  `usePreference(name)` → `[value, save]`, `useStoreVersion`); and `usePremiumStatus()` → `{ isPremium, tokenTier,
  daysLeft }` from the stored access token on `auth-changed` (F11). App's three (Phase 5 (d)):
  `useSupabaseAuth({ flushPendingEdits, client? })` → `{ screen, notice, accountKey, signedIn, userEmail, configured,
  skipSignIn, showSignIn, signOut, conflict, syncBusy, resolveConflict }` (the session and its check, the store's backend
  keyed on the signed-in account in a PASSIVE effect — the removed subtree's unmount saves run before it, so never a
  layout effect or `flushSync` — hydrate's conflict for `SyncChoice`, the one sign-out; `flushPendingEdits` and `client`
  must keep one identity; its hook tests inject a fake client, the App tests mock the client module, and both reset the
  store's backend after each test);
  `usePositionDraft(ticker)` → `{ costBasis, shares, update, flush, settle }` (the position's one writer: the 300 ms
  saver, the edit, the `subscribeStore` listener keyed on this ticker's position, the pagehide and unmount flushes;
  `flush` and `settle` are stable, and `settle` goes in the same handler as the ticker change);
  `useResizableSidebar()` → `{ width, isResizing, handleProps }` (the chat sidebar's stored width, and the handlers and
  value App spreads on the resize handle, a separator: a drag by pointer events with pointer capture, so a mouse, a
  finger and a pen take one path, the primary button only and one drag at a time, listening on document so that its
  release still arrives if the handle goes away mid-drag; ArrowLeft and ArrowRight 16 px, Home and End the 280 and
  640 px bounds; `aria-valuenow` the width shown and `aria-valuetext` the same in words ("384 pixels"). The width is
  stored once through `savePreference`: on the pointerup (a pointercancel stores nothing), or on a key's release or a
  blur, since `sidebarWidth` syncs and a held key would queue a cloud write per repeat. A pointermove that leaves the
  width where it is (a vertical move, one past a bound) returns the same state, so App does not render per move;
  `isResizing` is a drag alone); `useMediaQuery(query)` → whether a media query
  matches, followed as it changes (`useSyncExternalStore` over `matchMedia`; false where there is none).
- `src/contexts/` `MarketContext.ts` and `AuthContext.ts`: the two values App builds from its hooks and state and
  provides inside the account-keyed div; `useMarket()` / `useAuth()` throw outside a provider. Header, PositionAnalysis,
  ChatBot, TickerResearch, the Settings tabs (AccountTab, BackupTab, DataTab) and PremiumGate read them instead of App's
  props; `KPICards`, `GexChart` and
  `FlowChart` keep their data props (pure leaves, and `App.test.jsx` counts App's renders through KPICards'), and the
  position draft, `isOpen`/`onClose` and `onOpenSettings` stay props.
- `src/components/` UI. `src/App.tsx` itself is a shell (Phase 5 (d)): it owns the ticker, the chat and Settings toggles, the
  data hooks and the two contexts, calls `usePositionDraft` before `useSupabaseAuth` (which takes its `flush`), destructures
  every hook result (a hook's return object in a dependency list would give the contexts a new value per render; the
  `App.shell.test.jsx` identity pin guards it) and renders the spinner, `LoginForm` or the dashboard keyed on the account,
  with `components/dashboard/{TickerSummary,DataSourceNote}.tsx` (pure prop leaves) as `main`'s first and last children.
  The chat is ONE element at every width and never remounts, since a remount would cut a streaming reply: a `div` (an
  `aside` may not take the dialog role) that from `md` up is the complementary landmark "AI Co-Pilot" while open,
  with the resize handle before it (closed, it is an empty 0 px element with neither role nor name, so that no empty
  landmark is listed), and below `md`, while open, a modal dialog fixed over the viewport with `main` and a wrapper
  around `Header` `inert` and no handle; closed below `md`, it is `hidden`. The handle's box is 5 px wide; a
  transparent `::before` widens what a pointer can press by 12 px to the right, over the chat's own padding (to the
  left is `main`'s scrollbar). The layout follows
  `useMediaQuery('(min-width: 48rem)')`, Tailwind's `md` (the stylesheet writes `(width >= 48rem)`, a range the test
  stand-in does not parse). Escape closes the chat only while it covers the page, heard on `document` by a listener
  that lives only then: from inside the chat or from `body`, where focus is after a send (the composer is disabled
  while a reply streams) or once a pressed button unmounts, and never while a `<dialog>` is open, since Settings hears
  Escape on `window`, after `document`, and one key would otherwise close both. Closing it with focus inside, or on
  `body` while it covered the page, moves focus to "Open AI Co-Pilot", which mounts in the same commit. The
  account-keyed root is never inert:
  Settings and the sync choice render in it, and an inert ancestor would leave even a top-layer dialog dead.
  Every dialog but the chat draws its panel in `ModalDialog.tsx`: `settings/SettingsDialog.tsx` and its stand-in
  `SettingsPlaceholder.tsx`, `StrategicContextDialog.tsx` and its stand-in (`StrategicContextEditor.tsx`'s
  `EditorModal`), `SyncChoice.jsx` and `dashboard/SyncChoiceLayer.tsx`. It is the platform's `<dialog>`, opened with
  `showModal()` in a layout effect and closed in its cleanup while still in the document (one removed while open leaves
  focus on body), so the browser supplies the focus trap, the inert page, the top layer (the editor over Settings) and
  the focus return. It is named by `labelledBy` or `label`; `initialFocus` (a ref) takes focus as it opens, else the
  dialog itself (`tabIndex={-1}`: a stand-in holding a spinner has nothing else). The dim is its `::backdrop`
  (`backdropClassName`, Tailwind's `backdrop:` variant), so a press outside the panel lands on the dialog element, and
  dismisses only when its down, up and click all do. The browser's `cancel` is always prevented and React alone closes:
  with `onDismiss`, a press outside or a close request calls it; without (`SyncChoice` and `SyncChoiceLayer`),
  `closedby="none"`, and a dialog the browser closes anyway opens again. Escape stays with each dialog's window listener
  (bubble phase: `SettingsDialog`, `SettingsPlaceholder`; capture phase, stopped: `StrategicContextDialog` and
  `StrategicContextEditor`'s `EditorModal`), which prevents the keydown, so the browser raises no `cancel` for it.
  App loads three parts on demand (Phase 5 (e)): `dashboard/ChartsPanel.tsx` (the grid with GexChart and FlowChart, and
  recharts with it) inside the Charts section, so only while that section is expanded (it is by default), with `dashboard/ChartsSkeleton.tsx`
  in its place meanwhile; `LoginForm` (its fallback is the session check's spinner) and `SyncChoice` (its fallback and
  its failure UI sit in `dashboard/SyncChoiceLayer.tsx`, which blocks the page as the dialog does), both preloaded from
  an effect only when `configured`. The idle preload starts from an effect once `screen === 'app'`.
  `TickerResearch.tsx` is the shell over `components/research/*.tsx` (pure leaves, the data props
  typed from `types/market.ts`, default-exported one per file; the shell renders its header through `CollapsibleSection` and owns
  the one `useNow` clock the leaves' relative times read; Phase 5 (d)). `CollapsibleSection.jsx` (the Position,
  Research and Charts sections) is the accordion pattern: an `h2` holding the toggle (`aria-expanded`, and
  `aria-controls` while open), and the open content a `region` labelled by the title's own element, not by the toggle,
  whose name also carries the badge (Research's "Loading..."); collapsed, the content is not rendered, so the toggle
  controls nothing. `AppSettings.tsx` renders
  `settings/SettingsDialog.tsx` only while open (loaded on demand, `SettingsPlaceholder.tsx` standing in for the
  dialog's frame while its chunk loads or after it failed), and the dialog mounts ONE tab at a time
  (`settings/{AITab,DataTab,AccountTab,BackupTab}.tsx`, with `SecretInput` and `DataSourceBanner` as leaves): a tab's
  state is born fresh on every switch and its autosaves flush in its unmount cleanup, which is what keeps Sign out safe
  without a hand flush. Its tab bar is a `tablist`: the selected tab alone is in the tab order and takes focus as the
  dialog opens; Left and Right select the neighbour, wrapping, Home and End the first and the last, focus following;
  every tab's `aria-controls` names the one `tabpanel`, which the selected tab labels. A key switch unmounts the tab it
  leaves, so its autosave flushes as on a click. The row scrolls sideways where it does not fit.
  `TokenActivationForm.tsx` is the activation leaf shared with `PremiumGate.tsx` (its lock screen
  mounts only while locked) and with the chat's `ChatLockScreen`; `StrategicContextEditor.tsx` mounts its editor only while open: the dialog itself is
  `StrategicContextDialog.tsx`, loaded on demand, and saves through `savePreference`. `ChatBot.tsx` is the always-mounted shell over `components/chat/*.tsx` (ChatMarkdown, the memoised
  ChatMessage, TypingIndicator, ChatLockScreen on `TokenActivationForm`, ChatHeader, ContextInspector on `useNow(60_000)`,
  ChatEmptyState and ChatComposer with the textarea `ref` prop) and the two chat hooks; `isOpen` and the lock only hide its
  UI, so a reply keeps streaming and is stored behind a closed or re-locked chat (Phase 5 (d)). The shell and its two hooks
  load with the entry for that reason, and the leaves because they are small and the composer is the shell's focus
  target; only `ChatMarkdown` (react-markdown and remark-gfm) is loaded on
  demand, by `ChatMessage`, whose fallback while it loads AND if it fails is the reply's raw text. `PositionAnalysis.tsx` is
  the shell over `components/position/*.tsx` (PriceDisplay, PositionInputs, PnLStat, RecommendationBadge,
  DualRecommendationView, PriceLevelBar, ReasonList: pure leaves) and `usePositionSignals`; it pairs each field's edit with
  the other field for App's `onUpdate`, and a shares edit with no cost basis sends null (Phase 5 (d)).
- `netlify/functions/` TypeScript, every function in Netlify's v2 form (a default export): six `Request → Response`
  handlers (`askLLM`, `getLiveQuote`, `getTickerContext`, `validateToken`, `getMarketData`, `getModels`), typed from
  `types/market.ts` (every error body is checked against `ApiErrorBody` with `satisfies`), and the scheduled
  `collectFlowHistory`, whose default export ignores the request (Netlify posts the NEXT run's time) and returns
  nothing; it exports `runCollection()` with an injectable Supabase client for tests. Its schedule is its last line,
  `export const config: Config = { schedule: '30 21 * * 1-5' };`, in the one form Netlify reads from the source when it
  bundles the function: `satisfies Config`, `as const`, a constant or a template literal there typechecks and loses
  the schedule without an error, and a named `handler` export beside the default makes the file a v1 function, which
  has none. The last test in `collectFlowHistory.test.js` checks the value, the absence of `handler` and the line
  itself. `netlify.toml` names no bundler: Netlify traces a v2 function with nft and builds its entry with esbuild
  whatever `node_bundler` says, its relative imports (`lib/`, `shared/`) bundled in and the npm packages left external.
  Shared code in `netlify/functions/lib/`: `http.ts`, `ticker.ts`, `auth.ts` (also loaded by plain Node: see the token
  command), `quota.ts`, `marketDataHelpers.ts`, `supabaseAdmin.ts` and `supabasePublic.ts`.
- `shared/` pure modules imported by both `src/` and `netlify/` (`marketCalendar.js`: ET clock, NYSE holidays and
  early closes, session windows, `isExpiryClosed`; `thresholds.js`: the P/C, dark-pool, P&L, GEX, staleness and
  recommendation cut-offs used by the engine, the KPI cards, the chat context and the LLM prompt). No Node or
  browser APIs, no `console`, injectable `now`; `netlify.toml` lists it in `included_files`.
- `supabase/migrations/` — run 001→005 in order in the SQL editor; all idempotent (see `supabase/README.md`).
- `types/market.ts` — the JSON contracts shared by `src/` and `netlify/` (`MarketData`/`MarketDataResponse`,
  `LiveQuote`, `TickerContext`, `ModelList`, `TokenValidation`, `ApiErrorBody` and the error-code unions); declarations
  only, included by both tsconfigs; `netlify/` must never import `src/`. Server/client discrepancies found while
  deriving it: #60. Where a function and the contract disagree, the function is typed as it behaves, its payload
  unchanged: converting the functions fixed none of them.
- `types/supabase.ts` — the Supabase generator's output for the public schema (the seven tables of migrations
  001→005), committed exactly as generated (`npm run types:supabase`) and imported only with `import type`. It is the
  `Database` of every `createClient<Database>` (`lib/supabaseAdmin.ts`, `lib/supabasePublic.ts`,
  `src/lib/supabase.ts`), so a query written in TypeScript is checked against the tables and their columns; the
  JavaScript callers (`SupabaseBackend.js`, `session.js`, `LoginForm.jsx`) are not.
- `services/quant/` (planned, Phase 7) Python FastAPI quant service + nightly pipeline; `infra/` (planned,
  Phase 8) Terraform for AWS. See the roadmap's Phase 7/8 for the skill-building rationale.

## Conventions
- Secrets: BYOK keys live only in localStorage (`SECRET_KEYS` in `store.ts`) and are never synced or exported;
  `DEVICE_KEYS` (secrets + per-browser flags) never sync, export or import; `LAYOUT_KEYS` sync but never raise the
  sync-conflict prompt.
- Persistence: the Supabase backend is keyed on the signed-in user (`useSupabaseAuth`'s `activeUserIdRef`); `hydrate()` never
  pushes into a non-empty cloud — it pulls into an empty browser, pushes into an empty account, and otherwise reports
  `conflict` so App shows `SyncChoice` (merge / cloud / local) and nothing is written until the user picks. Sign-out
  is `signOut()` in `src/lib/session.js` (confirm, send queued cloud writes for up to 5 s, Supabase sign-out, clear
  local user data + secrets + JWT, reset the backend); a `local_data_owner` mark records whose data the browser holds, and `claimLocalData()` clears another
  account's data (secrets kept) before a new account's backend exists. Replacing a backend disposes it.
  When a session ends and this tab finds the owner mark gone, `useSupabaseAuth` clears once more whatever was written
  after the sign-out's clear (a late edit, the dashboard's unmount saves, a hydrate still reading). When the mark still
  reads as the ended account's, which is how another tab's sign-out first looks here (its SIGNED_OUT arrives a few
  milliseconds before this tab's view of the storage shows its clear; measured with two Chromium tabs), the hook
  watches the mark through `storage` events: once it is gone the same clear follows, with that account's
  `sync_outbox_`/`sync_meta_` keys (`clearAccountSyncState` in `SupabaseBackend.js`); a session arriving or a skip here
  check the mark once more first; another account's mark stops the watch. A browser in use without an account
  (`auth_skipped`) and a session revoked elsewhere (the mark kept) are left alone. Other limits are in the fix commits'
  bodies (a sign-out heard late, a token activation in flight, a skip made before this tab hears the mark's removal, in
  another tab or here while this tab's view still shows the mark).
  An edit still inside its debounce at an account switch reaches neither account (known: it is written through the old
  account's backend, then cleared with that account's queue, since the client already holds the new session).
  Cloud writes go through a per-user outbox persisted in localStorage (`src/lib/syncOutbox.js`, `sync_outbox_<uid>`)
  that retries network failures (a returned `{ error }` without a code) with backoff; deletes are tombstones
  (`deleted_at`, migration 005); where both sides changed an item, the newer `updated_at` wins (`sync_meta_<uid>`).
  `store-changed` carries an optional `detail: { kind, id }`; no detail means "everything" (`useChatHistory` drops a streaming
  reply on one). Components do not add their own window listener for it: they read through `src/hooks/useStoreValue.ts`
  (`useChatHistory` subscribes through `subscribeStore`, keyed on a live reply, and `usePositionDraft` keyed on its
  ticker's position), and a
  UI write that this tab must see goes through `savePreference(name, value)` in `src/lib/storeEvents.ts` (the write plus
  `store-changed` with a `pref` detail); `setPreference` itself stays silent, which the import, hydrate and sync paths
  rely on. `storeEvents.ts` keeps one permanent window listener and counts events per kind and per item, so a reader
  scoped to its item (`useStoreObject(read, key, 'position', ticker)`) is not re-rendered by a preference save.
  `ai-settings-changed` no longer exists; `data-source-changed` stays for the data hooks; `auth-changed` feeds
  `usePremiumStatus`.
- Functions accept BYOK via headers/body (`x-tradier-key`, `x-finnhub-key`, `userApiKey`); server keys are
  only for access-token holders (`netlify/functions/lib/auth.ts`), and refused with 503 if `TOKEN_SECRET`
  is unset. New functions must use `lib/http.ts` (CORS allowlist, `fetchWithTimeout`, `errorResponse`
  with a request id, `rateLimit`) and `lib/ticker.ts` before touching an upstream URL.
- Market-hours logic is Eastern Time via `shared/marketCalendar.js` (holidays and early closes included); never
  use local `Date` for market decisions.
- Data fetching (Phase 5 (b)): one `QueryClient` (`src/lib/queryClient.ts`) with `retry: false` (the market-data hook
  owns its backoff and the hook tests pin request counts), `networkMode: 'always'` (fail fast offline to demo data;
  the default would pause silently) and no focus/reconnect refetch. A hook calls `useQuery(options, queryClient)` with
  a key from `keys`, and reads during render every result field it derives from (the result is a tracked proxy: an
  unread field never re-renders). `data-source-changed` is handled inside each hook: market data and research
  cancel, then invalidate, their key family (a request in flight carries the old key); the quote removes the entries
  no mounted hook observes, then resets the rest (a reset leaves an unobserved entry uncollectable).
  A value already stale on its key's first render stays hidden until its own refetch lands (quote, research); demo
  data stands in only for a key that failed with nothing of its own. The hook tests are the contract; see the
  roadmap's Phase 5 step 2 for where they overruled the original sketch.
- Code-splitting (Phase 5 (e)): a part loaded on demand is declared at module level with
  `lazyWithPreload(() => import('./X.js'), { idle? })` (`src/lib/lazyWithPreload.ts`) and rendered inside its own
  `ChunkBoundary` (`src/components/ChunkBoundary.tsx`), placed tightly around the lazy alone, never bare `React.lazy`:
  the helper renders a module that is already in directly (no suspended frame after a preload, which is also what keeps
  the tests synchronous) and retries a failed import through a fresh `React.lazy`; the boundary handles ONLY a
  `ChunkLoadError` (its `fallback` while pending; `ChunkFailureCard` with Try again and Reload, or the caller's `failed`
  UI) and rethrows anything else to the root `ErrorBoundary`. A part that lays out the whole screen or a modal itself
  passes `failed` with its own frame around `ChunkFailureCard` (a frame around the boundary would frame the loaded part
  too). For a modal part the `fallback` and the `failed` frame are each a `ModalDialog` of their own
  (`SettingsPlaceholder`, the editor's `EditorModal`, `SyncChoiceLayer`), so on a slow chunk the stand-in's dialog
  closes and the loaded one opens in the same commit, remembering the same opener. `{ idle: true }` parts (the
  markdown renderer, the Settings dialog, the context editor's dialog) load in
  `scheduleIdlePreload()`, which App starts once the dashboard shows (`requestIdleCallback`, a 2 s timeout where it is
  missing, nothing under `saveData`); the charts are never preloaded. The chat shell and its hooks, `useSupabaseAuth` and
  the Supabase client stay eager: a lazy `getSupabase()` would be its own change, since it alters the start-up
  path of sign-in and sync. It is deferred (issue #93): a configured build already preloads the SDK beside the entry
  chunk, so loading it on demand would put it behind the entry for a signed-in visitor.
- Accessibility (Phase 6): what a later change keeps. A modal is a `ModalDialog`, never `<dialog open>` (the attribute
  opens it non-modally: no top layer, no inert page, and a `showModal()` on it throws) nor a `div` with
  `role="dialog"`; the phone chat is the one exception, since it is the sidebar's own element, and App makes the page
  inert around it. A dialog closes before its node leaves the document (`ModalDialog` does, in its layout cleanup), and
  its first focus is `initialFocus`, a ref, never `autoFocus`, which writes no attribute and focuses at mount, while the
  dialog is still closed. Every input, select and textarea has a programmatic label that is not its placeholder: a
  visible `<label htmlFor>` where the layout has room, an `sr-only` one where an icon and a placeholder are the design,
  ids from `useId()` (the token form shows up to three times on one screen). An error is an `alert`, and one about a
  field describes it and marks it `aria-invalid` until the next edit. A result announced as a `status` keeps its
  region in the tree from the component's first render, empty and `sr-only` alone, and fills that same node (the AI
  tab's key test, the Backup tab's import, the access request): a live region announces a change inside it, and one
  inserted together with its text is not read by every screen reader; an alert may be inserted with its text. A panel
  that scrolls under a sticky header carries scroll padding above the header's height (`scroll-pt-32` on the Settings
  panel and its stand-in), so a control scrolled into view for focus is never under it. One pattern per toggle: a
  fixed name with `aria-pressed` (`aria-expanded` for a section), or a name that states the action and no
  `aria-pressed` (the auto-refresh button). A control's name contains the text it shows (WCAG 2.5.3). Nothing is
  conveyed by a colour, a
  hover or a drawing alone: a reading has its words, visible or `sr-only` beside it (the KPI cards, news sentiment,
  each chart's one-sentence summary), and controls show at rest (the message actions at 75% opacity). What a class
  hides below a breakpoint and a screen reader needs is `sr-only` there, not `display: none` (the header's one `h1`);
  headings run from that `h1` to an `h2` per section, for the chat and for each dialog's title, and `h3` below.
  Colour: secondary and muted text use `--color-text-secondary` and `--color-text-muted`, 4.5:1 or more on all four
  backgrounds; small text in the accent, purple or bear colour on a raised surface or on its own tint uses
  `--color-accent-text`, `--color-purple-text` or `--color-bear-text`; white text sits on `--color-accent-solid`
  (hover: `--color-accent-solid-hover`); fills, borders and icons keep the base colours. A new colour under 4.5:1 for
  text (3:1 for an icon or large text) is a bug. Motion: the `prefers-reduced-motion` block at the end of
  `src/index.css` stops every decorative animation and hover scaling and ends every transition at once; a spinner
  (`animate-spin`) keeps turning, the only sign of progress where it shows. A new animation class is added to that
  block. A button, a link or a field is at least 24 by 24 CSS px (WCAG 2.5.8), reached with padding (`min-h-6`,
  `size-6`), the icon keeping its size. Proof: one `expectNoAxeViolations` and one `expectLabelledControls` per
  rendered state in the dom tests; contrast, target size, the focus trap, the inert page and touch only in a real
  browser, since jsdom shows none of them.
- `generateMockData` is random — memoize/stub in tests.
- TypeScript (Phase 5, incremental): new and converted modules are `.ts`/`.tsx`; relative specifiers keep the `.js`
  extension, except that a not-yet-converted `.jsx` module is imported by its real `.jsx` extension (Vite maps `.js`
  to `.ts`/`.tsx` only, and `.jsx` to `.tsx` once the target converts); `import type { X }` for types
  (`verbatimModuleSyntax`), never the inline `import { type X }` (lint's `no-import-type-side-effects`: Node's type
  stripping erases the inline specifier and keeps the import, which then looks for a `.js` file that does not exist);
  `as const` objects with derived unions, never `enum`;
  no `any`, no `!`, no `@ts-ignore`/`@ts-expect-error`; types state the documented contract and a permissive overload
  keeps a test-pinned tolerance honest (`formatShortDate(42) → 42`); a conversion changes no runtime behaviour and
  no importer; tests stay JS until converted on purpose. A conversion also changes no JavaScript wherever it can. A
  value that arrives untyped is asserted, not narrowed, because a narrowing changes what an unexpected value does: a
  caught value keeps the read it had (`(err as Error).message`, as `src/lib/api.ts` already did), and parsed JSON is
  asserted once, where it is parsed, to the fields the code reads, each with a comment saying why the assertion holds.
  A narrowing whose test never decides (`m.get(k) ?? []` for a `k` taken from `m.keys()`, a second operand for two
  variables that are set together) is kept for an invariant the compiler cannot see and no erased construct states
  honestly; it carries a comment and is named in the commit. The check: print the old `.js` and the new `.ts` through
  the TypeScript emitter with types erased and comments off, and every line the two differ in must be one of those
  narrowings. `npm run typecheck` must be clean.
- Commit messages: imperative subject, body explains *why*. End every commit with
  `Co-Authored-By: Claude <noreply@anthropic.com>` and `Claude-Session: <session url>` (a local CLI session without a
  URL uses its session id, `$CLAUDE_CODE_SESSION_ID`: owner, 2026-09-29); never a model identifier
  (Fable, Opus, Sonnet…) anywhere in a commit message or PR — a harness reminder that suggests one loses to this rule
  (owner, 2026-09-26). Agents inherit this rule; the lead fixes any trailer that deviates when cherry-picking.
