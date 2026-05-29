/**
 * api/tiktok-api.js — RunSound Direct TikTok Content Posting API
 *
 * Replaces Postiz for artists who have connected their TikTok via OAuth.
 * Posts image carousels as drafts (SELF_ONLY) so the artist can open TikTok,
 * add their song from the music library, and publish.
 *
 * TikTok API v2 flow:
 *   1. POST /v2/post/publish/content/init/  → get publish_id + upload_urls
 *   2. PUT  {upload_url} for each image      → upload binary
 *   3. POST /v2/post/publish/status/fetch/  → poll until SEND_TO_USER_INBOX
 *
 * Token management:
 *   getValidToken(artistId) reads from Supabase, auto-refreshes if expired.
 *
 * Used by:
 *   post-to-tiktok.js (standalone script — require as './api/tiktok-api')
 *   api/routes/tiktok-auth.js  (Express route — require as '../tiktok-api')
 */

require('dotenv').config();

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const TIKTOK_API_HOST = 'open.tiktokapis.com';
const CLIENT_KEY      = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET   = process.env.TIKTOK_CLIENT_SECRET;

// ─── Supabase (optional — gracefully skipped if not configured) ───────────────
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (sbUrl && sbKey) {
    supabase = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
  }
} catch { /* supabase not installed */ }

// ─── Token management ─────────────────────────────────────────────────────────

/**
 * Get a valid TikTok access token for an artist.
 * Reads from Supabase, auto-refreshes if within 5 minutes of expiry.
 *
 * @param {string} artistId  Supabase artist UUID
 * @returns {{ accessToken: string, openId: string } | null}
 */
async function getValidToken(artistId) {
  if (!supabase || !artistId) return null;

  const { data: artist, error } = await supabase
    .from('artists')
    .select('tiktok_access_token, tiktok_refresh_token, tiktok_token_expires_at, tiktok_open_id')
    .eq('id', artistId)
    .single();

  if (error || !artist?.tiktok_access_token) return null;

  // Check expiry with a 5-minute buffer
  const expiresAt = new Date(artist.tiktok_token_expires_at || 0);
  const bufferMs  = 5 * 60 * 1000;
  const needsRefresh = expiresAt.getTime() - Date.now() < bufferMs;

  if (needsRefresh) {
    if (!artist.tiktok_refresh_token) {
      console.warn('[tiktok-api] Token expired and no refresh_token available');
      return null;
    }
    try {
      console.log('[tiktok-api] Access token expiring — refreshing...');
      const refreshed = await refreshAccessToken(artist.tiktok_refresh_token);

      if (!refreshed.access_token) {
        throw new Error(refreshed.error_description || 'No access_token in refresh response');
      }

      const now = new Date();
      const expiresIn = refreshed.expires_in || 86400;
      await supabase.from('artists').update({
        tiktok_access_token:     refreshed.access_token,
        tiktok_refresh_token:    refreshed.refresh_token || artist.tiktok_refresh_token,
        tiktok_token_expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      }).eq('id', artistId);

      console.log('[tiktok-api] ✅ Token refreshed');
      return { accessToken: refreshed.access_token, openId: artist.tiktok_open_id };
    } catch (err) {
      console.error('[tiktok-api] Token refresh failed:', err.message);
      return null;
    }
  }

  return { accessToken: artist.tiktok_access_token, openId: artist.tiktok_open_id };
}

/**
 * Refresh an expired access token using the refresh_token.
 */
function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_key:    CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  return jsonPost({
    hostname: TIKTOK_API_HOST,
    path:     '/v2/oauth/token/',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body);
}

// ─── Content Posting API ──────────────────────────────────────────────────────

/**
 * Post a photo carousel to TikTok as a draft (SELF_ONLY).
 * The artist will see it in their TikTok inbox, add sound, and publish.
 *
 * @param {string}   accessToken  Artist's valid access token
 * @param {string[]} imagePaths   Local file paths: [slide1.png, slide2.png, ...]
 * @param {string}   caption      Post caption (max 2200 chars)
 * @returns {Promise<{ publishId: string, status: string }>}
 */
