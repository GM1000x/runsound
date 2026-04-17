#!/usr/bin/env node
/**
 * RunSound — Daily report: TikTok views + Spotify clicks + recommendations
 *
 * Combines:
 *   - TikTok performance (views, likes) from Postiz analytics JSON
 *   - Spotify click-throughs from Supabase UTM tracking
 *   - Diagnostic framework: which content format is converting
 *   - Actionable recommendation for today's post
 *
 * Usage: node daily-report.js --config runsound-marketing/config.json [--days 7]
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

let fetchFn;
try { fetchFn = fetch; } catch { fetchFn = require('node-fetch'); }

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const configPath = getArg('config');
const days = parseInt(getArg('days') || '7', 10);

if (!configPath) {
  console.error('Usage: node daily-report.js --config runsound-marketing/config.json [--days 7]');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

function loadLatestAnalytics(configDir) {
  const dir = path.join(configDir, 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('analytics-') && f.endsWith('.json')).sort().reverse();
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8')); }
  catch { return null; }
}

function loadPostMetas(configDir) {
  const postsDir = path.join(configDir, 'posts');
  if (!fs.existsSync(postsDir)) return [];
  const metas = [];
  const entries = fs.readdirSync(postsDir, {'"withFileTypes": true });
  for (const e of entries.sort().reverse()) {
    if (!e.isDirectory()) continue;
    const mp = path.join(postsDir, e.name, 'meta.json');
    if (fs.existsSync(mp)) { try { metas.push(JSON.parse(fs.readFileSync(mp, 'utf-8'))); } catch {} }
  }
  return metas;
}

async function fetchSpotifyClicks(url, key, days) {
  if (!url || !key) return { total: 0, bySlug: {}, error: 'No Supabase credentials' };
  try {
    const sb = createClient(url, key);
    const since = new Date(); since.setDate(since.getDate() - days);
    const { data, error } = await sb.from('utm_clicks').select('slug,source,created_at,destination').gte('created_at', since.toISOString()).order('created_at', { ascending: false });
    if (error) throw error;
    const bySlug = {}; let total = 0;
    for (const row of (data || [])) {
      const slug = row.slug || row.source || 'unknown';
      bySlug[slug] = (bySlug[slug] || 0) + 1; total++;
    }
    return { total, bySlug, raw: data };
  } catch (err) { return { total: 0, bySlug: {}, error: err.message }; }
}

function diagnose(views, clicks, avgV, avgC) {
  const highV = views >= avgV * 0.8;
  const highC = clicks >= avgC * 0.8;
  if (highV && highC) return { label: 'SCALE', action: 'Post more of this exact format.' };
  if (highV && !highC) return { label: 'FIX_CTA', action: 'Views good but no clicks - improve slide 6.' };
  if (!highV && highC) return { label: 'FIX_HOOK', action: 'CTA works but hook isn\'t stopping scrolls.' };
  return { label: 'RESET', action: 'Both low - try a completely different hook format.' };
}

function fmt(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const configDir = path.dirname(configPath);
  const reportsDir = path.join(configDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  console.log(`\nRunSound Daily Report - ${today}`);
  const analytics = loadLatestAnalytics(configDir);
  const postMetas = loadPostMetas(configDir);
  const clickData = await fetchSpotifyClicks(config.tracking?.supabaseUrl, config.tracking?.supabaseKey, days);

  const posts = postMetas.map(meta => {
    const ap = analytics?.posts?.find(p => p.postId === meta.postizPostId);
    if (ap) meta.stats = { ...meta.stats, ...ap };
    return meta;
  });

  const avgV = posts.reduce((s, p) => s + (p.stats?.views || 0), 0) / Math.max(posts.length, 1);
  const avgC = clickData.total / Math.max(posts.length, 1);
  const best = [...posts].sort((a, b) => (b.stats?.views || 0) - (a.stats?.views || 0))[0];

  const lines = [
    `# RunSound Daily Report`,
    `**${today}** | ${config.artist.name} - ${config.song.title}`,
    '',
    `## Performance (Last ${days} Days)`, '',
  ];

  if (analytics?.posts?.length) {
    lines.push('| Date | Views | Likes | Status |');
    lines.push('|-----|------|------|-------|');
    for (const p of analytics.posts.slice(0, 10)) {
      lines.push(`| ${p.date || '-'} | ${fmt(p.views)} | ${fmt(p.likes)} | ${p.status || '-'} |`);
    }
    lines.push('');
    lines.push(`**Avg views:** ${fmt(Math.round(avgV))}`);
    lines.push('');
  } else {
    lines.push('_No TikTok analytics yet._'); lines.push('');
  }

  lines.push(`## Spotify Clicks (${daysd days)`);
  lines.push('');
  if (clickData.total > 0) {
    lines.push(`**Total:** ${clickData.total}`); lines.push('');
  } else {
    lines.push(clickData.error ? `_Supabase not connected: ${clickData.error}_` : '_No clicks yet._');
    lines.push('');
  }

  if (best) {
    const bestClicks = clickData.bySlug[best.song || ''] || 0;
    const { label, action } = diagnose(best.stats?.views || 0, bestClicks, avgV, avgC);
    lines.push(`## Diagnosis`); lines.push('');
    lines.push(`**${label}** - ${action}`); lines.push('');
  }

  lines.push('---');
  lines.push(`_Generated by RunSound at ${new Date().toISOString()}_`);

  const content = lines.join('\n');
  console.log('\n' + content);
  const outPath = path.join(reportsDir, `report-${today}.md`);
  fs.writeFileSync(outPath, content);
  console.log(`\nReport saved to ${outPath}\n`);
})();
