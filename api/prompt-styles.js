/**
 * api/prompt-styles.js — batch prompt-style catalog for freebeat generation
 *
 * From the Aug 2026 strategy shift: instead of generating one video per
 * song/idea, generate a BATCH of 10-15 clips per song, each using a
 * different creative "style" (vibe prompt passed to freebeat). Everything
 * gets tested organically; the winner gets boosted. This file owns:
 *
 *   1. The style catalog itself (name -> vibe prompt + freebeat variant type)
 *   2. pickBatchStyles() — weighted selection for a new batch, reading
 *      learned weights from rs_prompt_weights (see runLearnPromptStyles in
 *      cron.js) so styles that have historically performed better get
 *      picked more often — without ever fully dropping a style to zero
 *      (exploration vs exploitation, same principle as the winner's-pool
 *      ad-testing loop in the plan).
 *
 * Used by: api/routes/campaigns.js (batch generation on campaign create).
 */

const supabase = require('./db');

// Each style keeps aspect_ratio 9:16 (TikTok/Reels vertical) unless noted.
// `variant` maps to freebeat's own style/variant param (see api/freebeat.js).
const STYLES = [
  { key: 'neon_city',        label: 'Neon city, fast cuts',       variant: 'visualizer', vibe: 'neon-lit city at night, fast rhythmic cuts synced to the beat, high energy' },
  { key: 'moody_storytelling', label: 'Moody storytelling',       variant: 'lyric-video', vibe: 'moody cinematic storytelling, slow push-ins, muted color grade, emotional' },
  { key: 'dance_cut',        label: 'Dance video',                variant: 'dance-cut',   vibe: 'energetic dance cut synced to the drop, dynamic camera movement' },
  { key: 'lyric_closeup',    label: 'Lyric close-up',              variant: 'lyric-video', vibe: 'clean animated lyrics, tight close-up framing, minimal background' },
  { key: 'pov_handheld',     label: 'POV handheld',                variant: 'visualizer',  vibe: 'raw handheld POV footage, natural light, documentary feel' },
  { key: 'retro_vhs',        label: 'Retro VHS',                   variant: 'visualizer',  vibe: 'retro VHS grain and glitch, warm analog color, nostalgic' },
  { key: 'studio_bts',       label: 'Studio behind-the-scenes',    variant: 'visualizer',  vibe: 'behind-the-scenes studio session look, intimate, candid framing' },
  { key: 'split_screen',     label: 'Split-screen contrast',       variant: 'visualizer',  vibe: 'split-screen contrasting visuals synced to the beat switch' },
  { key: 'golden_hour',      label: 'Golden hour outdoor',         variant: 'visualizer',  vibe: 'golden hour outdoor footage, warm natural light, dreamy' },
  { key: 'high_contrast_bw', label: 'High-contrast black & white', variant: 'visualizer',  vibe: 'high-contrast black and white, dramatic shadows, bold framing' },
  { key: 'text_meme',        label: 'Text/meme hook format',       variant: 'lyric-video', vibe: 'bold meme-style text overlay hook, stop-scroll first 2 seconds' },
  { key: 'dreamy_slowmo',    label: 'Dreamy slow motion',          variant: 'visualizer',  vibe: 'dreamy slow motion, soft focus, pastel color grade' },
  { key: 'club_strobe',      label: 'Club strobe energy',          variant: 'dance-cut',   vibe: 'club strobe lighting, high-energy crowd feel, fast strobing cuts' },
  { key: 'minimal_studio',   label: 'Minimal studio portrait',     variant: 'lyric-video', vibe: 'minimal studio portrait, plain backdrop, focus entirely on the artist' },
  { key: 'street_pov',       label: 'Street POV walk',             variant: 'visualizer',  vibe: 'walking POV through city streets, candid passersby, urban energy' },
];

const DEFAULT_BATCH_SIZE = 12;
const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 15;
const MIN_WEIGHT = 0.15; // floor so no style ever fully stops getting tried (exploration)

/**
 * Weighted-random pick of N distinct styles for a new batch.
 * Reads rs_prompt_weights if available; falls back to equal weighting
 * (1.0 each) for styles with no learned data yet — new products have no
 * history, so this must work with an empty weights table on day one.
 *
 * @param {number} n  How many styles to pick (clamped 10-15)
 * @returns {Promise<Array<{key,label,variant,vibe,weight}>>}
 */
async function pickBatchStyles(n = DEFAULT_BATCH_SIZE) {
  const count = Math.min(Math.max(n, MIN_BATCH_SIZE), MAX_BATCH_SIZE);

  let weights = {};
  try {
    const { data } = await supabase.from('rs_prompt_weights').select('style_key, weight');
    for (const row of data || []) weights[row.style_key] = Math.max(row.weight, MIN_WEIGHT);
  } catch (err) {
    console.warn('[prompt-styles] Could not load rs_prompt_weights, using equal weights:', err.message);
  }

  const pool = STYLES.map(s => ({ ...s, weight: weights[s.key] ?? 1.0 }));

  // If we have <= count styles total, just return all of them (still batch-worthy at 15 max).
  if (pool.length <= count) return pool;

  // Weighted sample without replacement.
  const picked = [];
  const remaining = [...pool];
  while (picked.length < count && remaining.length > 0) {
    const totalWeight = remaining.reduce((sum, s) => sum + s.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= remaining[idx].weight;
      if (r <= 0) break;
    }
    picked.push(remaining.splice(Math.min(idx, remaining.length - 1), 1)[0]);
  }
  return picked;
}

module.exports = { STYLES, pickBatchStyles, DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE };
