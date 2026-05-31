-- Supabase Storage bucket for artist-uploaded images
-- Run this in Supabase Storage dashboard OR SQL editor

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'artist-images',
  'artist-images',
  true,
  5242880, -- 5MB
  array['image/jpeg','image/jpg','image/png','image/webp']
) on conflict (id) do nothing;

-- Allow public read
create policy if not exists "Public read artist images"
  on storage.objects for select
  using (bucket_id = 'artist-images');

-- Allow service role to upload
create policy if not exists "Service role upload artist images"
  on storage.objects for insert
  with check (bucket_id = 'artist-images');
