-- 001_initial_schema.sql
-- Run this in the Supabase SQL Editor to set up the database.
-- Idempotent: safe to re-run. Apply 001 → 002 → 003 → 004 in order.

-- Flow history: daily options flow snapshots per ticker
CREATE TABLE IF NOT EXISTS flow_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date         DATE NOT NULL,
  ticker       TEXT NOT NULL,
  net_premium  DOUBLE PRECISION NOT NULL,
  cum_premium  DOUBLE PRECISION NOT NULL,
  call_volume  INTEGER NOT NULL,
  put_volume   INTEGER NOT NULL,
  call_premium DOUBLE PRECISION,
  put_premium  DOUBLE PRECISION,
  spot_price   DOUBLE PRECISION,
  provider     TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_flow_history_ticker_date ON flow_history (ticker, date DESC);

-- Positions: cost basis and shares per ticker
CREATE TABLE IF NOT EXISTS positions (
  ticker     TEXT PRIMARY KEY,
  cost_basis DOUBLE PRECISION,
  shares     DOUBLE PRECISION,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Preferences: non-secret user settings
CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Chat histories: conversation messages per ticker
CREATE TABLE IF NOT EXISTS chat_histories (
  ticker     TEXT PRIMARY KEY,
  messages   JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security
ALTER TABLE flow_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON flow_history;
CREATE POLICY "Public read" ON flow_history FOR SELECT USING (true);

-- The user tables get their real (per-user) policies in 002. Until 002 runs
-- they have RLS enabled with NO policies, so nothing can read or write them
-- through the anon key. (The original version of this file opened them to
-- everyone with USING (true); that is no longer the case.)
ALTER TABLE positions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE preferences    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_histories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Full access" ON positions;
DROP POLICY IF EXISTS "Full access" ON preferences;
DROP POLICY IF EXISTS "Full access" ON chat_histories;
