/**
 * Onboarding pipeline — runs immediately after artist signup.
 *
 * When a new artist signs up:
 *   1. Materialize their campaign config to campaigns/<slug>/config.json
 *   2. Build image library (gpt-image-1.5, 18 images) — ~3-5 min
 *   3. Run full pipeline: pick → texts → overlay → post
 *   4. TikTok draft lands in inbox — artist gets notified
 *
 * Artists never wait until 3 AM. They get their first draft within ~8 min
 * of signing up. After that, scheduler.js handles the nightly cadence.
 *
 * Progress is tracked in Supabase campaigns.onboarding_status so
 * connect.html can poll and show a live step tracker.
 *
 * Routes:
 *   POST /api/onboard/:campaignId   — start onboarding (called by signup.js)
 *   GET  /api/onboard/:campaignId/status — poll progress (called by connect.html)
 */

const express      = require('express');
const router       = express.Router();
const path         = require('path');
const fs           = require('fs');
const { spawn }    = require('child_process');
const supabase     = require('../db');
const { sendDraftReadyEmail } = require('../email');

const ROOT         = path.join(__dirname, '..', '..');
const CAMPAIGNS_DIR = process.env.CAMPAIGNS_DIR || path.join(ROOT, 'campaigns');

// ─── In-memory status store (also written to Supabase) ────────────────────────
// Maps campaignId → { step, steps[], error, done }
const onboardingState = {};

// Steps shown in the connect.html UI
const STEPS = [
  { id: 'setup',    label: 'Setting up your campaign' },
  { id: 'library',  label: 'Generating AI images for your song' },
  { id: 'pick',     label: 'Picking today\'s slides' },
  { id: 'texts',    label: 'Writing hooks and captions' },
  { id: 'overlay',  label: 'Applying text overlays' },
  { id: 'post',     label: 'Sending draft to your TikTok inbox' },
  { id: 'done',     label: 'Your first draft is ready!' },
];

// ─── Update status in memory + Supabase ──────────────────────────────────────
async function setStatus(campaignId, stepId, error = null) {
  const stepIndex = STEPS.findIndex(s => s.id === stepId);
  const state = {
    currentStep:  stepId,
    currentIndex: stepIndex,
    steps:        STEPS,
    error:        error || null,
    done:         stepId === 'done',
    failed:       !!error,
    updatedAt:    new Date().toISOString(),
  };

  onboardingState[campaignId] = state;

  // Persist to Supabase (non-fatal if it fails)
  try {
    await supabase
      .from('campaigns')
      .update({ onboarding_status: stepId, onboarding_error: error || null })
      .eq('id', campaignId);
  } catch { /* non-fatal */ }
}

// ─── Run a shell command as a Promise ────────────────────────────────────────
function runCommand(cmd, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`[onboard] ▶ ${label}`);
    const child = spawn(cmd, args, {
      cwd:   ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d; process.stderr.write(d); });

    child.on('close', code => {
      if (code === 0) {
        console.log(`[onboard] ✅ ${label}`);
        resolve(stdout);
      } else {
        const msg = stderr.slice(-500) || stdout.slice(-500) || `exit code ${code}`;
        console.error(`[onboard] ❌ ${label} failed: ${msg}`);
        reject(new Error(msg));
      }
    });
  });
}

