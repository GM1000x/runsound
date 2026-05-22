/**
 * api/email.js — RunSound transactional email via Resend
 *
 * Usage:
 *   const { sendWelcomeEmail } = require('./email');
 *   await sendWelcomeEmail({ artistName, email, songTitle, dashboardUrl, smartLinkUrl });
 *
 * Requires env:
 *   RESEND_API_KEY   — from resend.com
 *   BASE_URL         — e.g. https://runsound.fm (for logo/link hrefs)
 *   EMAIL_FROM       — e.g. "RunSound <hello@runsound.fm>"  (default used if not set)
 */

const BASE      = process.env.BASE_URL   || 'https://runsound.fm';
const FROM      = process.env.EMAIL_FROM || 'RunSound <hello@run-sound.com>';
const RESEND_KEY = process.env.RESEND_API_KEY;

let fetchFn;
try { fetchFn = require('node-fetch').default; } catch {
  try { fetchFn = require('node-fetch'); } catch { fetchFn = global.fetch; }
}

// ─── Core send helper ─────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!RESEND_KEY) {
    console.warn('[email] RESEND_API_KEY not set — email skipped');
    return { ok: false, reason: 'no_api_key' };
  }

  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`[email] Resend error ${res.status}:`, data);
      return { ok: false, reason: data?.message || res.statusText };
    }

    console.log(`[email] ✅ Sent "${subject}" → ${to} (id: ${data.id})`);
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ─── Welcome email ────────────────────────────────────────────────────────────
// Sent immediately after signup. Contains:
//   - Dashboard link (with secret token)
//   - TikTok publishing instructions
//   - Smart link URL
async function sendWelcomeEmail({ artistName, email, songTitle, dashboardUrl, smartLinkUrl }) {
  const subject = `Welcome to RunSound, ${artistName} — your first post is generating now!`;

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0f;
    color: #f0f0f8;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap {
    max-width: 520px;
    margin: 0 auto;
    padding: 40px 24px;
  }
  .logo {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.5px;
    margin-bottom: 32px;
  }
  .logo span { color: #a855f7; }
  .card {
    background: #13131a;
    border: 1px solid #1e1e2e;
    border-radius: 16px;
    padding: 32px;
    margin-bottom: 24px;
  }
  h1 {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 10px;
    line-height: 1.3;
  }
  p {
    font-size: 15px;
    color: #c0c0d0;
    line-height: 1.6;
    margin-bottom: 16px;
  }
  .btn {
    display: inline-block;
    background: linear-gradient(135deg, #7c3aed, #a855f7);
    color: #fff !important;
    font-size: 15px;
    font-weight: 600;
    padding: 14px 28px;
    border-radius: 10px;
    text-decoration: none;
    margin-top: 8px;
  }
  .divider {
    border: none;
    border-top: 1px solid #1e1e2e;
    margin: 24px 0;
  }
  .steps-title {
    font-size: 11px;
    font-weight: 600;
    color: #888899;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 14px;
  }
  .step {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
    align-items: flex-start;
  }
  .step-num {
    background: #7c3aed;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    width: 20px; height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .step-text { font-size: 14px; color: #c0c0d0; line-height: 1.5; }
  .step-text strong { color: #f0f0f8; }
  .link-box {
    background: #0a0a0f;
    border: 1px solid #1e1e2e;
    border-radius: 8px;
    padding: 12px 14px;
    font-size: 13px;
    color: #888899;
    word-break: break-all;
    margin-top: 8px;
  }
  .link-box a { color: #a855f7; text-decoration: none; }
  .footer {
    font-size: 12px;
    color: #444455;
    text-align: center;
    line-height: 1.6;
  }
  .footer a { color: #666677; }
</style>
</head>
<body>
<div class="wrap">

  <div class="logo">Run<span>Sound</span></div>

  <!-- Main card -->
  <div class="card">
    <h1>Your first post is generating now, ${artistName}!</h1>
    <p>
      We're building your AI image set and crafting your first TikTok draft for
      <strong style="color:#f0f0f8">${songTitle}</strong>.
      It'll be in your TikTok inbox in about 5–8 minutes.
    </p>
    <p style="margin-bottom: 4px;">
      Track the progress and get your dashboard link here:
    </p>
    <a href="${dashboardUrl}" class="btn">Open my dashboard →</a>

    <p style="margin-top: 20px; font-size: 13px; color: #555566;">
      ⚠️ Save this email — this link is your personal access to your RunSound dashboard.
    </p>
  </div>

  <!-- TikTok instructions -->
  <div class="card">
    <p class="steps-title">When the draft arrives — publish in 30 seconds</p>

    <div class="step">
      <span class="step-num">1</span>
      <span class="step-text">Open TikTok → tap the <strong>notification in your inbox</strong></span>
    </div>
    <div class="step">
      <span class="step-num">2</span>
      <span class="step-text">Tap <strong>"Add sound"</strong></span>
    </div>
    <div class="step">
      <span class="step-num">3</span>
      <span class="step-text">Search for <strong>"${songTitle}"</strong> or pick any trending sound</span>
    </div>
    <div class="step">
      <span class="step-num">4</span>
      <span class="step-text">Tap <strong>Post ✓</strong></span>
    </div>

    <hr class="divider">

    <p style="font-size: 13px; color: #888899; margin-bottom: 0;">
      After today, a new draft arrives in your inbox every night automatically.
      RunSound learns what drives streams and improves your posts week by week.
    </p>
  </div>

  <!-- Smart link -->
  ${smartLinkUrl ? `
  <div class="card">
    <p class="steps-title">Your smart link</p>
    <p style="font-size: 14px; margin-bottom: 8px;">
      Share this link anywhere — it works for Spotify, Apple Music, Tidal and more.
    </p>
    <div class="link-box">
      <a href="${smartLinkUrl}">${smartLinkUrl}</a>
    </div>
  </div>
  ` : ''}

  <div class="footer">
    <p>RunSound — automated TikTok marketing for music artists</p>
    <p style="margin-top: 6px;"><a href="${BASE}">runsound.fm</a></p>
  </div>

</div>
</body>
</html>
  `.trim();

  return sendEmail({ to: email, subject, html });
}

// ─── Daily report email (optional — future use) ───────────────────────────────
async function sendDailyReport({ artistName, email, weekViews, weekClicks, diagnosis, dashboardUrl }) {
  const diagMessages = {
    scale:    '🚀 Killing it — scale up and keep going.',
    fix_cta:  '📢 Great reach, low streams — try a stronger CTA on slide 6.',
    fix_hook: '🪝 High CTR but low views — your opening hook needs more stopping power.',
    reset:    '🔄 Time for a fresh direction — new images, hook, posting time.',
  };

  const subject = `RunSound weekly: ${weekViews.toLocaleString()} views, ${weekClicks} stream clicks`;
  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { background:#0a0a0f; color:#f0f0f8; font-family:-apple-system,sans-serif; }
  .wrap { max-width:520px; margin:0 auto; padding:40px 24px; }
  .logo { font-size:22px; font-weight:800; margin-bottom:32px; }
  .logo span { color:#a855f7; }
  .card { background:#13131a; border:1px solid #1e1e2e; border-radius:16px; padding:28px; margin-bottom:20px; }
  h1 { font-size:19px; font-weight:700; margin-bottom:10px; }
  p { font-size:14px; color:#c0c0d0; line-height:1.6; margin-bottom:12px; }
  .stat { display:inline-block; margin-right:24px; }
  .stat-val { font-size:28px; font-weight:800; color:#f0f0f8; }
  .stat-label { font-size:12px; color:#888899; margin-top:2px; }
  .btn { display:inline-block; background:linear-gradient(135deg,#7c3aed,#a855f7); color:#fff!important; font-size:14px; font-weight:600; padding:12px 24px; border-radius:10px; text-decoration:none; }
</style>
</head><body><div class="wrap">
  <div class="logo">Run<span>Sound</span></div>
  <div class="card">
    <h1>This week, ${artistName}</h1>
    <div style="margin:20px 0">
      <div class="stat">
        <div class="stat-val">${weekViews.toLocaleString()}</div>
        <div class="stat-label">TikTok views</div>
      </div>
      <div class="stat">
        <div class="stat-val">${weekClicks}</div>
        <div class="stat-label">Stream clicks</div>
      </div>
    </div>
    <p>${diagMessages[diagnosis] || ''}</p>
    <a href="${dashboardUrl}" class="btn">See full dashboard →</a>
  </div>
</div></body></html>
  `.trim();

  return sendEmail({ to: email, subject, html });
}

// ─── Draft ready email ────────────────────────────────────────────────────────
// Sent when the onboarding pipeline completes and the TikTok draft is in inbox.
async function sendDraftReadyEmail({ artistName, email, songTitle, dashboardUrl }) {
  const subject = `🎵 Your TikTok draft for "${songTitle}" is ready — publish it now!`;

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0f;
    color: #f0f0f8;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 520px; margin: 0 auto; padding: 40px 24px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 32px; }
  .logo span { color: #a855f7; }
  .card {
    background: #13131a;
    border: 1px solid #1e1e2e;
    border-radius: 16px;
    padding: 32px;
    margin-bottom: 24px;
  }
  .badge {
    display: inline-block;
    background: rgba(34,197,94,0.15);
    border: 1px solid rgba(34,197,94,0.3);
    color: #22c55e;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 20px;
    margin-bottom: 16px;
    letter-spacing: 0.3px;
  }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 10px; line-height: 1.3; }
  p { font-size: 15px; color: #c0c0d0; line-height: 1.6; margin-bottom: 16px; }
  .btn {
    display: inline-block;
    background: linear-gradient(135deg, #7c3aed, #a855f7);
    color: #fff !important;
    font-size: 15px;
    font-weight: 600;
    padding: 14px 28px;
    border-radius: 10px;
    text-decoration: none;
    margin-top: 8px;
  }
  .divider { border: none; border-top: 1px solid #1e1e2e; margin: 24px 0; }
  .steps-title {
    font-size: 11px; font-weight: 600; color: #888899;
    text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 14px;
  }
  .step { display: flex; gap: 12px; margin-bottom: 12px; align-items: flex-start; }
  .step-num {
    background: #7c3aed; color: #fff; font-size: 11px; font-weight: 700;
    width: 20px; height: 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 2px;
  }
  .step-text { font-size: 14px; color: #c0c0d0; line-height: 1.5; }
  .step-text strong { color: #f0f0f8; }
  .footer { font-size: 12px; color: #444455; text-align: center; line-height: 1.6; }
  .footer a { color: #666677; }
</style>
</head>
<body>
<div class="wrap">

  <div class="logo">Run<span>Sound</span></div>

  <div class="card">
    <div class="badge">✓ Draft ready in your TikTok inbox</div>
    <h1>Your post for "${songTitle}" is waiting, ${artistName}!</h1>
    <p>
      RunSound has generated your images, written your hooks, and sent a draft straight to your
      <strong style="color:#f0f0f8">TikTok inbox</strong>.
      Open TikTok now and publish it — takes about 30 seconds.
    </p>
    <a href="${dashboardUrl}" class="btn">Open my dashboard →</a>
  </div>

  <div class="card">
    <p class="steps-title">Publish in 30 seconds</p>
    <div class="step">
      <span class="step-num">1</span>
      <span class="step-text">Open TikTok → tap the <strong>notification in your inbox</strong></span>
    </div>
    <div class="step">
      <span class="step-num">2</span>
      <span class="step-text">Tap <strong>"Add sound"</strong> and search for <strong>"${songTitle}"</strong></span>
    </div>
    <div class="step">
      <span class="step-num">3</span>
      <span class="step-text">Tap <strong>Post ✓</strong></span>
    </div>

    <hr class="divider">

    <p style="font-size: 13px; color: #888899; margin-bottom: 0;">
      A new draft arrives automatically every night.
      RunSound tracks views and stream clicks — and gets smarter each week.
    </p>
  </div>

  <div class="footer">
    <p>RunSound — automated TikTok marketing for music artists</p>
    <p style="margin-top: 6px;"><a href="${BASE}">run-sound.com</a></p>
  </div>

</div>
</body>
</html>
  `.trim();

  return sendEmail({ to: email, subject, html });
}

module.exports = { sendEmail, sendWelcomeEmail, sendDraftReadyEmail, sendDailyReport };
