/**
 * RunSound — Smartlink server
 *
 * Routes:
 *   GET  /:artistSlug/:songSlug          → Serve smartlink page
 *   GET  /r/:artistSlug/:songSlug/:platform → Track click + redirect
 *   GET  /api/clicks/:artistSlug         → Analytics data (for daily-report.js)
 *   POST /api/songs                      → Register/update artist + song config
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { getSong, logClick, getClicksByCampaign, getClickSummary, upsertArtist, upsertSong } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Platform config ──────────────────────────────────────────────────────────
const PLATFORMS = {
  spotify:      { label: 'Spotify',       color: '#1DB954', bg: '#1DB954', icon: 'spotify' },
  apple:        { label: 'Apple Music',   color: '#FC3C44', bg: '#FC3C44', icon: 'apple'   },
  youtube:      { label: 'YouTube Music', color: '#FF0000', bg: '#FF0000', icon: 'youtube' },
  tidal:        { label: 'Tidal',         color: '#000000', bg: '#00FFFF', icon: 'tidal'   },
  amazon:       { label: 'Amazon Music',  color: '#00A8E0', bg: '#00A8E0', icon: 'amazon'  },
  deezer:       { label: 'Deezer',        color: '#A238FF', bg: '#A238FF', icon: 'deezer'  }
};

// ─── Smartlink page ───────────────────────────────────────────────────────────
app.get('/:artistSlug/:songSlug', (req, res) => {
  const { artistSlug, songSlug } = req.params;
  const utm = {
    source:   req.query.utm_source   || '',
    medium:   req.query.utm_medium   || '',
    campaign: req.query.utm_campaign || ''
  };

  const song = getSong.get(artistSlug, songSlug);
  if (!song) {
    return res.status(404).send('<h1>Song not found</h1>');
  }

  // Build platform buttons (only show platforms that have a URL)
  const buttons = Object.entries(PLATFORMS)
    .filter(([key]) => song[`${key}_url`])
    .map(([key, meta]) => {
      const utmStr = utm.campaign
        ? `?utm_source=${utm.source}&utm_medium=${utm.medium}&utm_campaign=${utm.campaign}`
        : '';
      const trackUrl = `/r/${artistSlug}/${songSlug}/${key}${utmStr}`;
      return `
        <a href="${trackUrl}" class="btn btn-${key}" data-platform="${key}">
          ${svgIcon(key)}
          <span>${meta.label}</span>
        </a>`;
    }).join('\n');

  const html = smartlinkHTML({ song, artistSlug, buttons, utm });
  res.send(html);
});

// ─── Click tracker + redirect ─────────────────────────────────────────────────
app.get('/r/:artistSlug/:songSlug/:platform', (req, res) => {
  const { artistSlug, songSlug, platform } = req.params;

  const song = getSong.get(artistSlug, songSlug);
  if (!song || !song[`${platform}_url`]) {
    return res.status(404).send('Not found');
  }

  // Log the click
  logClick.run({
    artist_slug:  artistSlug,
    song_slug:    songSlug,
    platform,
    utm_source:   req.query.utm_source   || null,
    utm_medium:   req.query.utm_medium   || null,
    utm_campaign: req.query.utm_campaign || null,
    user_agent:   req.headers['user-agent'] || null
  });

  res.redirect(song[`${platform}_url`]);
});

// ─── Analytics API (used by daily-report.js) ─────────────────────────────────
app.get('/api/clicks/:artistSlug', (req, res) => {
  const { artistSlug } = req.params;
  const days = req.query.days || 7;
  const since = `-${days} days`;

  const byCampaign = getClicksByCampaign.all(artistSlug, since);
  const summary    = getClickSummary.all(artistSlug, since);

  res.json({ artistSlug, days, summary, byCampaign });
});

// ─── Register song (called from onboarding / config sync) ────────────────────
app.post('/api/songs', (req, res) => {
  const { artist, song } = req.body;
  if (!artist?.slug || !song?.slug) {
    return res.status(400).json({ error: 'artist.slug and song.slug required' });
  }

  upsertArtist.run({ slug: artist.slug, name: artist.name, genre: artist.genre || null });
  upsertSong.run({
    artist_slug:  artist.slug,
    slug:         song.slug,
    title:        song.title,
    cover_url:    song.coverUrl    || null,
    spotify_url:  song.spotifyUrl  || null,
    apple_url:    song.appleUrl    || null,
    youtube_url:  song.youtubeUrl  || null,
    tidal_url:    song.tidalUrl    || null,
    amazon_url:   song.amazonUrl   || null,
    deezer_url:   song.deezerUrl   || null
  });

  res.json({ ok: true, url: `/${artist.slug}/${song.slug}` });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n🎵 RunSound smartlink server running on http://localhost:${PORT}`);
  console.log(`   Smartlink format: http://localhost:${PORT}/:artist/:song\n`);
});

// ─── SVG icons ────────────────────────────────────────────────────────────────
function svgIcon(platform) {
  const icons = {
    spotify: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>`,
    apple:   `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`,
    youtube: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`,
    tidal:   `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996l4.004 4.004 4.004-4.004 4.004 4.004 4.004-4.004zM8.008 16.004l4.004-4.004 4.004 4.004 4.004-4.004L24 16.004l-4.004 4.004-4.004-4.004-4.004 4.004z"/></svg>`,
    amazon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.699-3.182v.685zm3.186 7.705c-.209.189-.512.201-.745.074-1.052-.872-1.238-1.276-1.814-2.106-1.734 1.767-2.962 2.297-5.209 2.297-2.66 0-4.731-1.641-4.731-4.925 0-2.565 1.391-4.309 3.37-5.164 1.715-.754 4.11-.891 5.942-1.095v-.41c0-.753.06-1.642-.384-2.294-.385-.579-1.124-.82-1.775-.82-1.205 0-2.277.618-2.54 1.897-.054.285-.261.567-.549.582l-3.061-.331c-.259-.056-.548-.266-.472-.66.704-3.716 4.06-4.836 7.066-4.836 1.537 0 3.547.41 4.758 1.574 1.538 1.436 1.392 3.352 1.392 5.438v4.923c0 1.481.616 2.13 1.192 2.929.204.287.25.629-.01.839-.647.541-1.794 1.537-2.42 2.099l-.01-.011z"/></svg>`,
    deezer:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.81 11.693c0-.463-.053-.483-.595-.483v-.965h2.142v.965c-.542 0-.595.02-.595.483v1.968c0 .463.053.484.595.484v.965H18.215v-.965c.542 0 .595-.021.595-.484v-1.968zM3.19 13.66c0 .463.053.484.595.484v.965H1.643v-.965c.542 0 .595-.021.595-.484v-1.968c0-.463-.053-.483-.595-.483v-.965H3.785v.965c-.542 0-.595.02-.595.483v1.968zm7.81-1.967c0-.463-.053-.483-.595-.483v-.965h2.142v.965c-.542 0-.595.02-.595.483v1.968c0 .463.053.484.595.484v.965H10.405v-.965c.542 0 .595-.021.595-.484v-1.968zm3.905 0c0-.463-.053-.483-.595-.483v-.965h2.142v.965c-.542 0-.595.02-.595.483v1.968c0 .463.053.484.595.484v.965H14.31v-.965c.542 0 .595-.021.595-.484v-1.968zm-7.81 0c0-.463-.053-.483-.595-.483v-.965h2.142v.965c-.542 0-.595.02-.595.483v1.968c0 .463.053.484.595.484v.965H6.5v-.965c.542 0 .595-.021.595-.484v-1.968z"/></svg>`
  };
  return icons[platform] || '';
}

// ─── HTML template ────────────────────────────────────────────────────────────
function smartlinkHTML({ song, artistSlug, buttons, utm }) {
  const utmMeta = utm.campaign ? `
    <meta name="utm-source"   content="${utm.source}">
    <meta name="utm-medium"   content="${utm.medium}">
    <meta name="utm-campaign" content="${utm.campaign}">` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${song.title} — ${song.title}</title>
  ${utmMeta}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      min-height: 100vh;
      background: #0a0a0a;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1rem;
    }

    .card {
      width: 100%;
      max-width: 420px;
      text-align: center;
    }

    .cover {
      width: 200px;
      height: 200px;
      border-radius: 12px;
      margin: 0 auto 1.5rem;
      object-fit: cover;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      background: #1a1a1a;
      display: block;
    }

    .cover-placeholder {
      width: 200px;
      height: 200px;
      border-radius: 12px;
      margin: 0 auto 1.5rem;
      background: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 4rem;
    }

    .song-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
      letter-spacing: -0.02em;
    }

    .artist-name {
      font-size: 1rem;
      color: #888;
      margin-bottom: 2rem;
    }

    .buttons {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .btn {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.875rem 1.5rem;
      border-radius: 50px;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.95rem;
      color: #fff;
      transition: transform 0.1s, opacity 0.1s;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
    }

    .btn:active { transform: scale(0.98); opacity: 0.9; }

    .btn svg { width: 22px; height: 22px; flex-shrink: 0; }

    .btn-spotify  { background: #1DB954; border-color: #1DB954; }
    .btn-apple    { background: #fc3c44; border-color: #fc3c44; }
    .btn-youtube  { background: #FF0000; border-color: #FF0000; }
    .btn-tidal    { background: #000; border-color: #333; color: #00ffff; }
    .btn-amazon   { background: #00A8E0; border-color: #00A8E0; }
    .btn-deezer   { background: #A238FF; border-color: #A238FF; }

    .btn span { flex: 1; text-align: left; }

    .footer {
      margin-top: 2.5rem;
      font-size: 0.75rem;
      color: #444;
    }

    .footer a { color: #555; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    ${song.cover_url
      ? `<img class="cover" src="${song.cover_url}" alt="${song.title} cover">`
      : `<div class="cover-placeholder">🎵</div>`
    }
    <div class="song-title">${song.title}</div>
    <div class="artist-name">${song.artist_name || song.artist_slug}</div>
    <div class="buttons">
      ${buttons}
    </div>
  </div>
  <div class="footer">
    Powered by <a href="https://runsound.fm">RunSound</a>
  </div>
</body>
</html>`;
}
