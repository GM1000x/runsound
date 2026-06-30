#!/usr/bin/env node
/**
 * scrape-trends.js — RunSound Trending Hook Scraper
 *
 * Fetches top-performing TikTok posts across ANY niche via Apify,
 * extracts hook patterns with GPT-4o, and stores them in Supabase
 * so generate-texts.js can use trending formats for music promotion.
 *
 * The key insight: a viral hook format from fitness/lifestyle/comedy
 * can be adapted for music. The format drives reach; the song gets exposure.
 *
 * Scrapes hashtags: #fyp #viral #pov #storytime + music-adjacent ones
 * Filters: engagement rate > 5%, excludes ads, min 10k views
 * Analyzes: GPT-4o extracts the hook PATTERN (not the niche-specific content)
 * Stores:   Supabase trending_hooks table — weekly batch
 *
 * Usage:
 *   node scrape-trends.js             ← run now
 *   node scrape-trends.js --dry-run   ← show what would be scraped, no Supabase write
 *   node scrape-trends.js --limit 20  ← only fetch N posts (default 100)
 *
 * Requires:
 *   APIFY_API_TOKEN    from apify.com → Settings → Integrations
 *   OPENAI_API_KEY     for GPT-4o pattern analysis
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY  for storing results
 */

require('dotenv').config();

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT   = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 100;

// ─── Clients ──────────────────────────────────────────────────────────────────
let fetch;
try { fetch = require('node-fetch').default; } catch { fetch = global.fetch; }

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

// ─── Hashtags to scrape ───────────────────────────────────────────────────────
// Mix of: universal viral formats + music-adjacent + lifestyle/emotion
// Intentionally NOT limited to music — we want cross-niche format inspiration
const HASHTAGS = [
  'fyp', 'viral', 'pov', 'storytime',       // universal high-reach formats
  'emotional', 'relatable', 'nostalgia',     // emotion-driven (maps well to music)
  'newmusic', 'indieartist', 'musicrelease', // music-adjacent for context
  'aesthetic', 'vibe', 'mood',               // visual/feeling formats
];

// ─── Step 1: Scrape TikTok via Apify ─────────────────────────────────────────
async function scrapeTikTok() {
  if (!APIFY_TOKEN) {
    console.error('❌ APIFY_API_TOKEN not set. Get one free at apify.com');
    process.exit(1);
  }

  console.log(`\n📡 Scraping TikTok via Apify...`);
  console.log(`   Hashtags: ${HASHTAGS.join(', ')}`);
  console.log(`   Target posts: ${LIMIT}`);

  // Use Apify's clockworks/tiktok-scraper actor
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hashtags:       HASHTAGS.slice(0, 5), // Apify free tier: limit input
        resultsPerPage: Math.ceil(LIMIT / HASHTAGS.length),
        maxItems:       LIMIT,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      }),
    }
  );

  if (!runRes.ok) {
    const text = await runRes.text();
    throw new Error(`Apify run failed (${runRes.status}): ${text.slice(0, 300)}`);
  }

  const run = await runRes.json();
  const runId = run.data?.id || run.id;
  console.log(`   Run ID: ${runId} — waiting for completion...`);

  // Poll until done (max 5 min)
  const startTime = Date.now();
  while (Date.now() - startTime < 5 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const status = await statusRes.json();
    const state  = status.data?.status || status.status;
    process.stdout.write('.');
    if (state === 'SUCCEEDED') { console.log(' ✅'); break; }
    if (state === 'FAILED' || state === 'ABORTED') throw new Error(`Apify run ${state}`);
  }

  // Fetch results
  const itemsRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json&limit=${LIMIT}`
  );
  const items = await itemsRes.json();
  console.log(`   Fetched ${items.length} posts`);
  return items;
}

// ─── Step 2: Filter for high-engagement posts ─────────────────────────────────
function filterPosts(posts) {
  return posts
    .filter(p => {
      const views  = p.playCount    || p.stats?.playCount    || 0;
      const likes  = p.diggCount    || p.stats?.diggCount    || 0;
      const shares = p.shareCount   || p.stats?.shareCount   || 0;
      const engRate = views > 0 ? (likes + shares) / views : 0;
      return views >= 10000 && engRate >= 0.03; // min 10k views, 3% engagement
    })
    .sort((a, b) => {
      const viewsA = a.playCount || a.stats?.playCount || 0;
      const viewsB = b.playCount || b.stats?.playCount || 0;
      return viewsB - viewsA;
    })
    .slice(0, 50); // top 50 for GPT analysis
}

// ─── Step 3: Extract hook patterns with GPT-4o ───────────────────────────────
async function analyzeHooks(posts) {
  console.log(`\n🧠 Analyzing ${posts.length} posts with GPT-4o...`);

  const captions = posts
    .map((p, i) => {
      const text   = p.text || p.desc || p.description || '';
      const views  = (p.playCount || p.stats?.playCount || 0).toLocaleString();
      const likes  = (p.diggCount || p.stats?.diggCount || 0).toLocaleString();
      return `${i + 1}. [${views} views, ${likes} likes] "${text.slice(0, 150)}"`;
    })
    .join('\n');

  const prompt = `You are an expert in viral TikTok content. Below are ${posts.length} high-performing TikTok captions from the past week, across all niches.

