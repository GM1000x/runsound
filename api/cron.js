/**
 * api/cron.js — RunSound Scheduled Jobs
 *
 * Safe to require from api/server.js — never calls process.exit().
 *
 * Schedule:
 *   03:00 UTC daily  — full pipeline (analytics → pick → texts → overlay → post)
 *   04:00 UTC Monday — hook learning (learn-hooks.js updates hook_weights)
 *
 * Manual trigger:
 *   POST /api/admin/run-pipeline      ← full pipeline for all campaigns
 *   POST /api/admin/learn-hooks       ← just the hook weight update
 */

const cron   = require('node-cron');
const { spawn } = require('child_process');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

// ─── Run a node script as a detached child process ────────────────────────────
// Returns a promise that resolves when the script exits.
// Streams stdout/stderr to console with a prefix.
function runScript(scriptName, args = [], label = scriptName) {
  return new Promise((resolve, reject) => {
    console.log(`\n[cron] ▶ ${label}`);
    const child = spawn('node', [path.join(ROOT, scriptName), ...args], {
      cwd:   ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
    });

    child.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));

    child.on('close', code => {
      if (code === 0) {
        console.log(`[cron] ✅ ${label} done`);
        resolve();
      } else {
        const err = new Error(`${label} exited with code ${code}`);
        console.error(`[cron] ❌ ${err.message}`);
        reject(err);
      }
    });

    child.on('error', err => {
      console.error(`[cron] ❌ ${label} spawn error: ${err.message}`);
      reject(err);
    });
  });
}

// ─── Full nightly pipeline ────────────────────────────────────────────────────
// analytics → pick → texts → overlay → post (all active campaigns)
async function runDailyPipeline() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`[cron] 🚀 Daily pipeline starting — ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(50)}`);
  try {
    await runScript('run-all-campaigns.js', [], 'daily-pipeline');
    console.log('[cron] ✅ Daily pipeline complete');
  } catch (err) {
    console.error(`[cron] ❌ Daily pipeline failed: ${err.message}`);
  }
}

// ─── Weekly hook learning ─────────────────────────────────────────────────────
// Reads post_log → updates hook_weights in Supabase → generate-texts.js uses them
async function runLearnHooks() {
  console.log(`\n[cron] 🧠 Hook learning starting — ${new Date().toISOString()}`);
  try {
    await runScript('learn-hooks.js', [], 'learn-hooks');
    console.log('[cron] ✅ Hook learning complete');
  } catch (err) {
    console.error(`[cron] ❌ Hook learning failed: ${err.message}`);
  }
}

// ─── Daily DM outreach ────────────────────────────────────────────────────────
// Sends 50-100 DMs per artist from their connected TikTok account
async function runDailyDms() {
  console.log(`\n[cron] 📩 Daily DMs starting — ${new Date().toISOString()}`);
  try {
    await runScript('scripts/send-daily-dms.js', [], 'daily-dms');
    console.log('[cron] ✅ Daily DMs complete');
  } catch (err) {
    console.error(`[cron] ❌ Daily DMs failed: ${err.message}`);
  }
}

// ─── Trending hook scrape ─────────────────────────────────────────────────────
// Runs Sunday 01:00 UTC — before the pipeline at 03:00 so fresh hooks are ready
async function runScrapeTrends() {
  console.log(`\n[cron] 🔥 Trending scrape starting — ${new Date().toISOString()}`);
  try {
    await runScript('scrape-trends.js', [], 'scrape-trends');
    console.log('[cron] ✅ Trending scrape complete');
  } catch (err) {
    console.error(`[cron] ❌ Trending scrape failed: ${err.message}`);
    // Non-fatal — pipeline still runs with existing/fallback hooks
  }
}

