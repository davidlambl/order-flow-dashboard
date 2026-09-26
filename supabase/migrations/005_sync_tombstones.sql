-- 005_sync_tombstones.sql
-- Deletes that sync: tombstones for positions, preferences and chat_histories (roadmap Phase 3, D5/D6).
-- Idempotent: safe to re-run.
--
-- The app now deletes an item with an upsert that nulls its content and sets deleted_at (a tombstone)
-- instead of a DELETE. The row stays, so the updated_at trigger from 004 keeps its time honest and
-- another device that still holds the item sees that it was deleted, and when, instead of uploading it
-- again (a hard delete left no trace to compare with). Writing the item again clears deleted_at.
-- Readers skip tombstoned rows (deleted_at IS NOT NULL); a client from before this change reads a
-- tombstone's null content as a delete. Purging old tombstones is a later follow-up.
-- Until this runs, the app falls back to hard deletes and logs a warning naming this file.

ALTER TABLE positions      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE preferences    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE chat_histories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- A tombstone has no content.
ALTER TABLE preferences    ALTER COLUMN value    DROP NOT NULL;
ALTER TABLE chat_histories ALTER COLUMN messages DROP NOT NULL;

-- Make the new column visible to the API at once (Supabase also reloads on DDL).
NOTIFY pgrst, 'reload schema';
