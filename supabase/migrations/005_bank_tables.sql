-- ============================================================
-- RunSound — Image Bank + Hook Bank
-- Run this once in Supabase → SQL Editor
-- ============================================================

-- ─── IMAGE BANK ───────────────────────────────────────────────────────────────
-- Persistent library of reusable lifestyle images stored in Supabase Storage.
-- Images accumulate across all artist campaigns; high-performers are reused
-- instead of spending API credits to generate new ones each time.
--
-- Matching: arc_role first, then ranked by avg_ctr desc.
-- Lifestyle photos are genre-agnostic — a sunset silhouette works for indie pop
-- and hip-hop alike — so we don't hard-filter by genre.

CREATE TABLE IF NOT EXISTS image_bank (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path  TEXT NOT NULL UNIQUE,      -- "image-bank/hook/img-001_hook_lifestyle_candid.png"
  public_url    TEXT NOT NULL,             -- Full Supabase Storage public URL
  arc_role      TEXT NOT NULL DEFAULT 'hook',  -- hook | story | peak | cta
  tags          TEXT[] DEFAULT '{}',       -- ["hook", "lifestyle", "candid"]
  safe_zone     TEXT DEFAULT 'bottom',     -- top | center | bottom  (safe text placement zone)
  genre         TEXT DEFAULT '',           -- free-form genre recorded for future analysis
  mood          TEXT DEFAULT '',           -- free-form mood recorded for future analysis

  -- Performance metrics (updated by check-analytics.js)
  times_used         INTEGER DEFAULT 0,
  total_views        BIGINT  DEFAULT 0,
  total_clicks       INTEGER DEFAULT 0,
  avg_ctr            FLOAT   DEFAULT 0,    -- clicks / views

  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS image_bank_arc_role_idx ON image_bank (arc_role);
CREATE INDEX IF NOT EXISTS image_bank_avg_ctr_idx  ON image_bank (avg_ctr DESC);


-- ─── HOOK BANK ────────────────────────────────────────────────────────────────
-- Cross-artist archetype performance per genre family.
-- Tracks which hook archetype (A/B/C/D) drives the most streaming clicks
-- for each genre family, pooling data across all artists.
-- New artists inherit these cross-artist weights as priors.

CREATE TABLE IF NOT EXISTS hook_bank (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  genre_family  TEXT NOT NULL,             -- pop | hiphop | dance | rnb | country
  variant_key   TEXT NOT NULL,             -- A | B | C | D
  archetype     TEXT NOT NULL,             -- social_proof | contrarian | mystery | lifestyle_placement

  -- Performance metrics (updated by check-analytics.js)
  times_used         INTEGER DEFAULT 0,
  total_views        BIGINT  DEFAULT 0,
  total_clicks       INTEGER DEFAULT 0,
  avg_ctr            FLOAT   DEFAULT 0,    -- clicks / views

  last_updated  TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (genre_family, variant_key)
);

CREATE INDEX IF NOT EXISTS hook_bank_genre_ctr_idx
  ON hook_bank (genre_family, avg_ctr DESC);

-- Seed: one row per genre × archetype combo so every artist has a prior to start from
INSERT INTO hook_bank (genre_family, variant_key, archetype) VALUES
  ('pop',     'A', 'social_proof'),
  ('pop',     'B', 'contrarian'),
  ('pop',     'C', 'mystery'),
  ('pop',     'D', 'lifestyle_placement'),
  ('hiphop',  'A', 'social_proof'),
  ('hiphop',  'B', 'contrarian'),
  ('hiphop',  'C', 'mystery'),
  ('hiphop',  'D', 'lifestyle_placement'),
  ('dance',   'A', 'social_proof'),
  ('dance',   'B', 'contrarian'),
  ('dance',   'C', 'mystery'),
  ('dance',   'D', 'lifestyle_placement'),
  ('rnb',     'A', 'social_proof'),
  ('rnb',     'B', 'contrarian'),
  ('rnb',     'C', 'mystery'),
  ('rnb',     'D', 'lifestyle_placement'),
  ('country', 'A', 'social_proof'),
  ('country', 'B', 'contrarian'),
  ('country', 'C', 'mystery'),
  ('country', 'D', 'lifestyle_placement')
ON CONFLICT (genre_family, variant_key) DO NOTHING;


-- ─── POST LOG — add image bank attribution ────────────────────────────────────
-- Records which image_bank images were used in each post so check-analytics.js
-- can update their performance after stats arrive.

ALTER TABLE post_log
  ADD COLUMN IF NOT EXISTS image_bank_ids UUID[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hook_archetype TEXT;   -- social_proof | contrarian | mystery | lifestyle_placement

CREATE INDEX IF NOT EXISTS post_log_image_bank_ids_idx
  ON post_log USING gin (image_bank_ids);


-- ─── Verify ───────────────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name IN ('image_bank', 'hook_bank');
--
-- SELECT genre_family, variant_key, archetype FROM hook_bank ORDER BY genre_family, variant_key;
