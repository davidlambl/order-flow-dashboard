-- 001_initial_schema.sql
-- Run this in the Supabase SQL Editor to set up the database.

-- Flow history: daily options flow snapshots per ticker
CREATE TABLE flow_history (
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
CREATE INDEX idx_flow_history_ticker_date ON flow_history (ticker, date DESC);

-- Positions: cost basis and shares per ticker
CREATE TABLE positions (
  ticker     TEXT PRIMARY KEY,
  cost_basis DOUBLE PRECISION,
  shares     DOUBLE PRECISION,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Preferences: non-secret user settings
CREATE TABLE preferences (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Chat histories: conversation messages per ticker
CREATE TABLE chat_histories (
  ticker     TEXT PRIMARY KEY,
  messages   JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security
ALTER TABLE flow_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON flow_history FOR SELECT USING (true);

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Full access" ON positions FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Full access" ON preferences FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE chat_histories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Full access" ON chat_histories FOR ALL USING (true) WITH CHECK (true);
