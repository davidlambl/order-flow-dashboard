<!-- Source of truth for the modernization roadmap. Each phase is tracked as a GitHub issue labelled `roadmap`. -->

# Order Flow Dashboard — fresh-look review & improvement plan

## Context

`davidlambl/order-flow-dashboard` is a React 19 / Vite 7 / Tailwind 4 / Recharts 3 options-flow
dashboard with Netlify Functions (Tradier → CBOE → mock market data, multi-provider LLM proxy,
Yahoo live quotes, Finnhub/Alpha Vantage ticker context) and Supabase persistence.
~8.2k lines across 51 files. Created 2026-02-28; last commit to `main` 2026-03-12
(six months idle). No tests, no CI workflow, no CLAUDE.md.

The owner wants a fresh look and a prioritized proposal of fixes, enhancements and features.
Work happens on branch `claude/admiring-pascal-egfvqf`.

## State of the repo (verified 2026-09-25)

**Build**: `npm run build` passes (~5 s) but emits one 1.05 MB JS chunk (305 kB gzip) —
no code-splitting; Vite warns.

**Lint**: `npm run lint` FAILS — 28 errors, 1 warning:
- 19 × `no-undef` — `eslint.config.js` applies `globals.browser` to *everything*, so the Node
  code in `netlify/functions/**` and `scripts/generate-token.js` trips on `process`, `Buffer`, etc.
- 6 × `react-hooks/set-state-in-effect` (new in eslint-plugin-react-hooks 7): `src/hooks/useMarketData.js:122,149`,
  `src/hooks/useAutoSave.js`, `src/App.jsx`, `src/components/AppSettings.jsx`, `StrategicContextEditor.jsx`, `PositionAnalysis.jsx`, `KPICards.jsx`
- 1 × `react-refresh/only-export-components`, 1 × `no-useless-escape`, 1 × `no-unused-vars`,
  1 × `react-hooks/exhaustive-deps` warning (`useMarketData.js:168` missing `data`).

**Security audit**: `npm audit` → 6 vulnerabilities (5 high, 1 low), all in the dev toolchain
(vite `server.fs.deny` bypass, `ws`, `brace-expansion`, `browserslist`, `postcss`, `nanoid`, …).
None ship to the browser bundle; all fixable by dependency bumps.

**Outdated deps**: majors available for vite 8, eslint 10 / @eslint/js 10, @vitejs/plugin-react 6,
lucide-react 1.x, dotenv 18, @netlify/functions 6, globals 17. Minors for react 19.3, recharts 3.10,
@supabase/supabase-js 2.117, tailwindcss 4.3.

**Open PRs — seven owner PRs from 2026-03-12 that were never merged, plus one Copilot draft:**

| PR | Branch | Changes | Merge vs main |
|----|--------|---------|---------------|
| #20 | fix/recommend-engine | zero costBasis, div-by-zero, neutral net premium (`src/lib/recommend.js`) | clean |
| #21 | fix/chatbot-stale-closures | `messagesRef` for stale closures in ChatBot | clean |
| #22 | fix/data-integrity | `?? 0` vs `\|\| 0`, null darkPoolPct, skip empty-options upsert | clean |
| #23 | fix/live-quote-preservation | pre-market priority, shared ET-time helper in getLiveQuote | clean |
| #24 | fix/store-safety | import backup, quota-error logging, costBasis type | clean |
| #25 | fix/hook-stability | useAutoSave saveFn ref, bounded caches | clean |
| #26 | ux/error-boundary-and-a11y | ErrorBoundary, viewport zoom, PositionAnalysis skeleton | clean |
| #29 | copilot/sub-pr-21 (draft, base = #21) | fold `chunkBuf` into `messagesRef` reads | clean |

All eight also merge cleanly when stacked sequentially (verified with local test merge:
14 files, +250/−101, zero conflicts). `mergeable_state` is `blocked` only because branch
protection wants an approving review (owner's "APPROVE" on #22 was posted as a *comment*).
Netlify deploy previews + GitGuardian are green on all of them.

**Spot-check of the PR diffs (read every hunk):**
- #22, #23, #24, #25, #26 — correct as written; safe to merge. Nits to carry forward:
  - #25 cache eviction is FIFO-by-first-insertion, not LRU (`cache.set` on an existing key does
    not move it, so a hot ticker can be evicted right after refresh). Fix: `cache.delete(k)` before `cache.set(k)`.
  - #22 makes `darkPoolPct` `null` for every Tradier user (Tradier path hard-codes `iv30: 0`);
    `formatPct(null)` renders "—" so it is safe, but the KPI becomes permanently "No data" on Tradier.
- **#20 body over-claims.** Diff contains only (a) `Math.max(0, Number(shares)||0)` and (b) the
  three-way net-premium branch. The described zero-`costBasis` guard, division-by-zero handling and
  `extractPriceLevels` falsy-guard fixes are NOT in the branch — `recommend.js:13` still reads
  `if (!costBasis || !spotPrice || !kpis) return null;` and `:18` still divides by `costBasis`.
  Merge it, but the missing three fixes go into Phase 1.
- **#29 (Copilot draft on #21) crashes ChatBot.** The ticker-change `useEffect` lists
  `getCompleteMessages` in its deps array (~line 636) but `const getCompleteMessages = useCallback(...)`
  is declared ~40 lines later (~line 676) → TDZ `ReferenceError` on first render. Vite builds it fine
  (no `no-use-before-define` rule), which is why the Netlify preview showed green. Do NOT merge #29
  as-is: move the `useCallback` above the effect (or fold the fix into #21 by hand). The idea is right.
- #21 itself is fine (`useLayoutEffect` keeps `messagesRef` in sync; `userMsg` is appended explicitly
  because the ref lags one render).

## Findings from code review

### Verified directly (own reading)
- **Visible text bug** `src/App.jsx:293,298`: footer JSX text contains `—` / `×` — JSX text does
  not process JS escapes, so the page literally shows "—". (Other `\u` uses in Header/KPICards are
  inside JS strings and fine.) Fix: use `—` / `×` characters or `{'—'}`.
- **Dark Pool % is synthetic** `netlify/functions/lib/marketDataHelpers.js:281-285`: `37.5 + (iv30-30)*0.1`
  clamped to 25–55. It is not data. Options: label it clearly as "estimate" in the card, replace with FINRA
  ATS weekly off-exchange share (free), or swap the card for a real metric (IV rank, gamma-flip level).
- **Ticker unvalidated** `netlify/functions/getMarketData.js:39` → interpolated into upstream URLs in
  `marketDataHelpers.js` (`fetchCBOE`/`fetchTradier`). Needs `^[A-Z.\-]{1,10}$` whitelist (same in
  getLiveQuote / getTickerContext).
- **Math is standard**: GEX = γ·OI·100·S²·0.01 per strike (calls +, puts −, all expiries summed, ±20% window);
  max pain = nearest expiry only; net premium = vol·mid·100 with no buy/sell side inference. All fine as
  heuristics but none are per-expiry and there is no gamma-flip (zero-crossing) level — cheap feature.
- `getMarketData.js` returns `detail: err.message` to the client (`:160`) and uses `Cache-Control: max-age=60`
  even for user-key (Tradier) responses served via CDN — key-specific data could be cached publicly.
- `App.jsx`: chat sidebar is a fixed-width `<aside>` (384px default) with mouse-only resize
  (`handleResizeStart` uses `mousemove`/`mouseup`, no pointer/touch events) → unusable on phones.
  Ticker lives only in React state (no `?ticker=` URL sync, no watchlist); default hard-coded `'AVGO'`.

