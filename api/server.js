/**
 * api/server.js — RunSound API Server
 *
 * Handles:
 *   POST /api/signup       — artist registration + campaign creation
 *   POST /api/click        — UTM click tracking (from smart link)
 *   GET  /api/link/:slug   — smart link JSON data
 *   GET  /l/:slug          — smart link page (HTML, server-rendered config)
 *   GET  /                 — landing page
 *   GET  /*                — static files from web/
 *
 * Environment variables (.env):
 *   PORT                   HTTP port (default: 3000)
 *   BASE_URL               Public URL e.g. https://runsound.fm
 *   SUPABASE_URL           Supabase project URL
 *   SUPABASE_SERVICE_KEY   Supabase service role key (never expose to frontend)
 *
 * Deploy:
 *   Railway:   set START_COMMAND = "node api/server.js"
 *   Replit:    set run = "node api/server.js"
 *
 * Usage:
 *   npm run server         — production
 *   npm run dev            — development with nodemon
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const supabase   = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logger
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next(); // only log API
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/signup', require('./routes/signup'));
app.use('/api/click',  require('./routes/click'));
app.use('/api/link',   require('./routes/link'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ─── Smart Link short URL ─────────────────────────────────────────────────────
// GET /l/:slug → serve link.html with campaign data injected
app.get('/l/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select(`
        slug, artist_name, song_title, artwork_url,
        spotify_url, apple_url, youtube_url, tidal_url,
        deezer_url, amazon_url, soundcloud_url
      `)
      .eq('slug', slug)
      .eq('active', true)
      .single();

    const webDir  = path.join(__dirname, '..', 'web');
    const linkHtml = path.join(webDir, 'link.html');

    if (!fs.existsSync(linkHtml)) {
      return res.status(404).send('Smart link page not found');
    }

    let html = fs.readFileSync(linkHtml, 'utf8');

    if (campaign) {
      // Inject config into the page so it works without a JS API call
      const config = {
        artist: campaign.artist_name,
        song:   campaign.song_title,
        art:    campaign.artwork_url || '',
        utm:    slug,
        spotify:    campaign.spotify_url    || '',
        apple:      campaign.apple_url      || '',
        youtube:    campaign.youtube_url    || '',
        tidal:      campaign.tidal_url      || '',
        deezer:     campaign.deezer_url     || '',
        amazon:     campaign.amazon_url     || '',
        soundcloud: campaign.soundcloud_url || '',
      };

      // Inject as window.RUNSOUND_CONFIG before the closing </body>
      const configScript = `<script>window.RUNSOUND_CONFIG = ${JSON.stringify(config)};</script>`;
      html = html.replace('</body>', `${configScript}\n</body>`);

      // Update page title and meta description
      html = html
        .replace('<title>Listen — RunSound Smart Link</title>',
                 `<title>${campaign.song_title} — ${campaign.artist_name}</title>`)
        .replace('content="Stream this song on your favourite platform."',
                 `content="Listen to ${campaign.song_title} by ${campaign.artist_name} on Spotify, Apple Music, and more."`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60'); // 1 min cache
    res.send(html);

  } catch (err) {
    console.error('[/l/:slug] Error:', err.message);
    // Fall back to serving the plain link.html
    res.sendFile(path.join(__dirname, '..', 'web', 'link.html'));
  }
});

// ─── Static files (web/) ──────────────────────────────────────────────────────
const webDir = path.join(__dirname, '..', 'web');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
}

// Root → landing page
app.get('/', (req, res) => {
  const indexPath = path.join(webDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ service: 'RunSound API', status: 'running' });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  const indexPath = path.join(webDir, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Not found');
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 RunSound API running on http://localhost:${PORT}`);
  console.log(`   Landing page:  http://localhost:${PORT}/`);
  console.log(`   Smart link:    http://localhost:${PORT}/l/:slug`);
  console.log(`   Health check:  http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
