/**
 * TikTok OAuth v2 routes
 *
 *   GET /auth/tiktok?artist_id=xxx
 *     → redirects artist to TikTok consent screen
 *
 *   GET /auth/tiktok/callback?code=...&state=...
 *     → exchanges code for tokens, saves to Supabase, redirects to /connect
 *
 * Required env vars:
 *   TIKTOK_CLIENT_KEY      TikTok app Client Key
 *   TIKTOK_CLIENT_SECRET   TikTok app Client Secret
 *   BASE_URL               e.g. https://runsound-production.up.railway.app
 */

const express  = require('express');
const router   = express.Router();
const https    = require('https');
const supabase = require('../db');

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const BASE_URL      = process.env.BASE_URL || 'https://runsound.fm';
const REDIRECT_URI  = `${BASE_URL}/auth/tiktok/callback`;
const SCOPES        = 'user.info.basic,video.upload,video.publish';

// ── Step 1: redirect to TikTok consent ───────────────────────────────────────
router.get('/', (req, res) => {
  const { artist_id } = req.query;

  if (!CLIENT_KEY) {
    return res.status(500).send('TikTok client key not configured');
  }

  const params = new URLSearchParams({
    client_key:    CLIENT_KEY,
    response_type: 'code',
    scope:         SCOPES,
    redirect_uri:  REDIRECT_URI,
    state:         artist_id || '',
  });

  res.redirect(`https://www.tiktok.com/v2/auth/authorize?${params.toString()}`);
});

// ── Step 2: handle callback ───────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state: artistId, error } = req.query;

  if (error || !code) {
    console.error('[tiktok-auth] OAuth error or missing code:', error);
    const dest = artistId
      ? `/connect?error=cancelled&artist_id=${encodeURIComponent(artistId)}`
      : '/connect?error=cancelled';
    return res.redirect(dest);
  }

  try {
    // Exchange code for tokens
    const tokenData = await exchangeCodeForTokens(code);

    if (!tokenData.access_token) {
      throw new Error('No access_token in response');
    }

    // Save tokens to Supabase
    const now = new Date();
    const accessExpiresAt  = new Date(now.getTime() + tokenData.expires_in * 1000);
    const refreshExpiresAt = tokenData.refresh_expires_in
      ? new Date(now.getTime() + tokenData.refresh_expires_in * 1000)
      : null;

    const updatePayload = {
      tiktok_open_id:            tokenData.open_id,
      tiktok_access_token:       tokenData.access_token,
      tiktok_refresh_token:      tokenData.refresh_token || null,
      tiktok_token_expires_at:   accessExpiresAt.toISOString(),
      tiktok_refresh_expires_at: refreshExpiresAt?.toISOString() || null,
      tiktok_scope:              tokenData.scope || SCOPES,
      tiktok_connected_at:       now.toISOString(),
    };

    if (artistId) {
      const { error: dbErr } = await supabase
        .from('artists')
        .update(updatePayload)
        .eq('id', artistId);

      if (dbErr) throw dbErr;
      console.log(`[tiktok-auth] Connected TikTok for artist ${artistId} (open_id: ${tokenData.open_id})`);
    } else {
      // No artist_id — try to match by open_id
      console.warn('[tiktok-auth] No artist_id in state param');
    }

    const dest = artistId
      ? `/connect?success=true&artist_id=${encodeURIComponent(artistId)}`
      : '/connect?success=true';
    res.redirect(dest);

  } catch (err) {
    console.error('[tiktok-auth] Callback error:', err.message);
    const dest = artistId
      ? `/connect?error=token_exchange&artist_id=${encodeURIComponent(artistId)}`
      : '/connect?error=token_exchange';
    res.redirect(dest);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_key:    CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  REDIRECT_URI,
    }).toString();

    const options = {
      hostname: 'open.tiktokapis.com',
      path:     '/v2/oauth/token/',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse token response')); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = router;
