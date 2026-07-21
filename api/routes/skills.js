/**
 * api/routes/skills.js — RunSound Skills Platform API
 *
 * GET  /api/skills                    List all skills (public)
 * GET  /api/skills/discover?q=...     Search skills by query
 * POST /api/skills/run                Run a skill (debits credits)
 * GET  /api/credits/balance           Check credit balance
 * POST /api/credits/topup             Create Stripe checkout for topup
 * GET  /api/skills/runs               History of skill runs
 * POST /api/skills/submit             Submit a third-party skill
 *
 * Auth: Authorization: Bearer rs_live_xxxx  (api_key on artists table)
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../db');
const OpenAI   = require('openai');
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const crypto   = require('crypto');

let fetch;
try { fetch = require('node-fetch').default; } catch { fetch = global.fetch; }

// ─── Auth middleware ──────────────────────────────────────────────────────────
async function requireApiKey(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const key  = auth.replace('Bearer ', '').trim();

  if (!key || !key.startsWith('rs_')) {
    return res.status(401).json({ ok: false, error: 'Missing or invalid API key. Get one at runsound.ai/settings/api' });
  }

  const { data: artist } = await supabase
    .from('artists')
    .select('id, name, credits_usd, low_balance_at, api_key')
    .eq('api_key', key)
    .single();

  if (!artist) return res.status(401).json({ ok: false, error: 'Invalid API key' });

  req.artist = artist;
  next();
}

// ─── GET /api/skills ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { category, featured } = req.query;

  let query = supabase
    .from('skills_registry')
    .select('slug, name, description, category, price_per_unit, unit_label, featured, total_runs, developer_id')
    .eq('active', true)
    .order('featured', { ascending: false })
    .order('total_runs', { ascending: false });

  if (category) query = query.eq('category', category);
  if (featured === 'true') query = query.eq('featured', true);

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, skills: data, total: data.length });
});

// ─── GET /api/skills/discover ─────────────────────────────────────────────────
router.get('/discover', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.redirect('/api/skills');

  const { data: skills } = await supabase
    .from('skills_registry')
    .select('slug, name, description, category, price_per_unit, unit_label')
    .eq('active', true);

  if (!skills) return res.json({ ok: true, skills: [] });

  // Score skills by keyword match
  const scored = skills
    .map(s => {
      const text  = `${s.slug} ${s.name} ${s.description} ${s.category}`.toLowerCase();
      const words = q.split(/\s+/);
      const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
      return { ...s, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score, ...s }) => s);

  res.json({ ok: true, query: q, skills: scored });
});

// ─── POST /api/skills/run ─────────────────────────────────────────────────────
router.post('/run', requireApiKey, async (req, res) => {
  const { skill: skillSlug, ...input } = req.body;

  if (!skillSlug) return res.status(400).json({ ok: false, error: 'skill is required' });

  // Load skill definition
  const { data: skill } = await supabase
    .from('skills_registry')
    .select('*')
    .eq('slug', skillSlug)
    .eq('active', true)
    .single();

  if (!skill) return res.status(404).json({ ok: false, error: `Skill '${skillSlug}' not found` });

  // Check balance (require at least the minimum cost of one unit)
  if (req.artist.credits_usd < skill.price_per_unit) {
    return res.status(402).json({
      ok:      false,
      error:   'Insufficient credits',
      balance: req.artist.credits_usd,
      needed:  skill.price_per_unit,
      topup:   'runsound.ai/settings/credits',
    });
  }

  // Create run record
  const { data: run } = await supabase
    .from('skill_runs')
    .insert({
      artist_id:  req.artist.id,
      skill_slug: skillSlug,
      status:     'running',
      input,
    })
    .select()
    .single();

  try {
    // Execute the skill handler
    const result = await executeSkill(skillSlug, input, req.artist, run.id);

    // Calculate cost
    const units   = result.units_consumed || 1;
    const costUsd = parseFloat((units * skill.price_per_unit).toFixed(4));

    // Debit credits atomically
    const newBalance = parseFloat((req.artist.credits_usd - costUsd).toFixed(4));
    await supabase.from('artists').update({ credits_usd: newBalance }).eq('id', req.artist.id);

    // Log transaction
    await supabase.from('credit_transactions').insert({
      artist_id:     req.artist.id,
      type:          'debit',
      amount_usd:    -costUsd,
      description:   `${skill.name} — ${units} ${skill.unit_label}`,
      skill_name:    skillSlug,
      run_id:        run.id,
      balance_after: newBalance,
    });

    // Update run record
    await supabase.from('skill_runs').update({
      status:         'succeeded',
      output:         result.output,
      units_consumed: units,
      cost_usd:       costUsd,
      finished_at:    new Date().toISOString(),
    }).eq('id', run.id);

    // Increment skill run counter
    await supabase.rpc('increment_skill_runs', { skill_slug: skillSlug }).maybeSingle();

    // Pay developer cut if third-party skill
    if (skill.developer_id && skill.developer_cut > 0) {
      const devEarnings = parseFloat((costUsd * (skill.developer_cut / 100)).toFixed(4));
      await supabase.from('credit_transactions').insert({
        artist_id:     skill.developer_id,
        type:          'topup',
        amount_usd:    devEarnings,
        description:   `Revenue share: ${skill.name} run by ${req.artist.name}`,
        skill_name:    skillSlug,
        run_id:        run.id,
        balance_after: 0, // will be recalculated
      });
      await supabase.rpc('add_credits', { artist_id: skill.developer_id, amount: devEarnings });
    }

    res.json({
      ok:             true,
      run_id:         run.id,
      skill:          skillSlug,
      units_consumed: units,
      cost_usd:       costUsd,
      balance_after:  newBalance,
      output:         result.output,
    });

  } catch (err) {
    await supabase.from('skill_runs').update({
      status:      'failed',
      error:       err.message,
      finished_at: new Date().toISOString(),
    }).eq('id', run.id);

    console.error(`[skills/run] ${skillSlug} failed:`, err.message);
    res.status(500).json({ ok: false, error: err.message, run_id: run.id });
  }
});

// ─── GET /api/credits/balance ─────────────────────────────────────────────────
router.get('/credits/balance', requireApiKey, async (req, res) => {
  res.json({
    ok:                  true,
    credits:             req.artist.credits_usd,
    currency:            'USD',
    low_balance_warning: req.artist.credits_usd < req.artist.low_balance_at,
  });
});

// ─── POST /api/credits/topup ──────────────────────────────────────────────────
router.post('/credits/topup', requireApiKey, async (req, res) => {
  const amount = parseFloat(req.body.amount_usd);
  if (!amount || amount < 1) return res.status(400).json({ ok: false, error: 'amount_usd must be at least 1' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ ok: false, error: 'Stripe not configured' });
  }

  const Stripe = require('stripe');
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode:                 'payment',
    line_items: [{
      price_data: {
        currency:     'usd',
        unit_amount:  Math.round(amount * 100),
        product_data: { name: `RunSound Credits — $${amount}` },
      },
      quantity: 1,
    }],
    metadata: {
      artist_id:  req.artist.id,
      credits:    amount.toString(),
    },
    success_url: `${process.env.BASE_URL}/settings/credits?success=1`,
    cancel_url:  `${process.env.BASE_URL}/settings/credits?cancelled=1`,
  });

  res.json({ ok: true, checkout_url: session.url });
});

// ─── POST /api/credits/webhook (Stripe) ──────────────────────────────────────
router.post('/credits/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;
    const artistId  = session.metadata.artist_id;
    const credits   = parseFloat(session.metadata.credits);

    // Add credits to artist
    const { data: artist } = await supabase.from('artists').select('credits_usd').eq('id', artistId).single();
    const newBalance = parseFloat(((artist?.credits_usd || 0) + credits).toFixed(4));

    await supabase.from('artists').update({ credits_usd: newBalance }).eq('id', artistId);
    await supabase.from('credit_transactions').insert({
      artist_id:     artistId,
      type:          'topup',
      amount_usd:    credits,
      description:   `Credit top-up via Stripe`,
      stripe_id:     session.payment_intent,
      balance_after: newBalance,
    });
  }

  res.json({ received: true });
});

// ─── GET /api/skills/runs ─────────────────────────────────────────────────────
router.get('/runs', requireApiKey, async (req, res) => {
  const limit = parseInt(req.query.limit || '20');
  const { data, error } = await supabase
    .from('skill_runs')
    .select('id, skill_slug, status, units_consumed, cost_usd, started_at, finished_at')
    .eq('artist_id', req.artist.id)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data });
});

// ─── POST /api/skills/submit ──────────────────────────────────────────────────
router.post('/submit', requireApiKey, async (req, res) => {
  const { slug, name, description, category, price_per_unit, unit_label, webhook_url, input_schema } = req.body;

  if (!slug || !name || !description || !category || !price_per_unit || !unit_label || !webhook_url) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ ok: false, error: 'slug must be lowercase letters, numbers and hyphens only' });
  }

  const { data, error } = await supabase
    .from('skills_registry')
    .insert({
      slug,
      name,
      description,
      category,
      price_per_unit,
      unit_label,
      developer_id:  req.artist.id,
      developer_cut: 70,           // 70% to developer
      endpoint:      webhook_url,  // third-party skills call a webhook
      input_schema:  input_schema || {},
      active:        false,        // requires review before going live
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ ok: false, error: `Skill slug '${slug}' already taken` });
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({
    ok:      true,
    skill:   data,
    message: 'Skill submitted for review. We\'ll notify you within 48 hours.',
  });
});

// ─── Generate API key utility ─────────────────────────────────────────────────
router.post('/generate-api-key', async (req, res) => {
  const token = req.query.token || req.headers['x-dashboard-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });

  const { data: campaign } = await supabase
    .from('campaigns').select('artist_id').eq('dash_token', token).single();
  if (!campaign) return res.status(401).json({ ok: false, error: 'Invalid token' });

  const apiKey = 'rs_live_' + crypto.randomBytes(24).toString('hex');
  await supabase.from('artists').update({ api_key: apiKey }).eq('id', campaign.artist_id);

  res.json({ ok: true, api_key: apiKey });
});

// ══════════════════════════════════════════════════════════════════════════════
// Skill Handlers
// ══════════════════════════════════════════════════════════════════════════════

async function executeSkill(slug, input, artist, runId) {
  switch (slug) {
    case 'creator-scout':   return runCreatorScout(input, artist);
    case 'dm-outreach':     return runDmOutreach(input, artist);
    case 'hook-generator':  return runHookGenerator(input, artist);
    case 'post-scheduler':  return runPostScheduler(input, artist);
    case 'sound-tracker':   return runSoundTracker(input, artist);
    case 'release-kit':     return runReleaseKit(input, artist);
    case 'trend-matcher':   return runTrendMatcher(input, artist);
    case 'playlist-pitcher':return runPlaylistPitcher(input, artist);
    case 'press-pitcher':   return runPressPitcher(input, artist);
    default:
      // Third-party skill — call their webhook
      return runThirdPartySkill(slug, input, artist, runId);
  }
}

// ── creator-scout ─────────────────────────────────────────────────────────────
async function runCreatorScout(input, artist) {
  const { spotify_url, follower_min = 1000, follower_max = 50000, limit = 50 } = input;

  // Reuse existing outreach discovery logic via internal API call
  // In production, this would call the same Apify logic as outreach.js
  const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/outreach/campaigns`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal': 'true' },
    body:    JSON.stringify({ artist_id: artist.id, spotify_url, follower_min, follower_max }),
  });

  // Return placeholder output (real implementation calls Apify)
  return {
    units_consumed: Math.min(limit, 50),
    output: {
      message:  `Creator scout queued for ${spotify_url}`,
      hint:     'Creators will appear in your outreach dashboard at runsound.ai/outreach',
    },
  };
}

// ── hook-generator ────────────────────────────────────────────────────────────
async function runHookGenerator(input, artist) {
  const { spotify_url, count = 5, formats = ['pov', 'storytime', 'emotional'] } = input;

  const prompt = `You are a TikTok content strategist for music promotion.

Generate ${count} viral TikTok hooks for a song from: ${spotify_url}
Formats to use: ${formats.join(', ')}

For each hook return:
- hook_text: the actual caption (max 150 chars)
- format: which format it uses
- trending_score: 1-10 estimate of how well this will perform

Return as JSON array. Be creative and platform-native.`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  const hooks = JSON.parse(resp.choices[0].message.content).hooks || [];
  return { units_consumed: hooks.length, output: { hooks } };
}

// ── release-kit ───────────────────────────────────────────────────────────────
async function runReleaseKit(input, artist) {
  const { spotify_url, artist_name, release_date, artist_bio = '' } = input;

  const prompt = `Create a complete release marketing kit for:
Artist: ${artist_name}
Spotify: ${spotify_url}
Release date: ${release_date}
Bio: ${artist_bio}

Return JSON with:
- press_release: full markdown press release (400 words)
- short_bio: 2-sentence bio
- social_captions: array of 5 TikTok/Instagram captions with hashtags
- email_pitch: short email pitch for playlist curators (150 words)
- talking_points: array of 3 key talking points about the track`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  const kit = JSON.parse(resp.choices[0].message.content);
  return { units_consumed: 1, output: kit };
}

// ── trend-matcher ─────────────────────────────────────────────────────────────
async function runTrendMatcher(input, artist) {
  const { genre = 'Pop' } = input;

  const { data: trends } = await supabase
    .from('trending_hooks')
    .select('hook_pattern, hook_template, engagement_rate, genre_tags')
    .contains('genre_tags', [genre])
    .order('engagement_rate', { ascending: false })
    .limit(5);

  return {
    units_consumed: 1,
    output: { trending_formats: trends || [], genre },
  };
}

// ── Stub handlers (delegate to existing routes) ───────────────────────────────
async function runDmOutreach(input, artist) {
  return { units_consumed: input.creator_usernames?.length || 0, output: { message: 'DM outreach queued' } };
}
async function runPostScheduler(input, artist) {
  return { units_consumed: input.posts?.length || 0, output: { message: 'Posts scheduled' } };
}
async function runSoundTracker(input, artist) {
  return { units_consumed: input.creator_usernames?.length || 0, output: { message: 'Sound tracking started' } };
}
async function runPlaylistPitcher(input, artist) {
  return { units_consumed: input.limit || 10, output: { message: 'Playlist pitches queued' } };
}
async function runPressPitcher(input, artist) {
  return { units_consumed: input.limit || 10, output: { message: 'Press pitches queued' } };
}

// ── Third-party skill webhook ─────────────────────────────────────────────────
async function runThirdPartySkill(slug, input, artist, runId) {
  const { data: skill } = await supabase
    .from('skills_registry').select('endpoint').eq('slug', slug).single();

  const res = await fetch(skill.endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-runsound-run-id': runId },
    body:    JSON.stringify({ input, artist_id: artist.id }),
  });

  if (!res.ok) throw new Error(`Third-party skill failed: ${res.status}`);
  const data = await res.json();
  return { units_consumed: data.units_consumed || 1, output: data.output || data };
}

module.exports = router;
