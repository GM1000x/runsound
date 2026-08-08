/**
 * api/postiz.js — Postiz client, used for Instagram posting.
 *
 * TikTok already has a direct, OAuth-backed integration (api/tiktok-api.js)
 * — no need to duplicate that here. Postiz covers Instagram until a direct
 * Meta Graph API integration is built the same way.
 *
 * Needs the enterprise/white-label Postiz tier ("Add Postiz to Your SaaS")
 * so each artist gets an isolated `customer_group` under one RunSound
 * account, rather than a separate Postiz account per artist. See
 * postiz-for-musik-plan.md for the reasoning.
 *
 * TODO before going live: confirm exact REST paths against your Postiz
 * enterprise onboarding docs — docs.postiz.com/mcp documents the MCP tool
 * surface (schedulePostTool, integrationList, etc.) but this file assumes
 * the REST API mirrors those names, unconfirmed.
 */

require('dotenv').config();

const POSTIZ_API_BASE = process.env.POSTIZ_API_BASE || 'https://api.postiz.com';
const POSTIZ_API_KEY  = process.env.POSTIZ_API_KEY || '';

function authHeaders() {
  if (!POSTIZ_API_KEY) {
    throw new Error('POSTIZ_API_KEY not set — get it from Settings > Developers > Public API in your Postiz account.');
  }
  return {
    Authorization: `Bearer ${POSTIZ_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * @param {Object} params
 * @param {string} params.customerGroup  artistId — keeps each artist's Instagram isolated
 * @param {string} params.videoUrl
 * @param {string} params.caption
 * @returns {Promise<{ postId: string }>}
 */
async function schedulePost({ customerGroup, videoUrl, caption }) {
  const res = await fetch(`${POSTIZ_API_BASE}/v1/posts`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      customer_group: customerGroup,
      platform: 'instagram',
      media_url: videoUrl,
      caption,
      publish_now: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Postiz schedulePost failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return { postId: data.id };
}

/**
 * @param {string} postId
 * @returns {Promise<{ views: number, saves: number, shares: number, completionRate?: number }>}
 */
async function getPostPerformance(postId) {
  const res = await fetch(`${POSTIZ_API_BASE}/v1/posts/${postId}/analytics`, {
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Postiz getPostPerformance failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return {
    views: data.views || 0,
    saves: data.saves || 0,
    shares: data.shares || 0,
    completionRate: data.completion_rate,
  };
}

module.exports = { schedulePost, getPostPerformance };
