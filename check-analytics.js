#!/usr/bin/env node
/**
 * check-analytics.js — Fetch TikTok stats from Postiz
 *
 * Reads recent post meta.json files, fetches current view/like/share counts
 * from Postiz for each post, and writes the stats back into meta.json.
 * This lets learn.js compute streamingCTR from real TikTok performance data.
 *
 * Called as step 1 of the nightly pipeline — before learn.js and optimize.js.
 *
 * BANK UPDATES:
 *   After syncing streaming CTR for a post, this script also updates:
 *   - image_bank: avg_ctr for all images used in the post (via post_log.image_bank_ids)
 *   - hook_bank:  avg_ctr for the archetype+genre_family combo used in the post
 *   This builds up the cross-artist performance data that lets new artists
 *   inherit proven content from day one.
 *
 * Usage:
 *   node check-analytics.js --config runsound-marketing/config.json
 *   node check-analytics.js --config runsound-marketing/config.json --days 7
 *
 * Output:
 *   - Updates stats.views/likes/shares in each post's meta.json
 *   - Writes runsound-marketing/analytics/latest.json (summary for optimize-strategy.js)
 *   - Updates image_bank + hook_bank performance in Supabase
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

let fetchFn;
try { fetchFn = require('node-fetch').default; } catch {
  try { fetchFn = require('node-fetch'); } catch { fetchFn = global.fetch; }
}

// ─── Supabase client (optional — gracefully skipped if not configured) ────────
let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
} catch { /* supabase not installed — streaming_ctr won't be updated */ }

// ─── Bank utils (optional — gracefully skipped if not present) ────────────────
let bank = null;
try { bank = require('./bank-utils'); } catch { /* bank-utils not present */ }

// ─── Genre family helper (mirrors generate-texts.js) ─────────────────────────
function deriveGenreFamily(cfg) {
  const g = (cfg.song?.genre  || cfg.artist?.genre || '').toLowerCase();
  const m = (cfg.song?.mood   || '').toLowerCase();
  if (/house|techno|edm|dance|electronic|trance|club|disco|drum|bass/.test(g + ' ' + m)) return 'dance';
  if (/hip.hop|rap|trap|drill/.test(g + ' ' + m))  return 'hiphop';
  if (/r.b|soul|neo.soul/.test(g + ' ' + m))       return 'rnb';
  if (/country|folk|bluegrass/.test(g + ' ' + m))  return 'country';
  return 'pop';
}

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; }

const configPath = getArg('config') || 'runsound-marketing/config.json';
const days       = parseInt(getArg('days') || '7', 10);

if (!fs.existsSync(configPath)) {
  console.error(`❌ Config not found: ${configPath}`);
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);

// ─── Resolve API keys ─────────────────────────────────────────────────────────
const rawKey = config.postiz?.apiKey || 'POSTIZ_API_KEY';
const POSTIZ_KEY = rawKey.startsWith('ey') || rawKey.length > 20
  ? rawKey
  : (process.env[rawKey] || process.env.POSTIZ_API_KEY);

const INTEGRATION_ID = config.postiz?.integrationIds?.tiktok ||
                       config.posting?.postizIntegrationId || null;

