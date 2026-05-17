-- Migration: add onboarding tracking + dashboard auth token to campaigns
-- Run in Supabase SQL editor.

-- dash_token: random 64-char hex, included in the artist's dashboard URL.
-- Without a valid token the API returns 401. Sent in the welcome email so
-- only the artist can access their data.
alter table campaigns
  add column if not exists dash_token          text unique,
  add column if not exists onboarding_status   text not null default 'setup',
  add column if not exists onboarding_error    text;

-- Indexes for auth lookups
create index if not exists campaigns_dash_token_idx
  on campaigns(dash_token) where dash_token is not null;

create index if not exists campaigns_onboarding_idx
  on campaigns(onboarding_status);
