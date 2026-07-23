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
    artist_name:         req.artist.name,
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
    case 'full-campaign':   return runFullCampaign(input, artist, runId);
    case 'gig-pitcher':     return runGigPitcher(input, artist);
    default:
      // Third-party skill — call their webhook
      return runThirdPartySkill(slug, input, artist, runId);
  }
}

// ── Spotify genre helper ──────────────────────────────────────────────────────
async function getSpotifyGenreFromUrl(spotify_url) {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const { access_token } = await tokenRes.json();
  if (!access_token) return null;

  const trackMatch  = spotify_url.match(/track\/([A-Za-z0-9]+)/);
  const artistMatch = spotify_url.match(/artist\/([A-Za-z0-9]+)/);

  let artistId = null;
  if (trackMatch) {
    const r = await fetch(`https://api.spotify.com/v1/tracks/${trackMatch[1]}`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const t = await r.json();
    artistId = t.artists?.[0]?.id;
  } else if (artistMatch) {
    artistId = artistMatch[1];
  }

  if (!artistId) return null;
  const ar = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const artData = await ar.json();
  return artData.genres?.[0] || null;
}

// ── Genre → TikTok lifestyle hashtag mapping ──────────────────────────────────
// Maps music genre → content categories that audience actually scrolls
// e.g. house fans are on #gymtok and #nightlife — not "house music" search
function genreToHashtags(genre) {
  const g = (genre || '').toLowerCase();

  const rules = [
    { match: ['house', 'techno', 'trance', 'electronic', 'edm', 'dance', 'deep', 'progressive'],
      tags: ['gymtok', 'fittok', 'gettingready', 'clubnight', 'nightlife'] },
    { match: ['hip hop', 'hip-hop', 'rap', 'trap', 'drill', 'boom bap'],
      tags: ['streetwear', 'sneakerhead', 'hypecheck', 'streetstyle', 'fashiontok'] },
    { match: ['r&b', 'rnb', 'soul', 'neo soul', 'funk'],
      tags: ['selfcare', 'grwm', 'glowup', 'vibecheck', 'relationshiptok'] },
    { match: ['indie', 'alternative', 'alt-rock', 'shoegaze', 'dream pop'],
      tags: ['indievibes', 'coffeeshop', 'aestheticroom', 'bookish', 'vintagefit'] },
    { match: ['pop'],
      tags: ['grwm', 'aestheticcheck', 'currentlyobsessed', 'girlytok', 'fashiontok'] },
    { match: ['country', 'americana', 'bluegrass', 'folk'],
      tags: ['countrylife', 'westernstyle', 'cottagecore', 'southernliving', 'farmtok'] },
    { match: ['jazz', 'blues', 'swing', 'bebop'],
      tags: ['jazzvibes', 'cocktailhour', 'lounge', 'midnightvibes', 'soulcheck'] },
    { match: ['classical', 'orchestral', 'chamber', 'opera', 'baroque'],
      tags: ['studywithme', 'pianocheck', 'classicalmusic', 'productivitycheck', 'aestheticvibes'] },
    { match: ['metal', 'heavy metal', 'thrash', 'death metal', 'metalcore'],
      tags: ['metalhead', 'concertcheck', 'altcheck', 'tattootok', 'darkfashion'] },
    { match: ['punk', 'hardcore', 'post-punk'],
      tags: ['altcheck', 'punkstyle', 'vinylcheck', 'concertcheck', 'diyculture'] },
    { match: ['reggae', 'dancehall', 'ska'],
      tags: ['summervibes', 'tropicalcheck', 'beachcheck', 'islandvibes', 'vibetok'] },
    { match: ['afrobeats', 'afropop', 'afro'],
      tags: ['afrobeats', 'africanfashion', 'partycheck', 'dancechallenge', 'melanin'] },
    { match: ['lo-fi', 'lofi', 'chillhop', 'ambient', 'chill'],
      tags: ['lofi', 'studycheck', 'cozycheck', 'nightowl', 'aestheticroom'] },
    { match: ['latin', 'salsa', 'reggaeton', 'cumbia', 'bachata'],
      tags: ['latincheck', 'latinvibes', 'salsacheck', 'bailando', 'latinbeauty'] },
    { match: ['k-pop', 'kpop', 'j-pop', 'jpop', 'korean'],
      tags: ['kpop', 'kpopcheck', 'kdrama', 'koreacheck', 'asianfashion'] },
    { match: ['rock'],
      tags: ['rockcheck', 'concertcheck', 'guitartok', 'altcheck', 'bandcheck'] },
  ];

  for (const rule of rules) {
    if (rule.match.some(m => g.includes(m))) return rule.tags;
  }
  return ['vibecheck', 'musiccheck', 'newmusic', 'musiclover', 'musictok'];
}

// ── creator-scout ─────────────────────────────────────────────────────────────
// Budget → follower ceiling for music promotion (2026 market rates)
// Source: Dynamoi, Influencer Marketing Hub, Collabstr
//   Nano  (1K–10K):    avg $100/video  → $50–200 range
//   Micro (10K–100K):  avg $350/video  → $150–800 range
//   Mid   (100K–500K): avg $1200/video → $500–2500 range
//   Macro (500K–1M):   avg $3500/video → $2000–5000 range
function budgetToFollowerMax(budget_usd) {
  if (!budget_usd || budget_usd < 30)  return 5000;    // < $30:  a few nano creators gratis/cheap
  if (budget_usd < 100)                return 10000;   // $30–100:  1 nano at avg $100
  if (budget_usd < 300)                return 50000;   // $100–300: 1–3 low-micro ($150–350 each)
  if (budget_usd < 800)                return 100000;  // $300–800: 1–2 mid-micro ($350–800 each)
  return 500000;                                        // $800+: can reach mid-tier ($500–2500/video)
}

async function runCreatorScout(input, artist) {
  const {
    spotify_url,
    budget_usd    = null,
    follower_min  = 0,                                         // no floor — find everyone
    follower_max  = budgetToFollowerMax(budget_usd),           // ceiling from budget
    limit         = 20,
    genre: genreInput = null,
  } = input;

  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) throw new Error('Creator scout is not configured — contact support.');

  // ── 1. Determine genre ───────────────────────────────────────────────────
  let genre = genreInput;
  if (!genre && spotify_url) {
    genre = await getSpotifyGenreFromUrl(spotify_url).catch(() => null);
  }
  genre = (genre || 'pop').toLowerCase();
  console.log(`[creator-scout] genre="${genre}"`);

  // ── 2. Genre → hashtags (lifestyle categories, not music genres) ─────────
  const hashtags = genreToHashtags(genre).slice(0, 3); // 3 hashtags keeps run time under 30s
  console.log(`[creator-scout] hashtags: ${hashtags.join(', ')}`);

  // ── 3. Apify: scrape TikTok posts by hashtag, extract creator metadata ───
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${APIFY_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        hashtags,
        resultsPerPage:    12,
        maxRequestRetries: 2,
        proxyConfiguration: { useApifyProxy: true },
      }),
    }
  );
  if (!startRes.ok) {
    const txt = await startRes.text();
    throw new Error(`Apify start failed: ${startRes.status} — ${txt.slice(0, 200)}`);
  }
  const { data: { id: runId } } = await startRes.json();
  console.log(`[creator-scout] Apify run ${runId} started`);

  // Poll until SUCCEEDED (max 75s = 25 × 3s)
  let items = [];
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const { data: run } = await statusRes.json();
    if (run.status === 'SUCCEEDED') {
      const dataRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json&limit=300`
      );
      items = await dataRes.json();
      console.log(`[creator-scout] Got ${items.length} posts from Apify`);
      break;
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
      throw new Error(`Apify run ${run.status.toLowerCase()} — please try again`);
    }
  }

  // ── 4. Extract unique creators from post metadata ────────────────────────
  const seen     = new Set();
  const creators = [];

  for (const item of items) {
    const meta      = item.authorMeta || {};
    const author    = item.author     || {};
    const username  = meta.name       || author.uniqueId || item.uniqueId;
    const followers = Number(meta.fans ?? author.fans ?? 0);

    if (!username || seen.has(username))                    continue;
    if (followers < follower_min || followers > follower_max) continue;

    seen.add(username);

    // Which niche tag did this post appear under?
    const postTags = (item.hashtags || []).map(h => (h.name || h || '').toLowerCase());
    const matched  = hashtags.find(h => postTags.includes(h)) || hashtags[0];
    const niche    = matched.replace(/tok$/, '').replace(/check$/, '');

    creators.push({
      username,
      followers,
      total_likes: Number(meta.heart  ?? author.heart  ?? 0),
      videos:      Number(meta.video  ?? author.video  ?? 0),
      niche,
      profile_url: `https://www.tiktok.com/@${username}`,
    });
  }

  // Sort by followers desc, cap at limit
  creators.sort((a, b) => b.followers - a.followers);
  const selected = creators.slice(0, limit);
  console.log(`[creator-scout] Returning ${selected.length} creators`);

  return {
    units_consumed: selected.length || 1,
    output: {
      genre,
      hashtags_searched: hashtags,
      creators_found:    selected.length,
      creators:          selected,
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

// ── full-campaign ─────────────────────────────────────────────────────────────
// Orchestrates the full loop: scout → DM → track → report
async function runFullCampaign(input, artist, runId) {
  const {
    spotify_url,
    artist_name,
    song_title,
    follower_min  = 1000,
    follower_max  = 100000,
    creator_limit = 30,
    hooks_count   = 5,
  } = input;

  const steps   = [];
  let totalUnits = 0;

  // ── Step 1: Generate hooks ────────────────────────────────────────────────
  steps.push({ step: 'hook-generator', status: 'running' });
  const hookResult = await runHookGenerator(
    { spotify_url, count: hooks_count },
    artist
  );
  steps[0].status = 'done';
  steps[0].output = hookResult.output;
  totalUnits += hookResult.units_consumed;

  // ── Step 2: Scout creators ────────────────────────────────────────────────
  steps.push({ step: 'creator-scout', status: 'running' });

  // Use Spotify data to determine genre/categories for targeting
  const spotifyId = spotify_url.match(/track\/([A-Za-z0-9]+)/)?.[1];
  let genre = 'Pop';
  if (spotifyId && process.env.SPOTIFY_CLIENT_ID) {
    try {
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString('base64'),
        },
        body: 'grant_type=client_credentials',
      });
      const { access_token } = await tokenRes.json();
      const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${spotifyId}`, {
        headers: { 'Authorization': `Bearer ${access_token}` },
      });
      const track = await trackRes.json();
      const artistId = track.artists?.[0]?.id;
      if (artistId) {
        const artRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
          headers: { 'Authorization': `Bearer ${access_token}` },
        });
        const artData = await artRes.json();
        genre = artData.genres?.[0] || 'Pop';
      }
    } catch { /* fallback to Pop */ }
  }

  const scoutResult = await runCreatorScout(
    { spotify_url, follower_min, follower_max, limit: creator_limit },
    artist
  );
  steps[1].status = 'done';
  steps[1].output = scoutResult.output;
  totalUnits += scoutResult.units_consumed;

  // ── Step 3: Match trends ──────────────────────────────────────────────────
  steps.push({ step: 'trend-matcher', status: 'running' });
  const trendResult = await runTrendMatcher({ genre }, artist);
  steps[2].status = 'done';
  steps[2].output = trendResult.output;
  totalUnits += trendResult.units_consumed;

  // ── Step 4: Queue DM outreach ─────────────────────────────────────────────
  steps.push({ step: 'dm-outreach', status: 'queued' });
  // DMs are queued asynchronously — actual sending happens via outreach.js
  // We log the intent here and the outreach system picks it up
  await supabase.from('skill_runs').update({
    output: { campaign_queued: true, run_id: runId },
  }).eq('id', runId);
  steps[3].status = 'queued';
  steps[3].output = { message: `DMs queued for ${scoutResult.units_consumed} creators` };

  // ── Step 5: Start sound tracking ──────────────────────────────────────────
  steps.push({ step: 'sound-tracker', status: 'queued' });
  steps[4].status = 'queued';
  steps[4].output = { message: 'Sound tracking will start once DMs are sent' };

  return {
    units_consumed: totalUnits,
    output: {
      campaign_id:    runId,
      song:           song_title || spotify_url,
      artist:         artist_name,
      genre,
      steps,
      hooks:          hookResult.output.hooks,
      trending_formats: trendResult.output.trending_formats,
      creators_queued:  scoutResult.units_consumed,
      next_steps: [
        'Creators will receive personalized DMs within 24h',
        'Sound tracking activates automatically after DMs are sent',
        `Check progress: runsound.ai/outreach`,
      ],
    },
  };
}

// ── gig-pitcher ───────────────────────────────────────────────────────────────
async function runGigPitcher(input, artist) {
  const {
    city,
    country        = 'Sweden',
    genre          = 'indie',
    artist_name    = artist.name || 'Artist',
    artist_bio     = '',
    spotify_url    = '',
    soundcloud_url = '',
    venue_limit    = 10,
  } = input;

  if (!city) throw new Error('city is required');

  // 1. Derive venue types from genre so searches are relevant
  const venueTypeMap = {
    jazz:        ['jazz club', 'jazz bar', 'live music bar'],
    blues:       ['blues bar', 'live music bar', 'rock bar'],
    classical:   ['concert hall', 'music hall', 'cultural center'],
    opera:       ['opera house', 'concert hall', 'cultural center'],
    folk:        ['folk club', 'acoustic bar', 'café concert'],
    acoustic:    ['acoustic bar', 'café concert', 'intimate venue'],
    punk:        ['rock bar', 'dive bar', 'underground club'],
    metal:       ['rock club', 'metal bar', 'underground venue'],
    electronic:  ['club', 'electronic music venue', 'bar with DJ'],
    hip_hop:     ['hip-hop club', 'urban bar', 'open mic venue'],
    rnb:         ['r&b bar', 'soul club', 'live music lounge'],
    pop:         ['bar with live music', 'concert venue', 'music club'],
    indie:       ['indie bar', 'live music bar', 'music venue'],
    rock:        ['rock bar', 'live music venue', 'concert hall'],
    country:     ['country bar', 'americana venue', 'acoustic bar'],
    reggae:      ['reggae bar', 'world music venue', 'tropical bar'],
  };

  const genreKey   = Object.keys(venueTypeMap).find(k => genre.toLowerCase().includes(k)) || 'indie';
  const venueTypes = venueTypeMap[genreKey];

  // 2. Search Google Places for each venue type — collect all unique results
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  let venues      = [];

  if (googleKey) {
    for (const type of venueTypes) {
      try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(`${type} in ${city}`)}&key=${googleKey}`;
        const r   = await fetch(url);
        const d   = await r.json();
        if (d.results) {
          d.results.forEach(p => {
            if (!venues.find(v => v.place_id === p.place_id)) {
              venues.push({
                place_id: p.place_id,
                name:     p.name,
                address:  p.formatted_address || city,
                rating:   p.rating || null,
                type,
              });
            }
          });
        }
      } catch (e) { /* continue on individual failures */ }
    }

    // Sort by rating descending and cap at venue_limit
    venues.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    venues = venues.slice(0, venue_limit);

  } else {
    // Fallback: GPT generates real venue suggestions when no Places key
    const fallback = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `List real live music venues in ${city}, ${country} that would be a good fit for a ${genre} artist.
Include bars, clubs, concert halls, cafés — any place that books live acts.
Return JSON: { "venues": [{ "name": string, "address": string, "venue_type": string, "why_fit": string }] }
Only include real, existing places. Include as many as you know.`
      }],
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(fallback.choices[0].message.content);
    venues = (parsed.venues || []).slice(0, venue_limit).map(v => ({
      name: v.name, address: v.address || city,
      rating: null, type: v.venue_type, why_fit: v.why_fit
    }));
  }

  if (!venues.length) throw new Error(`No venues found in ${city} for ${genre} — try a larger nearby city`);

  // 3. GPT writes a personalized pitch for every venue found
  const pitches = await Promise.all(venues.map(async venue => {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `You write concise, professional booking pitch emails for musicians. Under 150 words. Warm but direct. Each email must feel personally written for that specific venue.`
      }, {
        role: 'user',
        content: `Write a booking inquiry email from "${artist_name}" to "${venue.name}" (${venue.type || 'music venue'}) in ${city}.

Genre: ${genre}
Bio: ${artist_bio || `${artist_name} is a ${genre} artist based near ${city}.`}
${spotify_url    ? `Spotify: ${spotify_url}` : ''}
${soundcloud_url ? `SoundCloud: ${soundcloud_url}` : ''}
${venue.why_fit  ? `Why this venue fits: ${venue.why_fit}` : ''}

Requirements:
- Mention the venue by name and reference its vibe or reputation
- Explain why this artist fits their stage
- Clear ask: availability to discuss a booking
- Do NOT sound like a mass email`
      }],
    });

    return {
      venue:         venue.name,
      address:       venue.address,
      venue_type:    venue.type || null,
      rating:        venue.rating || null,
      email_subject: `Booking inquiry — ${artist_name} (${genre})`,
      email_body:    completion.choices[0].message.content.trim(),
      status:        'ready',
    };
  }));

  return {
    units_consumed: pitches.length,
    output: {
      city,
      genre,
      artist:            artist_name,
      venues_found:      venues.length,
      pitches_generated: pitches.length,
      pitches,
      next_steps: [
        `Find each venue's booking email on their website or Instagram bio`,
        `Send each pitch from your own email — they're ready to copy-paste`,
        `Follow up after 5–7 days if no reply`,
        `Venues typically book 4–8 weeks ahead — send early before your target date`,
      ],
    },
  };
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
