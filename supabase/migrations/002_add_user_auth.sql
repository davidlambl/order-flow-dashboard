-- 002_add_user_auth.sql
-- Adds per-user isolation via Supabase Auth.
-- Run this in the Supabase SQL Editor AFTER enabling Auth in the dashboard.

-- 1. Clean up orphan rows (pre-auth data with no user association)
DELETE FROM positions;
DELETE FROM preferences;
DELETE FROM chat_histories;

-- 2. Add user_id column to user-scoped tables
ALTER TABLE positions     ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);
ALTER TABLE preferences   ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);
ALTER TABLE chat_histories ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);

-- 3. Replace single-column PKs with composite PKs
ALTER TABLE positions     DROP CONSTRAINT positions_pkey;
ALTER TABLE positions     ADD PRIMARY KEY (user_id, ticker);

ALTER TABLE preferences   DROP CONSTRAINT preferences_pkey;
ALTER TABLE preferences   ADD PRIMARY KEY (user_id, key);

ALTER TABLE chat_histories DROP CONSTRAINT chat_histories_pkey;
ALTER TABLE chat_histories ADD PRIMARY KEY (user_id, ticker);

-- 4. Drop old permissive RLS policies (IF EXISTS for idempotency)
DROP POLICY IF EXISTS "Full access" ON positions;
DROP POLICY IF EXISTS "Full access" ON preferences;
DROP POLICY IF EXISTS "Full access" ON chat_histories;

-- 5. Create user-scoped RLS policies (auth.uid() = user_id)
CREATE POLICY "User isolation" ON positions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "User isolation" ON preferences
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "User isolation" ON chat_histories
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- flow_history is unchanged — it's shared/public data
