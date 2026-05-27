/**
 * bank-utils.js — RunSound Shared Bank Utilities
 *
 * Image bank and hook bank functions used across pipeline scripts.
 * Both banks live in Supabase for persistence across Railway redeploys.
 *
 * Image bank:  lifestyle photos stored in Supabase Storage, ranked by streaming CTR.
 *              New artists reuse proven images instead of spending OpenAI credits.
 *
 * Hook bank:   cross-artist archetype performance per genre family.
 *              New artists inherit pooled priors from all previous artists.
 *
 * Matching strategy for images:
 *   1. Same arc_role, ordered by avg_ctr DESC (best performers first)
 *   2. Only pick from images with <MAX_REUSE uses recently (ensures variety)
 *   3. Random selection among top-N candidates (avoids always the same image)
 *
 * Exports:
 *   initStorage(supabase)
 *   pickBankImages(supabase, arcRoles, count)         → [{arc_role, id, public_url, safe_zone, tags}]
 *   uploadToBank(supabase, localPath, {arcRole, tags, safeZone, genre, mood})  → {id, public_url}
 *   recordPostImages(supabase, postUid, bankIds)
 *   updateImagePerformance(supabase, bankIds, views, clicks)
 *   getHookWeightsFromBank(supabase, genreFamily)     → {A, B, C, D}
 *   updateHookPerformance(supabase, genreFamily, variantKey, views, clicks)
 */

const fs   = require('fs');
const path = require('path');

const BUCKET          = 'image-bank';
const TOP_N_CANDIDATES = 5;    // Pick randomly from top-N by CTR to ensure visual variety
const MIN_BANK_CTR    = 0;     // Min avg_ctr to prefer bank image (0 = any image counts)

// ─── Ensure Supabase Storage bucket exists ────────────────────────────────────
async function initStorage(supabase) {
  try {
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 10 * 1024 * 1024, // 10 MB
    });
    if (error && !error.message?.includes('already exists')) {
      console.warn(`[bank] Storage bucket init warning: ${error.message}`);
    }
  } catch (err) {
    // Bucket may already exist — that's fine
    if (!err.message?.includes('already exists')) {
      console.warn(`[bank] initStorage error: ${err.message}`);
    }
  }
}

// ─── Pick images from bank for a set of arc roles ─────────────────────────────
// Returns one image per arc role (or null if bank has none for that role).
// Picks randomly from the top-N by avg_ctr to keep visual variety.
//
// arcRoles: ['hook', 'story', 'peak', 'cta']
// Returns: { hook: {id, public_url, safe_zone, tags}, story: {...}, ... }
async function pickBankImages(supabase, arcRoles) {
  const result = {};

  for (const role of arcRoles) {
    try {
      const { data, error } = await supabase
        .from('image_bank')
        .select('id, public_url, safe_zone, tags, avg_ctr, times_used')
        .eq('arc_role', role)
        .order('avg_ctr', { ascending: false })
        .limit(20);  // fetch top 20, pick randomly from top-N

      if (error || !data?.length) {
        result[role] = null;
        continue;
      }

      // Pick randomly from top-N candidates for visual variety
      const candidates = data.slice(0, TOP_N_CANDIDATES);
      const picked     = candidates[Math.floor(Math.random() * candidates.length)];
      result[role] = picked;

    } catch (err) {
      console.warn(`[bank] pickBankImages error for ${role}: ${err.message}`);
      result[role] = null;
    }
  }

  return result;
}

// ─── Upload a local image to Supabase Storage and register in image_bank ──────
// Returns { id, public_url } on success, null on failure.
async function uploadToBank(supabase, localPath, { arcRole, tags = [], safeZone = 'bottom', genre = '', mood = '' }) {
  try {
    const filename    = path.basename(localPath);
    const storagePath = `${arcRole}/${filename}`;
    const fileBuffer  = fs.readFileSync(localPath);

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadError) {
      console.warn(`[bank] Storage upload failed for ${filename}: ${uploadError.message}`);
      return null;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    const publicUrl = urlData?.publicUrl;
    if (!publicUrl) {
      console.warn(`[bank] Could not get public URL for ${storagePath}`);
      return null;
    }

    // Register in image_bank table
    const { data: row, error: insertError } = await supabase
      .from('image_bank')
      .upsert({
        storage_path: storagePath,
        public_url:   publicUrl,
        arc_role:     arcRole,
        tags:         tags,
        safe_zone:    safeZone,
        genre:        genre,
        mood:         mood,
      }, { onConflict: 'storage_path' })
      .select('id, public_url')
      .single();

    if (insertError) {
      console.warn(`[bank] image_bank insert failed: ${insertError.message}`);
      return null;
    }

    return { id: row.id, public_url: row.public_url };

  } catch (err) {
    console.warn(`[bank] uploadToBank error: ${err.message}`);
    return null;
  }
}

// ─── Download a bank image to a local path ────────────────────────────────────
// Uses node's https module (no extra deps needed).
function downloadFromUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http  = require('http');
    const client = url.startsWith('https') ? https : http;
    const file   = require('fs').createWriteStream(destPath);

    client.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFromUrl(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      file.close();
      reject(err);
    });
  });
}

// ─── Record which bank images were used in a post ────────────────────────────
// Stores image_bank_ids on the post_log row so check-analytics.js can
// update image performance after TikTok stats arrive.
async function recordPostImages(supabase, postUid, bankIds) {
  if (!postUid || !bankIds?.length) return;
  try {
    await supabase
      .from('post_log')
      .update({ image_bank_ids: bankIds })
      .eq('post_uid', postUid);

    // Increment times_used for all used images
    for (const id of bankIds) {
      await supabase.rpc('increment_image_bank_uses', { row_id: id }).catch(() => {
        // RPC may not exist yet — fall back to manual update
        return supabase
          .from('image_bank')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', id);
      });
    }
  } catch (err) {
    console.warn(`[bank] recordPostImages error: ${err.message}`);
  }
}

