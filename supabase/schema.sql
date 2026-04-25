-- RunSound — Supabase Schema
-- Run this in the Supabase SQL editor: https://app.supabase.com/project/_/sql
--
-- Tables:
--   artists      — one row per registered artist (email, plan, billing)
--   campaigns    — one campaign per song per artist
--   utm_clicks   — one row per streaming click (UTM attribution)
--   post_log     — history of every TikTok post sent

-- ─── Enable UUID extension ─────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── ARTISTS ──────────────────────────────────────────────────────────────────
create table if not exists artists (
  id           uuid primary key default uuid_generate_v4(),
  email        text unique not null,
  name         text,
  plan         text not null default 'starter',   -- starter | growth | pro
  status       text not null default 'trial',     -- trial | active | paused | cancelled
  stripe_id    text,                               -- Stripe customer ID
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ─── CAMPAIGNS ────────────────────────────────────────────────────────────────
create table if not exists campaigns (
  id              uuid primary key default uuid_generate_v4(),
  artist_id       uuid references artists(id) on delete cascade,
  slug            text unique not null,            -- url-safe: "carly-rae-jepsen-summer-love"
  artist_name     text not null,
  song_title      text not null,
  genre           text,
  mood            text,

  -- Streaming links
  spotify_url     text,
  apple_url       text,
  youtube_url     text,
  tidal_url       text,
  deezer_url      text,
  amazon_url      text,
  soundcloud_url  text,

  -- Smart link
  smart_link_url  text,                            -- e.g. https://runsound.fm/l/summer-love
  artwork_url     text,

  -- Hook lines (stored as JSON array)
  hook_lines      jsonb not null default '[]',

  -- Campaign config (mirrors config.json structure)
  config          jsonb not null default '{}',

  -- State
  active          boolean not null default true,
  tiktok_inbox_id text,                            -- TikTok user ID for draft delivery

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists campaigns_artist_id_idx on campaigns(artist_id);
create index if not exists campaigns_slug_idx      on campaigns(slug);
create index if not exists campaigns_active_idx    on campaigns(active) where active = true;

-- ─── UTM CLICKS ───────────────────────────────────────────────────────────────
-- Tracks every click from TikTok → streaming services
-- utm_campaign = POST_UID from post-to-tiktok.js (rs-<timestamp>-<variant>)
create table if not exists utm_clicks (
  id           uuid primary key default uuid_generate_v4(),
  campaign_id  uuid references campaigns(id) on delete set null,
  utm_campaign text not null,   -- POST_UID: "rs-1736000000000-a"
  platform     text,            -- spotify | apple | youtube | tidal | deezer | amazon | soundcloud
  clicked_at   timestamptz not null default now(),
  user_agent   text,
  ip_hash      text             -- hashed for privacy
);

create index if not exists utm_clicks_utm_campaign_idx on utm_clicks(utm_campaign);
create index if not exists utm_clicks_campaign_id_idx  on utm_clicks(campaign_id);
create index if not exists utm_clicks_clicked_at_idx   on utm_clicks(clicked_at desc);

-- ─── POST LOG ─────────────────────────────────────────────────────────────────
-- One row per TikTok draft sent
create table if not exists post_log (
  id              uuid primary key default uuid_generate_v4(),
  campaign_id     uuid references campaigns(id) on delete set null,
  post_uid        text unique not null,   -- POST_UID: "rs-<ts>-<variant>"
  variant         text,                   -- A | B | C
  hook_line       text,
  hook_angle      text,
  visual_direction text,
  tiktok_post_id  text,
  views           bigint default 0,
  likes           bigint default 0,
  shares          bigint default 0,
  comments        bigint default 0,
  streaming_clicks bigint default 0,
  streaming_ctr   float,
  posted_at       timestamptz not null default now(),
  stats_updated_at timestamptz
);

create index if not exists post_log_campaign_id_idx on post_log(campaign_id);
create index if not exists post_log_post_uid_idx    on post_log(post_uid);
create index if not exists post_log_posted_at_idx   on post_log(posted_at desc);

-- ─── Auto-update updated_at ───────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger artists_updated_at
  before update on artists
  for each row execute function update_updated_at();

create or replace trigger campaigns_updated_at
  before update on campaigns
  for each row execute function update_updated_at();

-- ─── Row Level Security ────────────────────────────────────────────────────────
-- Enable RLS — the API uses the service role key (bypasses RLS)
-- These policies allow the anon key to only read public smart link data
alter table artists   enable row level security;
alter table campaigns enable row level security;
alter table utm_clicks enable row level security;
alter table post_log   enable row level security;

-- Public can read campaign smart link data (needed for link.html)
create policy "Public read smart link data"
  on campaigns for select
  using (active = true);

-- Service role key (used by backend) bypasses all RLS
-- No additional policies needed for backend operations
