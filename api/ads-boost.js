/**
 * api/ads-boost.js — STUB. Boosting a winning organic post with real ad
 * spend is NOT implemented yet. This file exists to mark the shape of the
 * next phase, not to be called from cron or routes yet.
 *
 * Where this fits: api/cron.js's runScoreIdeas() already moves a campaign
 * to status 'AWAITING_BUDGET_APPROVAL' once its top idea has a non-zero
 * organic score. Nothing currently reads that status — that's the gap this
 * file is meant to fill, deliberately left undone rather than faked,
 * because it involves real artist money and needs explicit design work
 * first, not just an API wrapper:
 *
 *   1. An artist-facing approval step (dashboard UI + endpoint) — the plan's
 *      safety principle is "agent proposes, artist approves," never
 *      autonomous spend. AWAITING_BUDGET_APPROVAL should stay in that
 *      state until a human artist explicitly confirms a budget amount.
 *   2. TikTok Spark Ads — boosting the winning organic post (not a fresh
 *      cold ad) requires the artist to generate a Spark Ads Video
 *      Authorization Code from TikTok's own app/creator tools for that
 *      specific post, which gets passed into TikTok's Ads API
 *      (POST /open_api/v1.3/ad/create/ with a TT_SparkAds identity). This
 *      is a one-time per-post authorization the artist does, not something
 *      RunSound can generate on their behalf.
 *   3. A TikTok Ads API app + access token — separate credential/approval
 *      track from the Content Posting API app already set up
 *      (developers.tiktok.com/app/7633100747659560967), not yet created.
 *   4. Budget pacing/kill-switch logic per the plan's winner's-pool
 *      algorithm — not just "spend $X", but front-loaded pacing the first
 *      24-48h and a stop condition if cost-adjusted engagement underperforms.
 *
 * Until all four exist, boosting should stay a manual step: the artist
 * gets notified their campaign is ready to boost, and does the TikTok/Meta
 * ads step themselves for now. Automating it is real future work, not a
 * afternoon's wrapper.
 */

async function boostWinner() {
  throw new Error(
    'ads-boost.boostWinner() is not implemented — see file header. ' +
    'AWAITING_BUDGET_APPROVAL campaigns currently require manual boosting by the artist.'
  );
}

module.exports = { boostWinner };