// ─── Video generation -> organic publish pipeline ─────────────────────────────
// New flow from postiz-for-musik-plan.md: polls freebeat job status for
// rs_videos still GENERATING, and as soon as one is ready, publishes it
// organically to TikTok (if the artist has connected via OAuth — see
// api/tiktok-api.js) and Instagram (via Postiz). Runs inline rather than
// as a spawned script like the pipeline steps above — this is lightweight
// polling of two external APIs, not CPU-bound work.
//
// Throttled by design: batches are now 10-15 clips per idea (see
// api/prompt-styles.js). Posting all of them in one tick would (a) dump
// the artist's TikTok inbox with 10+ drafts at once, and (b) risk TikTok's
// spam-detection on posting frequency/content-similarity even though these
// go out as SELF_ONLY drafts. Cap how many go out per campaign per day so
// the batch spreads across the ~48-72h organic-test window instead.
const MAX_POSTS_PER_CAMPAIGN_PER_DAY = 3;

async function countPostsToday(supabase, campaignId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('rs_post_results')
    .select('id, rs_videos!inner(campaign_id)', { count: 'exact', head: true })
    .eq('rs_videos.campaign_id', campaignId)
    .gte('published_at', since);
  return count || 0;
}

async function runVideoPipeline() {
  const supabase = require('./db');
  const freebeat  = require('./freebeat');
  const tiktokApi = require('./tiktok-api');
  const postiz    = require('./postiz');

  console.log(`\n[cron] 🎬 Video pipeline starting — ${new Date().toISOString()}`);

  const { data: pending, error } = await supabase
    .from('rs_videos')
    .select('id, campaign_id, freebeat_job_id, status, rs_campaigns(artist_id)')
    .in('status', ['PENDING', 'GENERATING']);

  if (error) {
    console.error(`[cron] ❌ Video pipeline: could not load pending videos: ${error.message}`);
    return;
  }
  if (!pending.length) {
    console.log('[cron] Video pipeline: nothing pending');
    return;
  }

  // Track today's post count per campaign in-memory across this tick so we
  // don't re-query for every video of the same campaign.
  const postedTodayByCampaign = {};

  for (const video of pending) {
    if (!video.freebeat_job_id) continue;

    try {
      const jobStatus = await freebeat.getVideoStatus(video.freebeat_job_id);

      if (jobStatus.status === 'failed') {
        await supabase.from('rs_videos').update({ status: 'FAILED' }).eq('id', video.id);
        console.log(`[cron]   video ${video.id}: freebeat job failed`);
        continue;
      }
      if (jobStatus.status !== 'ready' || !jobStatus.videoUrl) {
        continue; // still processing, check again next tick
      }

      await supabase.from('rs_videos').update({
        status: 'READY',
        video_url: jobStatus.videoUrl,
      }).eq('id', video.id);

      // ── Throttle: cap posts/day per campaign ────────────────────────────
      if (postedTodayByCampaign[video.campaign_id] === undefined) {
        postedTodayByCampaign[video.campaign_id] = await countPostsToday(supabase, video.campaign_id);
      }
      if (postedTodayByCampaign[video.campaign_id] >= MAX_POSTS_PER_CAMPAIGN_PER_DAY) {
        console.log(`[cron]   video ${video.id}: ready but campaign ${video.campaign_id} hit today's post cap (${MAX_POSTS_PER_CAMPAIGN_PER_DAY}) — holding for next day`);
        continue; // stays READY, picked up on a later tick once the cap resets
      }

      console.log(`[cron]   video ${video.id}: ready, publishing organically...`);

      const artistId = video.rs_campaigns?.artist_id;
      let published = false;

      // TikTok — only if this artist has connected via OAuth
      try {
        const token = await tiktokApi.getValidToken(artistId);
        if (token) {
          const { publishId } = await tiktokApi.postVideo(token.accessToken, jobStatus.videoUrl, '');
          await supabase.from('rs_post_results').insert({
            video_id: video.id,
            platform: 'TIKTOK',
            external_post_id: publishId,
            published_at: new Date().toISOString(),
          });
          published = true;
        } else {
          console.log(`[cron]   video ${video.id}: no TikTok token for artist ${artistId}, skipping`);
        }
      } catch (err) {
        console.error(`[cron]   video ${video.id}: TikTok publish failed: ${err.message}`);
      }

      // Instagram via Postiz
      try {
        const { postId } = await postiz.schedulePost({
          customerGroup: artistId,
          videoUrl: jobStatus.videoUrl,
          caption: '',
        });
        await supabase.from('rs_post_results').insert({
          video_id: video.id,
          platform: 'INSTAGRAM',
          external_post_id: postId,
          published_at: new Date().toISOString(),
        });
        published = true;
      } catch (err) {
        console.error(`[cron]   video ${video.id}: Instagram publish failed: ${err.message}`);
      }

      if (published) postedTodayByCampaign[video.campaign_id]++;
    } catch (err) {
      console.error(`[cron]   video ${video.id}: ${err.message}`);
    }
  }

  console.log('[cron] ✅ Video pipeline tick complete');
}

