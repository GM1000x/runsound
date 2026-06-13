/**
 * api/cron.js — RunSound Scheduled Jobs
 *
 * Safe to require from api/server.js — never calls process.exit().
 *
 * Schedule:
 *   03:00 UTC daily  — full pipeline (analytics → pick → texts → overlay → post)
 *   04:00 UTC Monday — hook learning (learn-hooks.js updates hook_weights)
 *
 * Manual trigger:
 *   POST /api/admin/run-pipeline      ← full pipeline for all campaigns
 *   POST /api/admin/learn-hooks       ← just the hook weight update
 */

const cron   = require('node-cron');
const { spawn } = require('child_process');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

// ─── Run a node script as a detached child process ────────────────────────────
// Returns a promise that resolves when the script exits.
// Streams stdout/stderr to console with a prefix.
function runScript(scriptName, args = [], label = scriptName) {
  return new Promise((resolve, reject) => {
    console.log(`\n[cron] ▶ ${label}`);
    const child = spawn('node', [path.join(ROOT, scriptName), ...args], {
      cwd:   ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
    });

    child.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));

    child.on('close', code => {
      if (code === 0) {
        console.log(`[cron] ✅ ${label} done`);
        resolve();
      } else {
        const err = new Error(`${label} exited with code ${code}`);
        console.error(`[cron] ❌ ${err.message}`);
        reject(err);
      }
    });

    child.on('error', err => {
      console.error(`[cron] ❌ ${label} spawn error: ${err.message}`);
      reject(err);
    });
  });
}

// ─── Full nightly pipeline ────────────────────────────────────────────────────
// analytics → pick → texts → overlay → post (all active campaigns)
async function runDailyPipeline() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`[cron] 🚀 Daily pipeline starting — ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(50)}`);
  try {
    await runScript('run-all-campaigns.js', [], 'daily-pipeline');
    console.log('[cron] ✅ Daily pipeline complete');
  } catch (err) {
    console.error(`[cron] ❌ Daily pipeline failed: ${err.message}`);
  }
}

// ─── Weekly hook learning ─────────────────────────────────────────────────────
// Reads post_log → updates hook_weights in Supabase → generate-texts.js uses them
async function runLearnHooks() {
  console.log(`\n[cron] 🧠 Hook learning starting — ${new Date().toISOString()}`);
  try {
    await runScript('learn-hooks.js', [], 'learn-hooks');
    console.log('[cron] ✅ Hook learning complete');
  } catch (err) {
    console.error(`[cron] ❌ Hook learning failed: ${err.message}`);
  }
}

// ─── Schedule ─────────────────────────────────────────────────────────────────
function startCron() {
  // Full pipeline: every day at 03:00 UTC
  cron.schedule('0 3 * * *', runDailyPipeline, { timezone: 'UTC' });

  // Hook learning: every Monday at 04:00 UTC (after pipeline has run)
  cron.schedule('0 4 * * 1', runLearnHooks, { timezone: 'UTC' });

  console.log('⏰ Cron scheduled:');
  console.log('   03:00 UTC daily   → full pipeline (pick → texts → overlay → post)');
  console.log('   04:00 UTC Monday  → hook learning (update archetype weights)');

  return { runDailyPipeline, runLearnHooks };
}

module.exports = { startCron, runDailyPipeline, runLearnHooks };
