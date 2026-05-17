#!/usr/bin/env node
/**
 * run-all-campaigns.js — RunSound Multi-Artist Campaign Runner
 *
 * Fetches all active campaigns from Supabase, materializes each campaign's
 * config to disk, then runs the full pipeline for each artist.
 *
 * This is the entry point for both the nightly cron (via scheduler.js)
 * and manual one-shot runs.
 *
 * Pipeline per campaign (nightly):
 *   analytics  → fetch TikTok view stats from Postiz
 *   learn      → compute streaming CTR, find winning patterns
 *   optimize   → GPT-4o writes smarter strategy.json
 *   pick-slides → pick 6 images from that artist's library
 *   texts      → generate hook/story/CTA slides (A/B/C variant)
 *   overlay    → burn text + film grain onto images
 *   post       → push carousel to TikTok inbox as draft
 *
 * Usage:
 *   node run-all-campaigns.js                 ← all active campaigns from Supabase
 *   node run-all-campaigns.js --campaigns campaigns.json  ← local file fallback
 *   node run-all-campaigns.js --step post     ← run only one step for all campaigns
 *   node run-all-campaigns.js --campaign mbn-summer-love  ← one campaign only
 *   node run-all-campaigns.js --dry-run       ← print commands, don't execute
 *
 * Campaign directories on disk (auto-created):
 *   campaigns/<slug>/config.json       ← materialized from Supabase
 *   campaigns/<slug>/image-library/    ← symlink or copy of artist's library
 *   campaigns/<slug>/posts/<date>/     ← today's generated slides
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   (or SUPABASE_ANON_KEY)
 *   OPENAI_API_KEY                       (for texts + optimize)
 *   POSTIZ_API_KEY                       (for posting)
 *   CAMPAIGNS_DIR                        base dir for per-artist data (default: campaigns/)
 */

require('dotenv').config();

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// ─── Optional Supabase ────────────────────────────────────────────────────────
let createClient;
try { ({ createClient } = require('@supabase/supabase-js')); } catch {}

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) {
  const i = args.indexOf(`--${n}`);
  return i !== -1 ? args[i + 1] : null;
}

const CAMPAIGNS_FILE  = getArg('campaigns') || null; // local JSON fallback
const STEP_FILTER     = getArg('step')      || null; // run only this step
const CAMPAIGN_FILTER = getArg('campaign')  || null; // run only this slug
const DRY_RUN         = args.includes('--dry-run');
const CAMPAIGNS_DIR   = process.env.CAMPAIGNS_DIR || path.join(process.cwd(), 'campaigns');

// Supabase
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// ─── Logging ──────────────────────────────────────────────────────────────────
const logsDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

function logFile() {
  return path.join(logsDir, `run-${new Date().toISOString().slice(0, 10)}.log`);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile(), line + '\n'); } catch {}
}

// ─── Execute (with dry-run) ───────────────────────────────────────────────────
function execStep(command, label, retries = 1) {
  if (DRY_RUN) {
    log(`  [dry-run] ${label}: ${command}`);
    return true;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`  ▶ ${label}${retries > 1 ? ` (${attempt}/${retries})` : ''}`);
      execSync(command, { stdio: 'inherit', cwd: process.cwd() });
      log(`  ✅ ${label}`);
      return true;
    } catch (err) {
      log(`  ❌ ${label} failed: ${err.message}`);
      if (attempt < retries) {
        const wait = 10000 * attempt;
        log(`     Retrying in ${wait / 1000}s...`);
        const end = Date.now() + wait;
        while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  }
  return false;
}

// ─── Build pipeline steps for a campaign ─────────────────────────────────────
function buildSteps(configPath, outputDir, campaignId) {
  return [
    {
      name: 'analytics',
      label: 'fetch TikTok stats',
      command: `node check-analytics.js --config "${configPath}" --days 3`,
      critical: false,
    },
    {
      name: 'learn',
      label: 'learning loop',
      command: `node learn.js --config "${configPath}"`,
      critical: false,
    },
    {
      name: 'optimize',
      label: 'optimize strategy',
      command: `node optimize-strategy.js --config "${configPath}"`,
      critical: false,
    },
    {
      name: 'pick-slides',
      label: 'pick slides',
      command: `node pick-slides.js --config "${configPath}" --output "${outputDir}"`,
      critical: true,
    },
    {
      name: 'texts',
      label: 'generate texts',
      command: `node generate-texts.js --config "${configPath}" --output "${outputDir}"${campaignId ? ` --campaign-id "${campaignId}"` : ''}`,
      critical: true,
    },
    {
      name: 'overlay',
      label: 'text overlay',
      command: `node add-text-overlay.js --input "${outputDir}" --config "${configPath}" --texts "${outputDir}/texts.json"`,
      critical: true,
    },
    {
      name: 'post',
      label: 'post to TikTok',
      command: `node post-to-tiktok.js --input "${outputDir}" --config "${configPath}"`,
      critical: true,
    },
  ];
}

