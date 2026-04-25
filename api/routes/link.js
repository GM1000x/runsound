/**
 * GET /api/link/:slug
 *
 * Returns smart link data for a campaign.
 * Called by the smart link page (web/link.html) to get
 * streaming URLs, artwork, and song info dynamically.
 *
 * Also handles the short URL redirect:
 *   GET /l/:slug  → renders the smart link page with pre-filled data
 *
 * Response:
 *   {
 *     ok: true,
 *     artist, song, artworkUrl,
 *     platforms: { spotify, apple, youtube, tidal, deezer, amazon, soundcloud }
 *   }
 */
const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const supabase = require('../db');

// GET /api/link/:slug — JSON data
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select(`
        slug, artist_name, song_title, artwork_url,
        spotify_url, apple_url, youtube_url, tidal_url,
        deezer_url, amazon_url, soundcloud_url, active
      `)
      .eq('slug', slug)
      .eq('active', true)
      .single();

    if (error || !campaign) {
      return res.status(404).json({ ok: false, error: 'Campaign not found' });
    }

    return res.json({
      ok:         true,
      artist:     campaign.artist_name,
      song:       campaign.song_title,
      artworkUrl: campaign.artwork_url || null,
      platforms: {
        spotify:    campaign.spotify_url    || null,
        apple:      campaign.apple_url      || null,
        youtube:    campaign.youtube_url    || null,
        tidal:      campaign.tidal_url      || null,
        deezer:     campaign.deezer_url     || null,
        amazon:     campaign.amazon_url     || null,
        soundcloud: campaign.soundcloud_url || null,
      },
    });

  } catch (err) {
    console.error('[link] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
