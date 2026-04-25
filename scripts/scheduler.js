#!/usr/bin/env node
/**
 * scheduler.js — RunSound Daily Automation
 *
 * Runs the full pipeline automatically every day at a configured time.
 * The artist never needs to touch a terminal — they just open TikTok,
 * see a ready draft, add their song, and hit publish.
 *
 * Full daily loop per campaign:
 *   1. check-analytics  → fetch TikTok stats from Postiz
 *   2. learn            → compute streamingCTR, find patterns
 *   3. optimize         → GPT-4o generates smarter strategy.json
 *   4. pick-slides      → select 6 images from library
 *   5. generate-texts   → hook texts + variant selection → texts.json
 *   6. add-text-overlay → burn text + film grain onto images
 *   7. post-to-tiktok   → send carousel to TikTok inbox as draft
 *
 * Configuration (env vars or .env):
 *   CRON_SCHEDULE      cron expression (default: "0 3 * * *" = 3:00 AM daily)
 *   CAMPAIGNS_FILE     path to campaigns.json (default: campaigns.json)
 *   TZ                 timezone (default: UTC — set to e.g. "Europe/Stockholm")
 *   NOTIFY_EMAIL       email to notify on failure (optional)
 *   RESEND_API_KEY     Resend API key for failure notifications (optional)
 *
 * Usage:
 *   node scripts/scheduler.js           ← start persistent cron process
 *   node scripts/scheduler.js --run-now ← run immediately (skip cron)
 *   node scripts/scheduler.js --dry-run ← show what would run
 *
 * Deploy:
 *   Railway:  set START_COMMAND = "node scripts/scheduler.js"
 *   Replit:   set run = "node scripts/scheduler.js" in .replit, enable Always On
 */

require('dotenv').config();

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const cron         = require('node-cron');

// ─── Config ───────────────────────────────────────────────────────────────────
const SCHEDULE       = process.env.CRON_SCHEDULE  || '0 3 * * *'; // 3:00 AM daily
const CAMPAIGNS_FILE = process.env.CAMPAIGNS_FILE || 'campaigns.json';
const NOTIFY_EMAIL   = process.env.NOTIFY_EMAIL   || null;
const RESEND_KEY     = process.env.RESEND_API_KEY || null;
const DRY_RUN        = process.argv.includes('--dry-run');
const RUN_NOW        = process.argv.includes('--run-now');

// ─── Logging ──────────────────────────────────────────────────────────────────
const logsDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

function logFile() {
  return path.join(logsDir, `scheduler-${new Date().toISOString().slice(0, 10)}.log`);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile(), line + '\n'); } catch {}
}

