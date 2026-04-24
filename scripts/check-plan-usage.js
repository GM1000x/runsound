#!/usr/bin/env node
/**
 * RunSound — Plan Enforcement & Swap Tracking
 *
 * A "swap" happens when a new song slug is activated (= new library build).
 * This script guards npm run library from exceeding the plan's monthly swap limit.
 *
 * Plan limits:
 *   Starter  ($29/mo)  → 2 swaps/month
 *   Growth   ($49/mo)  → 4 swaps/month
 *   Pro      ($79/mo)  → 6 swaps/month
 *   Extra swap         → $1.99 pay-per-swap
 *
 * Usage:
 *   node check-plan-usage.js --config <config.json> --action swap-check
 *   node check-plan-usage.js --config <config.json> --action status
 *
 * --action swap-check   Run before npm run library. Exits with code 1 if limit exceeded.
 * --action status       Print current usage summary and exit 0.
 *
 * Reads / writes:
 *   usage.json          Lives next to config.json. Created fresh if missing.
 *
 * usage.json structure:
 * {
 *   "plan":         "starter",
 *   "month":        "2026-04",        ← YYYY-MM, resets when month changes
 *   "swapCount":    1,                ← swaps used this month
 *   "swapLimit":    2,                ← from plan config
 *   "lastSongSlug": "my-song-title",  ← slug of last activated song
 *   "history": [
 *     { "slug": "...", "swappedAt": "ISO8601", "month": "YYYY-MM" }
 *   ]
 * }
 */

const fs   = require('fs');
const path = require('path');

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const configPath = getArg('config');
const action     = getArg('action') || 'swap-check';

if (!configPath) {
  console.error('Usage: node check-plan-usage.js --config <config.json> --action <swap-check|status>');
  process.exit(1);
}
if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

// ─── Plan swap limits ─────────────────────────────────────────────────────────
const SWAP_LIMITS = {
  starter: 2,
  growth:  4,
  pro:     6
};

const PAY_PER_SWAP_PRICE = '$1.99';

// ─── Load config ──────────────────────────────────────────────────────────────
const config    = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const projectDir = path.dirname(configPath);
const usagePath  = path.join(projectDir, 'usage.json');

// Resolve plan info from config
const planTier = (
  config.plan?.tier ||
  (config.library?.imageCount >= 40 ? 'pro' : config.library?.imageCount >= 25 ? 'growth' : 'starter')
).toLowerCase();

const swapLimit = config.plan?.swapsPerMonth ?? SWAP_LIMITS[planTier] ?? 2;
const songSlug  = config.song?.slug || config.song?.title?.toLowerCase().replace(/\s+/g, '-') || 'unknown';

// ─── Current month string ─────────────────────────────────────────────────────
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Load or initialise usage.json ───────────────────────────────────────────
function loadUsage() {
  if (!fs.existsSync(usagePath)) {
    return {
      plan:         planTier,
      month:        currentMonth(),
      swapCount:    0,
      swapLimit,
      lastSongSlug: null,
      history:      []
    };
  }
  return JSON.parse(fs.readFileSync(usagePath, 'utf-8'));
}

function saveUsage(usage) {
  fs.writeFileSync(usagePath, JSON.stringify(usage, null, 2));
}

// ─── Monthly reset ────────────────────────────────────────────────────────────
function maybeResetMonth(usage) {
  const now = currentMonth();
  if (usage.month !== now) {
    console.log(`📅 New month (${usage.month} → ${now}) — swap counter reset to 0/${swapLimit}`);
    usage.month      = now;
    usage.swapCount  = 0;
    usage.swapLimit  = swapLimit;
    usage.plan       = planTier;
  }
  return usage;
}

// ─── Detect if this is a new swap ────────────────────────────────────────────
function isNewSwap(usage) {
  // If no prior song slug, this is the very first activation (free — not a swap)
  if (!usage.lastSongSlug) return false;
  // Same slug → re-building same song (e.g. --force); not a swap
  if (usage.lastSongSlug === songSlug) return false;
  // Different slug → swapping to a new song
  return true;
}

// ─── Status action ────────────────────────────────────────────────────────────
function printStatus(usage) {
  const remaining = Math.max(0, usage.swapLimit - usage.swapCount);
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         RunSound — Plan Usage            ║');
  console.log('╚══════════════════════════════════════════╝\n');
  console.log(`  Plan:          ${usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)}`);
  console.log(`  Month:         ${usage.month}`);
  console.log(`  Active song:   ${usage.lastSongSlug || '(none yet)'}`);
  console.log(`  Song slug:     ${songSlug}`);
  console.log(`  Swaps used:    ${usage.swapCount} / ${usage.swapLimit}`);
  console.log(`  Remaining:     ${remaining} swap${remaining !== 1 ? 's' : ''} this month`);
  if (usage.history.length > 0) {
    console.log('\n  Recent swaps:');
    usage.history.slice(-5).forEach(h => {
      console.log(`    ${h.month}  ${h.slug}  (${h.swappedAt.slice(0, 10)})`);
    });
  }
  console.log('');
}

