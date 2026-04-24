#!/usr/bin/env node
/**
 * RunSound — Run All Campaigns
 *
 * Loops through every active campaign listed in campaigns.json and runs the
 * full daily posting pipeline for each one:
 *   1. npm run texts    → generate slide texts + pick images
 *   2. npm run overlay  → add text overlays
 *   3. npm run post     → schedule to TikTok via Postiz
 *
 * Plan limits on simultaneous active campaigns:
 *   Starter  ($29/mo) → 1 active campaign
 *   Growth   ($49/mo) → 3 active campaigns
 *   Pro      ($79/mo) → 5 active campaigns
 *
 * Usage:
 *   node run-all-campaigns.js --campaigns campaigns.json [--dry-run] [--step texts|overlay|post|all]
 *
 * --dry-run   Print what would run without executing
 * --step      Run only one step (default: all)
 *
 * campaigns.json lives next to package.json (project root).
 */

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const campaignsPath = getArg('campaigns') || 'campaigns.json';
const dryRun        = args.includes('--dry-run');
const stepArg       = getArg('step') || 'all';

if (!fs.existsSync(campaignsPath)) {
  console.error(`campaigns.json not found at: ${campaignsPath}`);
  console.error('\nRun: node scripts/run-all-campaigns.js --campaigns campaigns.json');
  console.error('Or create campaigns.json first — see campaigns.example.json for format.');
  process.exit(1);
}

// ─── Plan limits ──────────────────────────────────────────────────────────────
const CAMPAIGN_LIMITS = {
  starter: 1,
  growth:  3,
  pro:     5
};

// ─── Load campaigns registry ──────────────────────────────────────────────────
const registry = JSON.parse(fs.readFileSync(campaignsPath, 'utf-8'));
const planTier  = (registry.plan || 'starter').toLowerCase();
const limit     = CAMPAIGN_LIMITS[planTier] ?? 1;

const allCampaigns    = registry.campaigns || [];
const activeCampaigns = allCampaigns.filter(c => c.active !== false);

console.log(`\n🎵 RunSound — All Campaigns`);
console.log(`   Plan:       ${planTier.charAt(0).toUpperCase() + planTier.slice(1)}`);
console.log(`   Campaigns:  ${activeCampaigns.length} active / ${allCampaigns.length} total (limit: ${limit})`);
if (dryRun) console.log('   Mode:       DRY RUN — no commands will execute');
if (stepArg !== 'all') console.log(`   Step:       ${stepArg} only`);
console.log('');

// ─── Enforce plan campaign limit ──────────────────────────────────────────────
if (activeCampaigns.length > limit) {
  const tierName = planTier.charAt(0).toUpperCase() + planTier.slice(1);
  console.error(`
╔══════════════════════════════════════════════════════════╗
║  ⛔  Too many active campaigns (${String(activeCampaigns.length + '/' + limit).padEnd(5)})  (${tierName} plan)  ║
╚══════════════════════════════════════════════════════════╝

  Your plan allows ${limit} active campaign${limit !== 1 ? 's' : ''} at a time.
  You have ${activeCampaigns.length} active in campaigns.json.

  FIX: Set  "active": false  on campaigns you're not currently running,
       or upgrade to a higher plan:
         Starter  ($29/mo) → 1 campaign
         Growth   ($49/mo) → 3 campaigns
         Pro      ($79/mo) → 5 campaigns
`);
  process.exit(1);
}

// ─── Steps to run ─────────────────────────────────────────────────────────────
const STEPS = {
  texts:   (cfg) => `node scripts/generate-texts.js --config "${cfg}" --output "${outputDir(cfg)}"`,
  overlay: (cfg) => `node scripts/add-text-overlay.js --input "${outputDir(cfg)}" --config "${cfg}" --texts "${outputDir(cfg)}/texts.json"`,
  post:    (cfg) => `node scripts/post-to-tiktok.js --input "${outputDir(cfg)}" --config "${cfg}"`
};

function outputDir(configPath) {
  return path.join(path.dirname(configPath), 'posts', 'latest');
}

function stepsToRun() {
  if (stepArg === 'all') return ['texts', 'overlay', 'post'];
  if (STEPS[stepArg]) return [stepArg];
  console.error(`Unknown step: ${stepArg}. Use texts | overlay | post | all`);
  process.exit(1);
}

// ─── Run one campaign ──────────────────────────────────────────────────────────
function runCampaign(campaign, stepNames) {
  const { name, slug, config: configPath } = campaign;

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`🎵 Campaign: ${name || slug}`);
  console.log(`   Config:   ${configPath}`);
  console.log(`   Steps:    ${stepNames.join(' → ')}`);
  console.log(`${'─'.repeat(56)}`);

  if (!fs.existsSync(configPath)) {
    console.error(`  ❌ Config not found: ${configPath} — skipping`);
    return { slug, success: false, error: 'config not found' };
  }

  const outDir = outputDir(configPath);
  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const step of stepNames) {
    const cmd = STEPS[step](configPath);
    console.log(`\n  ▶ ${step.toUpperCase()}`);
    console.log(`    ${cmd}`);

    if (dryRun) {
      console.log(`    [dry-run — skipped]`);
      results.push({ step, success: true, dryRun: true });
      continue;
    }

    try {
      execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
      console.log(`  ✅ ${step} done`);
      results.push({ step, success: true });
    } catch (e) {
      console.error(`  ❌ ${step} failed: ${e.message}`);
      results.push({ step, success: false, error: e.message });
      break;
    }
  }

  const allOk = results.every(r => r.success);
  return { slug, success: allOk, steps: results };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const stepNames = stepsToRun();
  const summary   = [];

  for (const campaign of activeCampaigns) {
    const result = runCampaign(campaign, stepNames);
    summary.push(result);
  }

  console.log(`\n${'═'.repeat(56)}`);
  console.log('📋 SUMMARY');
  console.log(`${'═'.repeat(56)}`);

  for (const s of summary) {
    const icon = s.success ? '✅' : '❌';
    console.log(`  ${icon} ${s.slug}${s.error ? ` — ${s.error}` : ''}`);
  }

  const succeeded = summary.filter(s => s.success).length;
  const failed    = summary.filter(s => !s.success).length;

  console.log(`\n  ${succeeded}/${summary.length} campaigns completed successfully`);
  if (failed > 0) {
    console.log(`  ⚠️  ${failed} failed — check logs above`);
    process.exit(1);
  }

  console.log('\n🎉 All campaigns posted!\n');
})();
