#!/usr/bin/env node
/**
 * RunSound — Post image carousel to TikTok
 *
 * Strategy (tries in order):
 *   1. Direct TikTok API  — if artist has connected their TikTok via OAuth
 *      (token stored in Supabase artists.tiktok_access_token)
 *   2. Postiz             — legacy fallback for older campaigns
 *
 * Uploads slide1.png → slide6.png as a swipeable TikTok carousel (not a video).
 * Draft arrives in artist's TikTok inbox. They add their song and publish.
 *
 * Usage: node post-to-tiktok.js --input <dir> --config <config.json> [--variant A|B|C] [--caption "override"]
 */

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const FormData = require('form-data');

// Direct TikTok API (used when artist has connected their account via OAuth)
const tiktokApi = require('./api/tiktok-api');

// Force node-fetch for form-data compatibility
let fetchFn;
try {
  fetchFn = require('node-fetch').default;
} catch {
  fetchFn = require('node-fetch');
}

// Optional Supabase — writes to post_log so the artist dashboard has real data
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (sbUrl && sbKey) {
    supabase = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
  }
} catch { /* supabase not installed — post_log won't be updated */ }

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputDir   = getArg('input');
const configPath = getArg('config');
const captionArg = getArg('caption');
const variantArg = (getArg('variant') || 'A').toUpperCase();

