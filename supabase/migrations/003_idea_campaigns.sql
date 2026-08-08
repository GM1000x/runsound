-- RunSound — Idea/release testing tables (Utökning 7 + core loop from
-- postiz-for-musik-plan.md). Additive only — does NOT touch the existing
-- `campaigns` table (smart links / Fastlane batch content queue, still
-- used by web/link.html and api/routes/campaigns.js's :id/* routes).
--
-- New tables:
--   rs_campaigns     — one row per idea-test or release campaign
--   rs_ideas         — rough demos (idea-test) or the single finished song
--   rs_videos        — freebeat-generated videos, one per idea/variant
--   rs_post_results  — organic post performance per video per platform

create table if not exists rs_campaigns (
  id           uuid primary key default uuid_generate_v4(),
  artist_id    uuid references artists(id) on delete cascade,
  type         text not null check (type in ('IDEA_TEST', 'RELEASE')),
  status       text not null default 'DRAFT',
  -- DRAFT | IDEA_TESTING | AWAITING_ARTIST_FINISH | CONTENT_GENERATING |
  -- ORGANIC_TESTING | AWAITING_BUDGET_APPROVAL | BOOSTING | ACTIVE | COMPLETED

  genre             text,
  reference_artists text,
  budget_cents      int,
  release_date      date,
  smart_link_url    text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists rs_campaigns_artist_id_idx on rs_campaigns(artist_id);

create table if not exists rs_ideas (
  id           uuid primary key default uuid_generate_v4(),
  campaign_id  uuid references rs_campaigns(id) on delete cascade,

  title        text not null,
  audio_url    text not null,
  is_finished  boolean not null default false,

  score        float,   -- aggregated organic performance score
  rank         int,     -- rank within the campaign once scored

  created_at   timestamptz not null default now()
);

create index if not exists rs_ideas_campaign_id_idx on rs_ideas(campaign_id);

create table if not exists rs_videos (
  id              uuid primary key default uuid_generate_v4(),
  campaign_id     uuid references rs_campaigns(id) on delete cascade,
  idea_id         uuid references rs_ideas(id) on delete set null,

  freebeat_job_id text,
  variant_label   text not null,   -- 'idea-test-clip' | 'lyric-video' | 'dance-cut' | 'visualizer'
  prompt_json     jsonb,           -- logged prompt sent to freebeat (self-improvement loop)
  video_url       text,
  status          text not null default 'PENDING', -- PENDING | GENERATING | READY | FAILED

  created_at      timestamptz not null default now()
);

create index if not exists rs_videos_campaign_id_idx on rs_videos(campaign_id);
create index if not exists rs_videos_status_idx       on rs_videos(status);

create table if not exists rs_post_results (
  id              uuid primary key default uuid_generate_v4(),
  video_id        uuid references rs_videos(id) on delete cascade,

  platform        text not null check (platform in ('TIKTOK', 'INSTAGRAM')),
  external_post_id text,   -- TikTok publish_id or Postiz post id
  is_organic      boolean not null default true,

  published_at    timestamptz,
  views           bigint default 0,
  completion_rate float,
  saves           bigint default 0,
  shares          bigint default 0,

  updated_at      timestamptz not null default now()
);

create index if not exists rs_post_results_video_id_idx on rs_post_results(video_id);

create or replace trigger rs_campaigns_updated_at
  before update on rs_campaigns
  for each row execute function update_updated_at();

alter table rs_campaigns    enable row level security;
alter table rs_ideas        enable row level security;
alter table rs_videos       enable row level security;
alter table rs_post_results enable row level security;
-- Service role key (used by backend) bypasses all RLS — no public policies
-- needed since these aren't read directly by any public-facing page yet.