// ─── Increment times_used for image_bank rows (called by recordPostImages) ───
// Also updates last_used_at. Does a simple read-modify-write.
async function incrementImageUses(supabase, bankIds) {
  if (!bankIds?.length) return;
  for (const id of bankIds) {
    try {
      const { data } = await supabase
        .from('image_bank')
        .select('times_used')
        .eq('id', id)
        .single();

      if (data) {
        await supabase
          .from('image_bank')
          .update({
            times_used:   (data.times_used || 0) + 1,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', id);
      }
    } catch { /* best effort */ }
  }
}

// ─── Update image bank performance after analytics sync ──────────────────────
// Called by check-analytics.js once TikTok view counts are available.
// All images in the post share the same post-level performance.
async function updateImagePerformance(supabase, bankIds, newViews, newClicks) {
  if (!bankIds?.length || (!newViews && !newClicks)) return;

  for (const id of bankIds) {
    try {
      const { data } = await supabase
        .from('image_bank')
        .select('total_views, total_clicks, times_used')
        .eq('id', id)
        .single();

      if (!data) continue;

      const totalViews  = (data.total_views  || 0) + newViews;
      const totalClicks = (data.total_clicks || 0) + newClicks;
      const avgCtr      = totalViews > 0 ? totalClicks / totalViews : 0;

      await supabase
        .from('image_bank')
        .update({
          total_views:  totalViews,
          total_clicks: totalClicks,
          avg_ctr:      avgCtr,
        })
        .eq('id', id);

    } catch (err) {
      console.warn(`[bank] updateImagePerformance error for ${id}: ${err.message}`);
    }
  }
}

// ─── Get hook bank weights for a genre family ────────────────────────────────
// Returns {A: float, B: float, C: float, D: float} weight map.
// If a genre has no data yet, returns equal weights (flat prior).
// Used by generate-texts.js as cross-artist prior before campaign accumulates its own data.
async function getHookWeightsFromBank(supabase, genreFamily) {
  const flat = { A: 1.0, B: 1.0, C: 1.0, D: 1.0 };

  if (!supabase || !genreFamily) return flat;

  try {
    const { data, error } = await supabase
      .from('hook_bank')
      .select('variant_key, avg_ctr, times_used')
      .eq('genre_family', genreFamily);

    if (error || !data?.length) return flat;

    // Only use bank data if at least one variant has been tested
    const hasSomeData = data.some(r => (r.times_used || 0) > 0);
    if (!hasSomeData) return flat;

    // Convert avg_ctr to weights; add small epsilon so unexplored variants stay in play
    const EPSILON = 0.01;
    const weights = { ...flat };
    for (const row of data) {
      if (row.variant_key) {
        weights[row.variant_key] = (row.avg_ctr || 0) + EPSILON;
      }
    }

    return weights;
  } catch (err) {
    console.warn(`[bank] getHookWeightsFromBank error: ${err.message}`);
    return flat;
  }
}

// ─── Merge campaign-specific hook weights with bank-wide priors ───────────────
// Campaign weights take precedence once they have enough data (>= minPosts posts).
// Below that threshold, blend bank prior with campaign data.
//
// This prevents a new artist's first few posts from over-fitting to random variance.
function mergeHookWeights(campaignWeights, bankWeights, campaignPostCount = 0) {
  const MIN_CAMPAIGN_POSTS = 7; // trust campaign weights after 1 week

  if (campaignPostCount >= MIN_CAMPAIGN_POSTS) {
    // Enough campaign data — use it directly
    return campaignWeights;
  }

  // Blend: lerp between bank prior and campaign data based on post count
  const t = campaignPostCount / MIN_CAMPAIGN_POSTS; // 0.0 → 1.0
  const merged = {};
  for (const key of Object.keys(bankWeights)) {
    const bw = bankWeights[key]      || 1.0;
    const cw = campaignWeights[key]  || 1.0;
    merged[key] = bw * (1 - t) + cw * t;
  }
  return merged;
}

// ─── Update hook bank performance after analytics sync ───────────────────────
// Called by check-analytics.js once streaming CTR is known for a post.
async function updateHookPerformance(supabase, genreFamily, variantKey, newViews, newClicks) {
  if (!supabase || !genreFamily || !variantKey) return;
  if (!newViews && !newClicks) return;

  try {
    const { data } = await supabase
      .from('hook_bank')
      .select('total_views, total_clicks, times_used')
      .eq('genre_family', genreFamily)
      .eq('variant_key', variantKey)
      .single();

    if (!data) return;

    const totalViews  = (data.total_views  || 0) + newViews;
    const totalClicks = (data.total_clicks || 0) + newClicks;
    const avgCtr      = totalViews > 0 ? totalClicks / totalViews : 0;

    await supabase
      .from('hook_bank')
      .update({
        total_views:  totalViews,
        total_clicks: totalClicks,
        avg_ctr:      avgCtr,
        times_used:   (data.times_used || 0) + 1,
        last_updated: new Date().toISOString(),
      })
      .eq('genre_family', genreFamily)
      .eq('variant_key', variantKey);

  } catch (err) {
    console.warn(`[bank] updateHookPerformance error: ${err.message}`);
  }
}

module.exports = {
  initStorage,
  pickBankImages,
  uploadToBank,
  downloadFromUrl,
  recordPostImages,
  incrementImageUses,
  updateImagePerformance,
  getHookWeightsFromBank,
  mergeHookWeights,
  updateHookPerformance,
};