### Frontend (components/hooks) — from reviewer (top items re-verified by me)
**High**
- **F1 One failed background refresh replaces live data with random demo data.** `useMarketData.js:111-117`:
  the catch block ignores `silent` and calls `setData(generateMockData(symbol))` + `setUsingMock(true)`;
  auto-refresh then stops (`:147` requires `!usingMock`) and never recovers without a manual refresh.
  Fix: in silent mode keep last good `data`, set `error`, retry with backoff; mock only when there has never
  been a successful load. (Strong case for TanStack Query: `placeholderData: keepPreviousData`, `refetchInterval`.)
- **F2 = D7** `useAutoSave` first-edit loss. **F3 = D8** import wipes API keys. **F4 = D1** cross-account leak.
- **F5 = D10** ~60 full-history saves/upserts per second while streaming; `updatePosition` upserts per keystroke.
- **F6** Ticker change mid-stream appends the reply to the *new* ticker's history (`ChatBot.jsx:626-633,673-687`);
  `askLLMStream` already accepts `signal` (`api.js:67,75`) but ChatBot never passes one; `sending` blocks the
  new ticker until the old stream ends. Fix: AbortController in a ref, abort on ticker change/unmount, tag
  streams with ticker → also gives a **Stop button** for free.
**Medium**
- **F7** "Suggest Strategic Context updates" (`ChatBot.jsx:737-763`) streams with no placeholder assistant
  message → `flushChunks` appends to the previous answer with no separator and persists it mutated.
- **F8** Provider errors inside the stream are swallowed (`api.js:52-56` returns null for `{type:'error'}`) →
  stream ends, no bubble, no error. Also treat zero chunks as an error.
- **F9** `useTickerContext.js:31-62`: context not cleared on ticker change → Header earnings badge, GEX 50/200MA
  lines and chat news show the *old* ticker's data on the new ticker; A→B while A loading and B cached
  leaves `loading` stuck true. `useLiveQuote.js:76-79` aborted request's `finally` resets loading for a
  newer in-flight request.
- **F10** `App.jsx:36-39` `getSession()` no `.catch` → spinner forever; `LoginForm.jsx:18` `signInWithOtp` no try/catch.
- **F11** Expired token: `api.js:81,168` call `clearToken()` but App's `isPremium/tokenTier/daysLeft` never
  update → Header shows PRO while every request 401s. Fix: `auth-changed` event + `useSyncExternalStore`.
- **F12 Perf**: `setSecondsLeft` ticks 1 Hz in App state (`useMarketData.js:157-165`) → whole tree incl.
  every ReactMarkdown message and both Recharts charts re-render every second. `MessageBubble` not memoized,
  `onDelete={() => deleteMessage(i)}` new each render, `key={i}`. Fix: countdown state lives in Header;
  `React.memo(MessageBubble)`; stable message ids.
- **F13** `AppSettings.jsx:187-191` fetches model list on every keystroke of the key field; double-fetch on
  open (`:175` + `:190`); `testKey` (`:232-259`) no stale-response guard.
- **F14 GexChart** (`GexChart.jsx:85-90` vs `:202`, `:47-69`): legend says green=Calls/red=Puts but bars are
  colored by sign of net GEX; SPOT/BASIS/50MA/200MA `ReferenceLine`s snap to nearest strike on a categorical
  axis — an out-of-range level is drawn at the edge strike. Fix: numeric XAxis + exact `x=`; hide out-of-domain.