// ─── Materialize campaign config from Supabase ────────────────────────────────
async function materializeConfig(campaign) {
  const slug = campaign.slug;
  const dir  = path.join(CAMPAIGNS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });

  const dbConfig = campaign.config || {};

  const config = {
    ...dbConfig,
    artist: {
      ...(dbConfig.artist || {}),
      name:     campaign.artist_name,
      id:       campaign.artist_id,
      genre:    campaign.genre || dbConfig.artist?.genre || 'pop',
    },
    song: {
      ...(dbConfig.song || {}),
      title:    campaign.song_title,
      genre:    campaign.genre    || dbConfig.song?.genre    || 'pop',
      mood:     campaign.mood     || dbConfig.song?.mood     || '',
      hookLines: campaign.hook_lines || dbConfig.song?.hookLines || [],
      description: dbConfig.song?.description || '',
    },
    streaming: {
      spotify:    campaign.spotify_url    || null,
      apple:      campaign.apple_url      || null,
      youtube:    campaign.youtube_url    || null,
      tidal:      campaign.tidal_url      || null,
      deezer:     campaign.deezer_url     || null,
      amazon:     campaign.amazon_url     || null,
      soundcloud: campaign.soundcloud_url || null,
    },
    campaign: {
      id:           campaign.id,
      slug,
      smartLinkUrl: campaign.smart_link_url ||
        `${process.env.BASE_URL || 'https://runsound.fm'}/l/${slug}`,
    },
    tracking: {
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_SERVICE_KEY,
      campaignId:  campaign.id,
    },
    postiz: {
      apiKey:         process.env.POSTIZ_API_KEY,
      integrationIds: {
        tiktok: campaign.tiktok_inbox_id
               || dbConfig.postiz?.integrationIds?.tiktok
               || process.env.POSTIZ_TIKTOK_ID
               || null,
      },
    },
    posting: {
      ...(dbConfig.posting || {}),
      provider:  'postiz',
      schedule:  '0 3 * * *',
      timezone:  'Europe/Stockholm',
    },
    imageGen: {
      ...(dbConfig.imageGen || {}),
      // Always override model + count — db config may have stale dall-e-3 / 18
      model:  process.env.IMAGE_MODEL || 'gpt-image-2-2026-04-21',
      count:  2,
    },
    output: {
      postsDir: path.join(dir, 'posts'),
      latestDir: path.join(dir, 'posts', 'latest'),
    },
  };

  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));

  // Link default image library as a placeholder (build-image-library.js will replace it)
  const libDir     = path.join(dir, 'image-library');
  const defaultLib = path.join(ROOT, 'runsound-marketing', 'image-library');
  if (!fs.existsSync(libDir) && fs.existsSync(defaultLib)) {
    try { fs.symlinkSync(defaultLib, libDir, 'dir'); } catch {}
  }

  return { dir, cfgPath };
}

