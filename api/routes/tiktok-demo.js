/**
 * api/routes/tiktok-demo.js — TikTok Sandbox Integration Demo
 *
 * GET /api/tiktok/sandbox-demo?artist_id=UUID
 *
 * Demonstrates BOTH TikTok scopes live in sandbox:
 *   1. user.info.basic  → Login Kit: fetch artist profile from TikTok
 *   2. video.upload     → Content Posting API: init a video draft upload
 *
 * Used for TikTok App Review demo video.
 */

const express  = require('express');
const router   = express.Router();
const https    = require('https');
const supabase = require('../db');

// ── Helper: HTTPS POST/GET to TikTok API ─────────────────────────────────────
function tiktokRequest({ method = 'GET', path, token, body = null }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'open.tiktokapis.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── GET /api/tiktok/sandbox-demo ─────────────────────────────────────────────
router.get('/sandbox-demo', async (req, res) => {
  const { artist_id } = req.query;

  if (!artist_id) {
    return res.status(400).send('Missing artist_id query param');
  }

  // 1. Fetch token from Supabase
  let token = null;
  let openId = null;
  let dbError = null;

  try {
    const { data: artist, error } = await supabase
      .from('artists')
      .select('tiktok_access_token, tiktok_open_id, tiktok_scope')
      .eq('id', artist_id)
      .single();

    if (error) throw error;
    if (!artist?.tiktok_access_token) throw new Error('No TikTok token found for this artist');

    token  = artist.tiktok_access_token;
    openId = artist.tiktok_open_id;
  } catch (e) {
    dbError = e.message;
  }

  // 2. Call TikTok user info (user.info.basic scope)
  let userInfo = null;
  let userError = null;

  if (token) {
    try {
      const resp = await tiktokRequest({
        method: 'GET',
        path: '/v2/user/info/?fields=open_id,display_name,avatar_url',
        token,
      });
      userInfo = resp;
    } catch (e) {
      userError = e.message;
    }
  }

  // 3. Call Content Posting API — init inbox video upload (video.upload scope)
  let postingInfo = null;
  let postingError = null;

  if (token) {
    try {
      const resp = await tiktokRequest({
        method: 'POST',
        path: '/v2/post/publish/inbox/video/init/',
        token,
        body: {
          source_info: {
            source: 'PULL_FROM_URL',
            video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
          },
        },
      });
      postingInfo = resp;
    } catch (e) {
      postingError = e.message;
    }
  }

  // ── Render demo page ──────────────────────────────────────────────────────
  const green  = '#22c55e';
  const red    = '#ef4444';
  const yellow = '#eab308';

  function statusBadge(ok) {
    return ok
      ? `<span style="background:${green};color:#fff;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:600">✓ SUCCESS</span>`
      : `<span style="background:${red};color:#fff;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:600">✗ ERROR</span>`;
  }

  function pre(obj) {
    return `<pre style="background:#0f172a;color:#94a3b8;padding:16px;border-radius:8px;font-size:12px;overflow:auto;max-height:300px">${JSON.stringify(obj, null, 2)}</pre>`;
  }

  const userOk    = userInfo && userInfo.body?.data;
  const postingOk = postingInfo && (postingInfo.body?.data?.publish_id || postingInfo.status === 200);

  const userDisplay    = userInfo  ? userInfo.body  : (userError  || dbError || 'Token not found');
  const postingDisplay = postingInfo ? postingInfo.body : (postingError || dbError || 'Token not found');

  const avatarUrl = userInfo?.body?.data?.user?.avatar_url;
  const displayName = userInfo?.body?.data?.user?.display_name || openId || 'TikTok user';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RunSound — TikTok Sandbox Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e2e8f0; min-height: 100vh; }
    .header { background: #111; border-bottom: 1px solid #1e293b; padding: 20px 40px; display: flex; align-items: center; gap: 16px; }
    .logo { font-size: 20px; font-weight: 700; color: #fff; }
    .sandbox-badge { background: ${yellow}22; color: ${yellow}; border: 1px solid ${yellow}55; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 24px; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #64748b; font-size: 15px; margin-bottom: 40px; }
    .section { background: #111; border: 1px solid #1e293b; border-radius: 16px; padding: 28px; margin-bottom: 24px; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .section-title { font-size: 18px; font-weight: 600; }
    .scope-tag { background: #1e293b; color: #7dd3fc; font-size: 12px; font-family: monospace; padding: 4px 10px; border-radius: 6px; }
    .user-card { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; background: #0a0a0a; padding: 16px; border-radius: 12px; }
    .user-avatar { width: 56px; height: 56px; border-radius: 50%; background: #1e293b; object-fit: cover; }
    .user-name { font-size: 18px; font-weight: 600; }
    .user-id { color: #64748b; font-size: 13px; margin-top: 4px; font-family: monospace; }
    .api-call { background: #0a0a0a; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; font-size: 13px; color: #94a3b8; font-family: monospace; }
    .method { color: #7dd3fc; font-weight: 700; margin-right: 8px; }
    .endpoint { color: #a78bfa; }
    .footer { text-align: center; color: #334155; font-size: 13px; padding: 40px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">RunSound</div>
    <div class="sandbox-badge">⚡ SANDBOX MODE</div>
  </div>

  <div class="container">
    <h1>TikTok API Integration Demo</h1>
    <p class="subtitle">Live demonstration of all requested TikTok products and scopes in sandbox environment</p>

    <!-- ── Scope 1: Login Kit / user.info.basic ── -->
    <div class="section">
      <div class="section-header">
        <div>
          <div class="section-title">🔑 Login Kit — OAuth Authorization</div>
          <div style="margin-top:6px"><span class="scope-tag">user.info.basic</span></div>
        </div>
        ${statusBadge(userOk)}
      </div>

      <div class="api-call">
        <span class="method">GET</span>
        <span class="endpoint">https://open.tiktokapis.com/v2/user/info/</span>
      </div>

      ${avatarUrl ? `
      <div class="user-card">
        <img class="user-avatar" src="${avatarUrl}" alt="avatar" onerror="this.style.display='none'">
        <div>
          <div class="user-name">${displayName}</div>
          <div class="user-id">open_id: ${openId || '—'}</div>
        </div>
      </div>` : ''}

      <p style="color:#64748b;font-size:13px;margin-bottom:10px">API Response:</p>
      ${pre(userDisplay)}
    </div>

    <!-- ── Scope 2: Content Posting API / video.upload ── -->
    <div class="section">
      <div class="section-header">
        <div>
          <div class="section-title">🎬 Content Posting API — Video Draft Upload</div>
          <div style="margin-top:6px"><span class="scope-tag">video.upload</span></div>
        </div>
        ${statusBadge(postingOk)}
      </div>

      <div class="api-call">
        <span class="method">POST</span>
        <span class="endpoint">https://open.tiktokapis.com/v2/post/publish/inbox/video/init/</span>
      </div>

      <p style="color:#64748b;font-size:13px;margin:10px 0">
        Initiates a video upload to the connected TikTok user's inbox as a draft.
        Artists open TikTok, add their song from the music library, and publish.
      </p>

      <p style="color:#64748b;font-size:13px;margin-bottom:10px">API Response:</p>
      ${pre(postingDisplay)}
    </div>

    <div style="text-align:center;color:#334155;margin-top:40px">
      <div style="font-size:13px">RunSound Sandbox Integration — Both products and scopes demonstrated live</div>
      <div style="font-size:12px;margin-top:4px;font-family:monospace">artist_id: ${artist_id} &nbsp;|&nbsp; open_id: ${openId || '—'}</div>
    </div>
  </div>
</body>
</html>`);
});

module.exports = router;