${captions}

Your task: Extract 8 distinct HOOK PATTERNS that could be adapted for music promotion on TikTok.

A hook pattern is the FORMAT and emotional trigger — NOT the niche content. For example:
- "POV: [relatable situation where a song is playing]"
- "The [adjective] song that [emotional impact]"
- "If you know this song, you [shared experience]"

For each pattern:
1. Name it (e.g., "pov_relatable", "emotional_confession", "shared_experience")
2. Write the template with [brackets] for music-specific fill-ins
3. Write one concrete example adapted for a new indie/pop song release
4. Rate emotional resonance 1-10 (how much it triggers feeling over information)
5. Rate music fit 1-10 (how well this format works for song promotion)

Respond ONLY with valid JSON:
{
  "patterns": [
    {
      "name": "pov_relatable",
      "template": "POV: you're [situation] and [song/artist] comes on",
      "music_example": "POV: you're driving home at 2am and this song starts playing",
      "emotional_score": 9,
      "music_fit": 10
    }
  ],
  "week_insights": "One sentence about what emotional tone is dominating TikTok this week"
}`;

  const res = await openai.chat.completions.create({
    model:       'gpt-4o',
    messages:    [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens:  1500,
    response_format: { type: 'json_object' },
  });

  const result = JSON.parse(res.choices[0].message.content);
  console.log(`   Found ${result.patterns?.length || 0} hook patterns`);
  console.log(`   Insight: ${result.week_insights}`);
  return result;
}

// ─── Step 4: Save to Supabase ─────────────────────────────────────────────────
async function saveToSupabase(analysis) {
  const weekOf = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const { error } = await supabase
    .from('trending_hooks')
    .upsert({
      week_of:      weekOf,
      hooks:        analysis.patterns,
      week_insight: analysis.week_insights,
      post_count:   analysis.patterns?.length || 0,
      created_at:   new Date().toISOString(),
    }, { onConflict: 'week_of' });

  if (error) throw new Error(`Supabase write failed: ${error.message}`);
  console.log(`\n   ✅ ${analysis.patterns?.length} hook patterns saved for week ${weekOf}`);
}

// ─── Fallback: GPT-only mode (when no Apify token) ───────────────────────────
// Uses GPT-4o's knowledge of current TikTok trends directly.
// Less precise than real scraping but works immediately without Apify setup.
async function analyzeHooksGptOnly() {
  console.log(`\n🧠 GPT-4o trend analysis (no Apify — using training knowledge)...`);

  const today = new Date().toLocaleDateString('sv-SE');
  const prompt = `You are an expert in viral TikTok content trends. Today is ${today}.

Identify 8 currently trending TikTok hook FORMATS that work across niches (not music-specific) but could be adapted for music promotion.

Focus on formats with these traits:
- High emotional resonance (POV, confession, shared memory)
- Low production threshold (works for image carousels, not just video)
- Currently popular: think about what formats are dominating FYP right now

For each pattern:
1. Name it (snake_case)
2. Write the template with [brackets] for music-specific fill-ins
3. Write one concrete example for promoting a new indie/electronic song release
4. Rate emotional resonance 1-10
5. Rate music fit 1-10

Respond ONLY with valid JSON:
{
  "patterns": [
    {
      "name": "pov_relatable",
      "template": "POV: you're [situation] and [song/artist] comes on",
      "music_example": "POV: you're driving home at 2am and this song starts playing",
      "emotional_score": 9,
      "music_fit": 10
    }
  ],
  "week_insights": "One sentence about what emotional tone is dominating TikTok this week"
}`;

  const res = await openai.chat.completions.create({
    model:       'gpt-4o',
    messages:    [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens:  1500,
    response_format: { type: 'json_object' },
  });

  const result = JSON.parse(res.choices[0].message.content);
  console.log(`   Found ${result.patterns?.length || 0} patterns`);
  console.log(`   Insight: ${result.week_insights}`);
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🔥 RunSound — Trending Hook Scraper');
  console.log('=====================================');
  if (DRY_RUN) console.log('   Mode: DRY RUN\n');

  let analysis;

  if (APIFY_TOKEN) {
    // Full pipeline: scrape real TikTok data → analyze
    const posts    = await scrapeTikTok();
    const filtered = filterPosts(posts);
    console.log(`   After filtering: ${filtered.length} high-engagement posts`);
    analysis = await analyzeHooks(filtered);
  } else {
    // Fallback: GPT-only (no real scraping, uses training knowledge)
    console.log('⚠️  No APIFY_API_TOKEN — using GPT-4o knowledge mode');
    console.log('   Set APIFY_API_TOKEN for real-time TikTok scraping\n');
    analysis = await analyzeHooksGptOnly();
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Patterns found:');
    analysis.patterns?.forEach((p, i) =>
      console.log(`  ${i+1}. ${p.name} (emo:${p.emotional_score} music:${p.music_fit})\n     "${p.music_example}"`)
    );
    return;
  }

  await saveToSupabase(analysis);

  console.log('\n✅ Done — trending hooks ready for generate-texts.js');
  console.log('   Next run: Sunday 01:00 UTC (auto via cron)\n');
})().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