// ─── Main onboarding pipeline (runs in background) ───────────────────────────
async function runOnboarding(campaignId) {
  console.log(`\n[onboard] Starting for campaign ${campaignId}`);

  try {
    // ── 1. Load campaign from Supabase ────────────────────────────────────
    await setStatus(campaignId, 'setup');

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select(`
        id, slug, artist_id, artist_name, song_title, genre, mood,
        spotify_url, apple_url, youtube_url, tidal_url, deezer_url,
        amazon_url, soundcloud_url, smart_link_url, hook_lines,
        config, tiktok_inbox_id, dash_token
      `)
      .eq('id', campaignId)
      .single();

    if (error || !campaign) throw new Error('Campaign not found in Supabase');

    const { dir, cfgPath } = await materializeConfig(campaign);
    const today            = new Date().toISOString().slice(0, 10);
    const outputDir        = path.join(dir, 'posts', today);
    fs.mkdirSync(outputDir, { recursive: true });

    // ── 2. Build image library ─────────────────────────────────────────────
    await setStatus(campaignId, 'library');
    await runCommand('node', ['build-image-library.js', '--config', cfgPath], 'build image library');

    // Remove the default-library symlink now that we have real images
    const libDir = path.join(dir, 'image-library');
    if (fs.existsSync(libDir) && fs.lstatSync(libDir).isSymbolicLink()) {
      fs.unlinkSync(libDir);
      // build-image-library.js writes to <projectDir>/image-library
      // so it already created the real directory
    }

    // ── 3. Pick slides ─────────────────────────────────────────────────────
    await setStatus(campaignId, 'pick');
    await runCommand('node', [
      'pick-slides.js', '--config', cfgPath, '--output', outputDir,
    ], 'pick slides');

    // ── 4. Generate texts ──────────────────────────────────────────────────
    await setStatus(campaignId, 'texts');
    await runCommand('node', [
      'generate-texts.js', '--config', cfgPath, '--output', outputDir, '--campaign-id', campaignId,
    ], 'generate texts');

    // ── 5. Text overlay ────────────────────────────────────────────────────
    await setStatus(campaignId, 'overlay');
    await runCommand('node', [
      'add-text-overlay.js',
      '--input',  outputDir,
      '--config', cfgPath,
      '--texts',  path.join(outputDir, 'texts.json'),
    ], 'text overlay');

    // ── 6. Post to TikTok ──────────────────────────────────────────────────
    await setStatus(campaignId, 'post');
    await runCommand('node', [
      'post-to-tiktok.js', '--input', outputDir, '--config', cfgPath,
    ], 'post to TikTok');

    // ── Done ───────────────────────────────────────────────────────────────
    await setStatus(campaignId, 'done');
    console.log(`\n[onboard] ✅ Onboarding complete for ${campaign.artist_name} — ${campaign.song_title}`);

    // ── Send "draft ready" email ───────────────────────────────────────────
    // Fetch artist email (stored in artists table, not campaigns)
    try {
      const { data: artist } = await supabase
        .from('artists')
        .select('email')
        .eq('id', campaign.artist_id)
        .single();

      if (artist?.email && campaign.dash_token) {
        const BASE         = process.env.BASE_URL || 'https://run-sound.com';
        const dashboardUrl = `${BASE}/dashboard.html?campaign_id=${campaign.id}&token=${campaign.dash_token}`;
        await sendDraftReadyEmail({
          artistName:   campaign.artist_name,
          email:        artist.email,
          songTitle:    campaign.song_title,
          dashboardUrl,
        });
      } else {
        console.warn('[onboard] Skipped draft-ready email — missing artist email or dash_token');
      }
    } catch (emailErr) {
      console.error('[onboard] Draft-ready email failed (non-fatal):', emailErr.message);
    }

  } catch (err) {
    console.error(`[onboard] ❌ Failed: ${err.message}`);
    await setStatus(campaignId, 'error', err.message);
  }
}

// ─── POST /api/onboard/:campaignId ────────────────────────────────────────────
// Starts the onboarding pipeline in the background (non-blocking).
// Called by signup.js right after campaign creation.
router.post('/:campaignId', async (req, res) => {
  const { campaignId } = req.params;

  // Validate the campaign exists
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, artist_name, onboarding_status')
    .eq('id', campaignId)
    .single();

  if (!campaign) {
    return res.status(404).json({ ok: false, error: 'Campaign not found' });
  }

  // Don't re-run if already completed
  if (campaign.onboarding_status === 'done') {
    return res.json({ ok: true, status: 'already_done', steps: STEPS });
  }

  // If already running, return current status
  if (onboardingState[campaignId] && !onboardingState[campaignId].failed) {
    return res.json({ ok: true, status: 'already_running', ...onboardingState[campaignId] });
  }

  // Kick off in background (don't await — respond immediately)
  setImmediate(() => runOnboarding(campaignId));

  res.json({
    ok:      true,
    status:  'started',
    steps:   STEPS,
    message: `Onboarding started for ${campaign.artist_name}`,
  });
});

