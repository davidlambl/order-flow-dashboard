-- 003_earnings_cache.sql
-- Shared cache for Alpha Vantage earnings data (25 req/day free tier).
-- Public read; writes happen only from Netlify Functions using the service
-- role, which bypasses RLS, so no write policy is needed (or valid: a single
-- CREATE POLICY cannot cover INSERT, UPDATE and DELETE together).
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS earnings_cache (
  ticker TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  next_report_date DATE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE earnings_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read" ON earnings_cache;
CREATE POLICY "Public read" ON earnings_cache
  FOR SELECT USING (true);

-- Remove the invalid policy from the original version of this migration, in
-- case it was created by running that statement on its own.
DROP POLICY IF EXISTS "Service write" ON earnings_cache;
