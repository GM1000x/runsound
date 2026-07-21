/**
 * api/routes/outreach.js — Creator Outreach Engine
 *
 * POST /api/outreach/campaigns                     Create outreach campaign
 * GET  /api/outreach/campaigns/:id                 Get campaign + stats
 * POST /api/outreach/campaigns/:id/discover        Run creator discovery via Apify
 * POST /api/outreach/campaigns/:id/send-dms        Trigger DM batch via Apify actor
 * GET  /api/outreach/campaigns/:id/contacts        List all contacts
 * POST /api/outreach/accounts                      Connect TikTok outreach account
 * GET  /api/outreach/accounts                      List connected accounts
 * DELETE /api/outreach/accounts/:accountId         Remove account
 *
 * All routes require ?token= (campaign dash_token) except /accounts which
 * uses ?artist_token= (direct artist auth).
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../db');
const OpenAI   = require('openai');
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let fetch;
try { fetch = require('node-fetch').default; } catch { fetch = global.fetch; }

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

// ─── Genre → TikTok content categories map ────────────────────────────────────
const GENRE_CATEGORIES = {
  'Hip-Hop':         ['street', 'fashion', 'dance', 'gym', 'lifestyle'],
  'Rap':             ['street', 'fashion', 'dance', 'gym', 'lifestyle'],
  'Trap':            ['gym', 'dance', 'gaming', 'street'],
  'R&B':             ['romance', 'lifestyle', 'aesthetic', 'dance', 'fashion'],
  'Soul / Neo-Soul': ['aesthetic', 'lifestyle', 'romance', 'chill'],
  'Pop':             ['lifestyle', 'dance', 'fashion', 'vlogs', 'comedy'],
  'Indie Pop':       ['aesthetic', 'art', 'lifestyle', 'travel', 'study'],
  'Bedroom Pop':     ['aesthetic', 'study', 'art', 'chill', 'lifestyle'],
  'Singer-Songwriter': ['emotional', 'travel', 'aesthetic', 'vlogs'],
  'Folk':            ['travel', 'nature', 'aesthetic', 'lifestyle'],
  'Indie Rock':      ['aesthetic', 'art', 'concert', 'lifestyle', 'travel'],
  'Dance / EDM':     ['dance', 'party', 'gym', 'festival', 'nightlife'],
  'Deep House':      ['lifestyle', 'aesthetic', 'travel', 'party'],
  'Tech House':      ['gym', 'dance', 'nightlife'],
  'Afrobeats':       ['dance', 'fashion', 'party', 'lifestyle'],
  'Latin':           ['dance', 'lifestyle', 'party', 'romance'],
  'Country':         ['outdoor', 'travel', 'lifestyle', 'humor'],
};

// ─── Category → TikTok hashtags for discovery ────────────────────────────────
const CATEGORY_HASHTAGS = {
  'dance':      ['dancetok', 'dancevideos', 'choreography', 'fypdance'],
  'gym':        ['gymtok', 'fitness', 'workout', 'gymlife'],
  'lifestyle':  ['lifestyle', 'dayinmylife', 'vlog', 'lifestyleblogger'],
  'fashion':    ['fashion', 'ootd', 'style', 'fashiontok'],
  'aesthetic':  ['aesthetic', 'aestheticvideo', 'moodboard'],
  'travel':     ['travel', 'traveltok', 'travelvideos', 'explore'],
  'romance':    ['relationship', 'couplegoals', 'love', 'dating'],
  'study':      ['studytok', 'studywithme', 'student', 'studying'],
  'art':        ['artist', 'arttok', 'drawing', 'digitalart'],
  'party':      ['party', 'nightlife', 'partylife'],
  'chill':      ['chill', 'relax', 'lofi', 'vibes'],
  'gaming':     ['gaming', 'gamingtok', 'gaminglife'],
  'comedy':     ['comedy', 'funny', 'humor', 'comedytok'],
  'emotional':  ['emotional', 'relatable', 'feelings', 'storytime'],
  'vlogs':      ['vlog', 'dayinmylife', 'vlogger'],
  'outdoor':    ['outdoor', 'nature', 'adventure', 'hiking'],
  'street':     ['streetwear', 'streetstyle', 'urban'],
  'festival':   ['festival', 'concert', 'musicfestival'],
  'nightlife':  ['nightout', 'club', 'nightlife'],
  'nature':     ['nature', 'outdoors', 'hiking', 'wilderness'],
  'humor':      ['funny', 'humor', 'comedy', 'meme'],
};

// ─── Auth middleware — campaign token ────────────────────────────────────────
async function requireCampaignToken(req, res, next) {
  const token = req.query.token || req.headers['x-dashboard-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, artist_id, artist_name, song_title, genre, spotify_track_id')
    .eq('dash_token', token)
    .eq('active', true)
    .single();

  if (!campaign) return res.status(401).json({ ok: false, error: 'Invalid token' });
  req.campaign = campaign;
  next();
}

// ─── Auth middleware — artist token (for account management) ─────────────────
async function requireArtistToken(req, res, next) {
  const token = req.query.artist_token || req.headers['x-artist-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Missing artist_token' });

  const { data: artist } = await supabase
    .from('artists')
    .select('id, name')
    .eq('dash_token', token)
    .single();

  if (!artist) return res.status(401).json({ ok: false, error: 'Invalid artist_token' });
  req.artist = artist;
  next();
}

// ─── POST /api/outreach/campaigns ─────────────────────────────────────────────
// Create or return existing outreach campaign for a music campaign
router.post('/campaigns', requireCampaignToken, async (req, res) => {
  const { campaign } = req;
  const {
    follower_min = 1000,
    follower_max = 50000,
    min_engagement_rate = 3.0,
    target_categories,   // optional override
  } = req.body;

  // Check if outreach campaign already exists
  const { data: existing } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('campaign_id', campaign.id)
    .single();

  if (existing) return res.json({ ok: true, campaign: existing });

  // Auto-determine categories from genre if not provided
  let categories = target_categories;
  if (!categories || categories.length === 0) {
    categories = GENRE_CATEGORIES[campaign.genre] || ['lifestyle', 'aesthetic', 'dance'];
  }

  // Generate DM template with GPT
  const template = await generateDmTemplate(campaign, categories);

  const { data: newCampaign, error } = await supabase
    .from('outreach_campaigns')
    .insert({
      campaign_id:         campaign.id,
      artist_id:           campaign.artist_id,
      target_categories:   categories,
      follower_min,
      follower_max,
      min_engagement_rate,
      dm_template:         template,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, campaign: newCampaign });
});

// ─── GET /api/outreach/campaigns/:id ─────────────────────────────────────────
router.get('/campaigns/:id', requireCampaignToken, async (req, res) => {
  const { data, error } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('id', req.params.id)
    .eq('artist_id', req.campaign.artist_id)
    .single();

  if (error || !data) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, campaign: data });
});

// ─── POST /api/outreach/campaigns/:id/discover ────────────────────────────────
// Scrape TikTok creators via Apify based on target categories
router.post('/campaigns/:id/discover', requireCampaignToken, async (req, res) => {
  if (!APIFY_TOKEN) {
    return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not configured' });
  }

  const { data: outreachCampaign } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('id', req.params.id)
    .eq('artist_id', req.campaign.artist_id)
    .single();

  if (!outreachCampaign) return res.status(404).json({ ok: false, error: 'Not found' });

  const { target_categories, follower_min, follower_max, min_engagement_rate } = outreachCampaign;
  const limit = req.body.limit || 100;

  // Build hashtag list from categories
  const hashtags = [];
  for (const cat of target_categories) {
    const tags = CATEGORY_HASHTAGS[cat] || [cat];
    hashtags.push(...tags.slice(0, 2));
  }
  const uniqueHashtags = [...new Set(hashtags)].slice(0, 10);

  console.log(`[outreach/discover] Campaign ${req.params.id} — hashtags: ${uniqueHashtags.join(', ')}`);

  try {
    // Run Apify scraper to get posts + creator profiles
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hashtags:             uniqueHashtags,
          resultsPerPage:       20,
          maxItems:             limit,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
        }),
      }
    );

    if (!runRes.ok) throw new Error(`Apify start failed: ${runRes.status}`);
    const run   = await runRes.json();
    const runId = run.data?.id || run.id;

    // Poll for completion (max 5 min)
    const started = Date.now();
    let posts = [];
    while (Date.now() - started < 5 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 6000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      const status    = await statusRes.json();
      const state     = status.data?.status || status.status;
      if (state === 'SUCCEEDED') {
        const itemsRes = await fetch(
          `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json&limit=${limit}`
        );
        posts = await itemsRes.json();
        break;
      }
      if (state === 'FAILED' || state === 'ABORTED') throw new Error(`Apify run ${state}`);
    }

    // Extract unique creators from posts
    const creatorsMap = new Map();
    for (const post of posts) {
      const author = post.authorMeta || post.author || {};
      const username = author.name || author.uniqueId || post.uniqueId;
      if (!username || creatorsMap.has(username)) continue;

      const followers = author.fans || author.followerCount || 0;
      const likes     = author.heart || author.likeCount    || 0;
      const videos    = author.video || author.videoCount    || 1;
      // Approximate engagement: (likes / videos) / followers
      const engRate   = followers > 0 ? Math.min(((likes / Math.max(videos, 1)) / followers) * 100, 100) : 0;

      if (followers < follower_min || followers > follower_max) continue;
      if (engRate < min_engagement_rate) continue;

      // Extract email from bio if present
      const bio   = author.signature || author.bio || '';
      const email = bio.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)?.[0] || null;

      creatorsMap.set(username, {
        outreach_campaign_id: req.params.id,
        tiktok_username:      username,
        tiktok_user_id:       author.id || null,
        display_name:         author.nickName || author.name || username,
        follower_count:       followers,
        engagement_rate:      parseFloat(engRate.toFixed(2)),
        bio:                  bio || null,
        email,
        profile_url:          `https://www.tiktok.com/@${username}`,
        avatar_url:           author.avatar || author.avatarMedium || null,
        content_categories:   target_categories,
      });
    }

    const creators = [...creatorsMap.values()];
    console.log(`[outreach/discover] Found ${creators.length} eligible creators`);

    // Upsert into outreach_contacts (skip duplicates)
    if (creators.length > 0) {
      const { error: upsertErr } = await supabase
        .from('outreach_contacts')
        .upsert(creators, { onConflict: 'outreach_campaign_id,tiktok_username', ignoreDuplicates: true });

      if (upsertErr) console.error('[outreach/discover] Upsert error:', upsertErr.message);
    }

    // Update campaign creator count
    await supabase
      .from('outreach_campaigns')
      .update({
        creators_found: outreachCampaign.creators_found + creators.length,
        updated_at:     new Date().toISOString(),
      })
      .eq('id', req.params.id);

    res.json({ ok: true, creators_found: creators.length });

  } catch (err) {
    console.error('[outreach/discover]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/outreach/campaigns/:id/send-dms ────────────────────────────────
// Send DMs to pending creators using available outreach accounts
router.post('/campaigns/:id/send-dms', requireCampaignToken, async (req, res) => {
  if (!APIFY_TOKEN) {
    return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not configured' });
  }

  const artistId = req.campaign.artist_id;

  // Get outreach campaign
  const { data: outreachCampaign } = await supabase
    .from('outreach_campaigns')
    .select('*')
    .eq('id', req.params.id)
    .eq('artist_id', artistId)
    .single();

  if (!outreachCampaign) return res.status(404).json({ ok: false, error: 'Not found' });

  // Get active outreach accounts for this artist
  const { data: accounts } = await supabase
    .from('tiktok_outreach_accounts')
    .select('*')
    .eq('artist_id', artistId)
    .eq('active', true);

  if (!accounts || accounts.length === 0) {
    return res.status(400).json({ ok: false, error: 'No TikTok accounts connected. Add an account first.' });
  }

  // Get uncontacted creators
  const batchSize = accounts.reduce((sum, a) => sum + a.daily_limit, 0);
  const { data: contacts } = await supabase
    .from('outreach_contacts')
    .select('*')
    .eq('outreach_campaign_id', req.params.id)
    .eq('dm_sent', false)
    .limit(batchSize);

  if (!contacts || contacts.length === 0) {
    return res.json({ ok: true, sent: 0, message: 'No pending creators to contact' });
  }

  // Distribute contacts across accounts
  let accountIndex  = 0;
  let dmsSent       = 0;
  const results     = [];

  for (const contact of contacts) {
    const account = accounts[accountIndex % accounts.length];

    // Generate personalized DM for this creator
    const dmText = await personalizeMessage(
      outreachCampaign.dm_template,
      contact,
      req.campaign
    );

    // Trigger Apify DM actor
    try {
      const runRes = await fetch(
        `https://api.apify.com/v2/acts/~runsound-tiktok-dm-sender/runs?token=${APIFY_TOKEN}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionCookies:  JSON.parse(account.session_cookies),
            targetUsername:  contact.tiktok_username,
            message:         dmText,
          }),
        }
      );

      const run = await runRes.json();
      const runId = run.data?.id || run.id;

      // Mark as sent immediately (actor runs async)
      await supabase
        .from('outreach_contacts')
        .update({
          dm_sent:             true,
          dm_sent_at:          new Date().toISOString(),
          dm_sent_via_account: account.id,
          dm_text:             dmText,
        })
        .eq('id', contact.id);

      results.push({ username: contact.tiktok_username, status: 'sent', run_id: runId });
      dmsSent++;
      accountIndex++;

    } catch (err) {
      console.error(`[outreach/send-dms] Failed for @${contact.tiktok_username}:`, err.message);
      results.push({ username: contact.tiktok_username, status: 'failed', error: err.message });
    }

    // Small delay between requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 1500));
  }

  // Update campaign stats
  await supabase
    .from('outreach_campaigns')
    .update({
      dms_sent:   outreachCampaign.dms_sent + dmsSent,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id);

  // Update account last_used_at
  await supabase
    .from('tiktok_outreach_accounts')
    .update({ last_used_at: new Date().toISOString() })
    .in('id', accounts.map(a => a.id));

  res.json({ ok: true, sent: dmsSent, results });
});

// ─── GET /api/outreach/campaigns/:id/contacts ─────────────────────────────────
router.get('/campaigns/:id/contacts', requireCampaignToken, async (req, res) => {
  const page  = parseInt(req.query.page  || '1');
  const limit = parseInt(req.query.limit || '50');
  const filter = req.query.filter; // 'pending' | 'sent' | 'replied' | 'used_sound'

  let query = supabase
    .from('outreach_contacts')
    .select('*', { count: 'exact' })
    .eq('outreach_campaign_id', req.params.id)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (filter === 'pending')    query = query.eq('dm_sent', false);
  if (filter === 'sent')       query = query.eq('dm_sent', true).eq('replied', false);
  if (filter === 'replied')    query = query.eq('replied', true);
  if (filter === 'used_sound') query = query.eq('sound_used', true);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, contacts: data, total: count, page, limit });
});

// ─── POST /api/outreach/accounts ──────────────────────────────────────────────
// Connect a new TikTok outreach account
router.post('/accounts', requireCampaignToken, async (req, res) => {
  const { tiktok_username, session_cookies } = req.body;

  if (!tiktok_username || !session_cookies) {
    return res.status(400).json({ ok: false, error: 'tiktok_username and session_cookies required' });
  }

  // Validate session_cookies is valid JSON
  try { JSON.parse(session_cookies); } catch {
    return res.status(400).json({ ok: false, error: 'session_cookies must be valid JSON' });
  }

  const { data, error } = await supabase
    .from('tiktok_outreach_accounts')
    .upsert({
      artist_id:       req.campaign.artist_id,
      tiktok_username: tiktok_username.replace('@', ''),
      session_cookies,
      active:          true,
    }, { onConflict: 'artist_id,tiktok_username' })
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, account: { id: data.id, tiktok_username: data.tiktok_username, daily_limit: data.daily_limit } });
});

// ─── GET /api/outreach/accounts ───────────────────────────────────────────────
router.get('/accounts', requireCampaignToken, async (req, res) => {
  const { data, error } = await supabase
    .from('tiktok_outreach_accounts')
    .select('id, tiktok_username, tiktok_user_id, daily_limit, active, last_used_at, created_at')
    .eq('artist_id', req.campaign.artist_id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const total_daily = (data || []).filter(a => a.active).reduce((s, a) => s + a.daily_limit, 0);
  res.json({ ok: true, accounts: data || [], total_daily_dms: total_daily });
});

// ─── DELETE /api/outreach/accounts/:accountId ─────────────────────────────────
router.delete('/accounts/:accountId', requireCampaignToken, async (req, res) => {
  const { error } = await supabase
    .from('tiktok_outreach_accounts')
    .update({ active: false })
    .eq('id', req.params.accountId)
    .eq('artist_id', req.campaign.artist_id);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ─── Helper: Generate DM template with GPT ────────────────────────────────────
async function generateDmTemplate(campaign, categories) {
  const catStr = categories.slice(0, 3).join(', ');
  const prompt = `You are helping a music artist reach out to TikTok creators to use their new song.

Artist: ${campaign.artist_name}
Song: "${campaign.song_title}"
Genre: ${campaign.genre || 'music'}
Target creator niches: ${catStr}

Write a short, natural DM template (2-3 sentences max).
Use {{creator_name}} as placeholder for their name.
Use {{category}} for their content category.
Sound genuine, not spammy. Mention they could get paid if they use it.
Write in English. Keep it casual and direct.`;

  const resp = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    max_tokens:  200,
    messages: [{ role: 'user', content: prompt }],
  });

  return resp.choices[0].message.content.trim();
}

// ─── Helper: Personalize DM per creator ──────────────────────────────────────
async function personalizeMessage(template, contact, campaign) {
  if (!template) return `Hey ${contact.display_name || contact.tiktok_username}! We think our new track "${campaign.song_title}" would be perfect for your content. There's budget available if you use it — interested?`;

  const name     = contact.display_name || contact.tiktok_username;
  const category = contact.content_categories?.[0] || 'content';

  // Simple template substitution first
  let msg = template
    .replace(/\{\{creator_name\}\}/gi, name)
    .replace(/\{\{category\}\}/gi, category)
    .replace(/\{\{song\}\}/gi, campaign.song_title)
    .replace(/\{\{artist\}\}/gi, campaign.artist_name);

  // If bio gives us extra context, use GPT to refine
  if (contact.bio && contact.bio.length > 20) {
    const prompt = `Personalize this DM based on the creator's bio. Keep it under 3 sentences. Sound human.

DM template: "${msg}"
Creator's TikTok bio: "${contact.bio.slice(0, 200)}"

Return ONLY the personalized DM, no quotes.`;

    try {
      const resp = await openai.chat.completions.create({
        model:       'gpt-4o-mini',
        max_tokens:  150,
        messages: [{ role: 'user', content: prompt }],
      });
      msg = resp.choices[0].message.content.trim();
    } catch (err) {
      console.warn('[outreach] GPT personalization failed, using template:', err.message);
    }
  }

  return msg;
}

module.exports = router;
