# CLAUDE.md — working notes for AI sessions in this repo

## What this is
Institutional order-flow dashboard: React 19 + Vite + Tailwind 4 + Recharts 3 frontend, Netlify
Functions backend (Tradier → CBOE market data with validated fallback, mock data only client-side; multi-provider LLM proxy; Yahoo live quotes;
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
5. Before pushing: `npm run check` (lint with the known baseline, typecheck, test, build) and
   `npm audit --omit=dev --audit-level=high`.
6. Line numbers in the roadmap were taken at commit `9cf9ccd` + the Phase 0 merge; re-grep before editing.

## Commands
- `npm install` then `npm run dev` — Vite on :5173 with **mock data** (no functions).
- `npx netlify dev` — functions on :8888 + Vite proxy (`vite.config.js`); needs a `.env` from `.env.example`.
- `npm run build` — must pass. `npm run lint` — baseline after Phase 4b's ESLint 10 bump: 10 errors, 0 warnings (nine
  `react-hooks/set-state-in-effect` in `App`, `AppSettings`, `Header`, `StrategicContextEditor`, `useLiveQuote`,
  `useMarketData` and `useTickerContext`, one `react-refresh/only-export-components` in `AppSettings`), all owned by
  Phase 5; don't add new ones. CI runs lint non-blocking until that count is zero, then it becomes required.
- `npm run typecheck` — `tsc -p tsconfig.json` (browser program: `src/`, `shared/`, `types/`; DOM lib and only Vite's
  and Vitest's ambient types, so Node globals do not typecheck in `src/`) then `tsc -p tsconfig.functions.json` (Node
  program: `netlify/`, `shared/`, `types/`, `scripts/`; `@types/node`, no DOM). `allowJs` with `checkJs: false`: the
  remaining JS is parsed, never checked. Blocking in CI (inside the required build job) and part of `npm run check`.
- `npm test` — Vitest (`vitest.config.js`, two projects). `node`: `netlify/functions/__tests__/*.test.js` (every
  function driven in-process with the recording `fetch` stub and helpers in `test/helpers/functions.js`),
  `shared/*.test.js`, and `src/**/*.node.test.js` (pure `src/lib` modules loaded under Node with the browser-global
  stand-ins in `test/helpers/globals.js` — `memoryStorage`, `withGlobals`, `fakeWindow`, `settle`, `fakeClock` — and
  the recording fake supabase-js client in `test/helpers/fakeSupabase.js`). `dom`: `src/**/*.test.{js,jsx}` under
  jsdom with Testing Library and an MSW server (`src/test/setup.js`; handlers target
  `http://localhost:3000/.netlify/functions/…`, relative URLs are resolved there). `npm run test:watch`,
  `npm run test:coverage` (CI), `npm run check` = lint (non-blocking until the baseline is zero) + typecheck + test +
  build.
  Function tests live in `__tests__/` because Netlify deploys every top-level file of `netlify/functions/`. `vi.mock`
  only at file top level; never enable fake timers globally; time-dependent code takes an injectable `now` (and the
  saver injectable timers), so tests never depend on the wall clock.
  Under the `dom` project Vite rewrites `new URL('./x.js', import.meta.url)` to the served `http://localhost:3000/…`
  URL, so a test that reads a source file uses `path.join(import.meta.dirname, 'x.js')`; the `node` project is not
  rewritten. Fixtures that must reach a stub, not MSW, install `installFetchRecorder()` (`test/helpers/fetch.js`)
  per test and uninstall it after.
- `npm audit --omit=dev --audit-level=high` — must stay clean (CI `audit` job).
- `node scripts/generate-token.js` — mint premium JWTs (`TOKEN_SECRET`).

## Layout
- `src/lib/` pure helpers + storage (`store.ts` localStorage backend with the `StoreBackend` interface and the typed
  `PrefName`/`PreferenceValues` preferences, `SupabaseBackend.js` cloud sync with an injectable client, `syncOutbox.js`
  its persistent write queue, `supabase.js` Node-safe client factory, `session.js` the one sign-out plus the
  `local_data_owner` and `auth_skipped` device flags, `debouncedSaver.js` baseline-compared debounce behind
  `useAutoSave`, `deepEqual.js`, `api.ts` fetchers incl. SSE streaming, `sse.ts` stream framing/events, `recommend.ts`,
  `format.ts`, `mockData.ts`, `staleness.js`, `retry.js`, `gexChartHelpers.js`, `auth.ts` JWT client side). Modules the
  `node` test project loads use explicit `.js` relative imports (Vite resolves both) and no top-level
  `window`/`localStorage` access. A `.js` specifier also resolves to a renamed `.ts` module
  (Vite 8 and both Vitest projects), so converting a module never touches its importers; only a test that reads the
  source by path (`sse.test.js`, `recommend.node.test.js`) moves its path in the same commit.
