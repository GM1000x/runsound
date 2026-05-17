#!/usr/bin/env node
/**
 * scheduler.js — RunSound Daily Cron
 *
 * Runs the full multi-artist pipeline on a cron schedule.
 * All the campaign logic lives in run-all-campaigns.js —
 * this file is just the timer that fires it.
 *
 * Steps fired nightly per artist:
 *   analytics → learn → optimize → pick-slides → texts → overlay → post
 *
 * Configuration:
 *   CRON_SCHEDULE      cron expression (default: "0 3 * * *" = 3:00 AM daily)
 *   TZ                 timezone (default: UTC — set e.g. "Europe/Stockholm")
 *   NOTIFY_EMAIL       email to notify on failure (optional)
 *   RESEND_API_KEY     Resend API key for failure notifications (optional)
 *   SUPABASE_URL       Supabase project URL (for multi-artist mode)
 *   SUPABASE_SERVICE_KEY  Supabase service key
 *
 * Usage:
 *   node scheduler.js                ← start persistent cron
 *   node scheduler.js --run-now      ← run all campaigns immediately
 *   node scheduler.js --run-now --campaign mbn-summer-love  ← one campaign
 *   node scheduler.js --dry-run      ← show what would run
 *
 * Deploy on Railway / Replit:
 *   START_COMMAND = "node scheduler.js"
 *   Set TZ to your timezone.
 *   Enable "Always On" (Replit) or use Railway's persistent service.
 */

require('dotenv').config();

const { execSync } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const cron         = require('node-cron');

// ─── Config ───────────────────────────────────────────────────────────────────
const SCHEDULE     = process.env.CRON_SCHEDULE  || '0 3 * * *';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL   || null;
const RESEND_KEY   = process.env.RESEND_API_KEY || null;

const DRY_RUN  = process.argv.includes('--dry-run');
const RUN_NOW  = process.argv.includes('--run-now');

// Forward any extra args (--campaign, --step, --dry-run) to run-all-campaigns.js
const FORWARD_ARGS = process.argv.slice(2)
  .filter(a => a !== '--run-now') // --run-now is scheduler-only
  .join(' ');

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

// ─── Failure notification ─────────────────────────────────────────────────────
async function notifyFailure(errorSummary) {
  if (!RESEND_KEY || !NOTIFY_EMAIL) return;
  try {
    const { default: fetch } = await import('node-fetch');
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'RunSound <noreply@run-sound.com>',
        to:      [NOTIFY_EMAIL],
        subject: `⚠️ RunSound: Daily pipeline failed`,
        html: `
          <h2>RunSound Daily Run Failed</h2>
          <p><strong>Time:</strong> ${new Date().toISOString()}</p>
          <pre>${errorSummary}</pre>
          <p>Check logs/ for full details.</p>
        `,
      }),
    });
    log(`📧 Failure notification sent to ${NOTIFY_EMAIL}`);
  } catch (e) {
    log(`⚠️  Could not send notification: ${e.message}`);
  }
}

// ─── Run the full pipeline via run-all-campaigns.js ───────────────────────────
async function runPipeline() {
  log(`\n${'═'.repeat(60)}`);
  log('🚀 RunSound — Daily Pipeline Starting');
  log(`   ${new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ || 'UTC' })}`);
  log(`${'═'.repeat(60)}`);

  const cmd = `node run-all-campaigns.js ${FORWARD_ARGS}`.trim();
  log(`⚡ ${cmd}`);

  try {
    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
    log('🎉 Daily pipeline complete');
  } catch (err) {
    log(`💥 Pipeline failed: ${err.message}`);
    await notifyFailure(err.message);
  }

  // Run daily report regardless of pipeline success/failure
  const reportPath = path.join(process.cwd(), 'daily-report.js');
  if (fs.existsSync(reportPath)) {
    log('\n📊 Generating daily report...');
    try {
      execSync(`node daily-report.js`, { stdio: 'inherit', cwd: process.cwd() });
    } catch (e) {
      log(`⚠️  Daily report failed: ${e.message}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
log('🕐 RunSound Scheduler starting...');
log(`   Schedule:  ${SCHEDULE}`);
log(`   Timezone:  ${process.env.TZ || 'UTC'}`);
if (DRY_RUN) log('   Mode:      DRY RUN');
log('');

if (RUN_NOW || DRY_RUN) {
  runPipeline().catch(err => {
    log(`Fatal: ${err.message}`);
    process.exit(1);
  });
} else {
  if (!cron.validate(SCHEDULE)) {
    log(`❌ Invalid CRON_SCHEDULE: "${SCHEDULE}"`);
    log('   Example: "0 3 * * *" = every day at 3:00 AM');
    process.exit(1);
  }

  log(`✅ Cron scheduled: "${SCHEDULE}"`);
  log('   Waiting for next run...\n');

  cron.schedule(SCHEDULE, () => {
    runPipeline().catch(err => log(`Fatal: ${err.message}`));
  }, {
    timezone: process.env.TZ || 'UTC',
  });

  // Weekly hook learning — every Monday at 04:00
  // Reads post_log from Supabase, updates hook_weights per campaign
  // based on streaming_ctr per archetype (streaming clicks ÷ views)
  cron.schedule('0 4 * * 1', () => {
    log('\n🧠 Running weekly hook learning loop...');
    try {
      execSync('node learn-hooks.js', { stdio: 'inherit', cwd: process.cwd() });
      log('✅ Hook learning complete');
    } catch (e) {
      log(`⚠️  Hook learning failed: ${e.message}`);
    }
  }, { timezone: process.env.TZ || 'UTC' });

  process.on('SIGTERM', () => { log('Shutting down gracefully'); process.exit(0); });
  process.on('SIGINT',  () => { log('Interrupted');             process.exit(0); });
}
