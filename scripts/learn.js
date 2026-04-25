#!/usr/bin/env node
/**
 * learn.js — RunSound Feedback Loop Engine
 *
 * Connects what we post to what actually drives streams.
 *
 * For each published post it joins:
 *   - TikTok stats (views, likes, shares) from Postiz / cached meta.json
 *   - Streaming clicks (Spotify / Apple / etc.) from Supabase UTM data
 *
 * Computes streamingCTR = streaming clicks / views per post,
 * ranks patterns by what actually converts, and writes
 * learning-history.json for optimize-strategy.js to consume.
 *
 * Usage:
 *   node scripts/learn.js --config runsound-marketing/config.json
 *   node scripts/learn.js --config runsound-marketing/config.json --days 60
 *
 * Output: runsound-marketing/learning-history.json
 */

const fs   = require('fs');
const path = require('path');

let createClient;
try { ({ createClient } = require('@supabase/supabase-js')); } catch {}

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const configPath  = getArg('config') || 'runsound-marketing/config.json';
const days        = parseInt(getArg('days') || '30', 10);
const minAgeHours = parseInt(getArg('min-age') || '24', 10);

if (!fs.existsSync(configPath)) {
  console.error(`❌ Config not found: ${configPath}`);
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);

// ─── Resolve Supabase credentials ─────────────────────────────────────────────
const rawUrl = config.tracking?.supabaseUrl || '';
const rawKey = config.tracking?.supabaseKey || '';
const supabaseUrl = rawUrl.startsWith('http')
  ? rawUrl
  : process.env[rawUrl] || process.env.SUPABASE_URL;
const supabaseKey = rawKey.startsWith('eyJ')
  ? rawKey
  : process.env[rawKey] || process.env.SUPABASE_SERVICE_KEY;

// ─── Step 1: Find all post meta.json files ────────────────────────────────────
function loadAllPostMetas() {
  const postsDir = path.join(projectDir, 'posts');
  if (!fs.existsSync(postsDir)) return [];

  const cutoffMs  = Date.now() - days * 24 * 60 * 60 * 1000;
  const minAgeMs  = minAgeHours * 60 * 60 * 1000;
  const metas     = [];

  for (const entry of fs.readdirSync(postsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(postsDir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;

    try {
      const meta    = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!meta.postedAt) continue;

      const postedMs = new Date(meta.postedAt).getTime();
      if (postedMs < cutoffMs) continue;           // too old
      if (Date.now() - postedMs < minAgeMs) continue; // too new — no data yet

      metas.push({ ...meta, metaPath, postDir: path.join(postsDir, entry.name) });
    } catch { /* skip malformed */ }
  }

  return metas.sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt));
}

// ─── Step 2: Pull streaming clicks from Supabase per post ────────────────────
async function getClicksForPosts(metas) {
  if (!supabaseUrl || !supabaseKey) {
    console.log('⚠️  Supabase not configured — streaming clicks will show as 0');
    return {};
  }
  if (!createClient) {
    console.log('⚠️  @supabase/supabase-js not installed — skipping click data');
    return {};
  }

  const supabase  = createClient(supabaseUrl, supabaseKey);
  const campaigns = metas.map(m => m.postUid || m.utmCampaign).filter(Boolean);
  if (!campaigns.length) return {};

  try {
    const { data, error } = await supabase
      .from('utm_clicks')
      .select('campaign, platform, clicked_at')
      .in('campaign', campaigns);

    if (error) throw error;

    const clicksByPost = {};
    for (const row of (data || [])) {
      if (!clicksByPost[row.campaign]) {
        clicksByPost[row.campaign] = { total: 0, byPlatform: {} };
      }
      clicksByPost[row.campaign].total++;
      clicksByPost[row.campaign].byPlatform[row.platform] =
        (clicksByPost[row.campaign].byPlatform[row.platform] || 0) + 1;
    }
    return clicksByPost;
  } catch (err) {
    console.log(`⚠️  Supabase query failed: ${err.message}`);
    return {};
  }
}

// ─── Step 3: Get TikTok stats for a post ─────────────────────────────────────
// Priority: stats already cached in meta.json → reports/ folder
function getTikTokStats(meta) {
  if (meta.stats?.views != null) return meta.stats;

  const reportsDir = path.join(projectDir, 'reports');
  if (!fs.existsSync(reportsDir) || !meta.postizPostId) return null;

  for (const file of fs.readdirSync(reportsDir).sort().reverse()) {
    if (!file.endsWith('.json')) continue;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8'));
      const match  = (report.posts || []).find(p => p.postId === meta.postizPostId);
      if (match) return match;
    } catch { /* skip */ }
  }
  return null;
}

