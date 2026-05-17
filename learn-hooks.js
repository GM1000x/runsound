#!/usr/bin/env node
/**
 * learn-hooks.js — RunSound Hook Archetype Learning Loop
 *
 * Reads post_log from Supabase, computes streaming_ctr per hook archetype
 * per campaign, and updates campaigns.hook_weights so generate-texts.js
 * automatically favours the archetypes that drive the most streaming clicks.
 *
 * RunSound's core metric: STREAMING CLICKS (not views, not likes).
 * The archetype that gets the most people to click the smart link wins.
 *
 * Algorithm: normalised score weights (not ε-greedy here — that lives in
 * generate-texts.js). This script just computes and stores the weights.
 * Minimum 3 posts per archetype before we trust the data.
 *
 * Archetypes:
 *   social_proof  — "Showed someone + their reaction"
 *   contrarian    — "They doubted it → heard it → changed their mind"
 *   mystery       — Minimal / curiosity gap
 *
 * Usage:
 *   node learn-hooks.js                        ← all campaigns
 *   node learn-hooks.js --campaign-id <uuid>   ← one campaign
 *   node learn-hooks.js --dry-run              ← show without writing
 *
 * Called by scheduler.js every Monday at 04:00.
 */

require('dotenv').config();

const args     = process.argv.slice(2);
const getArg   = n => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i+1] : null; };
const DRY_RUN  = args.includes('--dry-run');
const ONE_ID   = getArg('campaign-id');
const MIN_POSTS = 3; // minimum posts per archetype before trusting the data

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Compute weights from post_log rows ───────────────────────────────────────
// Returns { social_proof: 1.4, contrarian: 0.8, mystery: 1.0 } etc.
// Archetypes with too few posts keep weight = 1.0 (neutral — keep exploring)
function computeWeights(rows) {
  const ARCHETYPES = ['social_proof', 'contrarian', 'mystery'];

  // Group by archetype
  const groups = {};
  for (const arch of ARCHETYPES) {
    groups[arch] = rows.filter(r => r.hook_archetype === arch);
  }

  // Compute average streaming_ctr per archetype
  const avgs = {};
  for (const arch of ARCHETYPES) {
    const posts = groups[arch];
    if (posts.length < MIN_POSTS) {
      avgs[arch] = null; // not enough data
    } else {
      const totalCtr = posts.reduce((s, p) => s + (p.streaming_ctr || 0), 0);
      avgs[arch] = totalCtr / posts.length;
    }
  }

  // If no archetype has enough data, keep equal weights
  const withData = ARCHETYPES.filter(a => avgs[a] !== null);
  if (withData.length === 0) {
    return { A: 1.0, B: 1.0, C: 1.0 };
  }

  // Normalise: map archetype → variant letter
  const archetypeToVariant = { social_proof: 'A', contrarian: 'B', mystery: 'C' };

  // Fill missing archetypes with the mean of known ones
  const knownAvgs   = withData.map(a => avgs[a]);
  const meanCtr     = knownAvgs.reduce((s, v) => s + v, 0) / knownAvgs.length;

  for (const arch of ARCHETYPES) {
    if (avgs[arch] === null) avgs[arch] = meanCtr;
  }

  // Normalise to sum = 3.0 (so average weight stays ~1.0)
  const total  = ARCHETYPES.reduce((s, a) => s + avgs[a], 0);
  const weights = {};
  for (const arch of ARCHETYPES) {
    const v = archetypeToVariant[arch];
    // Avoid division by zero; min weight 0.1 so we never fully stop exploring
    weights[v] = total > 0
      ? Math.max(0.1, parseFloat(((avgs[arch] / total) * 3).toFixed(3)))
      : 1.0;
  }

  return weights;
}

// ─── Process one campaign ─────────────────────────────────────────────────────
async function processCampaign(campaign) {
  const id   = campaign.id;
  const name = `${campaign.artist_name} — ${campaign.song_title}`;

  // Fetch all posts with streaming data for this campaign
  const { data: posts, error } = await sb
    .from('post_log')
    .select('hook_archetype, streaming_ctr, streaming_clicks, views, posted_at')
    .eq('campaign_id', id)
    .not('hook_archetype', 'is', null)
    .order('posted_at', { ascending: false })
    .limit(90); // last ~3 months

  if (error) {
    console.error(`  ❌ ${name}: ${error.message}`);
    return;
  }

  if (!posts || posts.length === 0) {
    console.log(`  ⏭  ${name}: no tagged posts yet — keeping equal weights`);
    return;
  }

  const withClicks  = posts.filter(p => p.streaming_ctr !== null && p.streaming_ctr !== undefined);
  const newWeights  = computeWeights(withClicks);

  // Count per archetype for logging
  const counts = { social_proof: 0, contrarian: 0, mystery: 0 };
  for (const p of posts) if (p.hook_archetype in counts) counts[p.hook_archetype]++;

  console.log(`\n  📊 ${name}`);
  console.log(`     Posts analysed: ${withClicks.length} (${posts.length} total tagged)`);
  console.log(`     social_proof (A): ${counts.social_proof} posts → weight ${newWeights.A}`);
  console.log(`     contrarian   (B): ${counts.contrarian}   posts → weight ${newWeights.B}`);
  console.log(`     mystery      (C): ${counts.mystery}      posts → weight ${newWeights.C}`);

  const winner = Object.entries(newWeights).sort((a, b) => b[1] - a[1])[0];
  const archetypeNames = { A: 'social_proof', B: 'contrarian', C: 'mystery' };
  console.log(`     🏆 Winner: Variant ${winner[0]} (${archetypeNames[winner[0]]}) — weight ${winner[1]}`);

  if (DRY_RUN) {
    console.log(`     [dry-run] would update hook_weights to ${JSON.stringify(newWeights)}`);
    return;
  }

  const { error: updateErr } = await sb
    .from('campaigns')
    .update({ hook_weights: newWeights })
    .eq('id', id);

  if (updateErr) {
    console.error(`  ❌ Failed to update hook_weights: ${updateErr.message}`);
  } else {
    console.log(`     ✅ hook_weights updated in Supabase`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🧠 RunSound — Hook Learning Loop');
  console.log('==================================');
  console.log(`   Metric:   streaming_ctr (clicks ÷ views)`);
  console.log(`   Min posts: ${MIN_POSTS} per archetype before trusting data`);
  if (DRY_RUN) console.log('   Mode:     DRY RUN\n');

  // Load campaigns
  let query = sb
    .from('campaigns')
    .select('id, artist_name, song_title, hook_weights')
    .eq('onboarding_status', 'done');

  if (ONE_ID) query = query.eq('id', ONE_ID);

  const { data: campaigns, error } = await query;
  if (error) { console.error('❌ Failed to load campaigns:', error.message); process.exit(1); }
  if (!campaigns?.length) { console.log('No active campaigns found.'); process.exit(0); }

  console.log(`\nProcessing ${campaigns.length} campaign(s)...\n`);

  for (const campaign of campaigns) {
    await processCampaign(campaign);
  }

  console.log('\n✅ Hook learning loop complete');
  console.log('   Weights updated → generate-texts.js will use them on next run\n');
})().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
