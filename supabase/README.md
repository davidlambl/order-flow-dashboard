# Supabase setup

The app works without Supabase (everything stays in the browser's localStorage). With it you get
sign-in, cross-device sync of positions / preferences / chat, the nightly flow-history table, the
earnings cache, and the access-token revocation list plus usage quotas used by the Netlify Functions.

## Apply the migrations

Run each file in `migrations/` **in order** in the Supabase SQL Editor (Dashboard → SQL Editor →
New query → paste → Run). All four are idempotent, so re-running one is safe.

| File | What it does |
|---|---|
| `001_initial_schema.sql` | `flow_history`, `positions`, `preferences`, `chat_histories`; RLS on, no user policies yet |
| `002_add_user_auth.sql` | adds `user_id`, composite primary keys, per-user RLS (enable **Authentication → Email** first) |
| `003_earnings_cache.sql` | shared Alpha Vantage earnings cache (public read, service-role write) |
| `004_security_hardening.sql` | `revoked_tokens`, `usage_log`, DB-owned `updated_at`, `ON DELETE CASCADE`, tighter policies |

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | Netlify env | project URL, used by functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Netlify env (secret) | writes from functions: flow history, earnings cache, usage log, revocation reads |
| `SUPABASE_ANON_KEY` | Netlify env | server-side *reads* of public tables (falls back to `VITE_SUPABASE_ANON_KEY`) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | build env | browser client (auth + user data sync under RLS) |

## Revoking an access token

Every token minted by `scripts/generate-token.js` prints its `jti`. To revoke it:

```sql
INSERT INTO revoked_tokens (jti, sub, reason) VALUES ('<jti>', '<label>', 'lost laptop');
```

Functions cache the revocation list for 60 seconds.

## Using the Supabase CLI instead (optional)

The CLI expects migration files named `<14-digit timestamp>_<name>.sql`; these files use a simple
numeric prefix so they can be pasted into the SQL editor. If you move to `supabase db push`,
rename them (e.g. `20260301000001_initial_schema.sql`) and run `supabase init` to create
`config.toml`; the SQL itself needs no changes.
