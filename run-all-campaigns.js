#!/usr/bin/env node
/**
 * run-all-campaigns.js — RunSound Multi-Campaign Runner
 *
 * Runs the full pipeline (or a single step) across all active campaigns
 * defined in campaigns.json.
 *
 * Unlike scheduler.js (which runs on a cron), this is a one-shot command
 * you can call manually or from CI. Good for testing, catch-up runs, or
 * running just one step across all campaigns at once.
 *
 * Full pipeline per campaign (default):
 *   analytics  → fetch TikTok stats from Postiz
 *   learn      → compute streamingCTR, find patterns
 *   optimize   → GPT-4o generates smarter strategy.json
 *   pick-slides → select 6 images from library
 *   texts      → hook texts + variant selection → texts.json
 *   overlay    → burn text + film grain onto images
 *   post       → send carousel to TikTok as draft
 *
 * Usage:
 *   node scripts/run-all-campaigns.js --campaigns campaigns.json
 *   node scripts/run-all-campaigns.js --campaigns campaigns.json --step texts
 *   node scripts/run-all-campaigns.js --campaigns campaigns.json --step overlay
 *   node scripts/run-all-campaigns.js --campaigns campaigns.json --step post
 *   node scripts/run-all-campaigns.js --campaigns campaigns.json --dry-run
 *
 * --step <name>   Run only this step (texts | overlay | post | analytics | learn | optimize | pick-slides)
 * --dry-run       Print commands without executing
 * --campaign <slug>  Run only this one campaign
 */

require('dotenv').config();

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; }

const CAMPAIGNS_FILE    = getArg('campaigns') || 'campaigns.json';
const STEP_FILTER       = getArg('step')      || null;  // run only this step
const CAMPAIGN_FILTER   = getArg('campaign')  || null;  // run only this slug
const DRY_RUN           = args.includes('--dry-run');

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Execute a command (with dry-run support) ─────────────────────────────────
function exec(cmd, label) {
  if (DRY_RUN) {
    log(`  [dry-run] ${label}: ${cmd}`);
    return true;
  }
  try {
    log(`  ▶ ${label}`);
    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
    log(`  ✅ ${label}`);
    return true;
  } catch (err) {
    log(`  ❌ ${label} failed: ${err.message}`);
    return false;
  }
}

// ─── Build commands ────────────────────────────────────────────────────────────
function cmd(script, configPath, extraArgs = '') {
  return `node ${script} --config "${configPath}" ${extraArgs}`.trim();
}

function outputDir(configPath) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(path.dirname(configPath), 'posts', today);
}

// ─── All pipeline steps ────────────────────────────────────────────────────────
function buildSteps(configPath) {
  const out = outputDir(configPath);
  if (!DRY_RUN) fs.mkdirSync(out, { recursive: true });

  return [
    {
      name: 'analytics',
      label: 'analytics',
      cmd: cmd('check-analytics.js', configPath, '--days 3'),
      critical: false,
    },
    {
      name: 'learn',
      label: 'learn',
      cmd: cmd('learn.js', configPath),
      critical: false,
    },
    {
      name: 'optimize',
      label: 'optimize',
      cmd: cmd('optimize-strategy.js', configPath),
      critical: false,
    },
    {
      name: 'pick-slides',
      label: 'pick-slides',
      cmd: cmd('pick-slides.js', configPath, `--output "${out}"`),
      critical: true,
    },
    {
      name: 'texts',
      label: 'generate-texts',
      cmd: cmd('generate-texts.js', configPath, `--output "${out}"`),
      critical: true,
    },
    {
      name: 'overlay',
      label: 'overlay',
      cmd: `node add-text-overlay.js --input "${out}" --config "${configPath}" --texts "${out}/texts.json"`,
      critical: true,
    },
    {
      name: 'post',
      label: 'post',
      cmd: `node post-to-tiktok.js --input "${out}" --config "${configPath}"`,
      critical: true,
    },
  ];
}

// ─── Run one campaign ──────────────────────────────────────────────────────────
function runCampaign(campaign) {
  const { name, slug, config: configPath } = campaign;
  const label = name || slug;

  log(`\n${'─'.repeat(60)}`);
  log(`🎵 Campaign: ${label}`);
  log(`   Config:   ${configPath}`);
  log(`${'─'.repeat(60)}`);

  if (!fs.existsSync(configPath)) {
    log(`❌ Config not found: ${configPath} — skipping`);
    return { slug, success: false, error: 'config not found' };
  }

  const allSteps = buildSteps(configPath);
  const steps = STEP_FILTER
    ? allSteps.filter(s => s.name === STEP_FILTER)
    : allSteps;

  if (steps.length === 0) {
    log(`❌ Unknown step: "${STEP_FILTER}". Valid steps: ${allSteps.map(s => s.name).join(', ')}`);
    return { slug, success: false, error: `unknown step ${STEP_FILTER}` };
  }

  let firstFailure = null;

  for (const step of steps) {
    const ok = exec(step.cmd, step.label);
    if (!ok) {
      if (step.critical) {
        firstFailure = step.label;
        log(`💥 Critical step "${step.label}" failed — stopping campaign`);
        break;
      } else {
        log(`⚠️  Non-critical step "${step.label}" failed — continuing`);
      }
    }
  }

  if (firstFailure) {
    return { slug, success: false, error: `failed at ${firstFailure}` };
  }

  log(`✅ Campaign "${label}" complete`);
  return { slug, success: true };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
log(`\n${'═'.repeat(60)}`);
log('🚀 RunSound — Run All Campaigns');
if (STEP_FILTER)     log(`   Step filter:  ${STEP_FILTER}`);
if (CAMPAIGN_FILTER) log(`   Campaign:     ${CAMPAIGN_FILTER}`);
if (DRY_RUN)         log('   Mode:         DRY RUN');
log(`${'═'.repeat(60)}\n`);

if (!fs.existsSync(CAMPAIGNS_FILE)) {
  log(`❌ campaigns.json not found: ${CAMPAIGNS_FILE}`);
  log('   Create a campaigns.json with a "campaigns" array of { name, slug, config } objects.');
  process.exit(1);
}

const registry = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
let campaigns  = (registry.campaigns || []).filter(c => c.active !== false);

// Respect plan limits
const LIMITS = { starter: 1, growth: 3, pro: 5 };
const limit  = LIMITS[(registry.plan || 'starter').toLowerCase()] ?? 1;
campaigns    = campaigns.slice(0, limit);

// Optional single-campaign filter
if (CAMPAIGN_FILTER) {
  campaigns = campaigns.filter(c => c.slug === CAMPAIGN_FILTER);
  if (campaigns.length === 0) {
    log(`❌ No campaign found with slug "${CAMPAIGN_FILTER}"`);
    process.exit(1);
  }
}

log(`📋 ${campaigns.length} campaign(s) to run (${registry.plan || 'starter'} plan)`);

const results = campaigns.map(runCampaign);

// ─── Summary ───────────────────────────────────────────────────────────────────
log(`\n${'═'.repeat(60)}`);
log('📋 SUMMARY');
log(`${'═'.repeat(60)}`);
const ok  = results.filter(r => r.success).length;
const bad = results.filter(r => !r.success);
log(`   ${ok}/${results.length} campaigns completed successfully`);
for (const r of bad) log(`   ❌ ${r.slug}: ${r.error}`);
log('');

process.exit(bad.length > 0 ? 1 : 0);