// ─── POST /api/onboard/:campaignId/rebuild-library ───────────────────────────
// Force-regenerates the image library for an existing campaign.
// Useful after prompt/model changes without needing a new signup.
router.post('/:campaignId/rebuild-library', async (req, res) => {
  const { campaignId } = req.params;

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select(`id, slug, artist_name, song_title, genre, mood, spotify_url, apple_url,
             youtube_url, tidal_url, deezer_url, amazon_url, soundcloud_url,
             smart_link_url, hook_lines, config, tiktok_inbox_id`)
    .eq('id', campaignId)
    .single();

  if (error || !campaign) {
    return res.status(404).json({ ok: false, error: 'Campaign not found' });
  }

  res.json({ ok: true, status: 'rebuilding', message: `Rebuilding image library for ${campaign.artist_name}` });

  setImmediate(async () => {
    try {
      const { dir, cfgPath } = await materializeConfig(campaign);
      // Remove old library so --force isn't needed
      const libDir = path.join(dir, 'image-library');
      if (require('fs').existsSync(libDir) && !require('fs').lstatSync(libDir).isSymbolicLink()) {
        require('fs').rmSync(libDir, { recursive: true });
      }
      await runCommand('node', ['build-image-library.js', '--config', cfgPath], 'rebuild image library');
      console.log(`[rebuild] ✅ Done for ${campaign.artist_name}`);
    } catch (err) {
      console.error(`[rebuild] ❌ ${err.message}`);
    }
  });
});

// ─── POST /api/onboard/:campaignId/repost ────────────────────────────────────
// Re-runs pick → texts → overlay → post for an existing campaign.
// Use after rebuild-library to get a new TikTok draft with updated images.
router.post('/:campaignId/repost', async (req, res) => {
  const { campaignId } = req.params;

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select(`id, slug, artist_name, song_title, genre, mood, spotify_url, apple_url,
             youtube_url, tidal_url, deezer_url, amazon_url, soundcloud_url,
             smart_link_url, hook_lines, config, tiktok_inbox_id`)
    .eq('id', campaignId)
    .single();

  if (error || !campaign) {
    return res.status(404).json({ ok: false, error: 'Campaign not found' });
  }

  res.json({ ok: true, status: 'reposting', message: `Re-running pipeline for ${campaign.artist_name} — draft arriving in TikTok inbox in ~2 min` });

  setImmediate(async () => {
    try {
      const { dir, cfgPath } = await materializeConfig(campaign);
      const today     = new Date().toISOString().slice(0, 10);
      const outputDir = path.join(dir, 'posts', today);
      fs.mkdirSync(outputDir, { recursive: true });

      await runCommand('node', ['pick-slides.js', '--config', cfgPath, '--output', outputDir], 'pick slides');
      await runCommand('node', ['generate-texts.js', '--config', cfgPath, '--output', outputDir, '--campaign-id', campaignId], 'generate texts');
      await runCommand('node', ['add-text-overlay.js', '--input', outputDir, '--config', cfgPath, '--texts', path.join(outputDir, 'texts.json')], 'text overlay');
      await runCommand('node', ['post-to-tiktok.js', '--input', outputDir, '--config', cfgPath], 'post to TikTok');

      console.log(`[repost] ✅ Done for ${campaign.artist_name}`);
    } catch (err) {
      console.error(`[repost] ❌ ${err.message}`);
    }
  });
});

// ─── GET /api/onboard/:campaignId/status ─────────────────────────────────────
// Polled by connect.html every 3 seconds to show live progress.
router.get('/:campaignId/status', async (req, res) => {
  const { campaignId } = req.params;

  // Check in-memory first (most up to date)
  if (onboardingState[campaignId]) {
    return res.json({ ok: true, ...onboardingState[campaignId], steps: STEPS });
  }

  // Fall back to Supabase (covers server restarts)
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('onboarding_status, onboarding_error')
    .eq('id', campaignId)
    .single();

  if (!campaign) {
    return res.status(404).json({ ok: false, error: 'Campaign not found' });
  }

  const stepId    = campaign.onboarding_status || 'setup';
  const stepIndex = STEPS.findIndex(s => s.id === stepId);

  res.json({
    ok:           true,
    currentStep:  stepId,
    currentIndex: stepIndex,
    steps:        STEPS,
    error:        campaign.onboarding_error || null,
    done:         stepId === 'done',
    failed:       !!campaign.onboarding_error,
  });
});

module.exports = router;
