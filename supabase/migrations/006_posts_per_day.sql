-- Add posts_per_day to artists table
-- Controls how many TikTok drafts are sent per day + how many images to generate
alter table artists
  add column if not exists posts_per_day integer not null default 1;

-- starter = 1 post/day, 12 images
-- growth  = 2 posts/day, 24 images  
-- pro     = 3 posts/day, 36 images
comment on column artists.posts_per_day is 'Number of TikTok drafts per day. Also drives image library size (posts_per_day × 12).';