// ─── Measure organic performance (48-72h after publish) ───────────────────────
// Pulls views/likes/comments/shares for TikTok posts via api/tiktok-insights.js.
//
// KNOWN GAP (see tiktok-insights.js header): needs the `video.list` TikTok
// scope, which isn't approved yet (video.publish isn't either — see
// api/tiktok-api.js). This function is written to run safely against that
// reality: every fetch is wrapped so an auth failure just gets logged and
// skipped, not thrown — the moment the scope is granted, this starts
// filling in real numbers with no code change needed.
//
// Also worth noting for later: TikTok's SELF_ONLY drafts only start
// accruing views once the artist actually taps "Post" inside the app —
// draft-in-inbox time doesn't count. So a post with published_at 72h ago
// but zero views might just mean the artist hasn't opened their drafts yet,
// not that the video flopped. Worth surfacing that distinction in the
// dashboard eventually rather than treating a silent draft as a loss.
async function runMeasurePerformance() {
  const supabase = require('./db');
  const tiktokApi = require('./tiktok-api');
  const insights  = require('./tiktok-insights');

  console.log(`\n[cron] 📊 Measuring organic performance — ${new Date().toISOString()}`);

  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // don't bother past 30 days
  const windowEnd   = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();      // at least 48h old

  const { data: results, error } = await supabase
    .from('rs_post_results')
    .select('id, video_id, platform, external_post_id, is_organic, published_at, rs_videos(campaign_id, rs_campaigns(artist_id))')
    .eq('platform', 'TIKTOK')
    .eq('is_organic', true)
    .lte('published_at', windowEnd)
    .gte('published_at', windowStart)
    .eq('views', 0); // haven't measured yet (default 0)

  if (error) {
    console.error(`[cron] ❌ Measure performance: could not load results: ${error.message}`);
    return;
  }
  if (!results.length) {
    console.log('[cron] Measure performance: nothing due for measurement');
    return;
  }

  for (const result of results) {
    const artistId = result.rs_videos?.rs_campaigns?.artist_id;
    if (!artistId || !result.external_post_id) continue;

    try {
      const token = await tiktokApi.getValidToken(artistId);
      if (!token) continue;

      const stats = await insights.getVideoPerformance(token.accessToken, result.external_post_id);
      await supabase.from('rs_post_results').update({
        views:    stats.views,
        shares:   stats.shares,
        // completion_rate/saves stay null — not available yet, see tiktok-insights.js
        updated_at: new Date().toISOString(),
      }).eq('id', result.id);

      console.log(`[cron]   post ${result.id}: ${stats.views} views, ${stats.shares} shares`);
    } catch (err) {
      // Expected to fail until video.list scope is approved — log, don't crash the tick.
      console.warn(`[cron]   post ${result.id}: measurement skipped (${err.message})`);
    }
  }

  console.log('[cron] ✅ Measure performance tick complete');
}

