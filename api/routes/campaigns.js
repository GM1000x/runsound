/**
 * Campaigns router — Fastlane-style bulk generation + content queue
 *
 * POST /api/campaigns/:id/generate-batch
 *   Generates N posts at once and stores them in the scheduled_posts queue.
 *   No TikTok posting yet — just fills the calendar. Artist reviews + approves.
 *
 * GET  /api/campaigns/:id/queue
 *   Returns all scheduled_posts for this campaign (pending, approved, posted).
 *
 * PATCH /api/campaigns/:id/queue/:postId
 *   Update a post in the queue (approve, reschedule, change caption, delete).
 *
 * POST /api/campaigns/:id/queue/:postId/post-now
 *   Immediately post a queued item to TikTok (calls existing posting logic).
 *
 * All routes require ?token= matching campaigns.dash_token.
 */

const express   = require('express');
const router    = express.Router({ mergeParams: true });
const supabase  = require('../db');
const OpenAI    = require('openai');
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { TEMPLATES, scoreTemplateForGenre } = require('./templates');

// ─── Auth middleware ───────────────────────────────────────────────────────────
async function requireToken(req, res, next) {
  const token = req.query.token || req.headers['x-dashboard-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, artist_id, artist_name, song_title, genre, hook_weights')
    .eq('dash_token', token)
    .eq('active', true)
    .single();

  if (!campaign) return res.status(401).json({ ok: false, error: 'Invalid token' });
  if (campaign.id !== req.params.id) return res.status(403).json({ ok: false, error: 'Token mismatch' });

  req.campaign = campaign;
  next();
}

