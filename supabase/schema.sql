-- RunSound Supabase Schema
-- Run this in the Supabase SQL editor: https://app.supabase.com → SQL Editor

-- ─── smart_links ─────────────────────────────────────────────────────────────
-- One row per song/release. The slug is what goes in the TikTok bio link.
-- Example: runsound.fm/my-song-title

CREATE TABLE IF NOT EXISTS smart_links (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,           -- URL slug (e.g. "my-song-title")
  artist_name  TEXT NOT NULL,
  title        TEXT NOT NULL,
  cover_url    TEXT,                           -- Public URL to cover art image
  spotify_url  TEXT,                           -- Full Spotify track URL
  apple_url    TEXT,                           -- Full Apple Music URL
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ─── utm_clicks ──────────────────────────────────────────────────────────────
-- One row per click on the smart link page.
-- destination = 'spotify' | 'apple'
-- source = referring URL (usually TikTok)

CREATE TABLE IF NOT EXISTS utm_clicks (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug        TEXT NOT NULL REFERENCES smart_links(slug) ON DELETE CASCADE,
  destination TEXT NOT NULL,                  -- 'spotify' or 'apple'
  source      TEXT,                           -- Referrer URL
  user_agent  TEXT,
  ip_hash     TEXT,                           -- Hashed IP (privacy-safe)
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Index for fast slug lookups
CREATE INDEX IF NOT EXISTS utm_clicks_slug_idx ON utm_clicks(slug);
CREATE INDEX IF NOT EXISTS utm_clicks_created_idx ON utm_clicks(created_at DESC);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- smart_links: public read (anyone can view a smart link page)
ALTER TABLE smart_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read smart_links"
  ON smart_links FOR SELECT USING (true);

-- utm_clicks: public insert (anyone can record a click), no public read
ALTER TABLE utm_clicks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can insert utm_clicks"
  ON utm_clicks FOR INSERT WITH CHECK (true);

-- Only authenticated users (you) can read click data
CREATE POLICY "Auth users can read utm_clicks"
  ON utm_clicks FOR SELECT USING (auth.role() = 'authenticated');

-- ─── Sample data (for testing) ───────────────────────────────────────────────
-- Uncomment to insert test data:
--
-- INSERT INTO smart_links (slug, artist_name, title, spotify_url)
-- VALUES ('test-song', 'Test Artist', 'Test Song', 'https://open.spotify.com/track/...');
