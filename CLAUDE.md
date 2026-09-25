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
4. Before pushing: `npm run lint` (see known baseline below), `npm run verify:functions`, `npm run build`, and
   `npm test` once it exists.
5. Line numbers in the roadmap were taken at commit `9cf9ccd` + the Phase 0 merge; re-grep before editing.

## Commands
- `npm install` then `npm run dev` — Vite on :5173 with **mock data** (no functions).
- `npx netlify dev` — functions on :8888 + Vite proxy (`vite.config.js`); needs a `.env` from `.env.example`.
- `npm run build` — must pass. `npm run lint` — baseline after Phase 3 (PR a): 5 errors, 0 warnings (four
  `react-hooks/set-state-in-effect` in `App`, `StrategicContextEditor` and `useMarketData`, one
  `react-refresh/only-export-components` in `AppSettings`), all owned by Phase 5; don't add new ones. CI runs lint
  non-blocking until that count is zero, then it becomes required.
- `npm run verify:functions` — drives every function in-process with a stubbed `fetch` (blocking in CI). The runner
  is `scripts/verify-functions.mjs`; Phase 2 checks live in `scripts/verify/<area>.mjs` and get the runner's helpers
  via `ctx`. Server areas: `calendar`, `marketData`, `liveQuote`, `tickerContext`, `collector`; client areas
  (pure `src/lib` modules loaded under Node): `recommend`, `clientLib`, `charts`, `sse`, `saver`, `store`, `sync`.
  `scripts/verify/helpers.mjs` has the browser-global stand-ins (`memoryStorage`, `withGlobals`, `fakeWindow`,
  `settle`) and `sync.mjs` exports the recording fake supabase-js client. Time-dependent code takes an injectable
  `now` (and the saver injectable timers), so checks never depend on the wall clock.
- `npm audit --omit=dev --audit-level=high` — must stay clean (CI `audit` job).
- `node scripts/generate-token.js` — mint premium JWTs (`TOKEN_SECRET`).

## Layout
- `src/lib/` pure helpers + storage (`store.js` localStorage backend, `SupabaseBackend.js` cloud sync with an
  injectable client, `syncOutbox.js` its persistent write queue, `supabase.js` Node-safe client factory, `session.js`
  the one sign-out plus the `local_data_owner` and `auth_skipped` device flags, `debouncedSaver.js`
  baseline-compared debounce behind `useAutoSave`, `deepEqual.js`, `api.js` fetchers incl. SSE streaming, `sse.js`
  stream framing/events, `recommend.js`, `format.js`, `staleness.js`, `retry.js`, `gexChartHelpers.js`, `auth.js`
  JWT client side). Modules the Node harness loads use explicit `.js` relative imports (Vite resolves both) and no
  top-level `window`/`localStorage` access.
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
- `types/` (planned) shared JSON contracts between `src/` and `netlify/` — `netlify/` must never import `src/`.
- `services/quant/` (planned, Phase 7) Python FastAPI quant service + nightly pipeline; `infra/` (planned,
  Phase 8) Terraform for AWS. See the roadmap's Phase 7/8 for the skill-building rationale.

## Conventions
- Secrets: BYOK keys live only in localStorage (`SECRET_KEYS` in `store.js`) and are never synced or exported;
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
- Commit messages: imperative subject, body explains *why*.