// ─── Step 4: Compute per-post performance metrics ────────────────────────────
function computeMetrics(stats, clicks) {
  const views    = stats?.views    || 0;
  const likes    = stats?.likes    || 0;
  const shares   = stats?.shares   || 0;
  const comments = stats?.comments || 0;
  const streaming = clicks?.total  || 0;

  // streamingCTR is the primary signal: streams = revenue, views = vanity
  const streamingCTR    = views > 0 ? streaming / views : 0;
  const engagementRate  = views > 0 ? (likes + shares + comments) / views : 0;

  // Composite score: streaming clicks weighted 5× over general engagement
  const performanceScore = (streamingCTR * 500) + (engagementRate * 100);

  return {
    views,
    likes,
    shares,
    comments,
    streamingClicks:   streaming,
    streamingCTR:      parseFloat(streamingCTR.toFixed(6)),
    engagementRate:    parseFloat(engagementRate.toFixed(4)),
    performanceScore:  parseFloat(performanceScore.toFixed(2)),
    clicksByPlatform:  clicks?.byPlatform || {},
  };
}

// ─── Step 5: Extract creative signals from each post ─────────────────────────
function extractSignals(meta) {
  const promptsPath = path.join(meta.postDir, 'prompts-used.json');
  let promptsUsed   = null;
  if (fs.existsSync(promptsPath)) {
    try { promptsUsed = JSON.parse(fs.readFileSync(promptsPath, 'utf8')); } catch {}
  }

  const postedDate  = new Date(meta.postedAt);
  const hourBucket  =
    postedDate.getUTCHours() < 6  ? 'night'     :
    postedDate.getUTCHours() < 12 ? 'morning'   :
    postedDate.getUTCHours() < 18 ? 'afternoon' : 'evening';

  return {
    variant:          meta.variant || 'A',
    hookLine:         meta.hookLine         || promptsUsed?.strategy?.hookLine    || null,
    hookAngle:        meta.hookAngle        || promptsUsed?.strategy?.hookAngle   || null,
    visualDirection:  meta.visualDirection  || promptsUsed?.strategy?.visualDirection || null,
    cta:              meta.cta              || promptsUsed?.strategy?.cta         || null,
    dayOfWeek:        postedDate.toLocaleDateString('en-US', { weekday: 'short' }),
    hourOfDay:        postedDate.getUTCHours(),
    hourBucket,
    model:            meta.model    || 'unknown',
    diagnosis:        meta.diagnosis || null,
  };
}

