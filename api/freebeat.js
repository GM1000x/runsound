/**
 * api/freebeat.js — freebeat.ai client
 *
 * Generates release videos / lyric videos / dance-cut videos / short test
 * clips directly from a song. Used by:
 *   - api/routes/campaigns.js (kicks off generation on upload)
 *   - api/cron.js (polls job status, hands finished videos to publishing)
 *
 * freebeat exposes an MCP server (`npx -y freebeat-mcp`) for agent clients
 * like Claude Desktop/Cursor. This server calls their REST API directly
 * instead — simpler for a long-running Node service than speaking MCP
 * JSON-RPC over stdio.
 *
 * TODO before going live: confirm exact REST paths/payload shape against
 * freebeat's own API docs once you have account access — the endpoints
 * below are a best-guess shape based on their MCP tool surface
 * (https://freebeat.ai/mcp) and may need adjusting.
 */

require('dotenv').config();

const FREEBEAT_API_BASE = process.env.FREEBEAT_API_BASE || 'https://api.freebeat.ai';
const FREEBEAT_API_KEY  = process.env.FREEBEAT_API_KEY || '';

/**
 * @param {Object} params
 * @param {string} params.audioUrl   Direct link, or a Suno/Udio/YouTube/SoundCloud link
 * @param {'lyric-video'|'dance-cut'|'visualizer'|'test-clip'} params.variant
 * @param {'9:16'|'16:9'} params.aspectRatio
 * @param {number} [params.maxDurationSeconds]
 * @param {string} [params.vibe]  Free-text creative brief (e.g. "energetic
 *   dance cut synced to the drop") — freebeat's own "Agent" UI suggests
 *   their model accepts a vibe prompt and auto-fills the rest; unconfirmed
 *   for the API specifically, verify once you have real access.
 * @returns {Promise<{ jobId: string, promptJson: string }>}
 */
async function generateVideo({ audioUrl, variant, aspectRatio, maxDurationSeconds, vibe }) {
  if (!FREEBEAT_API_KEY) {
    throw new Error('FREEBEAT_API_KEY not set — sign up at freebeat.ai and add the key from your profile.');
  }

  const body = {
    audio_url: audioUrl,
    style: variant,
    aspect_ratio: aspectRatio,
    max_duration_seconds: maxDurationSeconds || (variant === 'test-clip' ? 15 : 90),
    ...(vibe ? { vibe } : {}),
  };

  const res = await fetch(`${FREEBEAT_API_BASE}/v1/videos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FREEBEAT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`freebeat generateVideo failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return { jobId: data.job_id, promptJson: JSON.stringify(body) };
}

/**
 * @param {string} jobId
 * @returns {Promise<{ status: 'pending'|'processing'|'ready'|'failed', videoUrl?: string }>}
 */
async function getVideoStatus(jobId) {
  const res = await fetch(`${FREEBEAT_API_BASE}/v1/videos/${jobId}`, {
    headers: { Authorization: `Bearer ${FREEBEAT_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`freebeat getVideoStatus failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return { status: data.status, videoUrl: data.video_url };
}

module.exports = { generateVideo, getVideoStatus };
