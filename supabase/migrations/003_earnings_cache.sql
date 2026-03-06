-- 003_earnings_cache.sql
-- Shared cache for Alpha Vantage earnings data (25 req/day free tier).
-- Public read, service-role write. No user scoping — earnings are universal.

CREATE TABLE earnings_cache (
  ticker TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  next_report_date DATE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE earnings_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON earnings_cache
  FOR SELECT USING (true);

-- Only server-side functions (service role) can write
CREATE POLICY "Service write" ON earnings_cache
  FOR ALL USING (true) WITH CHECK (true);