// ─── POST /api/campaigns/:id/generate-batch ───────────────────────────────────
router.post('/:id/generate-batch', requireToken, async (req, res) => {
  const { campaign } = req;
  const {
    count        = 7,        // how many posts to generate (default: 1 week)
    template_id  = null,     // force a specific template (null = auto-pick)
    start_date   = null,     // ISO date string for first post (default: tomorrow)
    platform     = 'tiktok',
    time_of_day  = '18:00',  // local time for scheduled posts
  } = req.body;

  const batchSize = Math.min(Math.max(1, parseInt(count)), 30); // cap at 30

  try {
    // ── 1. Fetch latest trending hooks from Supabase ─────────────────────────
    const { data: trendRow } = await supabase
      .from('trending_hooks')
      .select('hooks, week_insight, visual_formats, visual_insight')
      .order('week_of', { ascending: false })
      .limit(1)
      .single();

    const trendingHooks    = trendRow?.hooks          || [];
    const trendingVisuals  = trendRow?.visual_formats || [];

    // ── 2. Pick template ──────────────────────────────────────────────────────
    let template;
    if (template_id) {
      template = TEMPLATES.find(t => t.id === template_id);
      if (!template) return res.status(400).json({ ok: false, error: `Unknown template: ${template_id}` });
    } else {
      // Auto-select: score all templates for this genre
      template = TEMPLATES
        .map(t => ({ ...t, _score: scoreTemplateForGenre(t, campaign.genre) }))
        .sort((a, b) => b._score - a._score)[0];
    }

    // ── 3. Fetch artist data ──────────────────────────────────────────────────
    const { data: artist } = await supabase
      .from('artists')
      .select('id, name, bio, genre, image_url')
      .eq('id', campaign.artist_id)
      .single();

    // ── 4. Generate N sets of hook texts with GPT ─────────────────────────────
    const trendContext = trendingHooks.length > 0
      ? `\n\nThis week's top TikTok hook patterns (adapt these for music):\n` +
        trendingHooks.slice(0, 4).map((h, i) =>
          `${i+1}. ${h.name}: "${h.template}" (e.g. "${h.music_example}")`
        ).join('\n')
      : '';

    const prompt = `You are a music marketing expert creating TikTok content for a music artist.

Artist: ${artist?.name || campaign.artist_name}
Song: ${campaign.song_title}
Genre: ${campaign.genre || 'indie'}
Visual template: ${template.name} — ${template.description}${trendContext}

Generate ${batchSize} unique sets of hook text for TikTok carousel posts. Each set has 4 slides:
- Slide 1 (hook): grab attention in 1 line — stop the scroll
- Slide 2 (build): deepen the feeling or story — 1–2 lines
- Slide 3 (payoff): the emotional peak — 1 line
- Slide 4 (cta): call to action — link in bio / stream now / follow

Rules:
- Each of the ${batchSize} sets must use a different angle/emotion/hook type
- No two sets should feel similar
- Keep each slide under 10 words
- Match the tone to: ${template.name} visual style
- The CTA (slide 4) should feel earned, not pushed

Respond ONLY with valid JSON:
{
  "posts": [
    {
      "archetype": "mystery",
      "slides": ["hook text here", "build text here", "payoff text here", "Link in bio 🎵"],
      "caption": "Full TikTok caption with hashtags (under 150 chars)",
      "hook_text": "First slide text (for DB indexing)"
    }
  ]
}`;

    const gptRes = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.85,
      max_tokens:      3000,
      response_format: { type: 'json_object' },
    });

    const generated = JSON.parse(gptRes.choices[0].message.content);
    const posts     = generated.posts || [];

    // ── 5. Build scheduled times ──────────────────────────────────────────────
    const baseDate = start_date ? new Date(start_date) : new Date();
    if (!start_date) baseDate.setDate(baseDate.getDate() + 1); // start tomorrow
    const [hh, mm] = time_of_day.split(':').map(Number);

    // ── 6. Insert into scheduled_posts ───────────────────────────────────────
    const rows = posts.slice(0, batchSize).map((post, i) => {
      const scheduledFor = new Date(baseDate);
      scheduledFor.setDate(scheduledFor.getDate() + i);
      scheduledFor.setHours(hh, mm, 0, 0);

      return {
        campaign_id:   campaign.id,
        artist_id:     campaign.artist_id,
        scheduled_for: scheduledFor.toISOString(),
        status:        'pending',
        hook_text:     post.hook_text || post.slides?.[0] || '',
        caption:       post.caption   || '',
        template_id:   template.id,
        image_urls:    null, // populated later by build-image step or template renderer
        platform:      platform,
        created_at:    new Date().toISOString(),
      };
    });

    const { data: inserted, error: insertErr } = await supabase
      .from('scheduled_posts')
      .insert(rows)
      .select('id, scheduled_for, status, hook_text, template_id');

    if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

    // ── 7. Merge slide data back for response (not stored in DB yet) ──────────
    const enriched = inserted.map((row, i) => ({
      ...row,
      slides:    posts[i]?.slides   || [],
      caption:   posts[i]?.caption  || '',
      archetype: posts[i]?.archetype || 'unknown',
      template:  { id: template.id, name: template.name, preview_emoji: template.preview_emoji },
    }));

    res.json({
      ok:          true,
      generated:   enriched.length,
      template:    { id: template.id, name: template.name },
      posts:       enriched,
      trend_used:  trendingHooks.length > 0,
    });

  } catch (err) {
    console.error('[generate-batch]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/campaigns/:id/queue ────────────────────────────────────────────
router.get('/:id/queue', requireToken, async (req, res) => {
  const { status, limit = 30 } = req.query;

  let query = supabase
    .from('scheduled_posts')
    .select('*')
    .eq('campaign_id', req.params.id)
    .order('scheduled_for', { ascending: true })
    .limit(parseInt(limit));

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, posts: data || [] });
});

