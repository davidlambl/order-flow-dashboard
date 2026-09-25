-- 004_security_hardening.sql
-- Token revocation, usage logging / quotas, DB-owned updated_at, cascading
-- user deletes, and tighter RLS. Idempotent: safe to re-run.

-- ── Revoked access tokens (jti denylist) ────────────────────────────────────
-- Written by the operator (SQL editor); read by Netlify Functions with the
-- service role. No policies: RLS enabled with none means anon/authenticated
-- clients can neither read nor write.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        TEXT PRIMARY KEY,
  sub        TEXT,
  reason     TEXT,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE revoked_tokens ENABLE ROW LEVEL SECURITY;

-- ── Usage log for requests made with server-side LLM keys ───────────────────
CREATE TABLE IF NOT EXISTS usage_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sub        TEXT,
  tier       TEXT,
  provider   TEXT NOT NULL,
  model      TEXT,
  key_source TEXT NOT NULL,               -- 'server' | 'user'
  stream     BOOLEAN NOT NULL DEFAULT false,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_log_sub_created ON usage_log (sub, created_at DESC);
ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;

-- ── updated_at maintained by the database ───────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_positions_updated_at ON positions;
CREATE TRIGGER trg_positions_updated_at
  BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_preferences_updated_at ON preferences;
CREATE TRIGGER trg_preferences_updated_at
  BEFORE UPDATE ON preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_chat_histories_updated_at ON chat_histories;
CREATE TRIGGER trg_chat_histories_updated_at
  BEFORE UPDATE ON chat_histories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Deleting an auth user removes their rows ────────────────────────────────
ALTER TABLE positions      DROP CONSTRAINT IF EXISTS positions_user_id_fkey;
ALTER TABLE positions      ADD CONSTRAINT positions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE preferences    DROP CONSTRAINT IF EXISTS preferences_user_id_fkey;
ALTER TABLE preferences    ADD CONSTRAINT preferences_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE chat_histories DROP CONSTRAINT IF EXISTS chat_histories_user_id_fkey;
ALTER TABLE chat_histories ADD CONSTRAINT chat_histories_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── user_id defaults to the caller ──────────────────────────────────────────
ALTER TABLE positions      ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE preferences    ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE chat_histories ALTER COLUMN user_id SET DEFAULT auth.uid();

-- ── RLS: evaluate auth.uid() once per query, and only for signed-in users ───
DROP POLICY IF EXISTS "User isolation" ON positions;
CREATE POLICY "User isolation" ON positions
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "User isolation" ON preferences;
CREATE POLICY "User isolation" ON preferences
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "User isolation" ON chat_histories;
CREATE POLICY "User isolation" ON chat_histories
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
