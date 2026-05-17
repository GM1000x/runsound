#!/usr/bin/env node
/**
 * daily-report.js — RunSound Morning Learning Loop
 *
 * Runs every morning (triggered by scheduler.js after the nightly pipeline).
 * Does four things per active campaign:
 *
 *   1. Fetch TikTok stats from Postiz for all posts in the last 30 days
 *   2. Sync stats into Supabase post_log (views, likes, shares, comments)
 *   3. Pull smart-link click counts from Supabase utm_clicks
 *   4. Run LarryBrain diagnosis — print a daily briefing + write to DB
 *
 * LarryBrain diagnosis (Oliver Henry formula):
 *   High views + High clicks → scale     — keep going, amplify what works
 *   High views + Low clicks  → fix_cta   — reach is good, CTA drives 0 streams
 *   Low views  + High clicks → fix_hook  — hook is weak, link performs when seen
 *   Low views  + Low clicks  → reset     — new direction needed
 *
 * Thresholds (per week):
 *   views  ≥ 5 000  →  "high views"
 *   clicks ≥ 10     →  "high clicks"
 *
 * Usage:
 *   node daily-report.js                          ← all active campaigns from Supabase
 *   node daily-report.js --campaign mbn-summer-love  ← one campaign only
 *   node daily-report.js --days 14               ← look back 14 days (default 7)
 *
 * Output:
 *   - Console summary (piped to logs/ by scheduler.js)
 *   - Supabase post_log stats updated
 *   - reports/<date>.json written (one per day, useful for optimize-strategy.js)
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

let sendDailyReport;
try { ({ sendDailyReport } = require('./api/email')); } catch {}

// ─── Optional dependencies ────────────────────────────────────────────────────
let createClient;
try { ({ createClient } = require('@supabase/supabase-js')); } catch {}

let fetch;
try {
  fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
} catch {
  fetch = global.fetch;
}

// ─── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function getArg(n) { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; }

const CAMPAIGN_FILTER = getArg('campaign') || null;
const DAYS            = parseInt(getArg('days') || '7', 10);

// ─── Config ───────────────────────────────────────────────────────────────────
const POSTIZ_API    = 'https://api.postiz.com/public/v1';
const POSTIZ_KEY    = process.env.POSTIZ_API_KEY;

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// Views/clicks thresholds for LarryBrain diagnosis
const HIGH_VIEWS_THRESHOLD  = parseInt(process.env.HIGH_VIEWS_THRESHOLD  || '5000',  10);
const HIGH_CLICKS_THRESHOLD = parseInt(process.env.HIGH_CLICKS_THRESHOLD || '10', 10);

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── LarryBrain diagnosis ─────────────────────────────────────────────────────
function diagnose(weekViews, weekClicks) {
  const hiV = weekViews  >= HIGH_VIEWS_THRESHOLD;
  const hiC = weekClicks >= HIGH_CLICKS_THRESHOLD;

  if (hiV  && hiC)  return { key: 'scale',    emoji: '🚀', action: 'Scale — keep creating similar content' };
  if (hiV  && !hiC) return { key: 'fix_cta',  emoji: '📢', action: 'Fix CTA — hook works, slide 6 needs a stronger stream push' };
  if (!hiV && hiC)  return { key: 'fix_hook', emoji: '🪝', action: 'Fix hook — CTA works, opening slide needs more stopping power' };
  return               { key: 'reset',   emoji: '🔄', action: 'Full reset — try different images, hook angle, and posting time' };
}

// ─── Postiz: fetch analytics for an integration ───────────────────────────────
async function fetchPostizAnalytics(integrationId) {
  if (!POSTIZ_KEY) {
    log('⚠️  POSTIZ_API_KEY not set — skipping Postiz analytics');
    return [];
  }

  const since = new Date();
  since.setDate(since.getDate() - 30);

  try {
    const url = `${POSTIZ_API}/posts?integrationId=${integrationId}&status=PUBLISHED&limit=50`;
    const res = await (await fetch)(url, {
      headers: {
        'Authorization': `Bearer ${POSTIZ_KEY}`,
        'Content-Type':  'application/json',
      },
    });

    if (!res.ok) {
      log(`⚠️  Postiz API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const posts = data.posts || data.data || data || [];

    // Filter to posts in our lookback window
    return posts.filter(p => {
      const published = p.publishDate || p.createdAt || p.published_at;
      return published && new Date(published) >= since;
    });
  } catch (err) {
    log(`⚠️  Postiz fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Postiz: get stats for a single post ─────────────────────────────────────
async function fetchPostStats(postizPostId) {
  if (!POSTIZ_KEY) return null;

  try {
    const url = `${POSTIZ_API}/posts/${postizPostId}/analytics`;
    const res = await (await fetch)(url, {
      headers: { 'Authorization': `Bearer ${POSTIZ_KEY}` },
    });

    if (!res.ok) return null;
    const data = await res.json();

    // Postiz may return stats directly or nested under .stats / .data
    const stats = data.stats || data.data || data;
    return {
      views:    stats.views     || stats.playCount    || stats.impressions || 0,
      likes:    stats.likes     || stats.likeCount     || 0,
      shares:   stats.shares    || stats.shareCount    || 0,
      comments: stats.comments  || stats.commentCount  || 0,
    };
  } catch {
    return null;
  }
}

// ─── Supabase: update post_log stats ─────────────────────────────────────────
async function syncStatsToSupabase(supabase, postizPostId, stats) {
  if (!supabase || !postizPostId || !stats) return;

  await supabase
    .from('post_log')
    .update({
      views:            stats.views,
      likes:            stats.likes,
      shares:           stats.shares,
      comments:         stats.comments,
      streaming_ctr:    null, // recalculated by learn.js
      stats_updated_at: new Date().toISOString(),
    })
    .eq('tiktok_post_id', postizPostId);
}

// ─── Supabase: update post status to published if it has views ────────────────
async function markPublished(supabase, postizPostId) {
  if (!supabase || !postizPostId) return;

  await supabase
    .from('post_log')
    .update({ status: 'published' })
    .eq('tiktok_post_id', postizPostId)
    .eq('status', 'pending_publish');
}

// ─── Get weekly click count from Supabase ────────────────────────────────────
async function getWeeklyClicks(supabase, campaignId, daysBack = 7) {
  if (!supabase || !campaignId) return { count: 0, platforms: {} };

  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const { data, error } = await supabase
    .from('utm_clicks')
    .select('platform')
    .eq('campaign_id', campaignId)
    .gte('clicked_at', since.toISOString());

  if (error || !data) return { count: 0, platforms: {} };

  const platforms = {};
  for (const row of data) {
    platforms[row.platform || 'unknown'] = (platforms[row.platform || 'unknown'] || 0) + 1;
  }

  return { count: data.length, platforms };
}

// ─── Load active campaigns from Supabase ─────────────────────────────────────
async function loadCampaigns(supabase) {
  let query = supabase
    .from('campaigns')
    .select(`
      id, slug, artist_name, song_title,
      config,
      artists ( plan )
    `)
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (CAMPAIGN_FILTER) {
    query = query.eq('slug', CAMPAIGN_FILTER);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ─── Analyze one campaign ─────────────────────────────────────────────────────
async function analyzeCampaign(supabase, campaign) {
  const { id: campaignId, slug, artist_name, song_title, config = {} } = campaign;
  const integrationId = config.postiz?.integrationIds?.tiktok ||
                        config.posting?.postizIntegrationId  || null;

  log(`\n${'─'.repeat(55)}`);
  log(`🎵 ${artist_name} — ${song_title}`);
  log(`   slug: ${slug}`);
  log(`${'─'.repeat(55)}`);

  // ── 1. Fetch Postiz analytics ──────────────────────────────────────────────
  let postizPosts = [];
  if (integrationId) {
    log('📡 Fetching Postiz analytics...');
    postizPosts = await fetchPostizAnalytics(integrationId);
    log(`   Found ${postizPosts.length} published post(s) on Postiz`);
  } else {
    log('⚠️  No Postiz integration ID — skipping platform analytics');
  }

  // ── 2. Get all post_log entries for this campaign ─────────────────────────
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: dbPosts = [] } = await supabase
    .from('post_log')
    .select('id, post_uid, tiktok_post_id, views, streaming_clicks, variant, hook_line, posted_at')
    .eq('campaign_id', campaignId)
    .gte('posted_at', since.toISOString())
    .order('posted_at', { ascending: false });

  log(`   ${dbPosts.length} post(s) in database`);

  // ── 3. Sync stats from Postiz → Supabase ─────────────────────────────────
  let statsUpdated = 0;

  for (const post of dbPosts) {
    if (!post.tiktok_post_id) continue;

    // Try to get stats from Postiz analytics response first
    const postizPost = postizPosts.find(
      p => p.id === post.tiktok_post_id || p.postId === post.tiktok_post_id
    );

    let stats = null;
    if (postizPost?.statistics || postizPost?.stats) {
      const raw = postizPost.statistics || postizPost.stats;
      stats = {
        views:    raw.views    || raw.playCount    || raw.impressions || 0,
        likes:    raw.likes    || raw.likeCount     || 0,
        shares:   raw.shares   || raw.shareCount    || 0,
        comments: raw.comments || raw.commentCount  || 0,
      };
    } else {
      // Fall back to fetching stats individually
      stats = await fetchPostStats(post.tiktok_post_id);
    }

    if (stats && stats.views > 0) {
      await syncStatsToSupabase(supabase, post.tiktok_post_id, stats);
      if (stats.views > 0) await markPublished(supabase, post.tiktok_post_id);
      statsUpdated++;
    }
  }

  if (statsUpdated > 0) {
    log(`   ✅ Updated stats for ${statsUpdated} post(s)`);
  }

  // ── 4. Compute weekly summary ─────────────────────────────────────────────
  const now     = new Date();
  const weekAgo = new Date(now - DAYS * 24 * 60 * 60 * 1000);

  const weekPosts = dbPosts.filter(p => new Date(p.posted_at) >= weekAgo);
  const weekViews = weekPosts.reduce((s, p) => s + (p.views || 0), 0);

  const { count: weekClicks, platforms } = await getWeeklyClicks(supabase, campaignId, DAYS);

  // ── 5. LarryBrain diagnosis ───────────────────────────────────────────────
  const dx = diagnose(weekViews, weekClicks);

  log(`\n📊 Last ${DAYS} days:`);
  log(`   Views:   ${weekViews.toLocaleString()}`);
  log(`   Clicks:  ${weekClicks}`);
  if (Object.keys(platforms).length) {
    const pStr = Object.entries(platforms)
      .sort(([, a], [, b]) => b - a)
      .map(([p, n]) => `${p}:${n}`)
      .join(', ');
    log(`   Platforms: ${pStr}`);
  }
  log(`   ${dx.emoji} ${dx.action}`);

  // ── 6. Variant breakdown ──────────────────────────────────────────────────
  const variantMap = {};
  for (const post of weekPosts) {
    if ((post.views || 0) === 0) continue;
    const v = post.variant || 'A';
    if (!variantMap[v]) variantMap[v] = { views: 0, clicks: 0, posts: 0 };
    variantMap[v].views  += post.views || 0;
    variantMap[v].clicks += post.streaming_clicks || 0;
    variantMap[v].posts++;
  }

  if (Object.keys(variantMap).length > 1) {
    log('\n   🧪 Variant performance:');
    for (const [v, data] of Object.entries(variantMap).sort(
      ([, a], [, b]) => (b.views > 0 ? b.clicks / b.views : 0) - (a.views > 0 ? a.clicks / a.views : 0)
    )) {
      const ctr = data.views > 0 ? ((data.clicks / data.views) * 100).toFixed(3) : '0.000';
      log(`   Variant ${v}: ${data.posts} post(s), ${data.views.toLocaleString()} views, ${data.clicks} clicks (CTR ${ctr}%)`);
    }
  }

  // ── 7. Send weekly summary email every Monday ─────────────────────────────
  const isMonday = new Date().getDay() === 1;
  if (isMonday && sendDailyReport) {
    const { data: artistRow } = await supabase
      .from('artists').select('email').eq('id', campaign.artist_id).single();

    if (artistRow?.email) {
      const BASE = process.env.BASE_URL || 'https://runsound.fm';
      const { data: camp } = await supabase
        .from('campaigns').select('dash_token').eq('id', campaignId).single();

      const dashboardUrl = camp?.dash_token
        ? `${BASE}/dashboard.html?campaign_id=${campaignId}&token=${camp.dash_token}`
        : `${BASE}/dashboard.html?campaign_id=${campaignId}`;

      await sendDailyReport({
        artistName: artist_name, email: artistRow.email,
        weekViews, weekClicks, diagnosis: dx.key, dashboardUrl,
      });
      log('📧 Weekly summary email sent');
    }
  }

  // ── 8. Return summary for the report file ─────────────────────────────────
  return {
    campaignId,
    slug,
    artistName:  artist_name,
    songTitle:   song_title,
    weekViews,
    weekClicks,
    platforms,
    diagnosis:   dx,
    variants:    variantMap,
    statsUpdated,
    postsAnalyzed: weekPosts.length,
    reportedAt:  new Date().toISOString(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  log(`\n${'═'.repeat(55)}`);
  log('☀️  RunSound — Daily Learning Loop');
  log(`   ${new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ || 'UTC' })}`);
  log(`   Lookback: ${DAYS} day(s)`);
  log(`${'═'.repeat(55)}`);

  // ── Connect to Supabase ───────────────────────────────────────────────────
  if (!createClient) {
    log('❌ @supabase/supabase-js not installed — run: npm install @supabase/supabase-js');
    process.exit(1);
  }
  if (!SB_URL || !SB_KEY) {
    log('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env');
    process.exit(1);
  }

  const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  // ── Load campaigns ────────────────────────────────────────────────────────
  let campaigns;
  try {
    campaigns = await loadCampaigns(supabase);
  } catch (err) {
    log(`❌ Failed to load campaigns: ${err.message}`);
    process.exit(1);
  }

  if (!campaigns.length) {
    log('ℹ️  No active campaigns found');
    process.exit(0);
  }

  log(`📋 ${campaigns.length} active campaign(s)\n`);

  // ── Analyze each campaign ─────────────────────────────────────────────────
  const summaries = [];
  for (const campaign of campaigns) {
    try {
      const summary = await analyzeCampaign(supabase, campaign);
      summaries.push(summary);
    } catch (err) {
      log(`❌ Error analyzing ${campaign.slug}: ${err.message}`);
      summaries.push({ slug: campaign.slug, error: err.message });
    }
  }

  // ── Write daily report JSON ───────────────────────────────────────────────
  const reportsDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const today      = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `${today}.json`);

  const report = {
    generatedAt: new Date().toISOString(),
    lookbackDays: DAYS,
    campaigns: summaries,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // ── Overall summary ───────────────────────────────────────────────────────
  const totalViews  = summaries.reduce((s, c) => s + (c.weekViews  || 0), 0);
  const totalClicks = summaries.reduce((s, c) => s + (c.weekClicks || 0), 0);

  log(`\n${'═'.repeat(55)}`);
  log('📋 DAILY SUMMARY');
  log(`${'═'.repeat(55)}`);
  log(`   Total views  (${DAYS}d):  ${totalViews.toLocaleString()}`);
  log(`   Total clicks (${DAYS}d):  ${totalClicks}`);
  log(`   Report saved: ${reportPath}`);
  log('');
  log('   Next → run "npm run optimize" to update strategy\n');

})().catch(err => {
  console.error(`[daily-report] Fatal: ${err.message}`);
  process.exit(1);
});
