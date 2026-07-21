-- ══════════════════════════════════════════════════════════════════════════════
-- RunSound — Creator Outreach tables
-- Run once in Supabase → SQL Editor
-- ══════════════════════════════════════════════════════════════════════════════

-- ── tiktok_outreach_accounts ──────────────────────────────────────────────────
-- One row per TikTok account an artist connects for outreach (can have many)
CREATE TABLE IF NOT EXISTS tiktok_outreach_accounts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id       uuid        NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  tiktok_username text        NOT NULL,
  tiktok_user_id  text,
  session_cookies text        NOT NULL,   -- JSON string, encrypted at app level
  daily_limit     int         NOT NULL DEFAULT 30,
  active          boolean     NOT NULL DEFAULT true,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_accounts_artist
  ON tiktok_outreach_accounts(artist_id)
  WHERE active = true;

-- ── outreach_campaigns ────────────────────────────────────────────────────────
-- One per music promotion campaign (linked to existing campaigns table)
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  artist_id           uuid        NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','paused','completed')),
  target_categories   text[]      NOT NULL DEFAULT '{}',  -- e.g. ['fitness','dance','lifestyle']
  follower_min        int         NOT NULL DEFAULT 1000,
  follower_max        int         NOT NULL DEFAULT 50000,
  min_engagement_rate numeric(5,2) NOT NULL DEFAULT 3.0,
  dm_template         text,       -- GPT-generated base template
  creators_found      int         NOT NULL DEFAULT 0,
  dms_sent            int         NOT NULL DEFAULT 0,
  emails_sent         int         NOT NULL DEFAULT 0,
  replies_received    int         NOT NULL DEFAULT 0,
  sounds_used         int         NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_artist
  ON outreach_campaigns(artist_id);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_campaign
  ON outreach_campaigns(campaign_id);

-- ── outreach_contacts ─────────────────────────────────────────────────────────
-- One row per creator contacted in a campaign
CREATE TABLE IF NOT EXISTS outreach_contacts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_campaign_id uuid       NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  tiktok_username     text        NOT NULL,
  tiktok_user_id      text,
  display_name        text,
  follower_count      int,
  engagement_rate     numeric(5,2),
  bio                 text,
  email               text,
  content_categories  text[]      DEFAULT '{}',
  profile_url         text,
  avatar_url          text,
  -- outreach status
  dm_sent             boolean     NOT NULL DEFAULT false,
  dm_sent_at          timestamptz,
  dm_sent_via_account uuid        REFERENCES tiktok_outreach_accounts(id),
  dm_text             text,       -- personalized DM that was sent
  email_sent          boolean     NOT NULL DEFAULT false,
  email_sent_at       timestamptz,
  replied             boolean     NOT NULL DEFAULT false,
  replied_at          timestamptz,
  sound_used          boolean     NOT NULL DEFAULT false,
  sound_used_at       timestamptz,
  sound_video_url     text,       -- URL to their video using the sound
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE(outreach_campaign_id, tiktok_username)
);

CREATE INDEX IF NOT EXISTS idx_outreach_contacts_campaign
  ON outreach_contacts(outreach_campaign_id);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_dm
  ON outreach_contacts(dm_sent, dm_sent_at);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_sound
  ON outreach_contacts(sound_used)
  WHERE sound_used = true;
