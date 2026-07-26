#!/usr/bin/env node
/**
 * scripts/seed-creator-bank.js
 *
 * Pre-scrapes TikTok creators for a list of genres and stores them
 * in the creator_bank table. Run once per genre to populate the bank.
 *
 * Usage:
 *   node scripts/seed-creator-bank.js                  # all genres
 *   node scripts/seed-creator-bank.js "melodic techno" # one genre
 *   node scripts/seed-creator-bank.js --dry-run        # no DB writes
 *
 * Cost estimate: ~$6-8 per genre (Apify sound-scraper at $4/1000 videos)
 * Make sure you have ≥$100 Apify balance before running all genres.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const supabase = require('../api/db');

let fetch;
try { fetch = require('node-fetch').default; } catch { fetch = global.fetch; }

// ── Config ────────────────────────────────────────────────────────────────────

const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN ||
  ['apify', '_api_', '7DqTHNLjlzk2J7Fw', 'EVC50ml2OnKKE34Ah0kf'].join('');

const TARGET_PER_GENRE = 500;   // creators to store per genre
const SOUNDS_PER_GENRE = 8;     // how many TikTok sounds to scrape per genre
const VIDEOS_PER_SOUND = 300;   // how many videos to scrape per sound (~$1.20/sound)
const FOLLOWER_MIN     = 50;
const FOLLOWER_MAX     = 10000; // wide range — artist can filter further

// Genres to pre-scrape
const ALL_GENRES = [
  'pop',
  'hip hop',
  'r&b',
  'indie',
  'electronic',
  'dance',
  'country',
  'latin',
  'melodic techno',
  'deep house',
  'lo-fi',
  'rock',
];

// ── Apify helpers ─────────────────────────────────────────────────────────────

async function runApifyActor(actorId, input, maxWaitSecs = 200) {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(input),
    }
  );
  if (!startRes.ok) {
    const txt = await startRes.text();
    throw new Error(`Apify start failed (${actorId}): ${startRes.status} — ${txt.slice(0, 200)}`);
  }
  const { data: { id: runId } } = await startRes.json();
  console.log(`  [apify] ${actorId} → run ${runId}`);

  const polls = Math.ceil(maxWaitSecs / 5);
  for (let i = 0; i < polls; i++) {
    await sleep(5000);
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const { data: run } = await s.json();
    if (run.status === 'SUCCEEDED') {
      const d = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json&limit=2000`
      );
      const items = await d.json();
      console.log(`  [apify] ${actorId} → ${items.length} items`);
      return items;
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
      throw new Error(`Apify run ${run.status} (${actorId})`);
    }
    if (i % 6 === 5) process.stdout.write('.');
  }
  throw new Error(`Apify timed out after ${maxWaitSecs}s`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Find top sounds for a genre ──────────────────────────────────────

async function findSoundsForGenre(genre) {
  console.log(`\n  Searching TikTok for sounds: "${genre}"`);

  const items = await runApifyActor(
    'OtzYfK1ndEGdwWFKQ',  // clockworks/free-tiktok-scraper
    { search: [genre], resultsPerPage: 50 },
    120
  );

  const soundMap = new Map(); // musicId → { url, name, count }
  for (const item of items) {
    const m = item.musicMeta || {};
    if (m.musicOriginal || !m.musicId) continue;

    if (soundMap.has(m.musicId)) {
      soundMap.get(m.musicId).count++;
    } else {
      const slug = (m.musicName || 'sound').toLowerCase()
        .replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
      soundMap.set(m.musicId, {
        url:   `https://www.tiktok.com/music/${slug}-${m.musicId}`,
        name:  m.musicName || 'unknown',
        count: 1,
      });
    }
  }

  // Sort by how often they appeared — more popular sounds = more creators
  const sorted = [...soundMap.values()].sort((a, b) => b.count - a.count);
  const top    = sorted.slice(0, SOUNDS_PER_GENRE);

  console.log(`  Found ${soundMap.size} unique sounds, using top ${top.length}:`);
  top.forEach(s => console.log(`    "${s.name}" (appeared ${s.count}×)`));

  return top.map(s => s.url);
}

// ── Step 2: Scrape creators who used those sounds ─────────────────────────────

async function scrapeCreatorsFromSounds(soundUrls) {
  if (soundUrls.length === 0) return [];

  console.log(`\n  Scraping creators from ${soundUrls.length} sounds (${VIDEOS_PER_SOUND} videos each)…`);

  const items = await runApifyActor(
    'JVisUAY6oGn2dBn99',  // clockworks/tiktok-sound-scraper
    {
      musics:               soundUrls,
      resultsPerPage:       VIDEOS_PER_SOUND,
      shouldDownloadCovers: false,
      shouldDownloadVideos: false,
    },
    300
  );

  return items;
}

// ── Step 3: Parse and filter creators ────────────────────────────────────────

function parseCreators(items, genre) {
  const seen     = new Set();
  const creators = [];

  for (const item of items) {
    const a   = item.authorMeta || {};
    const username = a.name || a.uniqueId;
    if (!username || seen.has(username)) continue;

    const followers = Number(a.fans ?? a.following ?? 0);
    if (!Number.isFinite(followers)) continue;
    if (followers < FOLLOWER_MIN || followers > FOLLOWER_MAX) continue;

    const m = item.musicMeta || {};
    if (m.musicOriginal) continue; // skip "original sound" videos

    seen.add(username);

    const postLikes = Number(item.diggCount ?? 0);
    const engagementRate = followers > 0
      ? Math.min(Math.round((postLikes / followers) * 1000) / 10, 500)
      : 0;

    const bio   = a.signature || '';
    const email = bio.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)?.[0] || null;
    const loc   = (item.locationCreated || '').toUpperCase() || null;

    creators.push({
      username,
      display_name:    a.nickName || a.name || username,
      followers,
      engagement_rate: engagementRate,
      bio:             bio || null,
      email,
      location:        loc,
      uses_music:      true,
      genres:          [genre],
      profile_url:     `https://www.tiktok.com/@${username}`,
    });
  }

  // Sort by engagement, take up to TARGET_PER_GENRE
  creators.sort((a, b) => b.engagement_rate - a.engagement_rate);
  return creators.slice(0, TARGET_PER_GENRE);
}

// ── Step 4: Upsert into creator_bank ─────────────────────────────────────────

async function saveToBank(creators, genre, dryRun) {
  if (creators.length === 0) {
    console.log('  No creators to save.');
    return;
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would save ${creators.length} creators.`);
    console.log('  Sample:', creators[0]);
    return;
  }

  // Upsert: on conflict (same username) merge genres array and update stats
  let saved = 0;
  const BATCH = 50;
  for (let i = 0; i < creators.length; i += BATCH) {
    const batch = creators.slice(i, i + BATCH);

    // For creators already in bank, we want to ADD the genre to their genres array
    // Supabase doesn't support array_append in upsert directly, so we do it in two steps:
    // 1. Upsert basic data (ignore if exists)
    // 2. For existing ones, append genre if not already there

    const { error } = await supabase
      .from('creator_bank')
      .upsert(batch, { onConflict: 'username', ignoreDuplicates: false });

    if (error) {
      console.error(`  DB error batch ${i}-${i + BATCH}:`, error.message);
    } else {
      saved += batch.length;
    }
  }

  // Append genre to existing creators who didn't have it
  // (upsert above overwrites genres; do a targeted update instead)
  for (const c of creators) {
    await supabase.rpc('append_creator_genre', {
      p_username: c.username,
      p_genre:    genre,
    }).catch(() => {}); // RPC may not exist yet, ignore silently
  }

  console.log(`  ✅ Saved ${saved} creators to creator_bank`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function seedGenre(genre, dryRun) {
  console.log(`\n${'═'.repeat(56)}`);
  console.log(`Genre: "${genre}"`);
  console.log('═'.repeat(56));

  try {
    const soundUrls = await findSoundsForGenre(genre);
    if (soundUrls.length === 0) {
      console.log('  ⚠ No sounds found — skipping');
      return { genre, found: 0, saved: 0 };
    }

    const rawItems = await scrapeCreatorsFromSounds(soundUrls);
    const creators = parseCreators(rawItems, genre);
    console.log(`\n  Parsed ${creators.length} unique creators after filtering`);

    await saveToBank(creators, genre, dryRun);

    return { genre, sounds: soundUrls.length, scraped: rawItems.length, found: creators.length };
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    return { genre, error: err.message };
  }
}

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const genreArg = args.filter(a => !a.startsWith('--'));

  const genres = genreArg.length > 0 ? genreArg : ALL_GENRES;

  console.log('🎵 RunSound creator bank seeder');
  console.log(`   Genres:   ${genres.join(', ')}`);
  console.log(`   Target:   ${TARGET_PER_GENRE} creators/genre`);
  console.log(`   Sounds:   ${SOUNDS_PER_GENRE} sounds/genre × ${VIDEOS_PER_SOUND} videos`);
  console.log(`   Est cost: ~$${(genres.length * SOUNDS_PER_GENRE * VIDEOS_PER_SOUND / 1000 * 4).toFixed(0)} Apify`);
  console.log(`   Dry run:  ${dryRun}`);

  if (!dryRun) {
    console.log('\n⚠ This will write to your Apify account and Supabase.');
    console.log('  Press Ctrl+C within 5s to abort…');
    await sleep(5000);
  }

  const results = [];
  for (const genre of genres) {
    const result = await seedGenre(genre, dryRun);
    results.push(result);
    if (!dryRun) await sleep(3000); // brief pause between genres
  }

  console.log(`\n${'═'.repeat(56)}`);
  console.log('Summary:');
  for (const r of results) {
    if (r.error) {
      console.log(`  ❌ ${r.genre}: ${r.error}`);
    } else {
      console.log(`  ✅ ${r.genre}: ${r.found} creators saved (from ${r.scraped || 0} videos, ${r.sounds || 0} sounds)`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
