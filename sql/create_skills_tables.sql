-- ══════════════════════════════════════════════════════════════════════════════
-- RunSound Skills Platform — database tables
-- Run once in Supabase → SQL Editor
-- ══════════════════════════════════════════════════════════════════════════════

-- ── artist_api_keys ───────────────────────────────────────────────────────────
ALTER TABLE artists
  ADD COLUMN IF NOT EXISTS api_key        text UNIQUE,
  ADD COLUMN IF NOT EXISTS credits_usd    numeric(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS low_balance_at numeric(10,4) NOT NULL DEFAULT 1.00;

CREATE INDEX IF NOT EXISTS idx_artists_api_key ON artists(api_key) WHERE api_key IS NOT NULL;

-- ── credit_transactions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   uuid        NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  type        text        NOT NULL CHECK (type IN ('topup','debit','refund')),
  amount_usd  numeric(10,4) NOT NULL,          -- positive = added, negative = spent
  description text        NOT NULL,
  skill_name  text,                             -- which skill was charged
  run_id      uuid,                             -- links to skill_runs
  stripe_id   text,                             -- Stripe Payment Intent ID for topups
  balance_after numeric(10,4) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_artist ON credit_transactions(artist_id, created_at DESC);

-- ── skills_registry ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills_registry (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text    NOT NULL UNIQUE,          -- e.g. 'creator-scout'
  name            text    NOT NULL,
  description     text    NOT NULL,
  category        text    NOT NULL,                 -- discovery, content, outreach, tracking, etc.
  price_per_unit  numeric(8,4) NOT NULL,
  unit_label      text    NOT NULL,                 -- 'per creator', 'per DM', 'per hook'
  developer_id    uuid    REFERENCES artists(id),   -- null = RunSound built-in
  developer_cut   numeric(4,2) NOT NULL DEFAULT 0,  -- % of revenue to developer (0-100)
  endpoint        text    NOT NULL,                 -- internal handler: /api/skills/run/:slug
  input_schema    jsonb   NOT NULL DEFAULT '{}',
  active          boolean NOT NULL DEFAULT true,
  featured        boolean NOT NULL DEFAULT false,
  total_runs      bigint  NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skills_category ON skills_registry(category) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_skills_featured ON skills_registry(featured) WHERE active = true;

-- ── skill_runs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id       uuid        NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  skill_slug      text        NOT NULL REFERENCES skills_registry(slug),
  status          text        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running','succeeded','failed')),
  input           jsonb       NOT NULL DEFAULT '{}',
  output          jsonb,
  units_consumed  int         NOT NULL DEFAULT 0,   -- creators found, DMs sent, etc.
  cost_usd        numeric(10,4) NOT NULL DEFAULT 0,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_skill_runs_artist ON skill_runs(artist_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_slug, started_at DESC);

-- ── Seed built-in skills ──────────────────────────────────────────────────────
INSERT INTO skills_registry (slug, name, description, category, price_per_unit, unit_label, developer_cut, endpoint, featured, input_schema) VALUES

('creator-scout', 'Creator Scout',
 'Find TikTok creators whose content matches your song''s energy, genre and mood.',
 'discovery', 0.0100, 'per creator found', 0,
 '/api/skills/run/creator-scout', true,
 '{"spotify_url":"string","follower_min":"number","follower_max":"number","limit":"number"}'::jsonb),

('dm-outreach', 'DM Outreach',
 'Send personalized TikTok DMs to creators. GPT writes a unique message per creator.',
 'outreach', 0.0300, 'per DM sent', 0,
 '/api/skills/run/dm-outreach', true,
 '{"campaign_id":"string","creator_usernames":"array","song_title":"string","artist_name":"string"}'::jsonb),

('hook-generator', 'Hook Generator',
 'Generate viral TikTok hooks based on trending formats in your genre.',
 'content', 0.0500, 'per hook', 0,
 '/api/skills/run/hook-generator', true,
 '{"spotify_url":"string","count":"number","formats":"array"}'::jsonb),

('post-scheduler', 'Post Scheduler',
 'Schedule and post content to TikTok at optimal times.',
 'content', 0.0500, 'per post', 0,
 '/api/skills/run/post-scheduler', false,
 '{"campaign_id":"string","posts":"array"}'::jsonb),

('sound-tracker', 'Sound Tracker',
 'Monitor TikTok to detect when creators post videos using your sound.',
 'tracking', 0.0100, 'per creator checked', 0,
 '/api/skills/run/sound-tracker', false,
 '{"campaign_id":"string","tiktok_sound_url":"string","creator_usernames":"array"}'::jsonb),

('playlist-pitcher', 'Playlist Pitcher',
 'Find Spotify playlist curators in your genre and send personalized pitches.',
 'outreach', 0.1000, 'per pitch sent', 0,
 '/api/skills/run/playlist-pitcher', true,
 '{"spotify_url":"string","genre":"string","limit":"number"}'::jsonb),

('press-pitcher', 'Press Pitcher',
 'Find music blogs and Substack writers covering your genre and send pitches.',
 'outreach', 0.1000, 'per pitch sent', 0,
 '/api/skills/run/press-pitcher', false,
 '{"spotify_url":"string","genre":"string","limit":"number"}'::jsonb),

('release-kit', 'Release Kit',
 'Generate a complete release marketing package: press release, bio, social captions, pitch templates.',
 'content', 0.2500, 'per kit', 0,
 '/api/skills/run/release-kit', true,
 '{"spotify_url":"string","artist_name":"string","release_date":"string","artist_bio":"string"}'::jsonb),

('trend-matcher', 'Trend Matcher',
 'Match your song to currently trending TikTok formats, sounds and hashtags.',
 'discovery', 0.0500, 'per analysis', 0,
 '/api/skills/run/trend-matcher', false,
 '{"spotify_url":"string","genre":"string"}'::jsonb)

ON CONFLICT (slug) DO NOTHING;