// ─── Step 6: Identify patterns across posts ───────────────────────────────────
function findPatterns(enriched) {
  if (enriched.length < 2) {
    return {
      note: 'Need ≥2 posts with data for pattern analysis',
      insufficient: true,
    };
  }

  const byVariant   = {};
  const byHookLine  = {};
  const byDay       = {};
  const byHourBucket = {};

  for (const { metrics, signals } of enriched) {
    // Skip posts with no TikTok views — no signal yet
    if (metrics.views === 0) continue;

    const acc = (map, key) => {
      if (!map[key]) map[key] = { posts: 0, totalCTR: 0, totalScore: 0 };
      map[key].posts++;
      map[key].totalCTR   += metrics.streamingCTR;
      map[key].totalScore += metrics.performanceScore;
    };

    if (signals.variant)    acc(byVariant,    signals.variant);
    if (signals.hookLine)   acc(byHookLine,   signals.hookLine.slice(0, 80));
    if (signals.dayOfWeek)  acc(byDay,        signals.dayOfWeek);
    if (signals.hourBucket) acc(byHourBucket, signals.hourBucket);
  }

  const rank = (map, keyName, extraFn) =>
    Object.entries(map)
      .map(([k, v]) => ({
        [keyName]: k,
        posts:    v.posts,
        avgCTR:   parseFloat((v.totalCTR   / v.posts).toFixed(6)),
        avgScore: parseFloat((v.totalScore / v.posts).toFixed(2)),
        ...(extraFn ? extraFn(k) : {}),
      }))
      .sort((a, b) => b.avgCTR - a.avgCTR);

  const variantRanking  = rank(byVariant,    'variant');
  const hookLineRanking = rank(byHookLine,   'hookLine');
  const dayRanking      = rank(byDay,        'dayOfWeek');
  const hourRanking     = rank(byHourBucket, 'hourBucket');

  return {
    bestVariant:     variantRanking[0]?.variant     || 'A',
    bestHookLine:    hookLineRanking[0]?.hookLine   || null,
    bestDayOfWeek:   dayRanking[0]?.dayOfWeek       || null,
    bestTimeBucket:  hourRanking[0]?.hourBucket     || null,
    variantRanking,
    topHookLines:    hookLineRanking.slice(0, 5),
    dayRanking,
    hourRanking,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🧠 RunSound — Learning Engine');
  console.log('================================');
  console.log(`📂 Config:  ${configPath}`);
  console.log(`📅 Window:  last ${days} days  (posts ≥${minAgeHours}h old)\n`);

  // 1. Find posts
  const metas = loadAllPostMetas();
  console.log(`📬 Found ${metas.length} eligible post(s)`);

  if (!metas.length) {
    console.log('\nℹ️  Nothing to analyze yet — post some content first!\n');
    process.exit(0);
  }

  // 2. Streaming clicks from Supabase (batched)
  console.log('🔗 Fetching streaming clicks from Supabase...');
  const clicksMap     = await getClicksForPosts(metas);
  const totalTracked  = Object.values(clicksMap).reduce((s, c) => s + c.total, 0);
  console.log(`   ✅ ${totalTracked} streaming click(s) tracked\n`);

  // 3. Enrich each post
  console.log('📊 Computing per-post metrics:');
  const enriched = [];

  for (const meta of metas) {
    const stats   = getTikTokStats(meta);
    const postUid = meta.postUid || meta.utmCampaign;
    const clicks  = postUid ? clicksMap[postUid] : null;
    const metrics = computeMetrics(stats, clicks);
    const signals = extractSignals(meta);

    enriched.push({
      postId:   meta.postizPostId || null,
      postUid:  meta.postUid      || null,
      postedAt: meta.postedAt,
      song:     meta.song,
      metrics,
      signals,
      hasStats: stats !== null,
    });

    const ctrPct   = (metrics.streamingCTR * 100).toFixed(3);
    const statIcon = stats ? '✅' : '⏳';
    console.log(
      `   ${statIcon} ${meta.postedAt?.slice(0, 10)} ` +
      `[${signals.variant}] ` +
      `views:${String(metrics.views).padStart(6)} ` +
      `streams:${String(metrics.streamingClicks).padStart(4)} ` +
      `CTR:${ctrPct}%`
    );
  }

  // 4. Pattern analysis
  console.log('\n🔍 Identifying patterns...');
  const patterns = findPatterns(enriched);

  if (!patterns.insufficient) {
    console.log(`   🏆 Best variant:   ${patterns.bestVariant}`);
    if (patterns.bestHookLine)
      console.log(`   🎯 Best hook:      "${patterns.bestHookLine.slice(0, 60)}"`);
    if (patterns.bestDayOfWeek)
      console.log(`   📅 Best day:       ${patterns.bestDayOfWeek}`);
    if (patterns.bestTimeBucket)
      console.log(`   ⏰ Best time slot: ${patterns.bestTimeBucket}`);
  } else {
    console.log(`   ℹ️  ${patterns.note}`);
  }

  // 5. Build and save learning-history.json
  const postsWithViews = enriched.filter(p => p.metrics.views > 0);
  const avgCTR = postsWithViews.length
    ? postsWithViews.reduce((s, p) => s + p.metrics.streamingCTR, 0) / postsWithViews.length
    : 0;

  const history = {
    generatedAt:    new Date().toISOString(),
    artist:         config.artist?.name,
    song:           config.song?.title,
    postsAnalyzed:  enriched.length,
    postsWithStats: postsWithViews.length,
    daysBack:       days,
    summary: {
      totalViews:           enriched.reduce((s, p) => s + p.metrics.views, 0),
      totalStreamingClicks: enriched.reduce((s, p) => s + p.metrics.streamingClicks, 0),
      avgStreamingCTR:      parseFloat(avgCTR.toFixed(6)),
      avgPerformanceScore:  parseFloat(
        (enriched.reduce((s, p) => s + p.metrics.performanceScore, 0) / enriched.length).toFixed(2)
      ),
    },
    patterns,
    topPosts: [...enriched]
      .sort((a, b) => b.metrics.performanceScore - a.metrics.performanceScore)
      .slice(0, 5),
    allPosts: enriched,
  };

  const outputPath = path.join(projectDir, 'learning-history.json');
  fs.writeFileSync(outputPath, JSON.stringify(history, null, 2));

  console.log(`\n✅ Saved: ${outputPath}`);
  console.log(`\nNext → npm run optimize  (generates smarter strategy.json)\n`);
})();
