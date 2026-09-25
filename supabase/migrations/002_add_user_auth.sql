-- 002_add_user_auth.sql
-- Adds per-user isolation via Supabase Auth.
-- Run this in the Supabase SQL Editor AFTER enabling Auth in the dashboard.
-- Idempotent and non-destructive: only rows with no user_id (pre-auth data)
-- are removed; re-running on an already-migrated database is a no-op.

-- 1. Add user_id (nullable first so existing rows are not rejected)
ALTER TABLE positions      ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE preferences    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE chat_histories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- 2. Remove orphan rows from before auth existed (they have no owner)
DELETE FROM positions      WHERE user_id IS NULL;
DELETE FROM preferences    WHERE user_id IS NULL;
DELETE FROM chat_histories WHERE user_id IS NULL;

ALTER TABLE positions      ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE preferences    ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE chat_histories ALTER COLUMN user_id SET NOT NULL;

-- 3. Replace single-column PKs with composite (user_id, key) PKs — only if not already done
DO $$
DECLARE
  t TEXT;
  keycol TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['positions', 'preferences', 'chat_histories'] LOOP
    keycol := CASE WHEN t = 'preferences' THEN 'key' ELSE 'ticker' END;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = t::regclass AND i.indisprimary AND a.attname = 'user_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_pkey');
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (user_id, %I)', t, keycol);
    END IF;
  END LOOP;
END $$;

-- 4. Drop the permissive policies from the original 001 (if they still exist)
DROP POLICY IF EXISTS "Full access" ON positions;
DROP POLICY IF EXISTS "Full access" ON preferences;
DROP POLICY IF EXISTS "Full access" ON chat_histories;

-- 5. User-scoped RLS policies (tightened further in 004)
DROP POLICY IF EXISTS "User isolation" ON positions;
CREATE POLICY "User isolation" ON positions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "User isolation" ON preferences;
CREATE POLICY "User isolation" ON preferences
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "User isolation" ON chat_histories;
CREATE POLICY "User isolation" ON chat_histories
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- flow_history is unchanged — it's shared/public data