// ─── Run a shell command with retry ──────────────────────────────────────────
async function runWithRetry(cmd, label, retries = 3, delayMs = 10000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (DRY_RUN) {
        log(`  [dry-run] ${label}: ${cmd}`);
        return true;
      }
      log(`  ▶ ${label} (attempt ${attempt}/${retries})`);
      execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
      log(`  ✅ ${label}`);
      return true;
    } catch (err) {
      log(`  ❌ ${label} failed: ${err.message}`);
      if (attempt < retries) {
        const wait = delayMs * attempt;
        log(`     Retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  log(`  💀 ${label} failed after ${retries} attempts`);
  return false;
}

// ─── Send failure notification via Resend ────────────────────────────────────
async function notifyFailure(campaignName, failedStep, errorSummary) {
  if (!RESEND_KEY || !NOTIFY_EMAIL) return;

  try {
    const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
    await (await fetch)('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'RunSound <noreply@runsound.fm>',
        to:      [NOTIFY_EMAIL],
        subject: `⚠️ RunSound: ${campaignName} failed at ${failedStep}`,
        html: `
          <h2>RunSound Daily Run Failed</h2>
          <p><strong>Campaign:</strong> ${campaignName}</p>
          <p><strong>Failed step:</strong> ${failedStep}</p>
          <p><strong>Time:</strong> ${new Date().toISOString()}</p>
          <pre>${errorSummary}</pre>
          <p>Check logs/ for details.</p>
        `,
      }),
    });
    log(`  📧 Failure notification sent to ${NOTIFY_EMAIL}`);
  } catch (e) {
    log(`  ⚠️  Could not send notification: ${e.message}`);
  }
}

// ─── Build the command for a pipeline step ────────────────────────────────────
function cmd(script, configPath, extraArgs = '') {
  return `node scripts/${script} --config "${configPath}" ${extraArgs}`.trim();
}

function outputDir(configPath) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(path.dirname(configPath), 'posts', today);
}

// ─── Run the full pipeline for one campaign ───────────────────────────────────
async function runCampaign(campaign) {
  const { name, slug, config: configPath } = campaign;
  const label = name || slug;
  const out   = outputDir(configPath);

  log(`\n${'─'.repeat(60)}`);
  log(`🎵 Campaign: ${label}`);
  log(`   Config:   ${configPath}`);
  log(`   Output:   ${out}`);
  log(`${'─'.repeat(60)}`);

  if (!fs.existsSync(configPath)) {
    log(`❌ Config not found: ${configPath} — skipping`);
    return { slug, success: false, error: 'config not found' };
  }

  if (!DRY_RUN) fs.mkdirSync(out, { recursive: true });

  const steps = [
    // ── Learning loop (runs before content generation) ──────────────────────
    {
      label: 'analytics',
      cmd:   cmd('check-analytics.js', configPath, '--days 3'),
      critical: false, // don't block pipeline if analytics fails
    },
    {
      label: 'learn',
      cmd:   cmd('learn.js', configPath),
      critical: false,
    },
    {
      label: 'optimize',
      cmd:   cmd('optimize-strategy.js', configPath),
      critical: false, // falls back to previous strategy.json if GPT fails
    },

    // ── Content generation ───────────────────────────────────────────────────
    {
      label: 'pick-slides',
      cmd:   cmd('pick-slides.js', configPath, `--output "${out}"`),
      critical: true,
    },
    {
      label: 'generate-texts',
      cmd:   cmd('generate-texts.js', configPath, `--output "${out}"`),
      critical: true,
    },
    {
      label: 'overlay',
      cmd:   `node scripts/add-text-overlay.js --input "${out}" --config "${configPath}" --texts "${out}/texts.json"`,
      critical: true,
    },
    {
      label: 'post',
      cmd:   `node scripts/post-to-tiktok.js --input "${out}" --config "${configPath}"`,
      critical: true,
    },
  ];

  let firstFailure = null;

  for (const step of steps) {
    const ok = await runWithRetry(step.cmd, step.label, step.critical ? 3 : 1);
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
    await notifyFailure(label, firstFailure, `See logs/${path.basename(logFile())}`);
    return { slug, success: false, error: `failed at ${firstFailure}` };
  }

  log(`✅ Campaign "${label}" complete`);
  return { slug, success: true };
}

// ─── Run all active campaigns ─────────────────────────────────────────────────
async function runAllCampaigns() {
  log(`\n${'═'.repeat(60)}`);
  log('🚀 RunSound — Daily Pipeline Starting');
  log(`${'═'.repeat(60)}`);

  if (!fs.existsSync(CAMPAIGNS_FILE)) {
    log(`❌ campaigns.json not found: ${CAMPAIGNS_FILE}`);
    return;
  }

  const registry = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
  const campaigns = (registry.campaigns || []).filter(c => c.active !== false);

  const LIMITS = { starter: 1, growth: 3, pro: 5 };
  const limit  = LIMITS[(registry.plan || 'starter').toLowerCase()] ?? 1;
  const active = campaigns.slice(0, limit);

  log(`📋 ${active.length} campaign(s) to run (${registry.plan || 'starter'} plan)`);

  const results = [];
  for (const campaign of active) {
    const result = await runCampaign(campaign);
    results.push(result);
  }

  // Summary
  log(`\n${'═'.repeat(60)}`);
  log('📋 DAILY RUN SUMMARY');
  log(`${'═'.repeat(60)}`);
  const ok  = results.filter(r => r.success).length;
  const bad = results.filter(r => !r.success);
  log(`   ${ok}/${results.length} campaigns completed successfully`);
  for (const r of bad) log(`   ❌ ${r.slug}: ${r.error}`);

  // Daily report
  try {
    log('\n📊 Generating daily report...');
    if (!DRY_RUN) {
      execSync(`node scripts/daily-report.js --campaigns "${CAMPAIGNS_FILE}"`, {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
    }
  } catch (e) {
    log(`⚠️  Report generation failed: ${e.message}`);
  }

  log(`\n🎉 Daily run complete at ${new Date().toISOString()}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
log('🕐 RunSound Scheduler starting...');
log(`   Schedule:  ${SCHEDULE} (${process.env.TZ || 'UTC'})`);
log(`   Campaigns: ${CAMPAIGNS_FILE}`);
log(`   Dry run:   ${DRY_RUN}`);
log('');

if (RUN_NOW || DRY_RUN) {
  // Run immediately (for testing or manual trigger)
  runAllCampaigns().catch(err => {
    log(`Fatal error: ${err.message}`);
    process.exit(1);
  });
} else {
  // Validate cron expression
  if (!cron.validate(SCHEDULE)) {
    log(`❌ Invalid CRON_SCHEDULE: "${SCHEDULE}"`);
    log(`   Example: "0 3 * * *" = every day at 3:00 AM`);
    process.exit(1);
  }

  log(`✅ Cron scheduled: "${SCHEDULE}"`);
  log(`   Next run: see Railway/Replit logs for exact time`);
  log('   Waiting...\n');

  cron.schedule(SCHEDULE, () => {
    runAllCampaigns().catch(err => log(`Fatal error: ${err.message}`));
  }, {
    timezone: process.env.TZ || 'UTC',
  });

  // Keep process alive
  process.on('SIGTERM', () => { log('Shutting down gracefully'); process.exit(0); });
  process.on('SIGINT',  () => { log('Interrupted');             process.exit(0); });
}
