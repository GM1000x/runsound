-- ── RunSound: trending_clips table ──────────────────────────────────────────
-- Run this once in the Supabase SQL Editor.
-- Stores individual TikTok clips for Blitz Mode.

CREATE TABLE IF NOT EXISTS trending_clips (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tiktok_url    text        NOT NULL UNIQUE,
  cover_url     text,
  caption       text,
  views         bigint      DEFAULT 0,
  likes         bigint      DEFAULT 0,
  shares        bigint      DEFAULT 0,
  author        text,
  hook_pattern  text,
  hook_template text,
  one_liner     text,
  genre_tags    text[]      DEFAULT '{}',
  format_type   text,
  music_fit     int,
  week_of       date,
  scraped_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trending_clips_views_idx ON trending_clips(views DESC);
CREATE INDEX IF NOT EXISTS trending_clips_week_idx  ON trending_clips(week_of);
CREATE INDEX IF NOT EXISTS trending_clips_genre_idx ON trending_clips USING gin(genre_tags);
