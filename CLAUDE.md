# CLAUDE.md — working notes for AI sessions in this repo

## What this is
Institutional order-flow dashboard: React 19 + Vite + Tailwind 4 + Recharts 3 frontend, Netlify
Functions backend (Tradier → CBOE → mock market data; multi-provider LLM proxy; Yahoo live quotes;
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
4. Before pushing: `npm run lint` (see known baseline below), `npm run build`, and `npm test` once it exists.
5. Line numbers in the roadmap were taken at commit `9cf9ccd` + the Phase 0 merge; re-grep before editing.

## Commands
- `npm install` then `npm run dev` — Vite on :5173 with **mock data** (no functions).
- `npx netlify dev` — functions on :8888 + Vite proxy (`vite.config.js`); needs a `.env` from `.env.example`.
- `npm run build` — must pass. `npm run lint` — baseline until Phase 4a lands: 19 `no-undef` in
  `netlify/**` (browser globals applied to Node code) plus a handful of react-hooks errors; don't add new ones.
- `node scripts/generate-token.js` — mint premium JWTs (`TOKEN_SECRET`).

## Layout
- `src/lib/` pure helpers + storage (`store.js` localStorage backend, `SupabaseBackend.js` cloud sync,
  `api.js` fetchers incl. SSE streaming, `recommend.js`, `format.js`, `auth.js` JWT client side).
- `src/hooks/` data hooks (`useMarketData`, `useLiveQuote`, `useTickerContext`, `useAutoSave`).
- `src/components/` UI; `ChatBot.jsx`, `AppSettings.jsx`, `PositionAnalysis.jsx`, `TickerResearch.jsx` are
  large and scheduled for decomposition (Phase 5) along the seams listed in the roadmap.
- `netlify/functions/` v2 `Request/Response` handlers (`askLLM`, `getLiveQuote`, `getTickerContext`,
  `validateToken`) and v1 `handler(event)` ones (`getMarketData`, `getModels`, `collectFlowHistory`);
  shared code in `netlify/functions/lib/`.
- `supabase/migrations/` — run in order in the SQL editor (003 currently has invalid policy SQL; Phase 1 fixes).
- `types/` (planned) shared JSON contracts between `src/` and `netlify/` — `netlify/` must never import `src/`.

## Conventions
- Secrets: BYOK keys live only in localStorage (`SECRET_KEYS` in `store.js`) and are never synced or exported.
- Functions accept BYOK via headers/body (`x-tradier-key`, `x-finnhub-key`, `userApiKey`); server keys are
  only for token holders (enforced from Phase 1 onward).
- Market-hours logic is Eastern Time; never use local `Date` for market decisions.
- `generateMockData` is random — memoize/stub in tests.
- Commit messages: imperative subject, body explains *why*.
