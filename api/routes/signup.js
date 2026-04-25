/**
 * POST /api/signup
 *
 * Registers a new artist and creates their first campaign.
 * Called by the signup form on web/index.html.
 *
 * Body:
 *   artist   string  Artist name
 *   song     string  Song title
 *   genre    string  Genre
 *   spotify  string  Spotify URL
 *   hooks    string  Newline-separated hook lines
 *   email    string  Artist email
 *
 * Response:
 *   { ok: true, slug, smartLinkUrl }
 *   { ok: false, error }
 */
const express  = require('express');
const router   = express.Router();
const supabase = require('../db');

// Slugify: "Carly Rae Jepsen — Summer Love" → "carly-rae-jepsen-summer-love"
function slugify(artist, song) {
  return `${artist}-${song}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Build the campaign config.json structure (used by pipeline scripts)
function buildConfig(data) {
  const hookLines = data.hooks
    ? data.hooks.split('\n').map(l => l.trim()).filter(Boolean)
    : [];

  return {
    artist: {
      name:     data.artist,
      tiktokId: null,  // Artist fills this in later
    },
    song: {
      title:     data.song,
      genre:     data.genre || 'pop',
      mood:      'emotional, authentic',
      hookLines,
    },
    streaming: {
      spotify:    data.spotify    || null,
      apple:      data.apple      || null,
      youtube:    data.youtube    || null,
      tidal:      data.tidal      || null,
      deezer:     data.deezer     || null,
      amazon:     data.amazon     || null,
      soundcloud: data.soundcloud || null,
    },
    imageGen: {
      model:  'dall-e-3',
      style:  'cinematic photography, moody, film grain, 35mm',
      count:  18,
    },
    posting: {
      schedule: '0 3 * * *',
      timezone: 'Europe/Stockholm',
    },
  };
}

router.post('/', async (req, res) => {
  try {
    const { artist, song, genre, spotify, hooks, email } = req.body;

    if (!artist || !song || !email) {
      return res.status(400).json({ ok: false, error: 'artist, song and email are required' });
    }

    // ── 1. Upsert artist ───────────────────────────────────────────────────────
    let artistRow;
    const { data: existingArtist } = await supabase
      .from('artists')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (existingArtist) {
      artistRow = existingArtist;
    } else {
      const { data: newArtist, error: artistErr } = await supabase
        .from('artists')
        .insert({
          email:  email.toLowerCase().trim(),
          name:   artist,
          plan:   'starter',
          status: 'trial',
        })
        .select()
        .single();

      if (artistErr) throw artistErr;
      artistRow = newArtist;
    }

    // ── 2. Create campaign ─────────────────────────────────────────────────────
    const baseSlug = slugify(artist, song);

    // Ensure slug is unique
    let slug = baseSlug;
    let suffix = 1;
    while (true) {
      const { data: existing } = await supabase
        .from('campaigns')
        .select('id')
        .eq('slug', slug)
        .single();
      if (!existing) break;
      slug = `${baseSlug}-${++suffix}`;
    }

    const hookLines = hooks
      ? hooks.split('\n').map(l => l.trim()).filter(Boolean)
      : [];

    const config = buildConfig({ artist, song, genre, spotify, hooks });
    const smartLinkUrl = `${process.env.BASE_URL || 'https://runsound.fm'}/l/${slug}`;

    const { data: campaign, error: campaignErr } = await supabase
      .from('campaigns')
      .insert({
        artist_id:     artistRow.id,
        slug,
        artist_name:   artist,
        song_title:    song,
        genre:         genre || null,
        spotify_url:   spotify || null,
        hook_lines:    hookLines,
        config,
        smart_link_url: smartLinkUrl,
        active:        true,
      })
      .select()
      .single();

    if (campaignErr) throw campaignErr;

    console.log(`[signup] New campaign: ${slug} (artist: ${email})`);

    return res.json({
      ok:           true,
      slug,
      smartLinkUrl,
      campaignId:   campaign.id,
    });

  } catch (err) {
    console.error('[signup] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