// ─── PATCH /api/campaigns/:id/queue/:postId ───────────────────────────────────
router.patch('/:id/queue/:postId', requireToken, async (req, res) => {
  const allowed = ['status', 'caption', 'hook_text', 'scheduled_for', 'template_id', 'image_urls'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid fields to update' });
  }

  const { data, error } = await supabase
    .from('scheduled_posts')
    .update(updates)
    .eq('id', req.params.postId)
    .eq('campaign_id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, post: data });
});

// ─── DELETE /api/campaigns/:id/queue/:postId ──────────────────────────────────
router.delete('/:id/queue/:postId', requireToken, async (req, res) => {
  const { error } = await supabase
    .from('scheduled_posts')
    .delete()
    .eq('id', req.params.postId)
    .eq('campaign_id', req.params.id);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ─── GET /api/campaigns/blitz-clips ──────────────────────────────────────────
// Returns trending clips filtered by genre for Blitz Mode.
// Public endpoint — no campaign token required (clips are public inspiration).
router.get('/blitz-clips', async (req, res) => {
  const { genre, limit = 30 } = req.query;

  let query = supabase
    .from('trending_clips')
    .select('id, tiktok_url, cover_url, caption, views, likes, hook_pattern, hook_template, one_liner, genre_tags, format_type, music_fit, week_of')
    .order('views', { ascending: false })
    .limit(parseInt(limit));

  // Filter by genre if provided — check if genre_tags contains the genre
  if (genre) {
    query = query.contains('genre_tags', [genre]);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, clips: data || [] });
});

// ─── POST /api/campaigns/:id/blitz-generate ──────────────────────────────────
// Takes a trending clip and generates an adapted post for this artist's song.
router.post('/:id/blitz-generate', requireToken, async (req, res) => {
  const { campaign } = req;
  const { clip_id, platform = 'tiktok' } = req.body;

  if (!clip_id) return res.status(400).json({ ok: false, error: 'clip_id required' });

  // Fetch the clip
  const { data: clip } = await supabase
    .from('trending_clips')
    .select('*')
    .eq('id', clip_id)
    .single();

  if (!clip) return res.status(404).json({ ok: false, error: 'Clip not found' });

  // Fetch artist data
  const { data: artist } = await supabase
    .from('artists')
    .select('id, name, bio, genre, image_url')
    .eq('id', campaign.artist_id)
    .single();

  const prompt = `You are a music marketing expert. Adapt a proven viral TikTok format for a music artist.

PROVEN FORMAT (${clip.views?.toLocaleString()} views on TikTok):
Caption: "${clip.caption}"
Hook pattern: ${clip.hook_pattern || 'unknown'}
Template: ${clip.hook_template || 'n/a'}
One-liner: ${clip.one_liner || 'n/a'}

ARTIST:
Name: ${artist?.name || campaign.artist_name}
Song: ${campaign.song_title}
Genre: ${campaign.genre || 'indie'}
${artist?.bio ? `Bio: ${artist.bio}` : ''}

Adapt the format above for this artist. Keep what made the original work (the emotional hook, the format structure) but make it feel authentic to this artist and song.

Generate:
1. hook_text: the TikTok caption (adapted hook, max 150 chars)
2. slides: 4 slide texts for a TikTok carousel
   - slide 1: hook line (stop the scroll)
   - slide 2: build (deepen the feeling)
   - slide 3: payoff (emotional peak)
   - slide 4: CTA (stream now / link in bio)
3. why_it_works: one sentence on why this format fits this song
4. archetype: one of [emotional_storyteller, hype_builder, relatable_confession, aesthetic_vibe, fan_connector]

Respond ONLY with valid JSON:
{
  "hook_text": "...",
  "slides": ["...", "...", "...", "..."],
  "why_it_works": "...",
  "archetype": "..."
}`;

  try {
    const gptRes = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.85,
      max_tokens:      600,
      response_format: { type: 'json_object' },
    });

    const generated = JSON.parse(gptRes.choices[0].message.content);

    // Save to scheduled_posts as pending (no scheduled_for = sits in draft)
    const { data: post, error } = await supabase
      .from('scheduled_posts')
      .insert({
        campaign_id:  campaign.id,
        artist_id:    campaign.artist_id,
        status:       'pending',
        hook_text:    generated.hook_text,
        caption:      generated.hook_text,
        platform,
        image_urls:   { slides: generated.slides, source_clip: clip.tiktok_url },
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.json({
      ok:            true,
      post,
      generated,
      source_clip:   {
        id:          clip.id,
        tiktok_url:  clip.tiktok_url,
        cover_url:   clip.cover_url,
        views:       clip.views,
      },
    });

  } catch (err) {
    console.error('[blitz-generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
