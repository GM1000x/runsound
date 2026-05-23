/**
 * api/routes/tiktok-auth.js — TikTok OAuth v2 with PKCE
 *
 * Routes (mounted at /auth/tiktok in server.js):
 *
 *   GET  /auth/tiktok
 *     ?artist_id=UUID&campaign_id=UUID&token=DASHTOKEN
 *     → Redirects artist to TikTok consent screen (PKCE flow)
 *
 *   GET  /auth/tiktok/callback
 *     ?code=xxx&state=xxx
 *     → Exchanges code for tokens, saves to Supabase
 *     → Triggers onboarding pipeline
 *     → Redirects to /connect.html
 *
 *   GET  /auth/tiktok/status/:artistId
 *     → { ok, connected, open_id, connected_at }
 *     (polled by connect.html to check if artist has linked TikTok)
 *
 * Required env vars:
 *   TIKTOK_CLIENT_KEY      — TikTok app Client Key
 *   TIKTOK_CLIENT_SECRET   — TikTok app Client Secret
 *   BASE_URL               — Public URL, e.g. https://run-sound.com
 */

const express   = require('express');
const router    = express.Router();
const https     = require('https');
const supabase  = require('../db');
const { generateCodeVerifier, generateCodeChallenge } = require('../tiktok-api');

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const BASE_URL      = process.env.BASE_URL || 'https://run-sound.com';
const REDIRECT_URI  = `${BASE_URL}/auth/tiktok/callback`;

// video.upload  → post as SELF_ONLY draft (artist inbox)
// user.info.basic → display name / avatar
const SCOPES = 'user.info.basic,video.upload';

// ── In-memory PKCE store (keyed by state, auto-expires in 10 min) ─────────────
// Works fine for single-server Railway. For multi-instance: use Redis instead.
const pkceStore = new Map();

// ── State encoding helpers ────────────────────────────────────────────────────
// State = base64url("artistId|campaignId|dashToken") — survives URL encoding
function encodeState(artistId, campaignId, dashToken) {
  const raw = [artistId || '', campaignId || '', dashToken || ''].join('|');
  return Buffer.from(raw).toString('base64url');
}

function decodeState(stateStr) {
  try {
    const raw  = Buffer.from(stateStr, 'base64url').toString('utf8');
    const [artistId, campaignId, dashToken] = raw.split('|');
    return {
      artistId:   artistId   || null,
      campaignId: campaignId || null,
      dashToken:  dashToken  || null,
    };
  } catch {
    // Fallback for old-style plain artist_id state
    return { artistId: stateStr, campaignId: null, dashToken: null };
  }
}

// ── GET /auth/tiktok → redirect to TikTok consent ────────────────────────────
router.get('/', (req, res) => {
  const { artist_id, campaign_id, token } = req.query;

  if (!CLIENT_KEY) {
    console.error('[tiktok-auth] TIKTOK_CLIENT_KEY not set');
    return res.status(500).send('TikTok app not configured yet — check TIKTOK_CLIENT_KEY env var');
  }

  // Generate PKCE
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state         = encodeState(artist_id, campaign_id, token);

  // Store verifier by state — expires in 10 minutes
  pkceStore.set(state, codeVerifier);
  setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_key:            CLIENT_KEY,
    response_type:         'code',
    scope:                 SCOPES,
    redirect_uri:          REDIRECT_URI,
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  console.log(`[tiktok-auth] Redirecting artist ${artist_id || '(unknown)'} → TikTok consent`);
  res.redirect(authUrl);
});