async function postPhotoCarousel(accessToken, imagePaths, caption, title = '') {
  const photoCount = imagePaths.length;
  if (photoCount === 0) throw new Error('No images provided');
  if (photoCount > 35)  throw new Error('TikTok supports max 35 images per carousel');

  // TikTok photo carousel API uses post_info.title as the caption/description field.
  // We combine the human-readable title with the hashtags+link caption.
  // Format: "Song by Artist\n🎵 Stream it: https://...\n#deephouse #newmusic"
  const fullCaption = [title, caption].filter(Boolean).join('\n');

  console.log(`\n[tiktok-api] 📸 Posting ${photoCount}-image carousel as draft...`);
  console.log(`[tiktok-api] Title:   ${title || '(none)'}`);
  console.log(`[tiktok-api] Caption: ${caption.slice(0, 80).replace(/\n/g, ' / ')}`);

  // ── Step 1: Initialise the post ──────────────────────────────────────────────
  const initBody = {
    post_info: {
      title:            fullCaption.slice(0, 2200),
      privacy_level:    'SELF_ONLY',   // → sends to artist's inbox as a draft
      disable_duet:     true,
      disable_stitch:   true,
      disable_comment:  false,
      auto_add_music:   false,
    },
    source_info: {
      source:             'FILE_UPLOAD',
      photo_cover_index:  0,
      photo_count:        photoCount,
    },
    media_type: 'PHOTO',
    post_mode:  'UPLOAD_AND_DIRECT_POST',
  };

  const initResp = await apiRequest('POST', '/v2/post/publish/content/init/', accessToken, initBody);

  if (initResp.error?.code && initResp.error.code !== 'ok') {
    throw new Error(`TikTok init error (${initResp.error.code}): ${initResp.error.message}`);
  }

  const publishId  = initResp.data?.publish_id;
  const uploadUrls = initResp.data?.upload_urls || [];

  if (!publishId) {
    throw new Error(`No publish_id in response: ${JSON.stringify(initResp).slice(0, 300)}`);
  }
  if (uploadUrls.length < photoCount) {
    throw new Error(`TikTok returned ${uploadUrls.length} upload URLs for ${photoCount} images`);
  }

  console.log(`[tiktok-api] Publish ID: ${publishId}`);

  // ── Step 2: Upload each image ────────────────────────────────────────────────
  for (let i = 0; i < imagePaths.length; i++) {
    const imgPath = imagePaths[i];
    console.log(`[tiktok-api] Uploading image ${i + 1}/${photoCount}: ${path.basename(imgPath)}`);
    await uploadImageToUrl(uploadUrls[i], imgPath);
    console.log(`[tiktok-api]   ✅ Image ${i + 1} uploaded`);
  }

  // ── Step 3: Poll until draft lands in inbox ──────────────────────────────────
  console.log('[tiktok-api] Waiting for TikTok to process images...');
  const finalStatus = await pollStatus(accessToken, publishId);
  console.log(`[tiktok-api] Final status: ${finalStatus}`);

  if (finalStatus === 'FAILED') {
    throw new Error('TikTok post processing failed — check TikTok developer console');
  }

  return { publishId, status: finalStatus };
}

/**
 * Upload a single image file to TikTok's upload URL via HTTP PUT.
 */
function uploadImageToUrl(uploadUrl, imagePath) {
  const imageData = fs.readFileSync(imagePath);
  const url       = new URL(uploadUrl);
  const isHttps   = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'PUT',
      headers:  {
        'Content-Type':   'image/png',
        'Content-Length': imageData.length,
      },
    };

    const req = transport.request(options, resp => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Image upload HTTP ${resp.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(imageData);
    req.end();
  });
}

/**
 * Poll /v2/post/publish/status/fetch/ until terminal state.
 *
 * Terminal states:
 *   SEND_TO_USER_INBOX  — draft in artist's TikTok inbox ✅
 *   PUBLISH_COMPLETE    — direct-published ✅
 *   FAILED              — processing error ❌
 */
async function pollStatus(accessToken, publishId, maxAttempts = 20, intervalMs = 4000) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);

    const resp = await apiRequest('POST', '/v2/post/publish/status/fetch/', accessToken, {
      publish_id: publishId,
    });

    const status = resp.data?.status;
    console.log(`[tiktok-api]   Poll ${i + 1}/${maxAttempts}: ${status || 'unknown'}`);

    if (!status || status === 'PROCESSING_UPLOAD') continue; // still processing
    if (['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE'].includes(status)) return status;
    if (status === 'FAILED') return 'FAILED';
  }

  throw new Error(`TikTok post timed out after ${maxAttempts} polls`);
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

/**
 * HTTPS JSON request to TikTok API.
 * Includes Authorization: Bearer header automatically.
 */
function apiRequest(method, apiPath, accessToken, body) {
  const bodyStr = JSON.stringify(body);
  return jsonPost({
    hostname: TIKTOK_API_HOST,
    path:     apiPath,
    method,
    headers:  {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json; charset=UTF-8',
    },
  }, bodyStr);
}

/**
 * Generic HTTPS POST/PUT that returns parsed JSON.
 */
function jsonPost(opts, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const options = {
      ...opts,
      method:  opts.method || 'POST',
      headers: {
        ...opts.headers,
        'Content-Length': bodyBuf.length,
      },
    };

    const req = https.request(options, resp => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Failed to parse response: ${data.slice(0, 300)}`)); }
      });
    });

    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── PKCE helpers (used by tiktok-auth.js) ───────────────────────────────────

function generateCodeVerifier() {
  // 96 random bytes → 128-char base64url string (within TikTok's 43-128 char limit)
  return crypto.randomBytes(96).toString('base64url').slice(0, 128);
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

module.exports = {
  getValidToken,
  postPhotoCarousel,
  refreshAccessToken,
  generateCodeVerifier,
  generateCodeChallenge,
};
