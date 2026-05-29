/**
 * GET /api/dashboard/artist/:artistId
 * GET /api/dashboard/campaign/:campaignId
 *
 * Returns everything the artist dashboard needs in one call:
 *   - Campaign info (song, smart link)
 *   - Today's pending posts count (posts in "pending_publish" status)
 *   - Weekly stats: views, stream clicks, total posts, week-over-week deltas
 *   - AI learning summary: variant test results, winning variant, LarryBrain diagnosis
 *   - Recent posts list (last 14 posts with their stats)
 *
 * LarryBrain diagnosis logic (Oliver Henry formula):
 *   High views + High clicks → "scale"       — keep doing this
 *   High views + Low clicks  → "fix_cta"     — hook works, CTA doesn't
 *   Low views  + High clicks → "fix_hook"    — CTA works, hook doesn't
 *   Low views  + Low clicks  → "reset"       — full creative reset
 *
 * "High" thresholds (based on weekly campaign averages):
 *   views  ≥ 5 000 / week
 *   clicks ≥ 10   / week
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../db');

// ─── Auth middleware ───────────────────────────────────────────────────────────
// Every dashboard endpoint requires ?token= matching campaigns.dash_token.
// This makes the dashboard URL private — only the artist (who received the
// welcome email) can access their own data.
async function requireToken(req, res, next) {
  const token = req.query.token || req.headers['x-dashboard-token'];
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Missing token. Use your personal dashboard link.' });
  }

  // Validate token exists in DB — attach campaign to req so routes can use it
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, artist_id')
    .eq('dash_token', token)
    .eq('active', true)
    .single();

  if (!campaign) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token.' });
  }

  req.tokenCampaignId = campaign.id;
  req.tokenArtistId   = campaign.artist_id;
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns ISO date string for N days ago from now */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/**
 * LarryBrain diagnosis — maps weekly aggregate stats to a string action.
 * @param {number} weekViews   total TikTok views last 7 days
 * @param {number} weekClicks  total smart-link clicks last 7 days
 */
function diagnose(weekViews, weekClicks) {
  const highViews  = weekViews  >= 5000;
  const highClicks = weekClicks >= 10;

  if (highViews  && highClicks)  return 'scale';
  if (highViews  && !highClicks) return 'fix_cta';
  if (!highViews && highClicks)  return 'fix_hook';
  return 'reset';
}

/**
 * Human-readable message for each diagnosis.
 */
const DIAGNOSIS_MSG = {
  scale:    'Great performance — keep posting similar content.',
  fix_cta:  'Good reach but low streams — test stronger CTA in slide 6.',
  fix_hook: 'High CTR but low views — try a stronger opening hook.',
  reset:    'Low views and streams — time for a fresh creative direction.',
};

/**
 * Compute week-over-week delta as a fraction (0.34 = +34%).
 * Returns 0 if there's no prior-week data to compare against.
 */
function weekDelta(thisWeek, lastWeek) {
  if (!lastWeek || lastWeek === 0) return 0;
  return parseFloat(((thisWeek - lastWeek) / lastWeek).toFixed(4));
}

// ─── Core data fetcher ────────────────────────────────────────────────────────

