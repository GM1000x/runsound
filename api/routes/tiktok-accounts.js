/**
 * api/routes/tiktok-accounts.js
 *
 * GET  /api/outreach/tiktok-status   — artist's connected account + DM stats
 * POST /api/outreach/tiktok-connect  — connect/update a TikTok account
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../db');

// ── Auth ──────────────────────────────────────────────────────────────────────
async function requireArtist(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });

  const { data: artist } = await supabase
    .from('artists')
    .select('id, name, genre')
    .eq('api_key', token)
    .single();

  if (!artist) return res.status(401).json({ ok: false, error: 'Invalid token' });
  req.artist = artist;
  next();
}

// ── GET /api/outreach/tiktok-status ──────────────────────────────────────────
router.get('/tiktok-status', requireArtist, async (req, res) => {
  const { data: account } = await supabase
    .from('tiktok_accounts')
    .select('tiktok_username, daily_limit, dms_sent_today, dms_sent_total, last_dm_at, active')
    .eq('artist_id', req.artist.id)
    .eq('active', true)
    .single();

  if (!account) return res.json({ ok: true, account: null });

  res.json({
    ok:             true,
    account,
    dms_sent_today: account.dms_sent_today || 0,
    dms_sent_total: account.dms_sent_total || 0,
  });
});

// ── POST /api/outreach/tiktok-connect ────────────────────────────────────────
router.post('/tiktok-connect', requireArtist, async (req, res) => {
  const { tiktok_username, session_cookies, daily_limit = 75 } = req.body;

  if (!tiktok_username || !session_cookies) {
    return res.status(400).json({ ok: false, error: 'tiktok_username and session_cookies required' });
  }

  try { JSON.parse(session_cookies); } catch {
    return res.status(400).json({ ok: false, error: 'session_cookies must be valid JSON' });
  }

  const { data, error } = await supabase
    .from('tiktok_accounts')
    .upsert({
      artist_id:       req.artist.id,
      tiktok_username: tiktok_username.replace('@', ''),
      session_cookies,
      daily_limit:     Math.min(daily_limit, 100),
      active:          true,
    }, { onConflict: 'artist_id,tiktok_username' })
    .select('id, tiktok_username, daily_limit')
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, account: data });
});

module.exports = router;