// ─── Swap check action ────────────────────────────────────────────────────────
function runSwapCheck(usage) {
  const swap = isNewSwap(usage);

  if (!swap) {
    if (!usage.lastSongSlug) {
      // Very first library build
      console.log(`\n✅ First song activation — no swap counted.`);
      console.log(`   Song: ${songSlug}\n`);
      usage.lastSongSlug = songSlug;
      saveUsage(usage);
      process.exit(0);
    }
    // Same song re-build (--force or retry)
    console.log(`\n✅ Same song re-build (${songSlug}) — no swap counted.\n`);
    process.exit(0);
  }

  // It's a swap — check against limit
  if (usage.swapCount >= usage.swapLimit) {
    // LIMIT REACHED
    const tierName = usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1);
    console.error(`
╔════════════════════════════════════════════════════════╗
║  ⛔  Swap limit reached — ${String(usage.swapCount + '/' + usage.swapLimit).padEnd(6)}  (${tierName} plan)     ║
╚════════════════════════════════════════════════════════╝

  You've used all ${usage.swapLimit} song swaps for ${usage.month}.

  Current song:   ${usage.lastSongSlug}
  Requested:      ${songSlug}

  OPTIONS:
  ┌─────────────────────────────────────────────────────┐
  │  A) Wait until next month (resets on 1st)           │
  │  B) Upgrade plan (more swaps/month)                 │
  │  C) Pay-per-swap: ${PAY_PER_SWAP_PRICE} for this swap                │
  └─────────────────────────────────────────────────────┘

  To pay per swap, run:
    node scripts/check-plan-usage.js --config ${configPath} --action pay-per-swap

  Plan upgrade info:
    Starter  ($29/mo) → 2 swaps   Growth ($49/mo) → 4 swaps   Pro ($79/mo) → 6 swaps
`);
    process.exit(1);
  }

  // WITHIN LIMIT — approve swap
  const newCount = usage.swapCount + 1;
  const remaining = usage.swapLimit - newCount;
  console.log(`
✅ Swap approved — ${songSlug}
   (${newCount}/${usage.swapLimit} swaps used this month, ${remaining} remaining)
`);

  usage.swapCount    = newCount;
  usage.lastSongSlug = songSlug;
  usage.history.push({
    slug:       songSlug,
    swappedAt:  new Date().toISOString(),
    month:      usage.month,
    fromSlug:   usage.lastSongSlug
  });
  // Keep history trimmed to last 100 entries
  if (usage.history.length > 100) usage.history = usage.history.slice(-100);

  saveUsage(usage);
  process.exit(0);
}

// ─── Pay-per-swap action ──────────────────────────────────────────────────────
function runPayPerSwap(usage) {
  // In production this would integrate with Stripe.
  // For now, it shows instructions and allows a manual override.
  console.log(`
╔════════════════════════════════════════════════════════╗
║  💳  Pay-per-swap: ${PAY_PER_SWAP_PRICE}                             ║
╚════════════════════════════════════════════════════════╝

  This will charge ${PAY_PER_SWAP_PRICE} to activate: ${songSlug}

  To complete the payment and unlock this swap:
    → Visit: https://run-sound.com/account/pay-per-swap
    → Or contact: support@run-sound.com

  After payment is confirmed, run:
    node scripts/check-plan-usage.js --config ${configPath} --action unlock-swap

  (Stripe webhook integration coming in a future update.)
`);
  process.exit(0);
}

// ─── Unlock-swap action (called after payment confirmed) ─────────────────────
function runUnlockSwap(usage) {
  // Bypasses limit check — used after payment is confirmed externally.
  // In production this would be called by a Stripe webhook handler.
  const newCount = usage.swapCount + 1;
  console.log(`
🔓 Swap unlocked (pay-per-swap) — ${songSlug}
   Charged: ${PAY_PER_SWAP_PRICE}
   Swap count: ${newCount} (over base limit of ${usage.swapLimit} — paid extra)
`);

  usage.swapCount    = newCount;
  usage.lastSongSlug = songSlug;
  usage.history.push({
    slug:      songSlug,
    swappedAt: new Date().toISOString(),
    month:     usage.month,
    fromSlug:  usage.lastSongSlug,
    paidExtra: true
  });
  if (usage.history.length > 100) usage.history = usage.history.slice(-100);

  saveUsage(usage);
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
let usage = loadUsage();
usage = maybeResetMonth(usage);

switch (action) {
  case 'swap-check':
    runSwapCheck(usage);
    break;
  case 'status':
    printStatus(usage);
    break;
  case 'pay-per-swap':
    runPayPerSwap(usage);
    break;
  case 'unlock-swap':
    runUnlockSwap(usage);
    break;
  default:
    console.error(`Unknown action: ${action}. Use swap-check | status | pay-per-swap | unlock-swap`);
    process.exit(1);
}
