#!/usr/bin/env node
/**
 * RunSound — Post image carousel to TikTok via Postiz
 *
 * Uploads slide1.png → slide6.png as a swipeable TikTok carousel (not a video).
 * User receives a TikTok inbox notification, opens the draft, adds their song
 * from TikTok's music library, then publishes.
 *
 * Usage: node post-to-tiktok.js --input <dir> --config <config.json> [--variant A|B|C] [--caption "override"]
 */

const fs      = require('fs');
const path    = require('path');
const FormData = require('form-data');

// Force node-fetch for form-data compatibility
let fetchFn;
try {
  fetchFn = require('node-fetch').default;
} catch {
  fetchFn = require('node-fetch');
}

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputDir    = getArg('input');
const configPath  = getArg('config');
const captionArg  = getArg('caption');
const variantArg  = (getArg('variant') || 'A').toUpperCase();

if (!inputDir || !configPath) {
  console.error('Usage: node post-to-tiktok.js --input <dir> --config <config.json>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const POSTIZ_API    = 'https://api.postiz.com/public/v1';
const apiKey        = process.env[config.postiz.apiKey] || config.postiz.apiKey;
const integrationId = config.postiz.integrationIds?.tiktok;

if (!apiKey || !integrationId) {
  console.error('❌ Missing postiz.apiKey or postiz.integrationIds.tiktok in config');
  process.exit(1);
}

const metaPath = path.join(inputDir, 'meta.json');

// ─── Find slide images ────────────────────────────────────────────────────────
function findSlides() {
  const slides = [];
  for (let i = 1; i <= 6; i++) {
    // Try slide1_final.png first, then slide1.png
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

// ─── Step 1: Upload a single image to Postiz ────────────────────────────────
async function uploadImage(imagePath) {
  const filename = path.basename(imagePath);
  const form = new FormData();
  form.append('file', fs.createReadStream(imagePath), {
    filename,
    contentType: 'image/png'
  });

  const res = await fetchFn(`${POSTIZ_API}/upload`, {
    method: 'POST',
    headers: { 'Authorization': apiKey, ...form.getHeaders() },
    body: form
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

// ─── UTM URL builder ─────────────────────────────────────────────────────────
function buildUtmUrl() {
  const { song } = config;
  const base = song.smartLinkSlug
    ? `https://runsound.fm/${song.smartLinkSlug}`
    : (song.spotifyUrl || '');
  if (!base) return '';

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const campaign = `${dateStr}-${variantArg}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}utm_source=tiktok&utm_medium=carousel&utm_campaign=${campaign}`;
}

// ─── Step 3: Build caption ────────────────────────────────────────────────────
function buildCaption(utmUrl) {
  if (captionArg) return captionArg;

  const { artist, song } = config;
  const link = utmUrl || '';

  return [
    `${song.title} by ${artist.name}`,
    link ? `🎵 Stream it: ${link}` : '',
    `#${artist.genre?.replace(/\s+/g, '') || 'music'} #newmusic #${artist.name?.replace(/\s+/g, '').toLowerCase() || 'artist'} #indiefolk`
  ].filter(Boolean).join('\n');
}

// ─── Step 4: Create carousel post ────────────────────────────────────────────
async function createPost(images, utmUrl) {
  console.log('\n📱 Creating TikTok carousel post...');

  const caption      = buildCaption(utmUrl);
  const scheduleDate = new Date(Date.now() + 2 * 60 * 1000).toISOString();

  const body = {
    type: 'now',
    date: scheduleDate,
    shortLink: false,
    tags: [],
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
          content_posting_method: 'UPLOAD'
        }
      }
    ]
  };

  const res = await fetchFn(`${POSTIZ_API}/posts`, {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
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

// ─── Step 5: Save meta ────────────────────────────────────────────────────────
function savePostMeta(postData, slideCount, utmUrl) {
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  }
  meta.postizPostId  = postData.postId || postData.id;
  meta.postedAt      = new Date().toISOString();
  meta.status        = 'pending_publish';
  meta.slideCount    = slideCount;
  meta.variant       = variantArg;
  meta.utmUrl        = utmUrl || null;
  meta.tiktokVideoId = null;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`\n💾 Post metadata saved to ${metaPath}`);
  if (utmUrl) console.log(`   UTM: ${utmUrl}`);
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

    console.log(`\n🎵 RunSound — TikTok Carousel Post`);
    console.log(`   Artist: ${config.artist.name}`);
    console.log(`   Song:   ${config.song.title}`);
    console.log(`   Slides: ${slides.length} images found`);
    console.log(`   Variant: ${variantArg}`);
    console.log(`   Mode:   UPLOAD → TikTok inbox notification\n`);

    const utmUrl         = buildUtmUrl();
    const uploadedImages = await uploadAllSlides(slides);
    const postData       = await createPost(uploadedImages, utmUrl);
    savePostMeta(postData, slides.length, utmUrl);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`✅ CAROUSEL IS IN YOUR TIKTOK INBOX`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`\n📱 To publish (30 seconds):`);
    console.log(`   1. Open TikTok → tap the notification in your inbox`);
    console.log(`   2. Tap "Add sound"`);
    console.log(`   3. Search for: "${config.song?.title || 'your song'}" (or any trending sound)`);
    console.log(`   4. Tap Post!\n`);
    console.log(`After posting, run:`);
    console.log(`   npm run analytics\n`);

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (err.message.includes('401') || err.message.includes('403')) {
      console.error(`   Check your POSTIZ_API_KEY`);
    }
    process.exit(1);
  }
})();