// ─── Score + rank ideas from measured performance ──────────────────────────────
// Aggregates rs_post_results across each idea's videos into a single score,
// then ranks ideas within their campaign. Simple weighted formula —
// engagement (shares/comments) counted heavier than raw views, since it's
// a stronger music-specific signal than passive view count. Tune freely
// once real data starts coming in.
function scorePost(r) {
  return (r.views || 0) * 1 + (r.likes || 0) * 2 + (r.comments || 0) * 3 + (r.shares || 0) * 5;
}

async function runScoreIdeas() {
  const supabase = require('./db');
  console.log(`\n[cron] 🏆 Scoring ideas — ${new Date().toISOString()}`);

  const { data: ideas, error } = await supabase
    .from('rs_ideas')
    .select('id, campaign_id, rs_videos(id, rs_post_results(views, likes, comments, shares))');

  if (error) {
    console.error(`[cron] ❌ Score ideas: could not load ideas: ${error.message}`);
    return;
  }
  if (!ideas.length) {
    console.log('[cron] Score ideas: nothing to score yet');
    return;
  }

  // Group by campaign so ranks are relative within each campaign, not globally.
  const byCampaign = {};
  for (const idea of ideas) {
    const videos = idea.rs_videos || [];
    const posts  = videos.flatMap(v => v.rs_post_results || []);
    const score  = posts.reduce((sum, r) => sum + scorePost(r), 0);
    (byCampaign[idea.campaign_id] ||= []).push({ id: idea.id, score });
  }

  for (const [campaignId, list] of Object.entries(byCampaign)) {
    list.sort((a, b) => b.score - a.score);
    for (let i = 0; i < list.length; i++) {
      await supabase.from('rs_ideas').update({ score: list[i].score, rank: i + 1 }).eq('id', list[i].id);
    }

    // If the top idea has a real, non-zero score, the campaign has a
    // usable organic signal — flag it for the artist's budget-approval
    // decision (see api/ads-boost.js — boosting itself is not wired yet).
    if (list[0]?.score > 0) {
      await supabase
        .from('rs_campaigns')
        .update({ status: 'AWAITING_BUDGET_APPROVAL' })
        .eq('id', campaignId)
        .eq('status', 'ORGANIC_TESTING'); // only advance from the expected prior state
    }
  }

  console.log(`[cron] ✅ Scored ideas across ${Object.keys(byCampaign).length} campaign(s)`);
}

// ─── Prompt-style feedback loop ─────────────────────────────────────────────────
// Reads measured performance grouped by variant_label (the style key from
// api/prompt-styles.js) across ALL campaigns/artists — not per-artist — so
// the whole customer base's data trains one shared model, same principle
// as the winner's-pool ad-creative learning described in the plan. Updates
// rs_prompt_weights, which pickBatchStyles() reads on the next campaign
// creation. Weight is the style's avg score relative to the overall mean,
// clamped so no style ever fully stops being tried (floor enforced in
// api/prompt-styles.js, ceiling enforced here to avoid one early lucky
// style dominating every future batch before enough data exists).
const MAX_LEARNED_WEIGHT = 3.0;

