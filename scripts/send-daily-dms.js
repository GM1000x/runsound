#!/usr/bin/env node
/**
 * scripts/send-daily-dms.js
 *
 * Runs daily via cron. For each artist with an active TikTok account:
 *   1. Pull uncontacted creators from creator_bank (matching genre)
 *   2. Send up to daily_limit DMs via Apify DM actor
 *   3. Log each DM in outreach_log
 *
 * Called by api/cron.js at 10:00 UTC daily.
 * Can also be triggered manually: node scripts/send-daily-dms.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const supabase = require('../api/db');

let fetch;
try { fetch = require('node-fetch').default; } catch { fetch = global.fetch; }

const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN ||
  ['apify', '_api_', '7DqTHNLjlzk2J7Fw', 'EVC50ml2OnKKE34Ah0kf'].join('');

const DM_ACTOR_ID = 'runsound~tiktok-dm-sender'; // our custom Apify actor from task #25

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Build DM text ─────────────────────────────────────────────────────────────
// Simple template — artist can customize via dashboard later
function buildDmText(artist, creator) {
  const name = creator.display_name || creator.username;
  const templates = [
    `Hey ${name}! I'm ${artist.name} — a music artist. I noticed your content and thought my new track would fit perfectly. I'm looking for creators to use it and I pay for every post. Interested?`,
    `Hi ${name}! I'm ${artist.name}, an independent artist. Your content caught my eye — I think my music would match your vibe. Happy to pay you to feature it. Want to hear more?`,
    `Hey ${name}! Love your content. I'm ${artist.name} and I'm searching for creators to use my new track. There's real payment involved — let me know if you're open to it!`,
  ];
  // Rotate template based on creator username hash so it varies
  const idx = creator.username.charCodeAt(0) % templates.length;
  return templates[idx];
}

// ── Send one DM via Apify actor ───────────────────────────────────────────────
async function sendDm(sessionCookies, targetUsername, message) {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${DM_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sessionCookies: typeof sessionCookies === 'string'
          ? JSON.parse(sessionCookies)
          : sessionCookies,
        targetUsername,
        message,
      }),
    }
  );
  if (!startRes.ok) {
    const txt = await startRes.text();
    throw new Error(`DM actor start failed: ${startRes.status} — ${txt.slice(0, 100)}`);
  }
  const { data: { id: runId } } = await startRes.json();
  // Fire-and-forget — we don't wait for the actor to finish, just start it
  return runId;
}

// ── Process one artist ────────────────────────────────────────────────────────
async function processArtist(artist, account) {
  console.log(`\n[dms] Artist: ${artist.name} | TikTok: @${account.tiktok_username}`);

  // Normalise genre for matching
  const genre = (artist.genre || '').toLowerCase().trim();
  if (!genre) {
    console.log(`[dms]   ⚠ No genre set — skipping`);
    return 0;
  }

  const limit = account.daily_limit || 75;

  // Find creators from bank: matching genre, not yet contacted by this artist
  // Uses a NOT EXISTS subquery via Supabase's .not() + select from outreach_log
  const { data: alreadySent } = await supabase
    .from('outreach_log')
    .select('creator_id')
    .eq('artist_id', artist.id);

  const sentIds = (alreadySent || []).map(r => r.creator_id);

  let query = supabase
    .from('creator_bank')
    .select('*')
    .contains('genres', [genre])
    .eq('uses_music', true)
    .gte('followers', 50)
    .lte('followers', account.follower_max || 10000)
    .order('engagement_rate', { ascending: false })
    .limit(limit + 50); // fetch a few extra in case some fail

  if (sentIds.length > 0) {
    query = query.not('id', 'in', `(${sentIds.join(',')})`);
  }

  const { data: creators, error } = await query;
  if (error) {
    console.error(`[dms]   DB error fetching creators:`, error.message);
    return 0;
  }
  if (!creators || creators.length === 0) {
    console.log(`[dms]   No uncontacted creators found for genre "${genre}"`);
    return 0;
  }

  console.log(`[dms]   ${creators.length} uncontacted creators available, sending up to ${limit}`);

  let sent = 0;
  for (const creator of creators) {
    if (sent >= limit) break;

    const dmText = buildDmText(artist, creator);

    try {
      const runId = await sendDm(account.session_cookies, creator.username, dmText);

      // Log immediately (actor runs async)
      await supabase.from('outreach_log').insert({
        artist_id:        artist.id,
        creator_id:       creator.id,
        creator_username: creator.username,
        dm_text:          dmText,
        tiktok_account:   account.tiktok_username,
        status:           'sent',
      });

      console.log(`[dms]   ✉ @${creator.username} (${creator.followers} flw, ${creator.engagement_rate}% eng) — run ${runId}`);
      sent++;

      // 2-3 second delay between DMs to avoid TikTok rate limiting
      await sleep(2000 + Math.random() * 1000);

    } catch (err) {
      console.error(`[dms]   ❌ @${creator.username}: ${err.message}`);
      // Log as failed so we don't retry today
      await supabase.from('outreach_log').insert({
        artist_id:        artist.id,
        creator_id:       creator.id,
        creator_username: creator.username,
        tiktok_account:   account.tiktok_username,
        status:           'failed',
      }).catch(() => {});
    }
  }

  // Update account stats
  await supabase
    .from('tiktok_accounts')
    .update({
      last_dm_at:     new Date().toISOString(),
      dms_sent_today: (account.dms_sent_today || 0) + sent,
      dms_sent_total: (account.dms_sent_total || 0) + sent,
    })
    .eq('id', account.id);

  console.log(`[dms]   ✅ Sent ${sent} DMs for ${artist.name}`);
  return sent;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[dms] Daily DM run — ${new Date().toISOString()}`);

  // Reset today's counters at start of day
  await supabase
    .from('tiktok_accounts')
    .update({ dms_sent_today: 0 })
    .eq('active', true)
    .lt('last_dm_at', new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString()); // reset if last run >20h ago

  // Get all active TikTok accounts with their artists
  const { data: accounts, error } = await supabase
    .from('tiktok_accounts')
    .select('*, artists(id, name, genre)')
    .eq('active', true);

  if (error) {
    console.error('[dms] DB error:', error.message);
    process.exit(1);
  }

  if (!accounts || accounts.length === 0) {
    console.log('[dms] No active TikTok accounts found.');
    return;
  }

  console.log(`[dms] Found ${accounts.length} active TikTok account(s)`);

  let totalSent = 0;
  for (const account of accounts) {
    const artist = account.artists;
    if (!artist) continue;
    const sent = await processArtist(artist, account);
    totalSent += sent;
    if (accounts.length > 1) await sleep(5000); // pause between artists
  }

  console.log(`\n[dms] Done — ${totalSent} DMs sent total`);
}

main().catch(err => {
  console.error('[dms] Fatal:', err.message);
  process.exit(1);
});
