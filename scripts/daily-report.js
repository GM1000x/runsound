#!/usr/bin/env node
/**
 * RunSound — Daily analytics report
 *
 * 1. Hämtar Postiz analytics (views/likes/comments/shares per post)
 * 2. Hämtar smartlink-klick per UTM-kampanj från RunSound-servern
 * 3. Korskopplar: vilka TikTok-varianter driver faktiska streamingklick?
 * 4. Kör Larry's diagnostic-loop
 * 5. Skriver rapport + föreslår nya hooks
 *
 * Usage: node daily-report.js --config <config.json> [--days 3] [--artist <slug>]
 */

const fs   = require('fs');
const path = require('path');

let fetchFn;
try { fetchFn = require('node-fetch').default; } catch { fetchFn = require('node-fetch'); }

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const configPath  = getArg('config');
const daysArg     = parseInt(getArg('days') || '3', 10);
const artistArg   = getArg('artist');

if (!configPath) {
  console.error('Usage: node daily-report.js --config <config.json> [--days 3]');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const POSTIZ_API    = 'https://api.postiz.com/public/v1';
const apiKey        = process.env[config.postiz?.apiKey] || config.postiz?.apiKey;
const artistSlug    = artistArg || config.artist?.slug || config.artist?.name?.toLowerCase().replace(/\s+/g, '-');
const SMARTLINK_API = config.smartlinkServer || 'http://localhost:3000';
const REPORTS_DIR   = path.join(path.dirname(configPath), '..', 'reports');

fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ─── Fetch Postiz posts + analytics ──────────────────────────────────────────
async function fetchPostizPosts() {
  if (!apiKey) {
    console.warn('⚠️  No Postiz API key — skipping TikTok analytics');
    return [];
  }

  const since = new Date(Date.now() - daysArg * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetchFn(`${POSTIZ_API}/posts?since=${since}&limit=50`, {
    headers: { 'Authorization': apiKey }
  });

  if (!res.ok) {
    console.warn(`⚠️  Postiz posts fetch failed (${res.status})`);
    return [];
  }

  const data = await res.json();
  const posts = Array.isArray(data) ? data : (data.posts || []);

  // Fetch analytics for each post
  const enriched = [];
  for (const post of posts) {
    const postId = post.id || post.postId;
    try {
      const aRes = await fetchFn(`${POSTIZ_API}/analytics/post/${postId}`, {
        headers: { 'Authorization': apiKey }
      });
      if (aRes.ok) {
        const analytics = await aRes.json();
        enriched.push({ ...post, analytics });
      } else {
        enriched.push({ ...post, analytics: null });
      }
    } catch {
      enriched.push({ ...post, analytics: null });
    }
  }

  return enriched;
}

// ─── Fetch smartlink click data ───────────────────────────────────────────────
async function fetchSmartlinkClicks() {
  if (!artistSlug) {
    console.warn('⚠️  No artist slug — skipping smartlink analytics');
    return { summary: [], byCampaign: [] };
  }

  try {
    const res = await fetchFn(`${SMARTLINK_API}/api/clicks/${artistSlug}?days=${daysArg + 1}`);
    if (!res.ok) return { summary: [], byCampaign: [] };
    return await res.json();
  } catch {
    console.warn('⚠️  Smartlink server not reachable — skipping click analytics');
    return { summary: [], byCampaign: [] };
  }
}

// ─── Diagnostic framework (Larry's loop) ─────────────────────────────────────
function diagnose(views, clicks) {
  const highViews  = views  >= 10000;
  const lowViews   = views  < 2000;
  const highClicks = clicks >= 5;
  const lowClicks  = clicks === 0;

  if (highViews && highClicks)  return { status: '🟢 SCALE IT',    action: 'Gör 3 varianter av denna hook direkt. Testa olika postningstider.' };
  if (highViews && lowClicks)   return { status: '🟡 FIXA CTA',    action: 'Hooken funkar — folk ser det. Men de klickar inte till streaming. Testa ny CTA på slide 6.' };
  if (!lowViews && highClicks)  return { status: '🟡 FIXA HOOKEN', action: 'Bra konvertering men för få ser det. Testa radikalt annorlunda hook/thumbnail.' };
  if (lowViews && lowClicks)    return { status: '🔴 FULL RESET',  action: 'Varken hook eller CTA funkar. Testa nytt format, ny vinkel, ny målgrupp.' };
  return { status: '⚪ SAMLAR DATA', action: 'För tidigt att döma — behöver mer data.' };
}

// ─── Match posts to UTM campaigns ────────────────────────────────────────────
function matchPostsToCampaigns(posts, clickData) {
  const clickMap = {};
  for (const row of (clickData.summary || [])) {
    clickMap[row.utm_campaign] = (clickMap[row.utm_campaign] || 0) + row.total_clicks;
  }

  return posts.map(post => {
    const metaFile = post._metaPath;
    let campaign = null;
    let variant  = null;

    if (metaFile && fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      campaign = meta.utmUrl ? new URL(meta.utmUrl).searchParams.get('utm_campaign') : null;
      variant  = meta.variant || null;
    }

    const views     = post.analytics?.views  || post.analytics?.impressions || 0;
    const likes     = post.analytics?.likes  || 0;
    const comments  = post.analytics?.comments || 0;
    const shares    = post.analytics?.shares || 0;
    const clicks    = campaign ? (clickMap[campaign] || 0) : 0;
    const diagnosis = diagnose(views, clicks);

    return { postId: post.id || post.postId, campaign, variant, views, likes, comments, shares, streamClicks: clicks, ...diagnosis };
  });
}

// ─── Generate hook suggestions ────────────────────────────────────────────────
function suggestHooks(results) {
  const winners = results.filter(r => r.status.includes('SCALE') || (r.views >= 5000 && r.streamClicks >= 3));
  const losers  = results.filter(r => r.status.includes('RESET'));
  const suggestions = [];

  if (winners.length > 0) {
    suggestions.push(`✅ Vinnarhooks (variant ${winners.map(w => w.variant || '?').join(', ')}): Kör fler varianter av dessa.`);
  }
  if (losers.length > 0) {
    suggestions.push(`🔄 ${losers.length} post(ar) behöver ny approach — prova:`);
    suggestions.push('   • Emotion-hook: "Jag visste inte att min musik lät så här..."');
    suggestions.push('   • Kontrast-hook: "Ingen strömmar min musik. Sedan detta."');
    suggestions.push('   • Minimal-hook: Bara låttiteln. Låt tystnaden sälja.');
  }
  if (results.every(r => r.views < 1000)) {
    suggestions.push('⚡ Alla posts har låga views — kontrollera att TikTok-kontot är tillräckligt uppvärmt.');
  }
  return suggestions;
}

// ─── Build + save report ─────────────────────────────────────────────────────
function buildReport(results, clickData) {
  const date        = new Date().toISOString().slice(0, 10);
  const totalViews  = results.reduce((s, r) => s + r.views, 0);
  const totalClicks = results.reduce((s, r) => s + r.streamClicks, 0);
  const ctr         = totalViews > 0 ? ((totalClicks / totalViews) * 100).toFixed(2) : '0.00';

  const topPlatforms = {};
  for (const row of (clickData.byCampaign || [])) {
    topPlatforms[row.platform] = (topPlatforms[row.platform] || 0) + row.clicks;
  }
  const platformStr = Object.entries(topPlatforms)
    .sort((a, b) => b[1] - a[1])
    .map(([p, c]) => `${p}: ${c}`)
    .join(' | ') || 'ingen data ännu';

  const postRows = results.map(r =>
    `| ${r.variant || '-'} | ${r.views.toLocaleString()} | ${r.likes} | ${r.streamClicks} | ${r.status} |`
  ).join('\n');

  const suggestions = suggestHooks(results);

  const report = `# RunSound Daily Report — ${date}

## Sammanfattning (senaste ${daysArg} dagar)

| Metric | Värde |
|--------|-------|
| Totala views | ${totalViews.toLocaleString()} |
| Streaming-klick | ${totalClicks} |
| Click-through rate | ${ctr}% |
| Topplattformar | ${platformStr} |

## Posts

| Variant | Views | Likes | Stream-klick | Diagnos |
|---------|-------|-------|--------------|---------|
${postRows || '| — | Ingen data | — | — | — |'}

## Åtgärder

${results.map(r => `**${r.variant || r.postId}** (${r.views.toLocaleString()} views, ${r.streamClicks} klick)\n→ ${r.action}`).join('\n\n') || 'Inga posts att analysera ännu.'}

## Hook-förslag för idag

${suggestions.join('\n') || 'Samlar data — kör igen imorgon.'}

---
*Genererad ${new Date().toISOString()} av RunSound daily-report.js*
`;

  const reportPath = path.join(REPORTS_DIR, `${date}.md`);
  fs.writeFileSync(reportPath, report);
  return { report, reportPath, totalViews, totalClicks, ctr };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n📊 RunSound Daily Report`);
  console.log(`   Artist: ${artistSlug || config.artist?.name}`);
  console.log(`   Period: senaste ${daysArg} dagar\n`);

  const [posts, clickData] = await Promise.all([
    fetchPostizPosts(),
    fetchSmartlinkClicks()
  ]);

  console.log(`   📱 Posts hämtade: ${posts.length}`);
  console.log(`   🔗 UTM-kampanjer: ${clickData.summary?.length || 0}`);

  const results = matchPostsToCampaigns(posts, clickData);
  const { report, reportPath, totalViews, totalClicks, ctr } = buildReport(results, clickData);

  console.log('\n' + '─'.repeat(60));
  console.log(report);
  console.log('─'.repeat(60));
  console.log(`\n💾 Rapport sparad: ${reportPath}\n`);
})();