if (!inputDir || !configPath) {
  console.error('Usage: node post-to-tiktok.js --input <dir> --config <config.json>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const POSTIZ_API    = 'https://api.postiz.com/public/v1';
// apiKey: support both env-var-name string ('POSTIZ_API_KEY') and literal value
const apiKey        = process.env[config.postiz?.apiKey] || config.postiz?.apiKey || process.env.POSTIZ_API_KEY;
// integrationId: config first, then env fallback
const integrationId = config.postiz?.integrationIds?.tiktok || process.env.POSTIZ_TIKTOK_ID;

if (!apiKey || !integrationId) {
  console.error('❌ Missing postiz.apiKey or postiz.integrationIds.tiktok in config');
  console.error(`   apiKey: ${apiKey ? 'ok' : 'MISSING (set POSTIZ_API_KEY)'}`);
  console.error(`   integrationId: ${integrationId ? 'ok' : 'MISSING (set POSTIZ_TIKTOK_ID)'}`);
  process.exit(1);
}

const metaPath = path.join(inputDir, 'meta.json');

// ─── Unique post identifier (generated BEFORE posting) ───────────────────────
// Used as the UTM campaign tag so clicks can be traced back to this exact post.
// Format: rs-<unix-ms>-<variant-lowercase>
// Example: rs-1714060800000-a
const POST_UID = `rs-${Date.now()}-${variantArg.toLowerCase()}`;

// ─── Find slide images ────────────────────────────────────────────────────────
function findSlides() {
  const slides = [];
  for (let i = 1; i <= 6; i++) {
    const finalPath = path.join(inputDir, `slide${i}_final.png`);
    const basicPath = path.join(inputDir, `slide${i}.png`);
    if (fs.existsSync(finalPath)) {
      slides.push(finalPath);
    } else if (fs.existsSync(basicPath)) {
      slides.push(basicPath);
    }
  }
  return slides;
}

// ─── Step 1: Upload a single image to Postiz ─────────────────────────────────
async function uploadImage(imagePath) {
  const filename = path.basename(imagePath);
  const form     = new FormData();
  form.append('file', fs.createReadStream(imagePath), {
    filename,
    contentType: 'image/png',
  });

  const res = await fetchFn(`${POSTIZ_API}/upload`, {
    method:  'POST',
    headers: { 'Authorization': apiKey, ...form.getHeaders() },
    body:    form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Image upload failed for ${filename} (${res.status}): ${text}`);
  }

  return await res.json(); // { id, name, path, ... }
}

// ─── Step 2: Upload all slides ────────────────────────────────────────────────
async function uploadAllSlides(slides) {
  console.log(`\n📤 Uploading ${slides.length} slides to Postiz...`);
  const uploaded = [];
  for (let i = 0; i < slides.length; i++) {
    const data = await uploadImage(slides[i]);
    console.log(`   ✅ Slide ${i + 1}/${slides.length}: ${data.path}`);
    uploaded.push({ id: data.id, path: data.path });
  }
  return uploaded;
}

// ─── UTM URL builder ──────────────────────────────────────────────────────────
// Uses POST_UID as campaign so each post is individually attributable in Supabase.
function buildUtmUrl() {
  const { song } = config;
  const base = song.smartLinkSlug
    ? `https://runsound.fm/${song.smartLinkSlug}`
    : (song.spotifyUrl || '');
  if (!base) return '';

  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}utm_source=tiktok&utm_medium=carousel&utm_campaign=${POST_UID}`;
}

// ─── Step 3: Build caption ────────────────────────────────────────────────────
function buildCaption(utmUrl) {
  if (captionArg) return captionArg;

  const { artist, song } = config;
  const link = utmUrl || '';

  return [
    `${song.title} by ${artist.name}`,
    link ? `🎵 Stream it: ${link}` : '',
    `#${artist.genre?.replace(/\s+/g, '') || 'music'} #newmusic #${artist.name?.replace(/\s+/g, '').toLowerCase() || 'artist'} #indiefolk`,
  ].filter(Boolean).join('\n');
}

// ─── Step 4: Create carousel post ────────────────────────────────────────────
async function createPost(images, utmUrl) {
  console.log('\n📱 Creating TikTok carousel post...');

  const caption      = buildCaption(utmUrl);
  const scheduleDate = new Date(Date.now() + 2 * 60 * 1000).toISOString();

  const body = {
    type:      'now',
    date:      scheduleDate,
    shortLink: false,
    tags:      [],
    posts: [
      {
        integration: { id: integrationId },
        value: [{ content: caption, image: images }],
        settings: {
          privacy_level:          'SELF_ONLY',
          duet:                   false,
          stitch:                 false,
          comment:                true,
          autoAddMusic:           'no',
          brand_content_toggle:   false,
          brand_organic_toggle:   false,
          content_posting_method: 'UPLOAD',
        },
      },
    ],
  };

  const res = await fetchFn(`${POSTIZ_API}/posts`, {
    method:  'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Post creation failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const post = Array.isArray(data) ? data[0] : data;
  console.log(`   ✅ Carousel posted! Post ID: ${post.postId || post.id}`);
  return post;
}

// ─── Step 5: Save meta to disk ───────────────────────────────────────────────
function savePostMeta(postData, slideCount, utmUrl, method = 'postiz') {
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  }

  // Support both Postiz response shape and direct TikTok shape
  meta.postizPostId  = postData.postId  || postData.id  || null;
  meta.tiktokPostId  = postData.postId  || postData.id  || null;
  meta.postedAt      = new Date().toISOString();
  meta.status        = 'pending_publish';
  meta.slideCount    = slideCount;
  meta.variant       = variantArg;
  meta.postUid       = POST_UID;
  meta.utmUrl        = utmUrl || null;
  meta.postMethod    = method; // 'direct_tiktok' | 'postiz'
  meta.tiktokVideoId = null;

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`\n💾 Post metadata saved to ${metaPath}`);
  console.log(`   Post UID:   ${POST_UID}`);
  console.log(`   Method:     ${method}`);
  if (utmUrl) console.log(`   UTM URL:    ${utmUrl}`);

  return meta;
}

// ─── Step 6: Write to Supabase post_log (so dashboard has data) ───────────────
async function writeToSupabase(meta) {
  if (!supabase) return;

  // campaign_id comes from config (materialized by run-all-campaigns.js)
  const campaignId = config.campaign?.id || null;
  if (!campaignId) {
    console.log('   ℹ️  No campaign.id in config — post_log not written to Supabase');
    console.log('      (This is fine for single-artist local runs)');
    return;
  }

  // Load hook/angle/archetype from texts-meta.json (written by generate-texts.js)
  let hookLine = null, hookAngle = null, hookArchetype = null, visualDirection = null;

  const textsMetaPath = path.join(inputDir, 'texts-meta.json');
  if (fs.existsSync(textsMetaPath)) {
    try {
      const tm     = JSON.parse(fs.readFileSync(textsMetaPath, 'utf-8'));
      hookArchetype = tm.hook_archetype || null;
      hookAngle     = tm.hook_archetype || null; // backwards compat
    } catch {}
  }

  // Also check texts.json for hookLine
  const textsPath = path.join(inputDir, 'texts.json');
  if (fs.existsSync(textsPath)) {
    try {
      const texts = JSON.parse(fs.readFileSync(textsPath, 'utf-8'));
      // texts.json is an array of slide strings — slide 0 is the hook
      hookLine = Array.isArray(texts) ? texts[0]?.replace(/\n/g, ' / ') : (texts.hook || texts.slide1 || null);
    } catch {}
  }

  try {
    const { error } = await supabase.from('post_log').upsert({
      campaign_id:      campaignId,
      post_uid:         POST_UID,
      variant:          variantArg,
      hook_line:        hookLine,
      hook_angle:       hookAngle,
      hook_archetype:   hookArchetype,
      visual_direction: visualDirection,
      tiktok_post_id:   meta.postizPostId || null,
      status:           'pending_publish',
      views:            0,
      likes:            0,
      shares:           0,
      comments:         0,
      streaming_clicks: 0,
      posted_at:        meta.postedAt,
    }, { onConflict: 'post_uid' });

    if (error) throw error;
    console.log(`   ✅ post_log written to Supabase (campaign: ${campaignId.slice(0, 8)}...)`);
  } catch (err) {
    // Non-fatal — local meta.json is the source of truth for single-artist
    console.log(`   ⚠️  Supabase post_log write failed: ${err.message}`);
  }
}

// ─── Direct TikTok API posting ────────────────────────────────────────────────
// Used when the artist has connected their TikTok account via OAuth.
async function postDirectToTikTok(slides, utmUrl) {
  const artistId = config.artist?.id || null;
  if (!artistId) return false; // no artist ID → can't look up token

  const tokenInfo = await tiktokApi.getValidToken(artistId);
  if (!tokenInfo) return false; // artist hasn't connected TikTok yet

  const { accessToken } = tokenInfo;
  const caption = buildCaption(utmUrl);

  console.log(`\n🎵 RunSound — TikTok Direct Post (OAuth)`);
  console.log(`   Artist:   ${config.artist.name}`);
  console.log(`   Song:     ${config.song.title}`);
  console.log(`   Slides:   ${slides.length} images`);
  console.log(`   Variant:  ${variantArg}`);
  console.log(`   Post UID: ${POST_UID}\n`);

  const { publishId, status } = await tiktokApi.postPhotoCarousel(accessToken, slides, caption);

  return {
    postId: publishId,
    status,
    method: 'direct_tiktok',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const slides = findSlides();
    if (slides.length === 0) {
      console.error(`❌ No slides found in ${inputDir}`);
      console.error(`   Expected: slide1.png → slide6.png (or slide1_final.png etc.)`);
      console.error(`   Run 'npm run generate' first.`);
      process.exit(1);
    }

    const utmUrl = buildUtmUrl();

    // ── Try direct TikTok API first ────────────────────────────────────────────
    let postData = null;
    let method   = 'postiz'; // will be overridden if direct succeeds

    try {
      const directResult = await postDirectToTikTok(slides, utmUrl);
      if (directResult) {
        postData = directResult;
        method   = 'direct_tiktok';
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`✅ CAROUSEL SENT TO TIKTOK INBOX (direct API)`);
        console.log(`${'─'.repeat(60)}`);
      }
    } catch (directErr) {
      console.warn(`[post-to-tiktok] Direct TikTok API failed: ${directErr.message}`);
      console.warn(`   Falling back to Postiz...`);
    }

    // ── Fall back to Postiz if direct didn't work ──────────────────────────────
    if (!postData) {
      if (!apiKey || !integrationId) {
        console.error('❌ No TikTok connection and no Postiz credentials configured.');
        console.error('   → Connect your TikTok at: /connect.html');
        console.error(`   apiKey: ${apiKey ? 'ok' : 'MISSING (POSTIZ_API_KEY)'}`);
        console.error(`   integrationId: ${integrationId ? 'ok' : 'MISSING (POSTIZ_TIKTOK_ID)'}`);
        process.exit(1);
      }

      console.log(`\n🎵 RunSound — TikTok Carousel Post (via Postiz)`);
      console.log(`   Artist:  ${config.artist.name}`);
      console.log(`   Song:    ${config.song.title}`);
      console.log(`   Slides:  ${slides.length} images found`);
      console.log(`   Variant: ${variantArg}`);
      console.log(`   Post UID: ${POST_UID}\n`);

      const uploadedImages = await uploadAllSlides(slides);
      postData = await createPost(uploadedImages, utmUrl);

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`✅ CAROUSEL IS IN YOUR TIKTOK INBOX (via Postiz)`);
      console.log(`${'─'.repeat(60)}`);
    }

    const meta = savePostMeta(postData, slides.length, utmUrl, method);
    await writeToSupabase(meta);

    console.log(`\n📱 To publish (30 seconds):`);
    console.log(`   1. Open TikTok → tap the notification in your inbox`);
    console.log(`   2. Tap "Add sound"`);
    console.log(`   3. Search for: "${config.song?.title || 'your song'}" (or any trending sound)`);
    console.log(`   4. Tap Post!\n`);

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (err.message.includes('401') || err.message.includes('403')) {
      console.error(`   Check your API credentials (POSTIZ_API_KEY or TikTok OAuth token)`);
    }
    process.exit(1);
  }
})();