- **F15 recommend.js**: confidence asymmetric (`:109` — `[0,0,0,0,0]` → HIGH HOLD, `[+1,+1,-1,-1,0]` → LOW);
  `netPremium===0` scored bearish (`:83-89`, fixed by PR #20); ±2 thresholds (`:107`) don't scale with the
  number of available factors; `extractPriceLevels` (`:128-135`) picks largest-|GEX| strike not nearest;
  P/C 0.7/1.0 and dark-pool 30/40 thresholds duplicated in KPICards/ChatBot.
- **F16** `FlowChart.jsx:88-91` `new Date('YYYY-MM-DD')` is UTC midnight → US users see dates one day early.
- **F17** `PositionAnalysis.jsx:196,213` labels a live Yahoo price "~15min delayed" (badge keyed on options
  provider); `:441` says "since last close" but measures from the options snapshot; staleness `useMemo`
  (`:323-334`) depends only on `lastUpdated` so "stale" never appears while idle (also the purity lint error).
- **F18** Small: `App.jsx:246` renders "0"; max-pain `0` shows "$0.00" (`KPICards.jsx:59`, `ChatBot.jsx:367`);
  `TickerResearch.jsx:286,294` `left: NaN%` when high==low target; `ChatBot.jsx:697` double-submit guard is
  state not ref; `:363` missing netPremium labelled BEARISH; `:359` "LAST UPDATED: undefined"; uncleared
  `setTimeout`s (`ChatBot.jsx:423,518,890`, `PremiumGate.jsx:28`); `store.js:47,116` no quota catch.

**Lint (actual list, from running eslint)**: `set-state-in-effect` App.jsx:145, StrategicContextEditor.jsx:26,
useAutoSave.js:19, useMarketData.js:122,149; `exhaustive-deps` useMarketData.js:168; `only-export-components`
AppSettings.jsx:28 (`getAISettings` exported from a component file → move to `lib/aiSettings.js`);
`purity` PositionAnalysis.jsx:325 (`Date.now()` in `useMemo`); `no-unused-vars` KPICards.jsx:5 is a false
positive (`icon: Icon` used in JSX) → add `argsIgnorePattern`. Restructure notes: derive `loading` from
`{ticker,data}` state or adopt TanStack Query; derive `secondsLeft` from `nextRefreshAt`; make `useAutoSave`
imperative (`schedule(value)`/`flush()`); position state via `useSyncExternalStore`; mount editors/modals
only while open with lazy `useState` initializers (also kills AppSettings' 20-setState effect at `:146-176`);
`key={ticker}` on the Header search form.

**UX gaps**: the ERROR badge (`App.jsx:240`) can never show (error ⇒ usingMock); `useTickerContext`/`useLiveQuote`
errors ignored; `TickerResearch.jsx:423` says "Add a Finnhub key" even when one exists; `PositionAnalysis`
returns null while loading (inputs vanish on refresh — PR #26 adds a skeleton); no chat Stop button, textarea
disabled while streaming, no Retry on error bubbles. **A11y**: modals lack `role="dialog"`/focus trap/focus
return (`AppSettings.jsx:355`, `StrategicContextEditor.jsx:48`); tab bar lacks tablist roles; unlabeled inputs
(`PositionAnalysis.jsx:380,392`, `AppSettings.jsx:424,571,607,724`, token inputs, `LoginForm.jsx:55`);
hover-only `opacity-0` action buttons (`ChatBot.jsx:455`); `--color-text-muted` #5a6475 on #111518 ≈ 3.1:1
contrast used for most 9-11px text; no `prefers-reduced-motion`. **Mobile**: chat aside min 280px flex
sibling squeezes main on phones → full-screen overlay below `md`; Header doesn't wrap; settings tab row
doesn't scroll. **Hard-coded → settings**: default ticker, refresh 30/60 s (duplicated in Header.jsx:123),
staleness cut-offs, recommendation thresholds, LLM history window `slice(-10)`, cache TTLs, no ticker validation
in `Header.jsx:17`.

**Decomposition seams** (line ranges verified by reviewer):
- `ChatBot.jsx` → `lib/financialContext.js` (18-375, split into positionBlock/gexBlock/flowBlock/signalBlock/
  painBlock/researchBlock; 177-193 duplicated), `ChatMarkdown.jsx` (377-413), `ChatMessage.jsx` (415-493),
  shared `TokenActivationForm` replacing `ChatLockScreen` (502-598), `useChatHistory(ticker)` (608-647),
  `useLLMStream()` (669-773; `sendMessage`/`requestContextSuggestions` ~90% identical), `ChatHeader`
  (815-875), `ContextInspector` (878-902), `ChatEmptyState` (910-933), `ChatComposer` (943-976).
- `AppSettings.jsx` → `lib/aiSettings.js` (28-36), `SecretInput` (×3: 430-448, 576-594, 612-630), `AITab`
  (401-526) + `useAIModels(provider,key)`, `DataTab` (531-638), `DataSourceBanner` (534-566 → one
  `PROVIDER_META` map shared with `App.jsx:291-310` and `Header.jsx:187-208`), `AccountTab` (643-792),
  `BackupTab` (797-930).
- `PositionAnalysis.jsx` → `PriceLevelBar` (53-109), `RecommendationBadge` (111-172), `PriceDisplay` (180-280),
  `usePositionSignals()` (284-347), `PositionInputs` (376-403), `PnLStat` (×3), `ReasonList` (×3),
  `DualRecommendationView` (435-560).
- `TickerResearch.jsx` → reuse `CollapsibleSection` (370-481 re-implements it), `NewsPanel`, `EarningsCard`,
  `RatingBar`, `AnalystPanel`, `MarketIndicesStrip`, `MarketHeadlines`; `timeAgo` → `format.js`.
- Duplicates: token activation ×3 (`ChatBot.jsx:507-527`, `PremiumGate.jsx:15-37`, `AppSettings.jsx:262-282`)
  → `useTokenActivation()`; "days until earnings" ×3; `isStale` ×2; `useTickerContext`/`useLiveQuote` cache
  code → `createCachedResource(fetcher, ttl)`; `MarketContext` + `AuthContext` to kill 12-prop drilling.
- Dead: `formatDollarFull`, `deletePosition` (unused → use it for a "clear position" button), unused hook
  returns (`error`/`refresh`), `handleTickerChange` wrapper, stale "UW API" comment in `mockData.js:3`.

**Cheap features (data already fetched / plumbing exists)**: Stop button (abort signal exists); Fundamentals &
Technicals card (RSI, 52w range, P/E, margins, beta, ROE, div yield fetched at `ChatBot.jsx:289-333` but only
sent to the LLM); daily price change on screen (`data.priceChange/Pct` only in LLM context); portfolio /
recent-tickers switcher from `getAllPositions()`/`getAllChatHistories()`; Retry buttons (unused `refresh`
returns); GEX extras: zero-gamma flip level (cumsum), call/put walls (`callGex`/`putGex` already in data),
IV30 expected-move band (ChatBot computes it at `:220-222`); FlowChart daily-net as signed bars on 2nd axis;
remember last ticker; holiday calendar; export chat to Markdown; token count in context inspector.

**Library notes**: Recharts — numeric XAxis fixes F14; `ResponsiveContainer debounce={100}` (resizes every
frame of the 300 ms sidebar animation); FlowChart two Areas of wildly different magnitude on one axis.
react-markdown — no `a` override (links navigate away, losing draft), `code` override hits fenced blocks with
no `pre` override (overflow in narrow sidebar), `h1/h2` unstyled, `list-inside` wraps badly.
React 19 — replace effect-syncing with derived state / `key` resets / `useSyncExternalStore` for the three
window-event stores; token forms → `useActionState`.

**Test targets**: pure first — `recommend.js` (threshold boundaries, confidence asymmetry, string inputs,
`optionsMarketOpen` branch), `format.js` (`formatDollar(999.999)` → "$1000.00" not "$1.0K";
`formatDollar(999_999)` → "$1000.0K"), `marketDataHelpers.js` (`parseOptionSymbol`, `computeGEX`,
`computeMaxPain` incl. returns-0 edge, `computePutCallRatio`, `computeNetPremium`), `mockData.js` (needs
injectable RNG). Export-then-test: `parseSSELine` + buffer splitting, `isMarketOpen`/`isOptionsMarketOpen`
(`vi.setSystemTime`), `buildFinancialContext` (snapshot), `auth.js` decode/expiry, `store.js` `importAll`
(regression for D8). Hooks via `renderHook` + fake timers + MSW: `useAutoSave` (D7 regression), `useMarketData`
(F1), `useTickerContext`/`useLiveQuote` (F9; module-level cache needs an exported reset), ChatBot streaming
(F6/F7 with mock ReadableStream), `SupabaseBackend` (D5/D1 with a fake client).

### Serverless / security — from reviewer (top items re-verified by me)
**Critical**
- **C1 Fail-open auth.** `askLLM.js:152` / `getModels.js:92` verify the JWT only `if (tokenSecret && !hasUserKey)`,
  then fall back to `process.env.ANTHROPIC_API_KEY` (`askLLM.js:181`). With `TOKEN_SECRET` unset (README
  calls it optional) anyone can bill the server key, while `validateToken.js:27` returns 500 so the UI
  *looks* locked. Fix: fail closed (503 when a server key would be used without a secret); make
  `TOKEN_SECRET` required in docs.
- **C2 No cost controls on askLLM.** Client picks any `model` (`:65`), `max_tokens` defaults 16384 (`:50-54`),
  no limits on `messages`/`financialContext` size, `content` passed through unchanged (images/docs), no
  per-`sub` quota, no `jti`/revocation, `tier` claim never checked server-side, pro tokens last 365 days.
  Fix: `ALLOWED_MODELS` env allowlist, clamp `max_tokens`, size caps, per-sub daily quota (Supabase table),
  log `sub`+model+usage, add `jti` + revocation table.
- **C3 Data endpoints spend server keys for anyone.** `getTickerContext.js:166` (12 Finnhub calls/request
  on a 60/min free tier; Alpha Vantage 25/day at `:62,96`), `getMarketData.js:41` (up to 9 Tradier calls),
  `getLiveQuote.js:391` — none check a token; CORS `*` everywhere. Fix: require token before any *server*
  key is used (anonymous = BYOK or free CBOE/Yahoo only), restrict `Access-Control-Allow-Origin`, add
  IP rate limiting (Netlify rate-limit rules), short per-ticker server cache.

**High**
- **H1** Ticker unvalidated in `getMarketData.js:39` and `getTickerContext.js:158`, interpolated unencoded into
  `marketDataHelpers.js:7,55,80,97` and `getTickerContext.js:198-203` (query-param smuggling, CBOE path
  traversal on same host; also used as `earnings_cache` PK). `getLiveQuote.js:13` already has a regex — share it.
- **H2** JWT: no `algorithms` pin, no `iss`/`aud`, `exp` not required (`validateToken.js:45`, `askLLM.js:160`,
  `getModels.js:104`); `validateToken.js:48` defaults missing tier to `'pro'`; `generate-token.js:22,38` takes
  `--secret` on argv; verification code copied in 3 files. Fix: one `netlify/functions/lib/auth.js`.
- **H3** `getMarketData.js:151` `Cache-Control: public, max-age=60` with no `Vary` on `x-tradier-key`.
- **H4** `collectFlowHistory.js:36-82` fetches 11 CBOE chains sequentially (SPY/QQQ are multi-MB), no timeout,
  single upsert at the end → likely exceeds the scheduled-function limit and loses the day; lookup errors
  at `:43-51` silently reset `prevCum` to 0; no holiday handling (duplicate row double-counts `cum_premium`).
- **H5** No upstream fetch has a timeout/`AbortController` (askLLM `:57,80,103`; getModels `:14,28,56`;
  marketDataHelpers `:7,54,79,96`; getLiveQuote `:70,202,349`; getTickerContext `:54,97`); `req.signal`
  never forwarded, so client aborts don't stop paid generations.

**Medium (correctness)**
- **M1** Tradier→CBOE fallback only on throw (`getMarketData.js:48-53`); empty chains → 404, null quote →
  502 instead of falling back; chain fetches don't check `r.ok` (`marketDataHelpers.js:104`); BYOK user never
  told their key failed. Add `fallbackReason` to the response.
- **M2** Metrics: Dark Pool synthetic (see above); Net Premium has no aggressor side (rename "premium traded"
  or classify vs bid/ask); GEX uses all expiries on CBOE but only 6 nearest on Tradier (`:94`) → provider-
  dependent numbers; Max Pain nearest expiry can be an already-closed 0DTE; P/C returns `0` when call vol is 0
  (`:248`) — should be `null`.
- **M3** `getLiveQuote.js:307-329` overwrites `quote.current` with an NQ-implied estimate built on the *prior*
  session's close → after 4 PM / weekends the stock's own last move is discarded. Keep the estimate in
  `futuresContext` only; never overwrite `current`. (PR #23 touches this area — coordinate.)
- **M4** getLiveQuote picks source by fixed order not newest timestamp (`:227-253`); no holidays/early closes;
  Finnhub `c: 0` treated as valid (`:354`); Yahoo `query2` scraping with fake UA (`:72,204`); errors return
  `err.message` and inherit `Cache-Control: private, max-age=60` (`:19`).
- **M5** getTickerContext: `forwardPE: m.peTTM` (`:289`) is trailing P/E; revenue pairing falls back to
  `cal[0]` (`:224`) = next quarter's estimate paired with last quarter's EPS; RSI is Cutler not Wilder
  (`:34-49`); `/stock/candle` is paid on Finnhub so `technicals` is always null on free keys (`:268`);
  always returns 200 even when every section failed, cached 900 s (`:24`).
- **M6** Earnings cache TTL = last report + 95 days (`:78-80,124-129`) → stale for early reporters and, once
  past, re-hits Alpha Vantage on *every* request until AV publishes. Add a `fetched_at` refetch floor (12 h).
- **M7** askLLM streaming: mid-stream provider errors (Anthropic `error`/`overloaded_error`, Gemini
  `finishReason: SAFETY`) are dropped by `src/lib/api.js:42-61` → silent truncation; `getMaxOutputTokens`
  (`:50-54`) gives `gpt-4-turbo` 16384 (limit 4096 → 400); default model `claude-sonnet-4-20250514` (`:65`)
  is likely retired — verify against claude-api skill before changing.
- **M8** `detectProvider` (`askLLM.js:18-24`) decides by model first → `model:"gpt-4o"` + `sk-ant-` key sends
  the Anthropic key to OpenAI; `getModels.js:6-11` treats any non-`sk-` key as Gemini; Gemini key in URL
  query (`:102`). Require explicit `provider`, check key prefix, use `x-goog-api-key` header.

**Low**
- L1 `err.message`/config leaks to clients (`askLLM.js:211-214,237-240`, `getMarketData.js:158-161`,
  `getModels.js:152`, `getLiveQuote.js:414,418`, `validateToken.js:29`).
- L2 BYOK keys stored in **localStorage** (`src/lib/store.js:20-25`) — README says session storage.
- L3 Service-role key used for public reads (`getMarketData.js:121-131`) and for cache writes triggered by
  unauthenticated requests (`getTickerContext.js:133-137`).
- L4 Scheduled function wiring is correct (`schedule()` v1 style); modern form is `export const config = { schedule }`.
- L5 `netlify.toml:6` pins Node 20 (EOL 2026-04-30) → move to 22, `engines >=22`.
- L6 Hard-coded config → env: `TRACKED_TICKERS`, `NASDAQ_100_CONSTITUENTS` (stale), `MARKET_SYMBOLS`,
  default models, token limits, 6-expiry / ±20% windows, 45-day history window. `ALPHA_VANTAGE_KEY` missing
  from `.env.example`.
- L7 No `node_bundler = "esbuild"`; getTickerContext eagerly imports supabase-js; handlers mix v1/v2
  signatures; no structured logs / request IDs / error tracking.

### Data layer / Supabase / hygiene — from reviewer (top items re-verified by me)
**Critical**
- **D1 Cross-account data leak on shared browser.** Sign-out only swaps the backend (`App.jsx:58-68`); positions,
  chats, prefs, BYOK keys and the premium JWT stay in localStorage. Next sign-in → `hydrate()` ends with
  `_pushLocal()` (`SupabaseBackend.js:197-232`) which upserts user A's local data into user B's account.
  Also: switching accounts without sign-out never re-inits (guard `App.jsx:51` is a boolean, not keyed on
  `userId`) → writes go out with A's `user_id` under B's session and RLS rejects them silently (`:126`).
  Fix: key backend on `userId`; on sign-out/user-change clear or namespace local user data; never
  auto-push local into an account that already has cloud rows without confirmation.
- **D2 Migration 003 is invalid SQL** (`003:18-20`: `FOR INSERT, UPDATE, DELETE ... USING` — Postgres allows one
  command per policy and no `USING` on INSERT). Run as a batch, `earnings_cache` is never created; the read
  error is swallowed (`getTickerContext.js:67-89`) so every request hits Alpha Vantage (25/day). The policy
  is pointless anyway (service_role bypasses RLS) — delete it.
- **D3 `.env.example:20` says run only 001**, which leaves `USING (true)` "Full access" policies (`001:48-55`)
  on user tables with the anon key in the bundle. 002's RLS (`auth.uid() = user_id`) is correct once applied.
  README never mentions Supabase/migrations.

**High**
- **D4 Migrations are destructive/non-idempotent.** `002:6-8` unconditional `DELETE FROM positions/preferences/
  chat_histories`; no `IF NOT EXISTS` anywhere; no CLI/migration tracking (paste-into-SQL-editor).
  FKs lack `ON DELETE CASCADE` (`002:11-13`) so auth user deletion fails. `updated_at` has no trigger.
- **D5 Sync retry is dead code.** `_flush` retries only when `op()` throws (`SupabaseBackend.js:127-137`), but
  postgrest-js returns `{ error }` for network failures → offline writes are dropped on first try; queue is
  in-memory only (`:14`); `_pushLocal` uses `ignoreDuplicates: true` so failed edits never repair.
- **D6 No conflict handling.** `hydrate` is "local wins, fill gaps only" (`:154-186`); next write overwrites
  the whole cloud document (chat = entire message array `:80-83`); deletes resurrect via `_pushLocal`;
  no `updated_at` comparison anywhere.
- **D7 `useAutoSave` swallows the first edit after `reset()`** (`useAutoSave.js:18,33-39`): `reset()` sets
  `initialRef=true`; the flag only clears on a value *change*, so if the loaded value equals current state
  (every reopen, and first use with an empty field) the user's first edit is skipped. Pasting an API key in
  one go and closing → never saved (same for Tradier/Finnhub/Strategic Context). Fix: baseline-compare
  instead of skip-flag. Also: cleanup clears the timer without flushing (`:29`), no `pagehide` flush,
  `flush()` never sets `saved`.
- **D8 Import is lossy** (`store.js:238-258`): `clearAll` wipes secret keys that exports never contain (`:125,140`);
  on SupabaseBackend `clearAll` leaves cloud alone (`SupabaseBackend.js:99-103`) so dropped items come back
  on next hydrate; unknown imported pref names become raw localStorage keys (`:107,114,252-255`).
- **D9 Premium gating is client-side and fakeable.** `auth.js:61-67` decodes `exp` without verifying the
  signature; only verified server-side on first activation (`PremiumGate.jsx:24`). Hand-made JWT unlocks
  Position Analysis / Research / chat UI; chat then works with a user key since askLLM skips the check when
  `userApiKey` is present. "Ticker Research" isn't really gated: `useTickerContext` fetches for everyone
  (`App.jsx:77`) and data reaches ungated Header earnings (`:209`) and GexChart technicals (`:284`).
  "Revoke token" (`AppSettings.jsx:284-288`) only deletes the local copy.

**Medium**
- **D10 Chat streaming hammers storage**: every rAF flush → `setMessages` → save effect (`ChatBot.jsx:635-638`)
  rewrites localStorage + queues a full-JSONB Supabase upsert (~60/s while streaming); no AbortController
  passed to `askLLMStream` (`:714-725`) so a ticker switch mid-stream appends the rest of the reply to the
  *new* ticker's history; `role:'error'` messages are persisted; position edits upsert per keystroke.
- **D11 Two unlinked login systems**: Supabase magic-link (cloud sync) vs JWT (premium). Header "Sign out"
  icon only clears the JWT (`Header.jsx:178-182`); real sign-out is buried in Settings › Account; "Continue
  without signing in" not remembered (`App.jsx:31,191`) → login screen every reload; `signInWithOtp` lacks
  `emailRedirectTo` (`LoginForm.jsx:18`); `getSession()` has no `.catch` (`App.jsx:36`) → spinner forever.
- **D12 `store-changed`/StrictMode**: `setPreference` called inside state-updater functions
  (`CollapsibleSection.jsx:21-25`, `TickerResearch.jsx:385-389`) → double writes in dev; no cross-tab
  `storage` event handling.
- **D13 Bundle (1.05 MB)**: recharts (+redux-toolkit, immer, d3) via `GexChart.jsx`/`FlowChart.jsx`;
  react-markdown + remark-gfm via `ChatBot.jsx:4-5` (closed by default, gated); supabase-js (incl. unused
  Realtime) via `supabase.js:3`; AppSettings 934 lines. `React.lazy` ChatBot/charts/AppSettings/LoginForm,
  dynamic-import supabase only when `VITE_SUPABASE_*` set, `manualChunks` for vendor caching.
- **D14 README inaccuracies (verified list)**: key storage claim (line 45, says sessionStorage), "uses Anthropic
  Claude" (43, it's 3 providers), premium list omits Ticker Research (49), env table missing FINNHUB /
  ALPHA_VANTAGE / 4× SUPABASE vars and calls TOKEN_SECRET optional (81-85), tech stack omits Supabase /
  Finnhub / Alpha Vantage / Yahoo / scheduled fn, functions list omits 4 functions + lib/, lib list omits
  5 files, hooks list omits 3, components list omits 8, tree omits `supabase/`, `scripts/`, `main.jsx`.
- **D15 Infra gaps**: no `.github/` CI, no tests/`test` script, no TS/jsconfig, no `.nvmrc`/LICENSE/CLAUDE.md,
  Node 20 EOL, `tailwindcss`+`@tailwindcss/vite` in `dependencies` not `devDependencies`, mixed v1/v2
  function handler styles, `index.html` blocks pinch-zoom (fixed by PR #26) and Google Fonts CSS is
  render-blocking.
- **D16 flow_history**: no holiday skip (double-counts `cum_premium`), hard-coded tracked tickers with a stale
  TODO (`collectFlowHistory.js:12`), no retention (growth is tiny, ~2.8k rows/yr — low priority).

## Proposed roadmap (sequenced; each phase = one or a few PRs off `claude/admiring-pascal-egfvqf`)

Owner's choices: land the March PRs first by merging them into this branch; full modernization; all four
feature areas matter (data quality, AI co-pilot, positions/recommendations, charts/UX/mobile); the deployed
site is single-user and `TOKEN_SECRET` is already set (fail-closed auth can ship immediately); license = MIT.
Effort: S ≈ hours, M ≈ a day, L ≈ days.

### Phase 0 — Land the seven March PRs (S)
Branch protection blocks self-approval, so the practical route is to merge the seven branches into the
working branch here (they merge cleanly, verified) and let one PR carry them; GitHub marks #20-#26 merged
automatically once their commits reach `main`.
1. `git merge` in order: #20, #22, #23, #24, #25, #26, #21 (no conflicts).
2. Hand-apply #29's `getCompleteMessages` idea into ChatBot.jsx **above** the ticker-change effect; close #29.
3. Carry-forward nits: LRU-correct eviction in `useLiveQuote.js`/`useTickerContext.js` (`delete` before `set`).
4. Build + lint-diff + smoke run (`npx netlify dev` not available here → `npm run dev` with mock data).

### Phase 1 — Server security & cost controls (M) — before anything public-facing changes
Files: `netlify/functions/askLLM.js`, `getModels.js`, `validateToken.js`, `getMarketData.js`,
`getTickerContext.js`, `getLiveQuote.js`, new `netlify/functions/lib/auth.js`, `lib/http.js`, `lib/ticker.js`.
1. Fail closed: no `TOKEN_SECRET` ⇒ 503 for any request that would use a server key (C1). Docs: required.
2. Shared `verifyAccessToken()` — `algorithms:['HS256']`, `iss`/`aud`, `exp` required, `tier` default `trial`,
   `jti` + `revoked_tokens` table (migration 004) (H2). `generate-token.js`: secret from env/stdin only.
3. `askLLM` guardrails: `ALLOWED_MODELS` env allowlist, `max_tokens` clamp per model, `messages` ≤ 40 /
   string-only content ≤ 8 KB / `financialContext` ≤ 32 KB, usage log `{sub, model, usage}` (C2).
   Per-sub daily quota in a `usage_log` table (same migration). Explicit `provider` required; key-prefix
   check; Gemini key via header; `encodeURIComponent(model)` (M8).
4. Data endpoints: token required before any *server* Finnhub/AV/Tradier key is used; anonymous gets BYOK or
   free CBOE/Yahoo only (C3). `Access-Control-Allow-Origin` = `process.env.SITE_ORIGIN`. Netlify rate-limit
   rules in `netlify.toml` for `/api/*`.
5. `lib/ticker.js`: one `TICKER_RE`, 400 on mismatch, all upstream URLs built with `URL`/`searchParams` (H1).
6. `lib/http.js`: `fetchWithTimeout(url, opts, ms)` using `AbortSignal.any([req.signal, AbortSignal.timeout(ms)])`;
   apply to every upstream call (H5). Generic client error bodies + server-side `requestId` logging (L1).
7. `getMarketData`: `Cache-Control: private` + `Vary: x-tradier-key` (H3); anon-key reads for `flow_history` (L3).
8. Supabase migrations: fix 003's invalid policy (D2); new `000_README.md` + `.env.example` "run 001→004 in
   order" (D3); make DDL idempotent, drop the `DELETE`s from 002, add `ON DELETE CASCADE`, `(select auth.uid())`,
   `TO authenticated`, `DEFAULT auth.uid()`, `updated_at` trigger (D4). Add `supabase/config.toml` for the CLI.
9. Client: verify signature server-side at startup, `auth-changed` event so an expired/cleared token updates
   Header/ChatBot (D9, F11); gate `useTickerContext` fetch behind premium (D9).

### Phase 2 — Data correctness (M)
1. `useMarketData`: silent refresh keeps last good data, sets `error`, retries with backoff; mock only on
   first-load failure; ERROR badge becomes reachable (F1). (Superseded by TanStack Query in Phase 5 —
   do the minimal fix here so it ships early.)
2. Provider fallback: validate spot+options inside tier selection, fall back to CBOE on bad Tradier data,
   check `r.ok`, add `fallbackReason` to the payload and a Header hint (M1). Same expiry window for both providers (M2).
3. Metrics honesty: P/C `null` when no call volume; max pain skips already-closed 0DTE; Net Premium relabelled
   "Premium traded (calls − puts)"; Dark Pool card → "Estimated" badge now, replaced by a real metric in
   Phase 7 (M2, F18 `$0.00`).
4. Live quote: never overwrite `current` with the futures estimate (`futuresContext` only); pick source by
   newest timestamp; Finnhub `c:0` invalid; holiday/early-close calendar in a shared `lib/marketCalendar.js`
   used by server + client `isMarketOpen` (M3, M4).
5. Ticker context: `forwardPE` → real forward or drop; remove `|| cal[0]` revenue fallback; Wilder RSI;
   return `errors:{}` map + 502 when everything failed; earnings cache `fetched_at` refetch floor (M5, M6).
6. Flow collector: per-ticker upsert, `p-limit` concurrency, timeouts, holiday skip, lookup error ⇒ skip not
   reset; `TRACKED_TICKERS` from env (H4, D16).
7. Frontend correctness: finish #20's missing zero-costBasis/div-by-zero guards + confidence symmetry +
   factor-scaled thresholds + nearest-strike levels (F15); `useTickerContext` clears on ticker change and
   fixes stuck loading (F9); FlowChart UTC dates (F16); PositionAnalysis badge/labels (F17); App.jsx footer
   escapes, `totalOptionsCount` "0", NaN marker, double-submit ref, uncleared timeouts (F18);
   GexChart numeric axis + correct legend (F14); react-markdown `a`/`pre` overrides (library notes).
8. Streaming: `{type:'error'}` / `finishReason` handling in `parseSSELine` (F8, M7); placeholder assistant
   message before every stream (F7); AbortController per stream, abort on ticker change ⇒ Stop button (F6);
   per-model `max_tokens` table verified against the claude-api skill (M7).

### Phase 3 — Persistence & sync (M–L)
1. Key backend on `userId`; on sign-out or user change clear/namespace local user data and the JWT; never
   auto-push local rows into an account that already has cloud rows — prompt "merge / replace / keep cloud" (D1).
2. `useAutoSave` → imperative `schedule(value)`/`flush()`, baseline compare, flush on unmount + `pagehide`,
   `saved` set on flush (D7). Persist chat once per stream end (or debounced) and not `role:'error'`;
   debounce position upserts (D10).
3. Sync engine: treat returned `{error}` as retryable, persist the outbox in localStorage, coalesce per key,
   `updated_at` last-writer-wins using the DB trigger, tombstones for deletes (D5, D6).
4. Import: keep secrets, replace cloud too (or warn), validate pref names, dispatch settings-changed events (D8).
5. Auth UX: one "Sign out" that clears both; "Remove access token" wording; remember "continue without
   signing in"; `emailRedirectTo`; `.catch` on `getSession` (D11, F10). Later: tie premium to the Supabase
   user via a `premium_users` table + RLS and retire the separate JWT (design decision for owner).
6. `setPreference` out of state updaters; cross-tab `storage` sync (D12).

### Phase 4 — Tooling, CI, hygiene (M) — compatibility verified against the npm registry
Node target **22** (not 24): `@netlify/functions@6` needs ≥22.12, `@supabase/supabase-js@2.117` needs ≥22,
`vitest@5`/`jsdom@30`/`jest-dom@7` need 22; Netlify's default runtime; nothing needs 24.
1. Pin Node 22: `netlify.toml` `NODE_VERSION="22"`, `engines: >=22.12`, `.nvmrc`. Add `.editorconfig`,
   `LICENSE` (MIT, per owner) + `"license":"MIT"`, `.github/pull_request_template.md`, `.github/dependabot.yml`
   (weekly, grouped minors), `CLAUDE.md` (purpose/tiers, commands, layout, conventions, testing, env table,
   gotchas), `.gitignore` += `coverage/`, `dist/stats.html`.
2. ESLint config split: base block for all files; `src/**` gets `globals.browser` + react plugins;
   `netlify/**`, `scripts/**`, `*.config.*` get `globals.node`; test files get both. `argsIgnorePattern:'^_'`.
   Kills the 19 `no-undef`; remaining hooks errors are fixed by Phases 2/5 restructures.
3. Safe minors in one commit: `react@^19.3 react-dom@^19.3 recharts@^3.10 @supabase/supabase-js@^2.117
   tailwindcss@^4.3 @tailwindcss/vite@^4.3` (+ `@types/react*`). Move `tailwindcss`, `@tailwindcss/vite`,
   `dotenv@^18` to devDependencies (`dotenv` only used by `scripts/generate-token.js`).
4. ESLint 10 stack together: `eslint@^10 @eslint/js@^10 globals@^17 eslint-plugin-react-hooks@^7.1
   eslint-plugin-react-refresh@^0.5` (all verified to peer on ESLint 10; `configs.vite` still exists).
5. Test stack: `vitest@^5 @vitest/coverage-v8@^5 jsdom@^30 @testing-library/react@^16 @testing-library/dom@^10
   @testing-library/jest-dom@^7 @testing-library/user-event@^14 msw@^2`. Single `vitest.config.js` with
   `test.projects` = `node` (`netlify/**`, `scripts/**`) and `dom` (jsdom, `src/**`, `setupFiles: src/test/setup.js`
   with MSW server + `localStorage.clear()`). Scripts: `test`, `test:watch`, `test:coverage`, `typecheck`,
   `check` (lint+typecheck+test+build). First test files in order: `format`, `recommend`, `marketDataHelpers`
   (node), `api` (SSE chunk-boundary splitting; export `parseSSELine`), `auth`, `store`, `useAutoSave`,
   `useMarketData` (MSW; the regression net for the TanStack migration), `useLiveQuote`/`useTickerContext`,
   `PositionAnalysis`/`CollapsibleSection`, `getLiveQuote` (node, MSW for Yahoo/Finnhub).
6. CI `.github/workflows/ci.yml`: on push to main + PRs; matrix Node 22 (required) / 24 (informational,
   `fail-fast:false`); `npm ci`, lint, typecheck (once TS lands), `test --coverage`, build, upload `dist`;
   separate `audit` job `npm audit --omit=dev --audit-level=high` (passes today). Lint step
   `continue-on-error` until the hooks errors are closed, then required. Netlify previews + GitGuardian stay.
7. Vite 8 + `@vitejs/plugin-react@^6` **in one commit** (plugin 6 peers on `vite ^8` only; `@tailwindcss/vite@4.3`
   supports Vite 8; `vitest@5` supports 6–8) + `rollup-plugin-visualizer@^7` behind `ANALYZE=1`. Clears the
   vite/postcss/nanoid/browserslist audit chain; `npm audit fix` for `ws`/`brace-expansion`.
8. `@netlify/functions@^6` — `schedule()` still exported with the same signature; `collectFlowHistory.js`
   unchanged (optionally the v2 `export const config = { schedule }` form).
9. `lucide-react@^1` — five imported names are removed aliases: `AlertCircle→CircleAlert`,
   `AlertTriangle→TriangleAlert`, `BarChart2→ChartNoAxesColumn`, `CheckCircle→CircleCheck`,
   `Loader2→LoaderCircle` (App, ChatBot, AppSettings, PremiumGate, PositionAnalysis; grep before renaming).
   Do after Phase 0 so the ChatBot PRs don't conflict. Other 50 icons exist in 1.48.
10. README rewrite (every D14 item), `ALPHA_VANTAGE_KEY` + `SITE_ORIGIN` in `.env.example`, Supabase setup
    section (run 001→004 in order / CLI).

### Phase 5 — Frontend architecture (L)
1. **TypeScript, incremental**: `typescript@~5.9.3` (NOT 7 — `typescript-eslint@8` peers `<6.1`),
   `typescript-eslint@^8`, `@types/node@^22`, `@types/jsonwebtoken`. `tsconfig.json` (bundler resolution,
   `react-jsx`, `allowJs`, `checkJs:false`, `strict`, `verbatimModuleSyntax`, `types:["vite/client","vitest/importMeta"]`),
   `tsconfig.functions.json` (no DOM lib, `types:["node"]`), `src/vite-env.d.ts` for `VITE_*`. Shared JSON
   contracts in root `types/market.ts` (imported by both `src/` and `netlify/`; `netlify/` must not import
   `src/`). Conversion order via `git mv`: `format` → `types/market` → `recommend` → `auth`/`mockData` →
   `store` (declare `StoreBackend` interface, `PrefName = keyof typeof PREF_MAP`) → `api` → hooks (or as
   part of the TanStack rewrite) → `main.tsx`/`App.tsx` → small components → the four big components only as
   they are decomposed (each extracted piece born `.tsx`). Netlify functions → real `.ts` (esbuild bundler
   handles it), v1 handlers (`getMarketData`, `getModels`) migrated to the v2 `Request/Response` shape at the
   same time. Supabase types: `npx supabase gen types typescript --project-id <ref>` → `types/supabase.ts`,
   `createClient<Database>` on both sides; `types:supabase` script.
2. **TanStack Query v5** (`@tanstack/react-query@^5`, ~13 kB gz; SWR lacks function-form `refetchInterval`
   and retry control). `src/lib/queryClient.ts`: `staleTime 60 s`, `gcTime 15 min`, retry ×2 with exponential
   backoff skipping `AbortError`, `refetchOnWindowFocus:false`. New pure `src/lib/marketHours.ts`
   (`isMarketOpen`, `isOptionsMarketOpen`, `getRefreshMs`) + `useMarketClock()`. `useMarketData` =
   `useQuery({ queryKey:['marketData',ticker], placeholderData: keepPreviousData, refetchInterval: q =>
   autoRefresh && optionsMarketOpen && !q.state.error && q.state.data ? getRefreshMs(provider) : false })`;
   `usingMock = !q.data && q.isError` (mock only on first-load failure — fixes F1 structurally);
   `secondsLeft` → `useCountdown(q.dataUpdatedAt)` living in Header (fixes F12). `useTickerContext`
   (`staleTime 15 min`), `useLiveQuote` (`refetchInterval 60 s`, `keepPreviousData`). Deleted: both module
   `Map` caches, all abort/epoch/timer refs, the `data-source-changed` listeners (AppSettings calls
   `queryClient.invalidateQueries()`).
3. **`useSyncExternalStore` stores**: `src/lib/storeEvents.ts` with `subscribe/notify/useStoreValue`; safe for
   primitive snapshots (`section_*`, `sidebarWidth`, `ai_provider`); for object snapshots (`getPosition`,
   `getChatHistory`) use a `version` counter + `useMemo` to avoid the infinite-loop trap. Replaces
   `store-changed`/`ai-settings-changed` `CustomEvent`s and the `set-state-in-effect` patterns in
   `CollapsibleSection`, `TickerResearch`, `App`. `MarketContext` + `AuthContext` end the 12-prop drilling.
4. **Decomposition order** (chosen to avoid conflicts with the March PRs, which touch ChatBot ×3,
   PositionAnalysis ×2, store, recommend, the three hooks, getLiveQuote, marketDataHelpers, KPICards):
   `TickerResearch` (no PR overlap; already 7 internal components → `components/research/*.tsx`,
   `timeAgo` → lib) → `AppSettings` (no overlap; by tab → `components/settings/*`, `useModelList`,
   `useKeyTester`, `getAISettings` → `lib/aiSettings.ts`) → `ChatBot` (after Phase 0; `lib/financialContext.ts`
   with tests, `components/chat/*`, `useChatStream`, `useChatHistory`) → `PositionAnalysis`
   (`components/position/*`) → `App` (`useSupabaseAuth`, `useResizableSidebar`, `usePremiumStatus`).
   Extract pure logic first, presentational leaves second, stateful hooks last.
5. **Code-splitting** (after Vite 8): `React.lazy` + `Suspense` (existing skeletons as fallbacks) for
   `ChatBot` (+ markdown graph; mount only while open, `requestIdleCallback` preload), `ChartsPanel`
   (GexChart+FlowChart+recharts), `AppSettings`/`LoginForm`/`StrategicContextEditor`/`RequestAccessForm`.
   `src/lib/supabase.ts` → `getSupabase()` lazy `import('@supabase/supabase-js')` gated on `VITE_SUPABASE_*`
   (statically replaced, so non-Supabase sites never fetch the chunk). Vite 8 is rolldown-based:
   `build.rolldownOptions.output.advancedChunks.groups` for `react`, `recharts`(+d3/victory-vendor),
   `markdown`(unified/micromark/mdast/hast…), `supabase`, `query`. Expected initial chunk ≈ 250–320 kB
   minified (from 1.05 MB) with recharts/markdown/supabase as separately cached lazy chunks — confirm with
   `ANALYZE=1 vite build` and record before/after in the PR.

### Phase 6 — UX, accessibility, mobile (M)
Chat as full-screen overlay below `md` + pointer/touch/keyboard resize handle; dialogs with `role`, focus
trap, focus return; tablist semantics; labels on every input; visible (not hover-only) message actions;
muted-text contrast ≥ 4.5:1; `prefers-reduced-motion`; error/retry surfaces for every data source;
Header wrapping; settings tabs scroll; remember last ticker; ticker input validation; PositionAnalysis
inputs stay visible while loading.

### Phase 7 — New-technology track: WebGL, Python quant service, ops console (L)
Reframed (owner decision, 2026-09-25) to build skills the current stack doesn't exercise: WebGL-based UI,
Python numeric/algorithmic backend, real data pipelines, and human-in-the-loop operations tooling.
Phases 0–6 are unchanged and remain prerequisites (TypeScript + decomposition before the WebGL work;
Phase 1's auth before any new service is exposed). Each item is its own PR.

1. **WebGL options-chain visualization with deck.gl** (`@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/react`,
   `OrthographicView`, no basemap). New `src/components/chain/ChainHeatmap.tsx`: strike × expiry grid of
   gamma exposure / open interest / volume (toggle), one GPU-instanced `SolidPolygonLayer` or
   `ScatterplotLayer` cell per contract (tens of thousands), GPU-side color scale, zoom/pan, hover tooltip
   with the contract's greeks, spot / max-pain / gamma-flip reference lines as a `LineLayer`. Needs the full
   chain (not the ±20 % trimmed `gexByStrike`) → the server returns `chain` (compact typed arrays) behind a
   `?full=1` flag with the Phase 1 token check. Keep Recharts for the small charts; swap `GexChart` for a
   deck.gl strike profile only if the heatmap proves the approach. Perf budget: first paint < 100 ms for
   20k cells, 60 fps pan on a laptop GPU; measure with `performance.mark`.
   Optional stretch: react-three-fiber 3D gamma / IV surface (strike × expiry × value) as a second view.
2. **Python quant service** (`services/quant/`, FastAPI + numpy + Polars, `uv` for deps, Ruff + mypy + pytest):
   ports `computeGEX`, `computeMaxPain`, `computePutCallRatio`, `computeNetPremium` and adds what the JS
   never had — per-expiry GEX, gamma-flip level, IV rank/percentile from history, Wilder RSI, expected-move
   bands. Typed API (`/v1/metrics/{ticker}`, `/v1/chain/{ticker}`, `/v1/history/{ticker}`) with OpenAPI schema
   consumed by the React app through a generated client (`openapi-typescript`). Golden tests: the Python
   metrics must match the JS helpers on a fixture chain before the JS is deleted.
3. **Nightly data pipeline** replacing `collectFlowHistory` (H4/D16 closed for good): scheduled job ingests
   full chains for the tracked tickers into Postgres (Supabase) or Parquet on S3 with a `runs` table
   (ticker, started, finished, status, row_count, error), idempotent per (ticker, date), holiday-aware,
   per-ticker timeouts and concurrency, backfill command. Pipeline steps are pure functions with unit tests.
4. **Ops console** (`src/pages/Ops.tsx`, premium-gated): data freshness per ticker, last run status and
   duration, anomaly flags from validation rules (empty chain, spot jump > 20 %, OI collapse, duplicate
   session), and human-in-the-loop actions — re-run, backfill a date range, mark a row as reviewed with a
   note. Validation rules live in the Python service; the console is the "data repair / validation
   workflow" pattern in miniature.
5. **UX craft**: Storybook for the decomposed components (Phase 5 output) with stories for loading / error /
   empty states; Playwright visual-regression screenshots in CI for the dashboard and the heatmap.
6. **Quick wins kept from the old feature list** (do opportunistically, one PR each): daily price change in
   Header; Fundamentals & Technicals card (data already fetched); chat export to Markdown; `?ticker=` URL
   sync; recent-tickers switcher; multiple lots per ticker; "clear position" via the unused `deletePosition`;
   FINRA ATS off-exchange share replacing the synthetic Dark Pool %.

### Phase 8 — Cloud infrastructure, containers, observability (M–L)
Runs alongside Phase 7 once the Python service exists. Goal: honest hands-on AWS, containers, IaC and
monitoring/alerting, without paying for a managed Kubernetes cluster for a hobby app.

1. **Containerize** `services/quant` (multi-stage Dockerfile, non-root user, `uv` lockfile, healthcheck);
   `docker compose` for local dev with Postgres. Frontend stays on Netlify.
2. **AWS deploy with Terraform** (`infra/`): ECR, ECS Fargate service (or App Runner, whichever is cheaper
   at this scale) behind an ALB with TLS, Parameter Store / Secrets Manager for provider keys, EventBridge
   schedule → the nightly pipeline task, CloudWatch log groups, a budget alarm. State in S3 + DynamoDB lock.
   GitHub Actions: build → push image → `terraform plan` on PR, `apply` on main with OIDC (no long-lived keys).
3. **Kubernetes as a learning track, not production**: Helm chart for the service + a CronJob for the
   pipeline, run on local k3d; `kubectl`/Helm workflows documented in `services/quant/README.md`. Revisit a
   managed cluster only if there's a real reason.
4. **Observability**: OpenTelemetry in FastAPI (traces + metrics), OTLP export to Grafana Cloud free tier
   (or Sentry for errors); dashboards for request latency, pipeline run duration, rows ingested; alerts:
   nightly run failed / missed, any ticker stale > 36 h, error rate > 2 %, ALB 5xx. Netlify functions get
   structured JSON logs with a request id (closes L7).
5. **Runbook**: `docs/RUNBOOK.md` — how to backfill, rotate a key, roll back a deploy, read an alert.

Skill map vs the target role: WebGL/React (7.1), Python algorithms + API design (7.2), data pipelines +
scaling workflows (7.3), validation/repair tooling and UX for operations (7.4, 7.5), AWS/containers/IaC/
CI-CD (8.1–8.2), Kubernetes (8.3), monitoring/alerting (8.4). Geospatial specifically is out of scope for
this repo; a follow-on project (MapLibre + deck.gl + PostGIS + shapely) can reuse the 7.2/8.x patterns.

## Suggested PR sequence (one PR per line unless noted)
1. Phase 0: "chore: land March fix PRs (#20–#26) + #29 ordering fix" — closes the seven PRs on merge.
2. Phase 4 steps 1–2 + 6: Node 22 pin, hygiene files, ESLint split, CI (lint non-blocking) — early so every
   later PR runs under CI.
3. Phase 1: server security & cost controls + migrations fix (may split: auth/quota vs migrations).
4. Phase 2: data correctness (split: server providers/quotes/collector vs frontend correctness/streaming).
5. Phase 3: persistence & sync (split: sign-out/hydrate safety + useAutoSave vs sync engine + import).
6. Phase 4 steps 3–5, 7–10: dep minors → ESLint 10 → Vitest + first tests → Vite 8 → lucide 1 → README.
7. Phase 5: TS scaffolding + lib conversions → TanStack Query (+ hook tests first) → storeEvents →
   decomposition (one PR per component) → code-splitting.
8. Phase 6: UX/a11y/mobile.
9. Phase 7: deck.gl heatmap → Python service (golden tests) → pipeline → ops console → Storybook/VRT; quick wins as they fit.
10. Phase 8: Dockerfile/compose → Terraform + ECS + OIDC CI → k3d/Helm → OpenTelemetry + alerts → runbook.

## Verification (per PR, and end-to-end)
- Local gate on every PR: `npm run lint && npm run build`, then `npm run test` once Vitest exists, then
  `npm run check` once `typecheck` exists. `npm audit --omit=dev --audit-level=high` must stay clean.
- Smoke in the browser (`npm run dev` here uses mock data; `npx netlify dev` locally with keys): ticker
  change, refresh + auto-refresh countdown, settings modal (paste a key in one go, close, reopen → still
  there = D7 fixed), chat open/stream/stop/ticker-switch mid-stream, position inputs while loading, import/
  export round trip keeps API keys, sign-out then sign-in as another user pushes nothing (D1).
- Phase 0: `git merge-tree` clean (already verified); after merging, `grep -n getCompleteMessages
  src/components/ChatBot.jsx` shows the `useCallback` declared before the ticker-change effect.
- Phase 1: `curl -X POST <site>/.netlify/functions/askLLM -d '{"messages":[...]}'` without a token → 401;
  with `TOKEN_SECRET` removed from env → 503 (not 200); `?ticker=../../x` → 400; `x-tradier-key` responses
  carry `Cache-Control: private` + `Vary`; `curl -I` shows `Access-Control-Allow-Origin` = site origin only;
  `psql -f 003_earnings_cache.sql` runs without error on a scratch DB; askLLM with `model:"gpt-4o"` +
  Anthropic key → 400 provider mismatch.
- Phase 2: MSW test — market data 500 on a *background* refetch leaves previous data and sets error
  (F1); `computePutCallRatio([])` → `null`; FlowChart renders `2026-03-12` as Mar 12 in `TZ=America/New_York`
  (`vi.stubEnv`/`process.env.TZ` in the node project); SSE fixture with `{type:"error"}` → error bubble.
- Phase 4/5: CI green on Node 22; `ANALYZE=1 vite build` shows initial chunk < 350 kB and recharts /
  markdown / supabase as separate chunks; Netlify deploy preview loads lazy chunks with `base:'./'`;
  `npx tsc -p tsconfig.json --noEmit` and `-p tsconfig.functions.json` clean; hook tests written before
  the TanStack rewrite pass unchanged after it.
- Phase 6: keyboard-only walkthrough (open settings, tab through tabs, Esc closes and focus returns);
  Lighthouse a11y ≥ 90; 375 px viewport shows chat as overlay with main content still usable.
- Phase 7: golden test — Python metrics equal the JS helpers on the fixture chain to 1e-9 before the JS
  path is removed; heatmap perf marks (< 100 ms first paint at 20k cells) recorded in the PR; ops console
  re-run triggers a pipeline run visible in the `runs` table; Storybook builds in CI; VRT baseline committed.
- Phase 8: `terraform plan` clean on PR and `apply` from main via OIDC; `curl https://<alb>/healthz` 200;
  EventBridge run appears in CloudWatch and Grafana; force a failed run and confirm the alert fires;
  `helm install` on k3d serves the same image.
- Not verifiable here: live provider behavior (Tradier/CBOE/Yahoo/Finnhub/AV) and the Netlify scheduled
  function timing (H4) — verify on the deploy preview / function logs after Phase 2.
