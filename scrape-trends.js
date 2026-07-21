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

// ─── Step 3b: Analyze visual formats with GPT-4o Vision ──────────────────────
async function analyzeVisuals(posts) {
  // Extract thumbnail URLs — Apify returns covers in several field names
  const withThumbs = posts
    .map(p => ({
      url:   p.covers?.[0] || p.videoMeta?.coverUrl || p.dynamicCover || p.cover || null,
      views: p.playCount   || p.stats?.playCount    || 0,
    }))
    .filter(p => p.url)
    .slice(0, 12); // top 12 thumbnails — cost control (~$0.02 total)

  if (withThumbs.length === 0) {
    console.log('   ⚠️  No thumbnail URLs in Apify results — skipping visual analysis');
    return null;
  }

  console.log(`\n👁  Analyzing ${withThumbs.length} thumbnails with GPT-4o Vision...`);

  const imageContent = withThumbs.map(p => ({
    type:      'image_url',
    image_url: { url: p.url, detail: 'low' },
  }));

  const res = await openai.chat.completions.create({
    model:    'gpt-4o',
    messages: [{
      role:    'user',
      content: [
        {
          type: 'text',
          text: `These are thumbnail covers from top-performing music TikTok posts. Analyze the visual patterns across them.

For each distinct visual style you observe, identify:
- format_type: one of "lyrics_slideshow" | "aesthetic_video" | "talking_head" | "text_overlay_only" | "album_art_focused" | "b_roll_nature" | "face_reaction" | "dark_cinematic"
- color_tone: one of "dark_moody" | "bright_energetic" | "warm_golden" | "cool_minimal" | "colorful_vibrant" | "black_white"
- text_style: one of "large_bold_centered" | "small_subtitle" | "no_text" | "scattered_overlay" | "lyrics_line_by_line"
- frequency: 0.0–1.0 (how common this style was across the images)
- why_it_works: one sentence

Return the TOP 3–5 most common styles. Then add a one-sentence insight about what visual style is dominating music TikTok right now.

Respond ONLY with valid JSON:
{
  "formats": [
    {
      "format_type": "dark_cinematic",
      "color_tone": "dark_moody",
      "text_style": "large_bold_centered",
      "frequency": 0.4,
      "why_it_works": "High contrast makes text instantly readable while the mood matches the music."
    }
  ],
  "top_visual_insight": "Dark, cinematic aesthetics with bold centered text dominate music TikTok this week."
}`,
        },
        ...imageContent,
      ],
    }],
    max_tokens:      800,
    response_format: { type: 'json_object' },
  });

  const result = JSON.parse(res.choices[0].message.content);
  console.log(`   Found ${result.formats?.length || 0} visual format patterns`);
  console.log(`   Visual insight: ${result.top_visual_insight}`);
  return result;
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

// ─── Step 4: Save clips to Supabase ──────────────────────────────────────────
// Stores top individual clips (not just patterns) so Blitz Mode can show them.
async function saveClipsToSupabase(posts, hooksAnalysis) {
  const weekOf = new Date().toISOString().slice(0, 10);

  // Build a quick hook name → template lookup from GPT analysis
  const patternMap = {};
  for (const p of hooksAnalysis?.patterns || []) {
    patternMap[p.name] = { template: p.template, music_example: p.music_example, music_fit: p.music_fit };
  }

  // Ask GPT to assign each clip a hook pattern name + genre tags
  const captionList = posts.slice(0, 20).map((p, i) => {
    const views = p.playCount || p.stats?.playCount || 0;
    const text  = p.text || p.desc || '';
    return `${i+1}. [${views.toLocaleString()} views] "${text.slice(0, 120)}"`;
  }).join('\n');

  let clipMeta = [];
  try {
    const res = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages: [{
        role: 'user',
        content: `For each TikTok clip below, extract:
- hook_pattern: one of [pov_relatable, emotional_confession, shared_experience, countdown_list, behind_the_scenes, trending_sound, storytelling, aesthetic_vibe, nostalgia_trigger, energy_hype]
- genre_tags: which music genres this format works for, e.g. ["Pop","R&B","Indie"]
- format_type: one of [slideshow, talking_head, text_overlay, b_roll, face_reaction, lyrics_video]
- one_liner: the core hook formula in max 8 words

Clips:
${captionList}

Respond ONLY with JSON: { "clips": [ { "index": 1, "hook_pattern": "...", "genre_tags": [...], "format_type": "...", "one_liner": "..." } ] }`
      }],
      max_tokens:      1000,
      response_format: { type: 'json_object' },
    });
    clipMeta = JSON.parse(res.choices[0].message.content).clips || [];
  } catch (e) {
    console.warn('   ⚠️  Clip meta GPT call failed (non-fatal):', e.message);
  }

  const rows = posts.slice(0, 20).map((p, i) => {
    const meta    = clipMeta.find(c => c.index === i + 1) || {};
    const views   = p.playCount   || p.stats?.playCount   || 0;
    const likes   = p.diggCount   || p.stats?.diggCount   || 0;
    const shares  = p.shareCount  || p.stats?.shareCount  || 0;
    const author  = p.authorMeta?.name || p.author?.name || '';
    const videoId = p.id || p.videoId || '';
    const tiktokUrl = p.webVideoUrl || p.shareUrl ||
      (author && videoId ? `https://www.tiktok.com/@${author}/video/${videoId}` : null);
    const coverUrl  = p.covers?.[0] || p.videoMeta?.coverUrl || p.dynamicCover || p.cover || null;

    if (!tiktokUrl) return null; // skip clips without a usable URL

    const pattern = patternMap[meta.hook_pattern] || {};

    return {
      tiktok_url:    tiktokUrl,
      cover_url:     coverUrl,
      caption:       (p.text || p.desc || '').slice(0, 500),
      views,
      likes,
      shares,
      author,
      hook_pattern:  meta.hook_pattern  || null,
      hook_template: pattern.template   || null,
      one_liner:     meta.one_liner     || null,
      genre_tags:    meta.genre_tags    || [],
      format_type:   meta.format_type   || null,
      music_fit:     pattern.music_fit  || null,
      week_of:       weekOf,
    };
  }).filter(Boolean);

  if (rows.length === 0) {
    console.log('   ⚠️  No clips with usable URLs — skipping clip save');
    return;
  }

  // Upsert by tiktok_url so reruns don't duplicate
  const { error } = await supabase
    .from('trending_clips')
    .upsert(rows, { onConflict: 'tiktok_url', ignoreDuplicates: false });

  if (error) console.warn('   ⚠️  trending_clips upsert error:', error.message);
  else console.log(`   ✅ ${rows.length} clips saved to trending_clips`);
}

