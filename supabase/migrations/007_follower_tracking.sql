-- Follower tracking for phase detection
-- Phase 1: <1000 followers → optimize for followers
-- Phase 2: ≥1000 followers → optimize for Spotify clicks

alter table campaigns
  add column if not exists follower_count integer not null default 0,
  add column if not exists follower_phase integer not null default 1; -- 1 or 2

-- Daily follower snapshots for growth correlation
create table if not exists follower_log (
  id           uuid primary key default uuid_generate_v4(),
  campaign_id  uuid references campaigns(id) on delete cascade,
  follower_count integer not null,
  recorded_at  timestamptz not null default now()
);

create index if not exists follower_log_campaign_idx on follower_log(campaign_id, recorded_at desc);