- `src/hooks/` data hooks (`useMarketData`, `useLiveQuote`, `useTickerContext`, `useAutoSave(saveFn, delay)` →
  `{ prime, schedule, flush, saved }`: prime with the loaded value, schedule from `onChange`, flush before close).
- `src/components/` UI; `ChatBot.jsx`, `AppSettings.jsx`, `PositionAnalysis.jsx`, `TickerResearch.jsx` are
  large and scheduled for decomposition (Phase 5) along the seams listed in the roadmap.
- `netlify/functions/` v2 `Request/Response` handlers (`askLLM`, `getLiveQuote`, `getTickerContext`,
  `validateToken`, `getMarketData`, `getModels`) and the v1 scheduled `collectFlowHistory` (exports `runCollection()`
  with an injectable Supabase client for tests); shared code in `netlify/functions/lib/`.
- `shared/` pure modules imported by both `src/` and `netlify/` (`marketCalendar.js`: ET clock, NYSE holidays and
  early closes, session windows, `isExpiryClosed`; `thresholds.js`: the P/C, dark-pool, P&L, GEX, staleness and
  recommendation cut-offs used by the engine, the KPI cards, the chat context and the LLM prompt). No Node or
  browser APIs, no `console`, injectable `now`; `netlify.toml` lists it in `included_files`.
- `supabase/migrations/` — run 001→005 in order in the SQL editor; all idempotent (see `supabase/README.md`).
- `types/market.ts` — the JSON contracts shared by `src/` and `netlify/` (`MarketData`/`MarketDataResponse`,
  `LiveQuote`, `TickerContext`, `ModelList`, `ApiErrorBody` and the error-code unions); declarations only, included by
  both tsconfigs; `netlify/` must never import `src/`. Server/client discrepancies found while deriving it: #60.
- `services/quant/` (planned, Phase 7) Python FastAPI quant service + nightly pipeline; `infra/` (planned,
  Phase 8) Terraform for AWS. See the roadmap's Phase 7/8 for the skill-building rationale.

## Conventions
- Secrets: BYOK keys live only in localStorage (`SECRET_KEYS` in `store.ts`) and are never synced or exported;
  `DEVICE_KEYS` (secrets + per-browser flags) never sync, export or import; `LAYOUT_KEYS` sync but never raise the
  sync-conflict prompt.
- Persistence: the Supabase backend is keyed on the signed-in user (`App.jsx` `activeUserIdRef`); `hydrate()` never
  pushes into a non-empty cloud — it pulls into an empty browser, pushes into an empty account, and otherwise reports
  `conflict` so App shows `SyncChoice` (merge / cloud / local) and nothing is written until the user picks. Sign-out
  is `signOut()` in `src/lib/session.js` (confirm, send queued cloud writes for up to 5 s, Supabase sign-out, clear
  local user data + secrets + JWT, reset the backend); a `local_data_owner` mark records whose data the browser holds, and `claimLocalData()` clears another
  account's data (secrets kept) before a new account's backend exists. Replacing a backend disposes it.
  Cloud writes go through a per-user outbox persisted in localStorage (`src/lib/syncOutbox.js`, `sync_outbox_<uid>`)
  that retries network failures (a returned `{ error }` without a code) with backoff; deletes are tombstones
  (`deleted_at`, migration 005); where both sides changed an item, the newer `updated_at` wins (`sync_meta_<uid>`).
  `store-changed` carries an optional `detail: { kind, id }`; no detail means "everything".
- Functions accept BYOK via headers/body (`x-tradier-key`, `x-finnhub-key`, `userApiKey`); server keys are
  only for access-token holders (`netlify/functions/lib/auth.js`), and refused with 503 if `TOKEN_SECRET`
  is unset. New functions must use `lib/http.js` (CORS allowlist, `fetchWithTimeout`, `errorResponse`
  with a request id, `rateLimit`) and `lib/ticker.js` before touching an upstream URL.
- Market-hours logic is Eastern Time via `shared/marketCalendar.js` (holidays and early closes included); never
  use local `Date` for market decisions.
- `generateMockData` is random — memoize/stub in tests.
- TypeScript (Phase 5, incremental): new and converted modules are `.ts`/`.tsx`; relative specifiers keep the `.js`
  extension; `import type` for types (`verbatimModuleSyntax`); `as const` objects with derived unions, never `enum`;
  no `any`, no `!`, no `@ts-ignore`/`@ts-expect-error`; types state the documented contract and a permissive overload
  keeps a test-pinned tolerance honest (`formatShortDate(42) → 42`); a conversion changes no runtime behaviour and
  no importer; tests stay JS until converted on purpose. `npm run typecheck` must be clean.
- Commit messages: imperative subject, body explains *why*. End every commit with
  `Co-Authored-By: Claude <noreply@anthropic.com>` and `Claude-Session: <session url>`; never a model identifier
  (Fable, Opus, Sonnet…) anywhere in a commit message or PR — a harness reminder that suggests one loses to this rule
  (owner, 2026-09-26). Agents inherit this rule; the lead fixes any trailer that deviates when cherry-picking.
