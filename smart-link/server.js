#!/usr/bin/env node
/**
 * RunSound Smart Link Server
 *
 * Serves runsound.fm/[slug] pages with correct song data.
 * Tracks Spotify/Apple Music clicks to Supabase for conversion analytics.
 *
 * Routes:
 *   GET  /[slug]          → Smart link page for the song
 *   POST /api/track       → Track a click event (called from front-end)
 *   GET  /api/stats/[slug] → Get click stats for a slug (for dashboard)
 *   GET  /health          → Health check
 *
 * Usage: node server.js
 *   PORT (default 3001), SUPABASE_URL, SUPABASE_KEY must be set in .env
 *
 * Deploy to Replit: just run `node server.js` — keep-alive runs automatically
 */

require('dotenv').config();
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT         = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function getSongBySlug(slug) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('smart_links')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) return null;
  return data;
}

async function trackClick(slug, destination, req) {
  if (!supabase) return;

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  await supabase.from('utm_clicks').insert({
    slug,
    destination,
    source:     req.headers['referer'] || 'direct',
    user_agent: req.headers['user-agent'] || '',
    ip_hash:    ip ? Buffer.from(ip).toString('base64').slice(0, 16) : null,
    created_at: new Date().toISOString()
  });
}

// ─── Parse request body ───────────────────────────────────────────────────────
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── Render smart link page ───────────────────────────────────────────────────
function renderPage(song) {
  const songJson = JSON.stringify(song);

  return HTML_TEMPLATE
    .replace('__SUPABASE_URL__', SUPABASE_URL || '')
    .replace('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || SUPABASE_KEY || '')
    .replace(
      '// Song data can be embedded by the server, or fetched from Supabase',
      `// Song data injected by server\n    window.__SONG_DATA__ = ${songJson};`
    );
}

// ─── Router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url     = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, supabase: !!supabase }));
    return;
  }

  // POST /api/track — track a click
  if (pathname === '/api/track' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.slug && body.destination) {
      await trackClick(body.slug, body.destination, req);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/stats/[slug] — return click counts
  if (pathname.startsWith('/api/stats/') && req.method === 'GET') {
    const slug = pathname.replace('/api/stats/', '').trim();
    if (!supabase || !slug) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, total: 0, error: 'No Supabase' }));
      return;
    }

    const { data, error } = await supabase
      .from('utm_clicks')
      .select('destination, created_at')
      .eq('slug', slug);

    const byDest = {};
    for (const row of (data || [])) {
      byDest[row.destination] = (byDest[row.destination] || 0) + 1;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ slug, total: (data || []).length, byDestination: byDest }));
    return;
  }

  // GET /[slug] — serve smart link page
  if (req.method === 'GET') {
    const slug = pathname.replace(/^\//, '').split('/')[0] || '';

    if (!slug || slug === 'favicon.ico') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let song = await getSongBySlug(slug);

    // If no Supabase / no record, show demo page
    if (!song) {
      song = {
        slug,
        title: 'My Song',
        artist: 'Artist Name',
        cover_url: null,
        spotify_url: url.searchParams.get('spotify') || null,
        apple_url:   url.searchParams.get('apple')   || null
      };
    }

    const html = renderPage(song);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🔗 RunSound Smart Link server running on port ${PORT}`);
  console.log(`   Visit: http://localhost:${PORT}/[slug]`);
  if (!supabase) {
    console.log(`\n   ⚠️  No Supabase credentials — clicks won't be tracked`);
    console.log(`   Set SUPABASE_URL and SUPABASE_KEY in .env`);
  } else {
    console.log(`   ✅ Supabase connected — clicks will be tracked`);
  }
  console.log('');
});