// ─── Materialize a campaign config from Supabase row to disk ─────────────────
// This lets all existing pipeline scripts (which read config.json) work
// unchanged for multi-artist mode.
async function materializeCampaign(dbCampaign) {
  const slug    = dbCampaign.slug;
  const dir     = path.join(CAMPAIGNS_DIR, slug);
  const cfgPath = path.join(dir, 'config.json');

  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });

  // Base config from campaign.config (stored as JSONB in Supabase)
  const dbConfig = dbCampaign.config || {};

  // Merge DB config with live fields that may have changed since signup
  const config = {
    ...dbConfig,
    artist: {
      ...(dbConfig.artist || {}),
      name:     dbCampaign.artist_name,
      id:       dbCampaign.artist_id,
    },
    song: {
      ...(dbConfig.song || {}),
      title:    dbCampaign.song_title,
      genre:    dbCampaign.genre    || dbConfig.song?.genre    || 'pop',
      mood:     dbCampaign.mood     || dbConfig.song?.mood     || '',
      hookLines: dbCampaign.hook_lines || dbConfig.song?.hookLines || [],
    },
    streaming: {
      spotify:    dbCampaign.spotify_url    || null,
      apple:      dbCampaign.apple_url      || null,
      youtube:    dbCampaign.youtube_url    || null,
      tidal:      dbCampaign.tidal_url      || null,
      deezer:     dbCampaign.deezer_url     || null,
      amazon:     dbCampaign.amazon_url     || null,
      soundcloud: dbCampaign.soundcloud_url || null,
    },
    campaign: {
      id:           dbCampaign.id,
      slug,
      smartLinkUrl: dbCampaign.smart_link_url ||
        `${process.env.BASE_URL || 'https://runsound.fm'}/l/${slug}`,
    },
    tracking: {
      supabaseUrl: 'SUPABASE_URL',   // env var name — learn.js resolves it
      supabaseKey: 'SUPABASE_SERVICE_KEY',
      campaignId:  dbCampaign.id,
    },
    posting: {
      ...(dbConfig.posting || {}),
      provider:   process.env.POSTING_PROVIDER || 'postiz',
      schedule:   dbConfig.posting?.schedule    || '0 3 * * *',
      timezone:   dbConfig.posting?.timezone    || 'Europe/Stockholm',
    },
    imageGen: {
      ...(dbConfig.imageGen || {}),
      model: process.env.IMAGE_MODEL || dbConfig.imageGen?.model || 'gpt-image-1.5',
    },
  };

  if (!DRY_RUN) {
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    log(`  📁 Config materialized: ${cfgPath}`);
  } else {
    log(`  [dry-run] Would write config to: ${cfgPath}`);
  }

  // Create image-library symlink if the artist doesn't have their own
  // library yet, point to the default one so the pipeline doesn't crash.
  const libDir     = path.join(dir, 'image-library');
  const defaultLib = path.join(process.cwd(), 'runsound-marketing', 'image-library');

  if (!DRY_RUN && !fs.existsSync(libDir) && fs.existsSync(defaultLib)) {
    try {
      fs.symlinkSync(defaultLib, libDir, 'dir');
      log(`  🔗 Linked default image library → ${libDir}`);
    } catch (e) {
      // symlink may already exist or be unsupported — not critical
    }
  }

  return { slug, dir, configPath: cfgPath, campaignId: dbCampaign.id };
}

// ─── Run the pipeline for one campaign ───────────────────────────────────────
async function runCampaign(entry) {
  const { slug, label, configPath, dir } = entry;

  const today     = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(dir, 'posts', today);
  if (!DRY_RUN) fs.mkdirSync(outputDir, { recursive: true });

  log(`\n${'─'.repeat(60)}`);
  log(`🎵 Campaign: ${label || slug}`);
  log(`   Config:   ${configPath}`);
  log(`   Output:   ${outputDir}`);
  log(`${'─'.repeat(60)}`);

  const allSteps = buildSteps(configPath, outputDir, entry.campaignId || null);
  const steps    = STEP_FILTER
    ? allSteps.filter(s => s.name === STEP_FILTER)
    : allSteps;

  if (STEP_FILTER && steps.length === 0) {
    const valid = allSteps.map(s => s.name).join(', ');
    log(`❌ Unknown step: "${STEP_FILTER}". Valid: ${valid}`);
    return { slug, success: false, error: `unknown step ${STEP_FILTER}` };
  }

  let firstFailure = null;

  for (const step of steps) {
    const ok = execStep(step.command, step.label, step.critical ? 3 : 1);
    if (!ok) {
      if (step.critical) {
        firstFailure = step.name;
        log(`💥 Critical step "${step.label}" failed — stopping campaign`);
        break;
      }
      log(`⚠️  Non-critical "${step.label}" failed — continuing`);
    }
  }

  if (firstFailure) {
    return { slug, success: false, error: `failed at ${firstFailure}` };
  }

  log(`✅ Campaign "${label || slug}" complete`);
  return { slug, success: true };
}

