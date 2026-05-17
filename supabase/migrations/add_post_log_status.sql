-- Migration: add status and postiz_post_id to post_log
-- Run this in the Supabase SQL editor if upgrading from an earlier schema version.

-- Status tracks where in the pipeline the post is:
--   pending_publish  — draft delivered to TikTok inbox; artist hasn't published yet
--   published        — artist added the sound and hit publish
--   failed           — delivery to TikTok failed
alter table post_log
  add column if not exists status         text not null default 'pending_publish',
  add column if not exists postiz_post_id text;

create index if not exists post_log_status_idx on post_log(status);

-- RPC used by click.js: increment streaming_clicks atomically
create or replace function increment_streaming_clicks(p_post_uid text)
returns void language sql as $$
  update post_log
  set streaming_clicks = streaming_clicks + 1
  where post_uid = p_post_uid;
$$;