async function getDashboardData(campaignId) {
  // ── 1. Campaign info ───────────────────────────────────────────────────────
  const { data: campaign, error: campaignErr } = await supabase
    .from('campaigns')
    .select(`
      id, slug, artist_name, song_title, smart_link_url, active,
      artist_id, genre, mood, created_at,
      artists ( name, email, plan, status )
    `)
    .eq('id', campaignId)
    .eq('active', true)
    .single();

  if (campaignErr || !campaign) {
    throw new Error('Campaign not found');
  }

  const smartLinkUrl = campaign.smart_link_url ||
    `${process.env.BASE_URL || 'https://runsound.fm'}/l/${campaign.slug}`;

  // ── 2. Post log — last 30 days ─────────────────────────────────────────────
  const { data: posts = [] } = await supabase
    .from('post_log')
    .select(`
      id, post_uid, variant, hook_line,
      views, likes, shares, comments, streaming_clicks, streaming_ctr,
      tiktok_post_id, posted_at, stats_updated_at
    `)
    .eq('campaign_id', campaignId)
    .gte('posted_at', daysAgo(30))
    .order('posted_at', { ascending: false })
    .limit(50);

  // ── 3. Pending posts: posted in last 48h with no views yet
  //    These are drafts sitting in the TikTok inbox waiting for the artist
  //    to add a trending sound and hit publish.
  const cutoff48h = daysAgo(2);
  const pendingPosts = posts.filter(p =>
    p.posted_at >= cutoff48h && (p.views || 0) === 0
  ).length;

  // ── 4. Weekly view stats (this week vs last week) ─────────────────────────
  const thisWeekStart = daysAgo(7);
  const lastWeekStart = daysAgo(14);

  const thisWeekPosts = posts.filter(p => p.posted_at >= thisWeekStart);
  const lastWeekPosts = posts.filter(
    p => p.posted_at >= lastWeekStart && p.posted_at < thisWeekStart
  );

  const weekViews  = thisWeekPosts.reduce((s, p) => s + (p.views || 0), 0);
  const prevViews  = lastWeekPosts.reduce((s, p) => s + (p.views || 0), 0);
  const totalPosts = posts.length;

  // ── 5. Smart-link clicks — this week vs last week ─────────────────────────
  const { data: clicksThisWeek = [] } = await supabase
    .from('utm_clicks')
    .select('id, platform, clicked_at')
    .eq('campaign_id', campaignId)
    .gte('clicked_at', thisWeekStart);

  const { data: clicksLastWeek = [] } = await supabase
    .from('utm_clicks')
    .select('id')
    .eq('campaign_id', campaignId)
    .gte('clicked_at', lastWeekStart)
    .lt('clicked_at', thisWeekStart);

  const weekClicks = clicksThisWeek.length;
  const prevClicks = clicksLastWeek.length;

  // ── 6. AI learning — variant performance ──────────────────────────────────
  const postsWithViews = posts.filter(p => (p.views || 0) > 0);

  // Aggregate by variant
  const variantMap = {};
  for (const post of postsWithViews) {
    const v = post.variant || 'A';
    if (!variantMap[v]) variantMap[v] = { posts: 0, totalViews: 0, totalClicks: 0 };
    variantMap[v].posts++;
    variantMap[v].totalViews  += post.views  || 0;
    variantMap[v].totalClicks += post.streaming_clicks || 0;
  }

  const variants = Object.entries(variantMap).map(([variant, data]) => ({
    variant,
    posts:    data.posts,
    avgViews: Math.round(data.totalViews  / data.posts),
    avgClicks: parseFloat((data.totalClicks / data.posts).toFixed(2)),
    ctr:      data.totalViews > 0
      ? parseFloat((data.totalClicks / data.totalViews * 100).toFixed(3))
      : 0,
  })).sort((a, b) => b.ctr - a.ctr);

  const winningVariant = variants[0]?.variant || 'A';

  // Lift = CTR of best vs second best (or vs 0 if only one)
  let winningLift = 0;
  if (variants.length >= 2) {
    const best   = variants[0].ctr;
    const second = variants[1].ctr;
    winningLift = second > 0
      ? Math.round((best - second) / second * 100)
      : 0;
  }

  // LarryBrain diagnosis
  const diagnosisKey = diagnose(weekViews, weekClicks);
  const diagnosis = {
    key:     diagnosisKey,
    message: DIAGNOSIS_MSG[diagnosisKey],
  };

  const learning = {
    testedVariants: variants.length,
    winningVariant,
    winningLift,
    diagnosis,
    variants,
    postsWithData: postsWithViews.length,
    totalPostsAnalyzed: posts.length,
    // Flag for "not enough data yet" — need at least 3 posts with views
    insufficientData: postsWithViews.length < 3,
  };

  // ── 7. Recent posts for the timeline ──────────────────────────────────────
  // Infer status from data: pending = posted recently with no views;
  // live = has views; archived = older with no views
  const recentPosts = posts.slice(0, 14).map(post => {
    const views = post.views || 0;
    const age   = Date.now() - new Date(post.posted_at).getTime();
    const ageH  = age / (1000 * 60 * 60);

    let status;
    if (views > 0)  status = 'live';
    else if (ageH < 48) status = 'pending';
    else status = 'draft';

    return {
      id:        post.id,
      postUid:   post.post_uid,
      hook:      post.hook_line || null,
      views,
      clicks:    post.streaming_clicks || 0,
      ctr:       post.streaming_ctr    || 0,
      status,
      variant:   post.variant   || 'A',
      createdAt: post.posted_at,
    };
  });

  // ── 8. Assemble response ───────────────────────────────────────────────────
  return {
    ok: true,
    campaignId,
    artistId:    campaign.artist_id,
    artistName:  campaign.artist_name,
    songTitle:   campaign.song_title,
    genre:       campaign.genre   || null,
    mood:        campaign.mood    || null,
    smartLinkUrl,
    slug:        campaign.slug,
    pendingPosts,
    weekViews,
    weekClicks,
    totalPosts,
    totalClicks: posts.reduce((sum, p) => sum + (p.streaming_clicks || 0), 0),
    viewsDelta:  weekDelta(weekViews, prevViews),
    clicksDelta: weekDelta(weekClicks, prevClicks),
    learning,
    posts: recentPosts,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/dashboard/campaign/:campaignId?token=<dash_token>
 * Direct lookup by campaign UUID. Token must match.
 */
router.get('/campaign/:campaignId', requireToken, async (req, res) => {
  try {
    // Ensure the token owner is allowed to see this campaign
    if (req.tokenCampaignId !== req.params.campaignId) {
      return res.status(403).json({ ok: false, error: 'Token does not match this campaign.' });
    }
    const data = await getDashboardData(req.params.campaignId);
    res.json(data);
  } catch (err) {
    console.error('[dashboard/campaign] Error:', err.message);
    const status = err.message === 'Campaign not found' ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/dashboard/artist/:artistId?token=<dash_token>
 * Looks up the artist's most recent active campaign, then returns its data.
 * Artists can have multiple campaigns; this returns the newest active one
 * (or a specific one if ?campaign= param is provided).
 */
router.get('/artist/:artistId', requireToken, async (req, res) => {
  try {
    const { artistId } = req.params;

    // Token must belong to this artist
    if (req.tokenArtistId !== artistId) {
      return res.status(403).json({ ok: false, error: 'Token does not match this artist.' });
    }
    const { campaign: specificCampaignId } = req.query;

    // If a specific campaign is requested, validate ownership then use it
    if (specificCampaignId) {
      const { data: ownership } = await supabase
        .from('campaigns')
        .select('id')
        .eq('id', specificCampaignId)
        .eq('artist_id', artistId)
        .eq('active', true)
        .single();

      if (!ownership) {
        return res.status(404).json({ ok: false, error: 'Campaign not found' });
      }
      const data = await getDashboardData(specificCampaignId);
      return res.json(data);
    }

    // Otherwise, find the most recent active campaign for this artist
    const { data: campaigns = [], error: campaignsErr } = await supabase
      .from('campaigns')
      .select('id, song_title, created_at')
      .eq('artist_id', artistId)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(10);

    if (campaignsErr) throw campaignsErr;

    if (!campaigns.length) {
      return res.status(404).json({ ok: false, error: 'No active campaigns found for this artist' });
    }

    // Return the most recent campaign's data, plus a list of all campaigns
    // so the dashboard can offer a campaign switcher
    const primaryCampaignId = campaigns[0].id;
    const data = await getDashboardData(primaryCampaignId);

    // Attach campaign switcher list if artist has multiple
    if (campaigns.length > 1) {
      data.allCampaigns = campaigns.map(c => ({
        id:        c.id,
        songTitle: c.song_title,
        createdAt: c.created_at,
      }));
    }

    res.json(data);

  } catch (err) {
    console.error('[dashboard/artist] Error:', err.message);
    const status = err.message === 'Campaign not found' ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/dashboard/artist/:artistId/campaigns?token=<dash_token>
 * Returns all campaigns for an artist (for a campaign switcher UI).
 */
router.get('/artist/:artistId/campaigns', requireToken, async (req, res) => {
  try {
    const { data: campaigns = [], error } = await supabase
      .from('campaigns')
      .select('id, slug, song_title, genre, smart_link_url, created_at, active')
      .eq('artist_id', req.params.artistId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ ok: true, campaigns });
  } catch (err) {
    console.error('[dashboard/campaigns] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