const POSTIZ_API = 'https://api.postiz.com/public/v1';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[analytics] ${msg}`); }

/** Find all post meta.json files within the lookback window */
function findRecentMetas() {
  const postsDir  = path.join(projectDir, 'posts');
  if (!fs.existsSync(postsDir)) return [];

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const metas    = [];

  for (const entry of fs.readdirSync(postsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(postsDir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!meta.postedAt) continue;
      if (new Date(meta.postedAt).getTime() < cutoffMs) continue;
      metas.push({ meta, metaPath, dir: path.join(postsDir, entry.name) });
    } catch { /* skip malformed */ }
  }

  return metas.sort((a, b) => new Date(a.meta.postedAt) - new Date(b.meta.postedAt));
}

/** Fetch all published posts from Postiz for this integration */
async function fetchPublishedPosts() {
  if (!POSTIZ_KEY || !INTEGRATION_ID) return [];

  try {
    const url = `${POSTIZ_API}/posts?integrationId=${INTEGRATION_ID}&status=PUBLISHED&limit=50`;
    const res = await fetchFn(url, {
      headers: { 'Authorization': POSTIZ_KEY, 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      log(`Postiz API error ${res.status} — skipping platform stats`);
      return [];
    }

    const data  = await res.json();
    const posts = data.posts || data.data || (Array.isArray(data) ? data : []);
    return posts;
  } catch (err) {
    log(`Postiz fetch failed: ${err.message}`);
    return [];
  }
}

/** Fetch analytics for a single post ID from Postiz */
async function fetchPostAnalytics(postizPostId) {
  if (!POSTIZ_KEY || !postizPostId) return null;

  try {
    // Try the analytics endpoint first
    const analyticsUrl = `${POSTIZ_API}/posts/${postizPostId}/analytics`;
    const res = await fetchFn(analyticsUrl, {
      headers: { 'Authorization': POSTIZ_KEY },
    });

    if (res.ok) {
      const data  = await res.json();
      const stats = data.stats || data.data || data;
      return extractStats(stats);
    }

    // Fall back to post detail
    const detailUrl = `${POSTIZ_API}/posts/${postizPostId}`;
    const res2 = await fetchFn(detailUrl, {
      headers: { 'Authorization': POSTIZ_KEY },
    });

    if (!res2.ok) return null;
    const data = await res2.json();
    return extractStats(data.statistics || data.stats || {});
  } catch {
    return null;
  }
}

/** Normalize Postiz stat field names to our canonical format */
function extractStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const views    = raw.views    || raw.playCount    || raw.impressions || 0;
  const likes    = raw.likes    || raw.likeCount     || 0;
  const shares   = raw.shares   || raw.shareCount    || 0;
  const comments = raw.comments || raw.commentCount  || 0;
  if (views === 0 && likes === 0) return null; // no real data yet
  return { views, likes, shares, comments };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n📡 RunSound — Analytics Sync');
  console.log('==============================');
  console.log(`📂 Config: ${configPath}`);
  console.log(`📅 Window: last ${days} day(s)\n`);

  if (!POSTIZ_KEY) {
    log('⚠️  POSTIZ_API_KEY not set — no platform stats available');
    log('   Run "npm run learn" anyway — it will use streaming clicks only');
    process.exit(0);
  }

  if (!INTEGRATION_ID) {
    log('⚠️  No Postiz integration ID in config (postiz.integrationIds.tiktok)');
    log('   Stats unavailable until TikTok is connected via Postiz');
    process.exit(0);
  }

  // ── 1. Find recent posts ───────────────────────────────────────────────────
  const entries = findRecentMetas();
  log(`Found ${entries.length} post(s) in the last ${days} day(s)`);

  if (!entries.length) {
    log('Nothing to analyze — post some content first!');
    process.exit(0);
  }

  // ── 2. Fetch all published posts from Postiz in one call ──────────────────
  log('Fetching published posts from Postiz...');
  const allPosts    = await fetchPublishedPosts();
  const postMap     = {};
  for (const p of allPosts) {
    const id = p.postId || p.id;
    if (id) postMap[id] = p;
  }
  log(`  ${allPosts.length} published post(s) found on Postiz`);

  // ── 3. Sync stats to each meta.json ───────────────────────────────────────
  let updated = 0;
  let pending = 0;
  const summary = [];

  for (const { meta, metaPath } of entries) {
    const postizId = meta.postizPostId || meta.tiktokPostId || null;
    if (!postizId) {
      pending++;
      continue;
    }

    // Try bulk response first, then individual fetch
    let stats = null;
    const bulkPost = postMap[postizId];
    if (bulkPost) {
      stats = extractStats(bulkPost.statistics || bulkPost.stats || {});
    }
    if (!stats) {
      stats = await fetchPostAnalytics(postizId);
    }

    if (stats) {
      meta.stats = stats;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      updated++;
      const date = meta.postedAt?.slice(0, 10) || '?';
      log(`  ✅ [${date}] ${meta.variant || 'A'} — ${stats.views.toLocaleString()} views, ${stats.likes} likes`);

      // ── Sync views + streaming_ctr to Supabase post_log ────────────────────
      // streaming_clicks is incremented live by /api/click via the smart link.
      // We now have TikTok views → compute ctr = clicks / views and persist.
      if (supabase && meta.postUid) {
        try {
          // Fetch current streaming_clicks + image_bank_ids for this post
          const { data: row } = await supabase
            .from('post_log')
            .select('streaming_clicks, image_bank_ids, hook_archetype')
            .eq('post_uid', meta.postUid)
            .single();

          const clicks       = row?.streaming_clicks || 0;
          const ctr          = stats.views > 0 ? clicks / stats.views : null;
          const imageBankIds = row?.image_bank_ids || meta.imageBankIds || [];
          const hookArch     = row?.hook_archetype || meta.hook_archetype || null;

          await supabase.from('post_log').update({
            views:          stats.views,
            streaming_ctr:  ctr,
          }).eq('post_uid', meta.postUid);

          log(`     Supabase: ${clicks} clicks / ${stats.views} views → ctr=${ctr !== null ? ctr.toFixed(4) : 'n/a'}`);

          // ── Update image bank performance ──────────────────────────────────
          if (bank && imageBankIds?.length && stats.views > 0) {
            await bank.updateImagePerformance(supabase, imageBankIds, stats.views, clicks);
            log(`     Image bank: updated ${imageBankIds.length} image(s)`);
          }

          // ── Update hook bank performance ───────────────────────────────────
          if (bank && hookArch && stats.views > 0) {
            const variant      = meta.variant || 'A';
            const genreFamily  = deriveGenreFamily(config);
            await bank.updateHookPerformance(supabase, genreFamily, variant, stats.views, clicks);
            log(`     Hook bank: updated ${genreFamily}/${variant} (${hookArch})`);
          }

        } catch (sbErr) {
          log(`     Supabase sync failed: ${sbErr.message}`);
        }
      }
    } else {
      pending++;
      const date = meta.postedAt?.slice(0, 10) || '?';
      log(`  ⏳ [${date}] ${meta.variant || 'A'} — no stats yet (post may be pending TikTok processing)`);
    }

    summary.push({
      date:             meta.postedAt?.slice(0, 10),
      variant:          meta.variant  || 'A',
      hook_archetype:   meta.hook_archetype || null,
      postUid:          meta.postUid  || null,
      postizId,
      views:            stats?.views    || 0,
      likes:            stats?.likes    || 0,
      shares:           stats?.shares   || 0,
      comments:         stats?.comments || 0,
    });
  }

  // ── 4. Write analytics/latest.json (read by optimize-strategy.js) ─────────
  const analyticsDir  = path.join(projectDir, 'analytics');
  const analyticsPath = path.join(analyticsDir, 'latest.json');

  if (!fs.existsSync(analyticsDir)) fs.mkdirSync(analyticsDir, { recursive: true });

  const output = {
    fetchedAt:   new Date().toISOString(),
    artist:      config.artist?.name,
    song:        config.song?.title,
    daysBack:    days,
    postsTotal:  entries.length,
    withStats:   updated,
    pending,
    posts:       summary,
    totals: {
      views:    summary.reduce((s, p) => s + p.views, 0),
      likes:    summary.reduce((s, p) => s + p.likes, 0),
      shares:   summary.reduce((s, p) => s + p.shares, 0),
      comments: summary.reduce((s, p) => s + p.comments, 0),
    },
  };

  fs.writeFileSync(analyticsPath, JSON.stringify(output, null, 2));

  // ── 5. Sync follower count ──────────────────────────────────────────────────
  // Reads from config.campaign.followerCount (manually updated until TikTok API approved)
  const campaignId      = config.campaign?.id;
  const manualFollowers = config.campaign?.followerCount;
  if (supabase && campaignId && manualFollowers !== undefined) {
    const phase = manualFollowers >= 1000 ? 2 : 1;
    await supabase.from('campaigns').update({
      follower_count: manualFollowers,
      follower_phase: phase,
    }).eq('id', campaignId);
    await supabase.from('follower_log').insert({ campaign_id: campaignId, follower_count: manualFollowers });
    console.log(`   👥 Followers: ${manualFollowers} → Phase ${phase}`);
  }

  // ── 6. Summary ─────────────────────────────────────────────────────────────
  console.log(`\n✅ Stats synced: ${updated}/${entries.length} posts updated`);
  if (pending) console.log(`   ${pending} post(s) still pending TikTok stats`);
  console.log(`   Total views (${days}d): ${output.totals.views.toLocaleString()}`);
  console.log(`   Analytics saved: ${analyticsPath}`);
  console.log(`\nNext → node learn.js --config ${configPath}\n`);

})().catch(err => {
  console.error(`[check-analytics] Fatal: ${err.message}`);
  process.exit(1);
});
