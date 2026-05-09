-- Migration: Add TikTok OAuth columns to artists table
-- Run in Supabase SQL editor: https://app.supabase.com/project/_/sql

alter table artists add column if not exists tiktok_open_id            text;
alter table artists add column if not exists tiktok_access_token       text;
alter table artists add column if not exists tiktok_refresh_token      text;
alter table artists add column if not exists tiktok_token_expires_at   timestamptz;
alter table artists add column if not exists tiktok_refresh_expires_at timestamptz;
alter table artists add column if not exists tiktok_scope              text;
alter table artists add column if not exists tiktok_connected_at       timestamptz;