async function runLearnPromptStyles() {
  const supabase = require('./db');
  console.log(`\n[cron] 🧠 Learning prompt-style weights — ${new Date().toISOString()}`);

  const { data: videos, error } = await supabase
    .from('rs_videos')
    .select('variant_label, rs_post_results(views, likes, comments, shares)')
    .not('rs_post_results', 'is', null);

  if (error) {
    console.error(`[cron] ❌ Learn prompt styles: could not load videos: ${error.message}`);
    return;
  }
  if (!videos.length) {
    console.log('[cron] Learn prompt styles: no measured videos yet');
    return;
  }

  const byStyle = {};
  for (const v of videos) {
    const posts = v.rs_post_results || [];
    if (!posts.length) continue;
    const score = posts.reduce((sum, r) => sum + scorePost(r), 0);
    const bucket = (byStyle[v.variant_label] ||= { total: 0, count: 0 });
    bucket.total += score;
    bucket.count += 1;
  }

  const styleKeys = Object.keys(byStyle);
  if (!styleKeys.length) {
    console.log('[cron] Learn prompt styles: no styles with measured results yet');
    return;
  }

  const avgByStyle = {};
  for (const key of styleKeys) avgByStyle[key] = byStyle[key].total / byStyle[key].count;

  const overallAvg = Object.values(avgByStyle).reduce((s, v) => s + v, 0) / styleKeys.length;

  for (const key of styleKeys) {
    const rawWeight = overallAvg > 0 ? avgByStyle[key] / overallAvg : 1.0;
    const weight = Math.min(Math.max(rawWeight, 0.15), MAX_LEARNED_WEIGHT);

    await supabase.from('rs_prompt_weights').upsert({
      style_key:   key,
      weight,
      avg_score:   avgByStyle[key],
      sample_size: byStyle[key].count,
      updated_at:  new Date().toISOString(),
    });

    console.log(`[cron]   style ${key}: avg score ${avgByStyle[key].toFixed(1)} → weight ${weight.toFixed(2)} (n=${byStyle[key].count})`);
  }

  console.log('[cron] ✅ Prompt-style learning complete');
}

// ─── Schedule ─────────────────────────────────────────────────────────────────
function startCron() {
  // Trending hook scrape: Sunday 01:00 UTC (before pipeline)
  cron.schedule('0 1 * * 0', runScrapeTrends, { timezone: 'UTC' });

  // Daily DM outreach: every day at 10:00 UTC (morning in EU/US)
  cron.schedule('0 10 * * *', runDailyDms, { timezone: 'UTC' });

  // Full pipeline: every day at 03:00 UTC
  cron.schedule('0 3 * * *', runDailyPipeline, { timezone: 'UTC' });

  // Hook learning: every Monday at 04:00 UTC (after pipeline has run)
  cron.schedule('0 4 * * 1', runLearnHooks, { timezone: 'UTC' });

  // Video pipeline: every 10 minutes — freebeat generation is async, this
  // is what actually notices when a video is ready and publishes it.
  cron.schedule('*/10 * * * *', runVideoPipeline, { timezone: 'UTC' });

  // Measure organic performance: hourly — cheap API polling, catches posts
  // as soon as they cross the 48h minimum age.
  cron.schedule('0 * * * *', runMeasurePerformance, { timezone: 'UTC' });

  // Score + rank ideas: every 2 hours, after measurement has a chance to
  // have run at least once with fresh data.
  cron.schedule('30 */2 * * *', runScoreIdeas, { timezone: 'UTC' });

  // Prompt-style feedback loop: weekly, same cadence as hook learning —
  // needs enough accumulated data across campaigns to be meaningful.
  cron.schedule('0 5 * * 1', runLearnPromptStyles, { timezone: 'UTC' });

  console.log('⏰ Cron scheduled:');
  console.log('   01:00 UTC Sunday  → trending scrape (fresh TikTok hook patterns)');
  console.log('   03:00 UTC daily   → full pipeline (pick → texts → overlay → post)');
  console.log('   04:00 UTC Monday  → hook learning (update archetype weights)');
  console.log('   05:00 UTC Monday  → prompt-style learning (update batch generation weights)');
  console.log('   10:00 UTC daily   → DM outreach (50-100 DMs per artist)');
  console.log('   every 10 min      → video pipeline (freebeat status → organic publish, throttled)');
  console.log('   hourly            → measure organic performance (48h+ old posts)');
  console.log('   every 2h (:30)    → score + rank ideas');

  return {
    runDailyPipeline, runLearnHooks, runScrapeTrends, runDailyDms, runVideoPipeline,
    runMeasurePerformance, runScoreIdeas, runLearnPromptStyles,
  };
}

module.exports = {
  startCron, runDailyPipeline, runLearnHooks, runScrapeTrends, runVideoPipeline,
  runMeasurePerformance, runScoreIdeas, runLearnPromptStyles,
};
