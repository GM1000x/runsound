/**
 * GET /api/spotify/lookup?url=<spotify_track_url>
 *
 * Fetches track metadata from the Spotify Web API and returns everything
 * the signup form needs to auto-fill:
 *   - artist_name
 *   - song_title
 *   - genre (from artist genres — first match)
 *   - artwork_url (highest-res cover image)
 *   - spotify_url (canonical)
 *   - preview_url (30-second clip, if available)
 *   - popularity (0–100)
 *   - release_date
 *   - is_released (true — if we got it from Spotify it's out)
 *
 * Uses Client Credentials flow — no user login required.
 *
 * Env vars required:
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 *
 * If env vars are missing, returns a graceful error so the form
 * falls back to manual entry without crashing.
 */

const express = require('express');
const router  = express.Router();

let fetch;
try { fetch = require('node-fetch').default; } catch { fetch = global.fetch; }

// ─── Spotify token cache (expires after 55 min) ───────────────────────────────
let _token     = null;
let _tokenExp  = 0;

async function getSpotifyToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
  }

  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res   = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);
  const data = await res.json();

  _token    = data.access_token;
  _tokenExp = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s early
  return _token;
}

// ─── Extract Spotify track ID from various URL formats ────────────────────────
function extractTrackId(url) {
  // Handles:
  //   https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh
  //   https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?si=xxx
  //   spotify:track:4iV5W9uYEdYUVa79Axb7Rh
  const match = url.match(/track[/:]([A-Za-z0-9]{22})/);
  return match ? match[1] : null;
}

// ─── Map Spotify genre strings to our genre list ──────────────────────────────
const GENRE_MAP = {
  'hip hop': 'Hip-Hop', 'rap': 'Rap', 'trap': 'Trap', 'drill': 'Drill',
  'r&b': 'R&B', 'soul': 'Soul / Neo-Soul', 'neo soul': 'Soul / Neo-Soul',
  'pop': 'Pop', 'indie pop': 'Indie Pop', 'bedroom pop': 'Bedroom Pop',
  'singer-songwriter': 'Singer-Songwriter', 'folk': 'Folk',
  'indie rock': 'Indie Rock', 'rock': 'Rock', 'alternative': 'Alternative',
  'country': 'Country', 'house': 'Deep House', 'deep house': 'Deep House',
  'tech house': 'Tech House', 'afro house': 'Afro House',
  'melodic house': 'Melodic House', 'tropical house': 'Tropical House',
  'progressive house': 'Progressive House', 'edm': 'Dance / EDM',
  'dance': 'Dance / EDM', 'electronic': 'Electronic / Other',
  'techno': 'Techno', 'trance': 'Trance', 'drum and bass': 'Drum & Bass',
  'dnb': 'Drum & Bass', 'afrobeats': 'Afrobeats', 'afropop': 'Afropop',
  'latin': 'Latin', 'reggaeton': 'Reggaeton', 'reggae': 'Reggae',
  'jazz': 'Jazz', 'k-pop': 'K-Pop', 'classical': 'Classical',
};

function mapGenre(spotifyGenres = []) {
  for (const sg of spotifyGenres) {
    const lower = sg.toLowerCase();
    for (const [key, val] of Object.entries(GENRE_MAP)) {
      if (lower.includes(key)) return val;
    }
  }
  return null; // fallback — let user pick
}

// ─── Page-meta fallback (no auth required) ───────────────────────────────────
// Fetches the Spotify track page and parses Open Graph meta tags.
// og:title       → song name
// og:description → "Artist · Album · Song · Year"
// og:image       → 640×640 artwork
async function lookupViaPageMeta(spotifyUrl) {
  const res = await fetch(spotifyUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RunSound/1.0)' },
  });
  if (!res.ok) throw new Error(`Spotify page fetch failed: ${res.status}`);
  const html = await res.text();

  const getMeta = (prop) =>
    html.match(new RegExp(`<meta property="${prop}" content="([^"]+)"`))?.[1] || '';

  const song_title  = getMeta('og:title');
  const description = getMeta('og:description'); // "Artist · Album · Song · Year"
  const artwork_url = getMeta('og:image') || null;

  // Parse description: split on " · "
  const parts       = description.split(' · ');
  const artist_name = parts[0] || '';
  const album_name  = parts[1] || null;
  const release_date = parts[3] || null; // year only

  return {
    ok:           true,
    track_id:     null,
    artist_name,
    song_title,
    genre:        null,    // not available without Web API — frontend shows genre picker
    genre_raw:    [],
    artwork_url,
    spotify_url:  spotifyUrl,
    preview_url:  null,
    popularity:   null,
    release_date,
    album_name,
    is_released:  true,
    source:       'pagemeta',  // signals to frontend: show genre picker
  };
}

// ─── GET /api/spotify/lookup ──────────────────────────────────────────────────
router.get('/lookup', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

  const trackId = extractTrackId(url);
  if (!trackId) {
    return res.status(400).json({ ok: false, error: 'Not a valid Spotify track URL' });
  }

  // Canonical Spotify track URL (clean up any ?si= params)
  const canonicalUrl = `https://open.spotify.com/track/${trackId}`;

  try {
    // ── Try Spotify Web API first ─────────────────────────────────────────────
    let usedWebApi = false;
    try {
      const token    = await getSpotifyToken();
      const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (trackRes.status === 403) {
        // Premium required — fall through to oEmbed
        console.log('[spotify/lookup] 403 — falling back to oEmbed');
      } else if (trackRes.status === 404) {
        return res.status(404).json({ ok: false, error: 'Track not found on Spotify' });
      } else if (trackRes.ok) {
        usedWebApi = true;
        const track = await trackRes.json();

        // Fetch artist genres
        const artistId   = track.artists?.[0]?.id;
        let artistGenres = [];
        if (artistId) {
          const artistRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (artistRes.ok) {
            const artist = await artistRes.json();
            artistGenres = artist.genres || [];
          }
        }

        const images     = track.album?.images || [];
        const artworkUrl = images.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;

        return res.json({
          ok:           true,
          track_id:     trackId,
          artist_name:  track.artists?.map(a => a.name).join(', ') || '',
          song_title:   track.name || '',
          genre:        mapGenre(artistGenres),
          genre_raw:    artistGenres.slice(0, 3),
          artwork_url:  artworkUrl,
          spotify_url:  track.external_urls?.spotify || canonicalUrl,
          preview_url:  track.preview_url || null,
          popularity:   track.popularity  || 0,
          release_date: track.album?.release_date || null,
          album_name:   track.album?.name || null,
          is_released:  true,
          source:       'webapi',
        });
      } else {
        throw new Error(`Spotify API error: ${trackRes.status}`);
      }
    } catch (webApiErr) {
      if (usedWebApi) throw webApiErr; // real error, don't mask
      console.log('[spotify/lookup] Web API unavailable, trying oEmbed:', webApiErr.message);
    }

    // ── Page-meta fallback ───────────────────────────────────────────────────
    const result = await lookupViaPageMeta(canonicalUrl);
    return res.json(result);

  } catch (err) {
    console.error('[spotify/lookup]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
