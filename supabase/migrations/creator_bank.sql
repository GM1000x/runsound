-- ============================================================
-- creator_bank  — global shared creator database
-- outreach_log  — tracks which artist has contacted which creator
--
-- Run this in Supabase SQL editor:
-- https://app.supabase.com → SQL Editor → New query → paste → Run
-- ============================================================

-- ── creator_bank ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creator_bank (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  username         text UNIQUE NOT NULL,
  display_name     text,
  followers        integer NOT NULL DEFAULT 0,
  engagement_rate  numeric(5,2) DEFAULT 0,
  bio              text,
  email            text,                    -- extracted from bio if present
  location         text,                    -- locationCreated country code, may be null
  uses_music       boolean DEFAULT true,
  genres           text[] DEFAULT '{}',     -- e.g. ['pop', 'electronic', 'melodic techno']
  profile_url      text,
  scraped_at       timestamptz DEFAULT now(),
  created_at       timestamptz DEFAULT now()
);

-- Fast lookup by genre array
CREATE INDEX IF NOT EXISTS creator_bank_genres_idx
  ON creator_bank USING GIN (genres);

-- Fast filtering by followers + engagement
CREATE INDEX IF NOT EXISTS creator_bank_followers_idx
  ON creator_bank (followers);

CREATE INDEX IF NOT EXISTS creator_bank_engagement_idx
  ON creator_bank (engagement_rate DESC);

-- ── outreach_log ──────────────────────────────────────────────
-- Tracks every DM sent: one row per (artist, creator) pair.
-- UNIQUE constraint ensures a creator is never DM'd twice by the same artist.
CREATE TABLE IF NOT EXISTS outreach_log (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id        uuid REFERENCES artists(id) ON DELETE CASCADE NOT NULL,
  creator_id       uuid REFERENCES creator_bank(id) ON DELETE CASCADE NOT NULL,
  creator_username text NOT NULL,
  dm_text          text,
  tiktok_account   text,                   -- which TikTok handle sent the DM
  status           text DEFAULT 'sent',    -- sent | replied | converted | failed
  sent_at          timestamptz DEFAULT now(),
  replied_at       timestamptz,
  UNIQUE(artist_id, creator_id)
);

CREATE INDEX IF NOT EXISTS outreach_log_artist_idx
  ON outreach_log (artist_id);

CREATE INDEX IF NOT EXISTS outreach_log_sent_at_idx
  ON outreach_log (sent_at DESC);

-- ── tiktok_accounts (artist TikTok credentials) ───────────────
-- Reuses existing tiktok_outreach_accounts if it exists,
-- otherwise creates a simplified version.
CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id        uuid REFERENCES artists(id) ON DELETE CASCADE NOT NULL,
  tiktok_username  text NOT NULL,
  session_cookies  text NOT NULL,          -- JSON string of cookies
  daily_limit      integer DEFAULT 75,     -- DMs per day (safe limit)
  active           boolean DEFAULT true,
  last_dm_at       timestamptz,
  dms_sent_today   integer DEFAULT 0,
  dms_sent_total   integer DEFAULT 0,
  created_at       timestamptz DEFAULT now(),
  UNIQUE(artist_id, tiktok_username)
);

CREATE INDEX IF NOT EXISTS tiktok_accounts_artist_idx
  ON tiktok_accounts (artist_id);
