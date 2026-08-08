-- RunSound — prompt-style feedback loop (Aug 2026 batch-generation strategy)
-- Additive only. Stores learned weights per freebeat prompt style (see
-- api/prompt-styles.js) so runLearnPromptStyles (api/cron.js) can bias
-- future batches toward styles that have historically performed better,
-- without ever fully dropping a style to zero (floor enforced in code,
-- not in this table).

create table if not exists rs_prompt_weights (
  style_key   text primary key,       -- matches api/prompt-styles.js STYLES[].key
  weight      float not null default 1.0,
  avg_score   float not null default 0,
  sample_size int   not null default 0,  -- how many measured posts fed this weight
  updated_at  timestamptz not null default now()
);

alter table rs_prompt_weights enable row level security;
-- Service role key (used by backend) bypasses all RLS — no public policies needed.