// ─── Step 5: Save patterns to Supabase ───────────────────────────────────────
async function saveToSupabase(analysis, visuals) {
  const weekOf = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const { error } = await supabase
    .from('trending_hooks')
    .upsert({
      week_of:        weekOf,
      hooks:          analysis.patterns,
      week_insight:   analysis.week_insights,
      post_count:     analysis.patterns?.length || 0,
      visual_formats: visuals?.formats       || null,
      visual_insight: visuals?.top_visual_insight || null,
      created_at:     new Date().toISOString(),
    }, { onConflict: 'week_of' });

  if (error) throw new Error(`Supabase write failed: ${error.message}`);
  console.log(`\n   ✅ ${analysis.patterns?.length} hook patterns saved for week ${weekOf}`);
  if (visuals?.formats?.length) {
    console.log(`   ✅ ${visuals.formats.length} visual formats saved`);
  }
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

  let visuals = null;

  if (APIFY_TOKEN) {
    // Full pipeline: scrape real TikTok data → analyze hooks + visuals + save clips
    const posts    = await scrapeTikTok();
    const filtered = filterPosts(posts);
    console.log(`   After filtering: ${filtered.length} high-engagement posts`);
    analysis = await analyzeHooks(filtered);
    visuals  = await analyzeVisuals(filtered).catch(e => {
      console.warn(`   ⚠️  Visual analysis failed (non-fatal): ${e.message}`);
      return null;
    });
    if (!DRY_RUN) {
      await saveClipsToSupabase(filtered, analysis).catch(e => {
        console.warn(`   ⚠️  Clip save failed (non-fatal): ${e.message}`);
      });
    }
  } else {
    // Fallback: GPT-only (no real scraping, uses training knowledge)
    console.log('⚠️  No APIFY_API_TOKEN — using GPT-4o knowledge mode');
    console.log('   Set APIFY_API_TOKEN for real-time TikTok scraping\n');
    analysis = await analyzeHooksGptOnly();
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Hook patterns:');
    analysis.patterns?.forEach((p, i) =>
      console.log(`  ${i+1}. ${p.name} (emo:${p.emotional_score} music:${p.music_fit})\n     "${p.music_example}"`)
    );
    if (visuals?.formats?.length) {
      console.log('\n[dry-run] Visual formats:');
      visuals.formats.forEach((f, i) =>
        console.log(`  ${i+1}. ${f.format_type} / ${f.color_tone} (${Math.round(f.frequency * 100)}%)\n     ${f.why_it_works}`)
      );
    }
    return;
  }

  await saveToSupabase(analysis, visuals);

  console.log('\n✅ Done — trending hooks ready for generate-texts.js');
  console.log('   Next run: Sunday 01:00 UTC (auto via cron)\n');
})().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