// ─── Load campaigns from Supabase ─────────────────────────────────────────────
async function loadFromSupabase() {
  if (!createClient) throw new Error('@supabase/supabase-js not installed');
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');

  const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  let query = supabase
    .from('campaigns')
    .select(`
      id, slug, artist_id, artist_name, song_title, genre, mood,
      spotify_url, apple_url, youtube_url, tidal_url, deezer_url,
      amazon_url, soundcloud_url, smart_link_url, hook_lines, config,
      artists ( plan, status )
    `)
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (CAMPAIGN_FILTER) {
    query = query.eq('slug', CAMPAIGN_FILTER);
  }

  const { data: campaigns, error } = await query;
  if (error) throw error;

  return campaigns || [];
}

// ─── Load campaigns from local JSON file (fallback / single-artist mode) ──────
function loadFromFile(filepath) {
  const registry = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  let list = (registry.campaigns || []).filter(c => c.active !== false);

  const LIMITS = { starter: 1, growth: 3, pro: 5 };
  const limit  = LIMITS[(registry.plan || 'starter').toLowerCase()] ?? 1;
  list = list.slice(0, limit);

  if (CAMPAIGN_FILTER) {
    list = list.filter(c => c.slug === CAMPAIGN_FILTER);
  }

  // Convert to the same shape as the Supabase entries
  return list.map(c => ({
    slug:       c.slug,
    label:      c.name || c.slug,
    configPath: c.config,
    dir:        path.dirname(c.config),
    fromFile:   true,
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  log(`\n${'═'.repeat(60)}`);
  log('🚀 RunSound — Multi-Artist Pipeline');
  if (STEP_FILTER)     log(`   Step filter:  ${STEP_FILTER}`);
  if (CAMPAIGN_FILTER) log(`   Campaign:     ${CAMPAIGN_FILTER}`);
  if (DRY_RUN)         log('   Mode:         DRY RUN');
  log(`${'═'.repeat(60)}\n`);

  let entries = [];

  if (CAMPAIGNS_FILE) {
    // ── Local file mode (single-artist / legacy) ───────────────────────────
    if (!fs.existsSync(CAMPAIGNS_FILE)) {
      log(`❌ campaigns.json not found: ${CAMPAIGNS_FILE}`);
      process.exit(1);
    }
    log(`📂 Source: ${CAMPAIGNS_FILE} (local file mode)`);
    entries = loadFromFile(CAMPAIGNS_FILE);

  } else {
    // ── Supabase mode (multi-artist) ───────────────────────────────────────
    log('🗄️  Source: Supabase (multi-artist mode)');

    let dbCampaigns;
    try {
      dbCampaigns = await loadFromSupabase();
    } catch (err) {
      // If Supabase is not configured, fall back gracefully to runsound-marketing/
      log(`⚠️  Supabase unavailable: ${err.message}`);
      log('   Falling back to runsound-marketing/config.json (single-artist mode)');
      const fallback = 'runsound-marketing/config.json';
      if (!fs.existsSync(fallback)) {
        log(`❌ No fallback config found at ${fallback}`);
        process.exit(1);
      }
      entries = [{
        slug:       'default',
        label:      'Default Campaign',
        configPath: fallback,
        dir:        'runsound-marketing',
        fromFile:   true,
      }];
    }

    if (dbCampaigns) {
      if (!dbCampaigns.length) {
        log('ℹ️  No active campaigns found in Supabase');
        process.exit(0);
      }

      log(`📋 Found ${dbCampaigns.length} active campaign(s) in Supabase\n`);

      // Materialize each campaign's config to disk
      if (!DRY_RUN) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

      for (const db of dbCampaigns) {
        const materialized = await materializeCampaign(db);
        entries.push({
          slug:       db.slug,
          label:      `${db.artist_name} — ${db.song_title}`,
          configPath: materialized.configPath,
          dir:        materialized.dir,
        });
      }
    }
  }

  if (!entries.length) {
    log('ℹ️  No campaigns to run');
    process.exit(0);
  }

  log(`\n📋 ${entries.length} campaign(s) to run\n`);

  // ── Run campaigns sequentially ─────────────────────────────────────────────
  const results = [];
  for (const entry of entries) {
    const result = await runCampaign(entry);
    results.push(result);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  log(`\n${'═'.repeat(60)}`);
  log('📋 SUMMARY');
  log(`${'═'.repeat(60)}`);
  const ok  = results.filter(r => r.success).length;
  const bad = results.filter(r => !r.success);
  log(`   ${ok}/${results.length} campaigns completed successfully`);
  for (const r of bad) log(`   ❌ ${r.slug}: ${r.error}`);
  log('');

  process.exit(bad.length > 0 ? 1 : 0);
})();