// ── GET /auth/tiktok/callback → exchange code for tokens ─────────────────────
router.get('/callback', async (req, res) => {
  const { code, state: stateStr, error, error_description } = req.query;

  if (error || !code) {
    console.error('[tiktok-auth] OAuth denied:', error, error_description);
    return res.redirect('/connect.html?error=cancelled');
  }

  const { artistId, campaignId, dashToken } = decodeState(stateStr);
  const codeVerifier = pkceStore.get(stateStr);
  pkceStore.delete(stateStr); // one-time use

  // Build the connect.html redirect base URL
  const connectBase = buildConnectUrl(campaignId, artistId, dashToken);

  if (!codeVerifier) {
    console.error('[tiktok-auth] PKCE verifier not found — session may have expired');
    return res.redirect(`${connectBase}&error=session_expired`);
  }

  try {
    // Exchange auth code for tokens
    const tokenData = await exchangeCodeForTokens(code, codeVerifier);

    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }
    if (!tokenData.access_token) {
      throw new Error(`No access_token: ${JSON.stringify(tokenData).slice(0, 200)}`);
    }

    // Persist tokens to Supabase
    const now = new Date();
    const expiresIn        = tokenData.expires_in        || 86400;
    const refreshExpiresIn = tokenData.refresh_expires_in || null;

    const updatePayload = {
      tiktok_open_id:            tokenData.open_id,
      tiktok_access_token:       tokenData.access_token,
      tiktok_refresh_token:      tokenData.refresh_token      || null,
      tiktok_token_expires_at:   new Date(now.getTime() + expiresIn * 1000).toISOString(),
      tiktok_refresh_expires_at: refreshExpiresIn
        ? new Date(now.getTime() + refreshExpiresIn * 1000).toISOString()
        : null,
      tiktok_scope:              tokenData.scope || SCOPES,
      tiktok_connected_at:       now.toISOString(),
    };

    if (artistId) {
      const { error: dbErr } = await supabase
        .from('artists')
        .update(updatePayload)
        .eq('id', artistId);

      if (dbErr) throw dbErr;
      console.log(`[tiktok-auth] ✅ TikTok connected for artist ${artistId} (open_id: ${tokenData.open_id})`);
    } else {
      console.warn('[tiktok-auth] No artistId in state — tokens not saved');
    }

    // ── Trigger onboarding pipeline now that TikTok is connected ──────────────
    // Non-blocking — connect.html will poll /api/onboard/:id/status
    if (campaignId) {
      triggerOnboarding(campaignId).catch(e =>
        console.error('[tiktok-auth] Onboarding trigger failed:', e.message)
      );
    }

    res.redirect(`${connectBase}&tiktok=connected`);

  } catch (err) {
    console.error('[tiktok-auth] Callback error:', err.message);
    res.redirect(`${connectBase}&error=token_exchange&detail=${encodeURIComponent(err.message.slice(0, 100))}`);
  }
});

// ── GET /auth/tiktok/status/:artistId → check TikTok connection ──────────────
// Polled by connect.html to know whether to show the connect button or not.
router.get('/status/:artistId', async (req, res) => {
  const { artistId } = req.params;

  try {
    const { data: artist, error } = await supabase
      .from('artists')
      .select('tiktok_open_id, tiktok_access_token, tiktok_connected_at, tiktok_token_expires_at')
      .eq('id', artistId)
      .single();

    if (error) throw error;

    const connected = !!(artist?.tiktok_open_id && artist?.tiktok_access_token);

    res.json({
      ok:           true,
      connected,
      open_id:      artist?.tiktok_open_id      || null,
      connected_at: artist?.tiktok_connected_at || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildConnectUrl(campaignId, artistId, dashToken) {
  const params = new URLSearchParams();
  if (campaignId) params.set('campaign_id', campaignId);
  if (artistId)   params.set('artist_id',   artistId);
  if (dashToken)  params.set('token',        dashToken);
  const qs = params.toString();
  return `/connect.html${qs ? '?' + qs : ''}`;
}

function exchangeCodeForTokens(code, codeVerifier) {
  const body = new URLSearchParams({
    client_key:    CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  REDIRECT_URI,
    code_verifier: codeVerifier,
  }).toString();

  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const options = {
      hostname: 'open.tiktokapis.com',
      path:     '/v2/oauth/token/',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': bodyBuf.length,
      },
    };

    const req = https.request(options, resp => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Failed to parse token response: ${data.slice(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function triggerOnboarding(campaignId) {
  const port = process.env.PORT || 3000;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`http://localhost:${port}/api/onboard/${campaignId}`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[tiktok-auth] Onboarding triggered for ${campaignId}: ${data.status || 'ok'}`);
}

module.exports = router;
