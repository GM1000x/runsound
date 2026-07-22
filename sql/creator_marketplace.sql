-- ─────────────────────────────────────────────────────────────────────────────
-- RunSound Creator Marketplace
-- Run this in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. CREATORS — TikTok creators who sign up to receive payment
CREATE TABLE IF NOT EXISTS creators (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz DEFAULT now(),

  -- Identity
  email               text UNIQUE NOT NULL,
  name                text NOT NULL,
  tiktok_handle       text UNIQUE NOT NULL,   -- e.g. "@username" (used by sound-tracker)

  -- Stripe Connect
  stripe_account_id   text,                   -- acct_xxx (Express account)
  stripe_onboarded    boolean DEFAULT false,  -- true once onboarding complete

  -- Status
  status              text DEFAULT 'pending', -- pending | active | suspended
  total_earned_usd    numeric(10,4) DEFAULT 0
);

-- 2. CREATOR_OFFERS — An artist creates an offer for a campaign
CREATE TABLE IF NOT EXISTS creator_offers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz DEFAULT now(),

  -- Who created it
  artist_id           uuid REFERENCES artists(id) ON DELETE CASCADE,
  campaign_id         uuid,                   -- references outreach_campaigns if exists

  -- Offer terms
  track_name          text NOT NULL,
  spotify_url         text NOT NULL,
  tiktok_sound_url    text,                   -- filled once sound is live on TikTok
  payout_per_post_usd numeric(8,2) NOT NULL,  -- e.g. 20.00
  max_creators        int NOT NULL DEFAULT 10,
  budget_usd          numeric(10,2) NOT NULL, -- payout_per_post * max_creators (held in escrow)

  -- Stripe escrow
  stripe_payment_intent_id text,             -- PI used to capture artist's payment
  escrow_funded       boolean DEFAULT false,

  -- State
  status              text DEFAULT 'draft',   -- draft | active | completed | cancelled
  accepted_count      int DEFAULT 0,
  expires_at          timestamptz,

  -- Message sent to creators in DM
  offer_message       text
);

-- 3. CREATOR_DEALS — Each creator who accepts an offer
CREATE TABLE IF NOT EXISTS creator_deals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz DEFAULT now(),

  offer_id            uuid REFERENCES creator_offers(id) ON DELETE CASCADE,
  creator_id          uuid REFERENCES creators(id) ON DELETE CASCADE,

  -- State machine: invited → accepted → posted → paid | failed
  status              text DEFAULT 'invited',

  -- When they accepted
  accepted_at         timestamptz,

  -- Post confirmation (filled by sound-tracker)
  tiktok_post_url     text,
  post_detected_at    timestamptz,

  -- Payment
  payout_usd          numeric(8,2),
  stripe_transfer_id  text,                  -- tr_xxx from Stripe Connect transfer
  paid_at             timestamptz,

  UNIQUE(offer_id, creator_id)
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_creator_deals_offer    ON creator_deals(offer_id);
CREATE INDEX IF NOT EXISTS idx_creator_deals_creator  ON creator_deals(creator_id);
CREATE INDEX IF NOT EXISTS idx_creator_deals_status   ON creator_deals(status);
CREATE INDEX IF NOT EXISTS idx_creator_offers_artist  ON creator_offers(artist_id);
CREATE INDEX IF NOT EXISTS idx_creators_tiktok        ON creators(tiktok_handle);
