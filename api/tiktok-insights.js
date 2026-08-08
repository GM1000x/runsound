/**
 * api/tiktok-insights.js — fetch organic performance for posted videos
 *
 * Used by api/cron.js (runMeasurePerformance) roughly 48-72h after a video
 * is published, to fill in rs_post_results with real numbers so
 * runScoreIdeas can rank ideas and runLearnPromptStyles can learn which
 * prompt styles win.
 *
 * HONEST SCOPE NOTE (checked against TikTok's own docs, Aug 2026):
 *   - This calls the Display API's /v2/video/query/ endpoint, which needs
 *     the `video.list` scope. RunSound's TikTok app currently only has
 *     `user.info.basic` + `video.upload` approved (see api/tiktok-api.js's
 *     scope comment on postVideo) — video.list is a THIRD scope gap on top
 *     of video.publish, and needs its own app-review submission before this
 *     function will return real data instead of an auth error.
 *   - Even once granted, the public Display API does not expose
 *     "completion rate" or "saves" — those numbers are only available
 *     through TikTok's Business/Creator Marketplace-tier APIs, which are a
 *     separate, heavier partnership application. So `completion_rate` and
 *     `saves` below are left null with a comment, not faked — views/likes/
 *     comments/shares are the real, gettable proxy signal for ranking in
 *     the meantime.
 */

require('dotenv').config();

const https = require('https');
const TIKTOK_API_HOST = 'open.tiktokapis.com';

/**
 * @param {string} accessToken   Artist's valid TikTok access token
 * @param {string} tiktokVideoId The platform video id (NOT the publish_id
 *   returned at post time — TikTok's post-status-fetch response includes
 *   the resulting video id once a post finishes processing; that's what
 *   should be stored/passed here. Confirm exact field name once video.list
 *   is granted and this can be tested end-to-end.)
 * @returns {Promise<{views:number, likes:number, comments:number, shares:number, completionRate:null, saves:null}>}
 */
async function getVideoPerformance(accessToken, tiktokVideoId) {
  const body = JSON.stringify({ filters: { video_ids: [tiktokVideoId] } });
  const fields = 'id,view_count,like_count,comment_count,share_count';

  const resp = await jsonRequest({
    hostname: TIKTOK_API_HOST,
    path: `/v2/video/query/?fields=${fields}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (resp.error?.code && resp.error.code !== 'ok') {
    throw new Error(`TikTok video.query error (${resp.error.code}): ${resp.error.message}`);
  }

  const video = (resp.data?.videos || [])[0];
  if (!video) throw new Error(`No video data returned for ${tiktokVideoId}`);

  return {
    views:    video.view_count    || 0,
    likes:    video.like_count    || 0,
    comments: video.comment_count || 0,
    shares:   video.share_count   || 0,
    completionRate: null, // not available via public Display API — see file header
    saves:          null, // not available via public Display API — see file header
  };
}

function jsonRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, resp => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Failed to parse response: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { getVideoPerformance };
