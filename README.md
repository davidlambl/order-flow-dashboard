# Institutional Order Flow Dashboard

An options order-flow dashboard for one ticker at a time: flow KPIs, gamma exposure, a 30-day flow history,
a live quote, a position recommendation engine, ticker research and an AI co-pilot. React on Netlify:
market data, quotes, research and LLM calls go through Netlify Functions, and Supabase (optional) adds
sign-in, sync and the stored history.

## What it is

Options data is CBOE's public delayed feed (15 minutes, no key) by default. With a Tradier key the chain
comes from Tradier (real-time on a brokerage key, delayed on a sandbox key); it is validated first, and an
unusable answer falls back to CBOE (the header badge's tooltip says why). Chain metrics use the six nearest
unexpired expiries, whichever provider served them.

| Access | What it gives |
|---|---|
| Anonymous | CBOE data, KPI cards, both charts, the header quote |
| Your own keys (Settings → Data / AI) | Tradier: its chain instead of CBOE's. Finnhub: research data, quote fallback. Anthropic / OpenAI / Gemini: the key and model the Co-Pilot uses |
| Access token | Unlocks Position Analysis, Ticker Research and the AI Co-Pilot; lets the functions use the server's Tradier, Finnhub, Alpha Vantage and Anthropic keys |

Your own keys work without a token, but the three premium panels open only with one, and no function
spends a server key for a caller without a valid token.

Demo data (random, badged DEMO) appears only while nothing real has loaded for the ticker (`npm run dev`
without functions, or a failed first load) and never auto-refreshes. Once real data has loaded, a failed
refresh keeps it on screen with an ERROR badge and background refreshes back off (up to 5 minutes).

Stack: React 19, Vite 8 (Rolldown), Tailwind CSS 4, Recharts 3, lucide-react 1, react-markdown; Netlify
Functions on Node 22 (`@netlify/functions` 6); Supabase. Upstreams: CBOE, Tradier, Yahoo Finance, Finnhub,
Alpha Vantage, Anthropic, OpenAI, Google Gemini.

## Features

**Market data (everyone)**

- KPI cards (`src/components/KPICards.jsx`):
  - *Premium Traded* (C − P): calls minus puts at volume × mid × 100; which side traded more premium, not
    buyer- or seller-signed flow.
  - *Max Pain*: the max-pain strike of the nearest expiry that is still open (a 0DTE drops out after the
    4:15 PM ET close) and has open interest; the card names the expiry.
  - *Dark Pool Vol %* (EST.): a statistical estimate from IV30, not reported volume; blank without IV30.
  - *Put / Call Ratio*: by volume, coloured by `shared/thresholds.js`; blank, never 0, without call volume.
- GEX chart: spot × gamma × OI × 100 × spot × 0.01 per contract (puts negative) for strikes within ±20 %
  of spot, on a numeric strike axis with lines at spot, your cost basis and the 50/200-day moving averages.
- 30-day flow chart: daily and cumulative net premium, only from the Supabase `flow_history` table that the
  nightly collector writes ([Supabase setup](#supabase-setup)); empty without it (demo data simulates it).
- Live quote (`getLiveQuote`, shown in the header): Yahoo with pre- and post-market prices (the newest
  wins), Finnhub fallback, refreshed every minute. For Nasdaq-100 names whose latest price is the last
  regular-session trade while the equity session is closed, it also returns the NQ futures move and an
  implied price (`futuresContext`) as context only; the UI does not show it yet.
- Auto-refresh in the options session (9:30 AM–4:15 PM ET on trading days): 30 s on Tradier real-time,
  60 s otherwise.

**Position Analysis (access token)**: cost basis and shares per ticker give P&L, a price-level bar (basis,
spot, max pain, GEX support and resistance) and a BUY / HOLD / SELL signal from `src/lib/recommend.ts`. It
scores up to five factors (P&L, max-pain distance, GEX near spot, premium, put/call), skips missing ones,
needs at least three for BUY or SELL, sets confidence by how many disagree and flags stale options data.
*Single mode* scores the options feed's spot. *Dual mode*, when the options market is closed and the live
price is 0.5 % or more from the options snapshot, shows two P&Ls and two signals: "Options Snapshot
(delayed)" and "If Live Price Holds".

**Ticker Research (access token)**: `getTickerContext` gathers Finnhub news, analyst ratings and price
targets, fundamentals, daily candles (50/200-day MA, RSI-14, 52-week range), index quotes and headlines,
plus Alpha Vantage earnings (EPS) cached in the Supabase `earnings_cache` table. The panel shows news,
earnings, analyst consensus and a market overview; the moving averages also appear on the GEX chart, and
technicals and fundamentals go into the Co-Pilot's context. Your own Finnhub key covers everything but
earnings (server key only).

**AI Co-Pilot (access token)**

- Anthropic, OpenAI or Google Gemini (Settings → AI, models from `getModels`). Without your own key,
  Anthropic uses the server key within `ALLOWED_MODELS`, `MAX_OUTPUT_TOKENS` and a daily quota per token;
  OpenAI and Gemini need your key.
- The dashboard context (KPIs, GEX, flow, position and signal, research, strategic context) is sent as a
  separate `financialContext` field that `askLLM` puts in the system prompt; the document icon shows it.
- Replies stream (SSE, Markdown) and have a stop button; switching ticker stops a reply and keeps it with
  its ticker. Chat history is per ticker and saved when a reply settles; errors are shown, not saved.
- Strategic context: a free-text document sent with every request, edited from the chat header or
  Settings → Backup; the chat can suggest edits to it.

**Account and data**

- Magic-link sign-in (Supabase), offered only when `VITE_SUPABASE_*` are set; "Continue without signing
  in" is remembered on the browser.
- Sync of positions, chats and settings, never API keys. At sign-in (and each load while signed in) an
  empty account gets this browser's data and an empty browser the account's; when both differ,
  **SyncChoice** asks: Merge (the newest copy of each item wins), Use cloud copy or Use this browser's copy.
  Nothing is written until you choose.
- Cloud writes go through a per-account outbox in localStorage that survives reloads and retries network
  failures with backoff. Deletes are tombstones (migration 005); where both sides changed an item, the
  newer `updated_at` wins. Other tabs update at once.
- One sign-out (header icon or Settings → Account): after a confirmation it sends queued writes (up to
  5 s), signs out and removes this browser's positions, chats, settings, API keys and access token; the
  cloud copy stays.
- Export / import (Settings → Backup): JSON without API keys; an import replaces this device's data (and
  the account's when signed in) and keeps the device's API keys.

## Key handling and privacy

- **Your keys** (Tradier, Finnhub, Anthropic, OpenAI, Gemini) live only in this browser's localStorage
  (`SECRET_KEYS` in `src/lib/store.ts`): never synced, exported or imported; sign-out and Reset all
  settings delete them. Requests carry them as `x-tradier-key`, `x-finnhub-key`, `x-api-key` (model
  lists) or `userApiKey` (chat body); the functions pass them on and store nothing.
- **The access token** is in localStorage too, never synced or exported. It is sent as
  `Authorization: Bearer`, checked at startup and dropped when a function reports it expired, invalid or
  revoked.
- **Server keys** (Netlify environment) are used only for requests with a valid token, verified on every
  call (HS256, issuer, audience, expiry, revocation list). With `TOKEN_SECRET` unset or under 32
  characters none is used: `validateToken` and the server-key paths of `askLLM` and `getModels` return 503,
  and the data functions carry on without server keys (CBOE, Yahoo, your own Finnhub key).
- Responses that depend on the caller's key or token are `Cache-Control: private`; errors are `no-store`.
- The Co-Pilot sends your messages and the dashboard context, including your position and strategic
  context, to the provider you chose.

## Quick start

Node 22 (`.nvmrc`; `engines` requires ≥ 22.12):

```bash
nvm use && npm ci
npm run dev                                # Vite on :5173 with demo data, no functions
cp .env.example .env && npx netlify dev    # app and functions on :8888 (:5173 proxies to it)
```

To deploy, connect the repository to Netlify (`netlify.toml` sets `npm run build` → `dist`, the functions
and `NODE_VERSION = "22"`) and set the variables below, all in [`.env.example`](.env.example); `VITE_*`
are read at build time. The functions' per-IP rate limits are best effort; enable Netlify's rate limiting
for `/.netlify/functions/*`.

| Variable | Required | Used by | Purpose |
|---|---|---|---|
| `TOKEN_SECRET` | **Yes**, for any server key to be usable | `lib/auth.js`, `scripts/generate-token.js` | Signs and verifies access tokens; ≥ 32 characters |
| `SITE_ORIGIN` | No | `lib/http.js` | Extra origins allowed cross-origin (comma-separated) |
| `TRADIER_API_KEY` | No | `getMarketData` | Tradier chain for token holders |
| `TRACKED_TICKERS` | No | `collectFlowHistory` | Tickers snapshotted nightly; default `AVGO,NVDA,AAPL,TSLA,MSFT,META,AMZN,GOOGL,AMD,SPY,QQQ` |
| `ANTHROPIC_API_KEY` | No | `askLLM`, `getModels` | Shared Anthropic key for token holders |
| `ALLOWED_MODELS` | No | `askLLM` | Models the shared key may use (comma-separated, trailing `*` = prefix); default `claude-*` |
| `MAX_OUTPUT_TOKENS` | No | `askLLM` | Output cap per shared-key request; default 4096 (own keys: model limit, ≤ 16384) |
| `DAILY_REQUEST_QUOTA_TRIAL` | No | `askLLM` | Shared-key requests per trial token per UTC day; default 50; needs Supabase |
| `DAILY_REQUEST_QUOTA_PRO` | No | `askLLM` | The same for pro tokens; default 500 |
| `LLM_TIMEOUT_MS` | No | `askLLM` | Time to the provider's first byte; default 60000 |
| `FINNHUB_API_KEY` | No | `getTickerContext`, `getLiveQuote` | Research data and quote fallback for token holders |
| `ALPHA_VANTAGE_KEY` | No | `getTickerContext` | Earnings for token holders, cached in `earnings_cache` |
| `SUPABASE_URL` | No | functions | Flow history, earnings cache, token revocation, quotas |
| `SUPABASE_SERVICE_ROLE_KEY` | No (secret) | functions | Server-side writes, revocation list, quota counts |
| `SUPABASE_ANON_KEY` | No | `getMarketData` | Public `flow_history` reads (falls back to `VITE_SUPABASE_ANON_KEY`) |
| `VITE_SUPABASE_URL` | No | browser (build) | Sign-in and sync |
| `VITE_SUPABASE_ANON_KEY` | No | browser (build) | Sign-in and sync (row-level security) |

## Supabase setup

Optional. Without it everything stays in the browser: no sign-in, no flow history, no earnings cache, no
token revocation and no LLM quota.

1. Create a project and enable **Authentication → Email**.
2. Run `supabase/migrations/001…005` in order in the SQL editor (all idempotent);
   [`supabase/README.md`](supabase/README.md) describes each and the CLI alternative.
3. Set the `SUPABASE_*` variables for the functions and `VITE_SUPABASE_*` for the build.
4. Add the site's URL (and your local one) under Authentication → URL Configuration → Redirect URLs, since
   the magic link returns to the page it was requested from.

The nightly collector `collectFlowHistory` (needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`) runs
`30 21 * * 1-5` (Mon–Fri 21:30 UTC, after the options close), skips NYSE holidays and upserts one
`flow_history` row per ticker in `TRACKED_TICKERS` per Eastern-Time trading day: CBOE net premium, running
cumulative premium, call/put volume and premium, spot. `getMarketData` returns the last 30 rows, so the
flow chart stays empty without the collector or for untracked tickers.

To revoke a token, insert its `jti` into `revoked_tokens`
([details](supabase/README.md#revoking-an-access-token)); functions refresh the list every 60 seconds.

## Access tokens

Tokens are HS256 JWTs (issuer `order-flow-dashboard`, audience `order-flow-api`, `sub`, `jti`, `exp`,
`tier`) minted with [`scripts/generate-token.js`](scripts/generate-token.js):

```bash
node scripts/generate-token.js --tier pro --days 365 --label "me"
echo "$SECRET" | node scripts/generate-token.js --secret-stdin --tier trial --label "beta-1"
```

`--tier trial|pro` (default `trial`), `--days N` (1–3650; default 7 for trial, 365 for pro), `--label`
(the subject; default `token-<jti prefix>`). The secret comes from `TOKEN_SECRET` (environment or `.env`)
or stdin with `--secret-stdin`, never an argument. The script prints the tier, subject, `jti`, expiry,
token and the revocation SQL.

Both tiers unlock the premium panels and the server keys; they differ in default lifetime, the daily quota
on the shared Anthropic key (50 / 500) and the header badge. Users paste the token into a lock screen or
Settings → Account; revoke one through `revoked_tokens` ([supabase/README.md](supabase/README.md)).

Without a token, the lock screens and Settings → Account offer **Request access**, which posts to Netlify
Forms (the `access-request` form in `index.html`; deployed site only). For email alerts add a notification
for that form under Site → Forms → Notifications in Netlify; your address stays out of the code.

> **Upgrading from an earlier version?** Access tokens minted before the security hardening (no
> issuer/audience/jti claims) are rejected. Mint a new one with `node scripts/generate-token.js`.

## Architecture

```
netlify/functions/          One function per top-level file (HTTP: /.netlify/functions/<name>, /api/<name>)
├── askLLM.js               Chat proxy for Anthropic, OpenAI, Gemini; relays SSE
├── collectFlowHistory.js   Scheduled flow_history snapshot
├── getLiveQuote.js         Yahoo quote with extended hours, Finnhub fallback, NQ context
├── getMarketData.js        Tradier → CBOE, KPIs and GEX, flow history
├── getModels.js            Model lists per provider
├── getTickerContext.js     Finnhub research, Alpha Vantage earnings
├── validateToken.js        Token check for the unlock screens
├── lib/
│   ├── auth.js             Token verification; fails closed
│   ├── http.js             CORS allowlist, responses, fetchWithTimeout, rate limit
│   ├── marketDataHelpers.js  CBOE/Tradier fetchers, expiry window, metric maths
│   ├── quota.js            Daily LLM quota, usage_log
│   ├── supabaseAdmin.js    Service-role client
│   ├── supabasePublic.js   Anon-key client
│   └── ticker.js           Ticker validator
└── __tests__/              Function tests (kept out of the deployed top level)
shared/                     Pure modules for src/ and netlify/
├── marketCalendar.js       ET clock, NYSE holidays, early closes, sessions (+ .test.js)
└── thresholds.js           Cut-offs for the engine, KPI cards, chat context, prompt
types/                      Contracts shared by src/ and netlify/ (declarations only; netlify/ never imports src/)
└── market.ts               getMarketData, getLiveQuote, getTickerContext, getModels bodies; error bodies and codes
src/                        Tests sit beside the code: *.node.test.js (node), other *.test.{js,jsx} (dom)
├── main.jsx                Entry: StrictMode, ErrorBoundary, App
├── App.jsx                 Layout, auth, per-account backend, SyncChoice, sign-out
├── index.css               Tailwind theme
├── vite-env.d.ts           import.meta.env typings (VITE_SUPABASE_*)
├── components/
│   ├── AppSettings.jsx     Settings: AI, Data, Account, Backup
│   ├── ChatBot.jsx         AI Co-Pilot
│   ├── CollapsibleSection.jsx  Section with a remembered open state
│   ├── ErrorBoundary.jsx   Recovery screen
│   ├── FlowChart.jsx       30-day flow chart
│   ├── GexChart.jsx        GEX chart
│   ├── Header.jsx          Search, price, refresh, badges, sign-out
│   ├── KPICards.jsx        The four KPI cards
│   ├── LoginForm.jsx       Magic-link sign-in, skip
│   ├── PositionAnalysis.jsx  Position, P&L, recommendation
│   ├── PremiumGate.jsx     Token lock screen
│   ├── RequestAccessForm.jsx  Netlify Forms access request
│   ├── StrategicContextEditor.jsx  Strategic context editor
│   ├── SyncChoice.jsx      Merge / cloud / local prompt
│   └── TickerResearch.jsx  Research panel
├── hooks/
│   ├── useAutoSave.js      Debounced, baseline-compared auto-save
│   ├── useLiveQuote.js     Live quote, 1-minute refresh
│   ├── useMarketData.js    Market data, auto-refresh, backoff, demo fallback
│   ├── useNow.js           Ticking clock for render code
│   └── useTickerContext.js Research context, 15-minute cache
├── lib/
│   ├── api.ts              Function fetchers, chat SSE reader
│   ├── auth.ts             Access-token storage and check
│   ├── debouncedSaver.js   Debounce with a baseline
│   ├── deepEqual.js        Key-order-insensitive equality
│   ├── format.ts           Number and date formatting
│   ├── gexChartHelpers.js  GEX axis ticks, reference lines
│   ├── mockData.ts         Demo data, checked against types/market.ts
│   ├── recommend.ts        Recommendation engine
│   ├── retry.js            Exponential backoff
│   ├── session.js          Sign-out, data-owner and skip flags
│   ├── sse.ts              SSE framing, per-provider events
│   ├── staleness.js        Stale-data rule
│   ├── store.ts            localStorage store, key classes, export/import, events
│   ├── supabase.js         Browser Supabase client
│   ├── SupabaseBackend.js  Cloud sync, conflicts, tombstones
│   └── syncOutbox.js       Persistent write queue
└── test/setup.js           dom setup: jest-dom, cleanup, MSW server
test/helpers/               fakeSupabase.js, fetch.js (recording fakes), functions.js (function-test
                            harness), globals.js (browser stand-ins for node tests)
supabase/                   migrations/001…005, README.md
scripts/generate-token.js   Mints access tokens
docs/ROADMAP.md             Findings and the phased plan
.github/                    workflows/ci.yml, dependabot.yml, pull_request_template.md
index.html                  App shell, hidden access-request form for Netlify Forms
netlify.toml                Build, NODE_VERSION 22, /api/* redirect, dev port, shared/** bundling
vite.config.js              React and Tailwind plugins, dev proxy to :8888, ANALYZE=1 bundle report
vitest.config.js            node and dom test projects, coverage
eslint.config.js            Flat config: browser, node and test globals; react-hooks, react-refresh, typescript-eslint
tsconfig.json               Browser type-check program (src/, shared/, types/); tsconfig.functions.json the Node one
.env.example · .nvmrc · .editorconfig · package.json · LICENSE · CLAUDE.md
```

## Development

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Build into `dist/`; `ANALYZE=1 npm run build` also writes `dist/stats.html` |
| `npm run preview` | Serve `dist/` |
| `npm run lint` | ESLint 10 (typescript-eslint 8 for `.ts`/`.tsx`) |
| `npm run typecheck` | `tsc` over `tsconfig.json` (browser: `src/`, `shared/`, `types/`) and `tsconfig.functions.json` (Node: `netlify/`, `shared/`, `types/`, `scripts/`); blocking in CI |
| `npm test` | Vitest 5, both projects |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Tests with coverage into `coverage/` (CI) |
| `npm run check` | Lint (non-blocking), typecheck, test, build |

- Lint has known `react-hooks` errors (and one `react-refresh` error) owned by roadmap Phase 5; see
  [CLAUDE.md](CLAUDE.md) for the baseline and don't add new ones. `check` and CI keep lint non-blocking
  until the baseline is zero.
- Vitest's `node` project runs the function tests, `shared/*.test.js` and `src/**/*.node.test.js` (pure
  `src/lib` modules under Node with the stand-ins in `test/helpers/`). The `dom` project runs the other
  `src/**/*.test.{js,jsx}` files under jsdom with Testing Library and an MSW server (`src/test/setup.js`).
- CI (`.github/workflows/ci.yml`, pushes to `main` and pull requests) runs `npm ci`, lint (non-blocking),
  `npm run typecheck`, `npm run test:coverage` and the build on Node 22 and 24 (`fail-fast: false`), plus a separate
  `npm audit --omit=dev --audit-level=high` job. Dependabot opens weekly npm and GitHub Actions updates.
- [CLAUDE.md](CLAUDE.md) has the working notes; [docs/ROADMAP.md](docs/ROADMAP.md) the modernization plan.
- License: MIT ([LICENSE](LICENSE)).
