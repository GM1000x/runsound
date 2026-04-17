#!/usr/bin/env node
/**
 * RunSound — Post silent video to TikTok drafts via Postiz
 *
 * Uploads slideshow_silent.mp4 to TikTok as a SELF_ONLY draft.
 * The artist then opens TikTok inbox, adds their song at hookTimestamp,
 * and publishes manually.
 *
 * Usage: node post-to-tiktok.js --input runsound-marketing/posts/latest --config runsound-marketing/config.json
 *
 * What happens:
 *   1. Reads slideshow_silent.mp4 from --input dir
 *   2. Uploads to Postiz → TikTok (SELF_ONLY = draft visible only to you)
 *   3. Saves post ID to meta.json for analytics tracking later
 *   4. Prints publishing instructions with hookTimestamp
 */

const fs   = require('fs');
const path = require('path');
const FormData = require('form-data');

// Postiz uses fetch (Node 18+) — fallback to node-fetch if needed
let fetchFn;
try {
  fetchFn = fetch; // Node 18+ built-in
} catch {
  fetchFn = require('node-fetch');
}

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputDir  = getArg('input');
const configPath = getArg('config');

if (!inputDir || !configPath) {
  console.error('Usage: node post-to-tiktok.js --input <dir> --config <config.json>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const POSTIZ_API   = 'https://api.postiz.com/public/v1';
const apiKey       = config.postiz.apiKey;
const integrationId = config.postiz.integrationIds?.tiktok;

if (!apiKey || !integrationId) {
  console.error('❌ Missing postiz.apiKey or postiz.integrationIds.tiktok in config');
  process.exit(1);
}

const videoPath = path.join(inputDir, 'slideshow_silent.mp4');
const metaPath  = path.join(inputDir, 'meta.json');

if (!fs.existsSync(videoPath)) {
  console.error(`❌ Video not found: ${videoPath}`);
  console.error(`   Run 'npm run strip' first.`);
  process.exit(1);
}

// ─── Step 1: Upload media to Postiz ─────────────────────────────────────────
async function uploadMedia() {
  console.log('\n📤 Uploading video to Postiz...');

  const form = new FormData();
  form.append('file', fs.createReadStream(videoPath), {
    filename: 'slideshow_silent.mp4',
    contentType: 'video/mp4'
  });

  const res = await fetchFn(`${POSTIZ_API}/media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      ...form.getHeaders()
    },
    body: form
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Media upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  console.log(`   ✅ Media uploaded: ${data.id || data.url || 'OK'}`);
  return data;
}

// ─── Step 2: Create post (TikTok draft) ──────────────────────────────────────
async function createPost(mediaData) {
  console.log('\n📱 Creating TikTok draft post...');

  // Build caption: song title + artist + CTA
  const { artist, song } = config;
  const spotifyUrl = song.spotifyUrl || '';
  const smartLink  = song.smartLinkSlug ? `https://runsound.fm/${song.smartLinkSlug}` : spotifyUrl;

  const caption = [
    `${song.title} by ${artist.name}`,
    smartLink ? `Stream it: ${smartLink}` : '',
    `#${artist.genre?.replace(/\s+/g, '') || 'music'} #newmusic #${artist.name?.replace(/\s+/g, '').toLowerCase() || 'artist'}`
  ].filter(Boolean).join('\n');

  // Schedule for 2 minutes from now (Postiz requires a future date)
  const scheduleDate = new Date(Date.now() + 2 * 60 * 1000).toISOString();

  const body = {
    type: 'draft',
    date: scheduleDate,
    shortLink: false,
    tags: [],
    content: [
      {
        integration: { id: integrationId },
        value: [
          {
            content: caption,
            media: mediaData.id ? [{ id: mediaData.id }] : [{ url: mediaData.url }]
          }
        ],
        settings: {
          // TikTok-specific: post as draft visible only to the account owner
          privacy_level: 'SELF_ONLY',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false
        }
      }
    ]
  };

  const res = await fetchFn(`${POSTIZ_API}/posts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Post creation failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  console.log(`   ℅ Draft created! Post ID: ${data.id}`);
  return data;
}

// ─── Step 3: Save post ID to meta.json ───────────────────────────────────────
function savePostMeta(postData) {
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  }

  meta.postizPostId = postData.id;
  meta.postedAt     = new Date().toISOString();
  meta.status       = 'draft';
  meta.tiktokVideoId = null; // Will be filled by check-analytics.js once published

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`\n💾 Post ID saved to ${metaPath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const videoSize = fs.statSync(videoPath).size;
    console.log(`\n🎬 Posting RunSound video to TikTok drafts`);
    console.log(`   Artist: ${config.artist.name}`);
    console.log(`   Song:   ${config.song.title}`);
    console.log(`   Video:  ${videoPath} (${(videoSize / 1024 / 1024).toFixed(1)}MB)`);
    console.log(`   Mode:   SELF_ONLY draft (only you can see it)\n`);

    const mediaData = await uploadMedia();
    const postData  = await createPost(mediaData);
    savePostMeta(postData);

    // ─── Publishing instructions ──────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`℅ VIDEO IS IN YOUR TIKTOK DRAFTS`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`\n📱 To publish from TikTok (takes 30 seconds):`);
    console.log(`\n   1. Open TikTok on your phone`);
    console.log(`   2. Tap Inbox → find your new draft`);
    console.log(`   3. Tap "Add sound"`);
    console.log(`   4. Search for: "${config.song.title}" by ${config.artist.name}`);
    console.log(`   5. Start the audio at: ${config.song.hookTimestamp}`);
    console.log(`      (The text on slide 1 should match what's playing)`);
    console.log(`   6. Add hashtags if you want`);
    console.log(`   7. Tap Post!\n`);
    console.log(`After posting, grab the TikTok video URL and run:`);
    console.log(`   npm run analytics`);
    console.log(`   (links the video to Postiz for stats tracking)\n`);

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);

    if (err.message.includes('401') || err.message.includes('403')) {
      console.error(`\n   Check your postiz.apiKey in config.json`);
      console.error(`   Get it from: https://app.postiz.com → Settings → API`);
    }

    if (err.message.includes('integration')) {
      console.error(`\n   Check your postiz.integrationIds.tiktok in config.json`);
      console.error(`   Get it from: https://app.postiz.com → Integrations → TikTok`);
    }

    process.exit(1);
  }
})();
