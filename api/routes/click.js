/**
 * POST /api/click
 *
 * Records a streaming click from the smart link page.
 * Called via navigator.sendBeacon from web/link.html.
 *
 * Body:
 *   utm       string  POST_UID: "rs-<timestamp>-<variant>"
 *   platform  string  spotify | apple | youtube | tidal | deezer | amazon | soundcloud
 *   ts        number  Client timestamp (ms)
 *
 * Returns 204 No Content (beacon doesn't read the response).
 */
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const supabase = require('../db');

router.post('/', async (req, res) => {
  // Always return 204 immediately — beacon doesn't wait
  res.status(204).end();

  try {
    const { utm, platform, ts } = req.body;

    if (!utm) return;

    // Hash IP for privacy
    const ip      = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '';
    const ipHash  = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);

    // Look up campaign by matching UTM to a post_uid or campaign slug
    let campaignId = null;
    const { data: postRow } = await supabase
      .from('post_log')
      .select('campaign_id')
      .eq('post_uid', utm)
      .single();

    if (postRow?.campaign_id) {
      campaignId = postRow.campaign_id;
    }

    // Insert click
    await supabase.from('utm_clicks').insert({
      campaign_id:  campaignId,
      utm_campaign: utm,
      platform:     platform || null,
      clicked_at:   ts ? new Date(ts).toISOString() : new Date().toISOString(),
      user_agent:   req.headers['user-agent']?.slice(0, 200) || null,
      ip_hash:      ipHash,
    });

    // Update streaming_clicks count on post_log
    if (campaignId) {
      await supabase.rpc('increment_streaming_clicks', { p_post_uid: utm });
    }

  } catch (err) {
    // Silent — beacon clicks should never error to the user
    console.error('[click] Error:', err.message);
  }
});

module.exports = router;
