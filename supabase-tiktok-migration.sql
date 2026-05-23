-- ============================================================
-- RunSound — TikTok OAuth columns for the artists table
-- Run this once in Supabase → SQL Editor
-- ============================================================

-- TikTok OAuth tokens (per artist)
ALTER TABLE artists
  ADD COLUMN IF NOT EXISTS tiktok_open_id             TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_access_token        TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_refresh_token       TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_token_expires_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tiktok_refresh_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tiktok_scope               TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_connected_at        TIMESTAMPTZ;

-- Index for fast token lookups (used by post-to-tiktok.js every nightly run)
CREATE INDEX IF NOT EXISTS idx_artists_tiktok_open_id
  ON artists (tiktok_open_id)
  WHERE tiktok_open_id IS NOT NULL;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- Run this after the migration to confirm columns exist:
--
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'artists'
--   AND column_name LIKE 'tiktok_%'
-- ORDER BY column_name;
