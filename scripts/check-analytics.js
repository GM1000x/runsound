#!/usr/bin/env node
/**
 * RunSound — Pull TikTok analytics via Postiz
 *
 * Two jobs:
 *   1. Connect posts: Link Postiz post IDs to actual TikTok video IDs
 *   2. Pull stats: Views, likes, comments, shares per video
 *
 * Usage: node check-analytics.js --config runsound-marketing/config.json [--days 7]
 */

const fs = require('fs');
const path = require('path');

let fetchFn;
try { fetchFn = fetch; } catch { fetchFn = require('node-fetch'); }

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const configPath = getArg('config');
const days = parseInt(getArg('days') || '7', 10);

if (!configPath) { console.error('Usage: node check-analytics.js --config <path>'); process.exit(1); }

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const POSTIZ_API = 'https://api.postiz.com/public/v1';
const apiKey = config.postiz.apiKey;
const integrationId = config.postiz.integrationIds?.tiktok;

if (!apiKey) { console.error('❌ Missing postiz.apiKey'); process.exit(1); }

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }

async function fetchRecentPosts() {
  const url = `${POSTIZ_API}/posts?startDate=${daysAgo(days)}&endDate=${daysAgo(0)}&limit=50`;
  const res = await fetchFn(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  if (!res.ok) { const t = await res.text(); throw new Error(`Failed (${res.status}): ${t}`); }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.posts || data.data || []);
}

amasync function fetchPostAnalytics(postId) {
  const res = await fetchFn(`${POSTIZ_API}/analytics/post/${postId}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

function findPostMetas(configDir) {
  const postsDir = path.join(configDir, 'posts');
  if (!fs.existsSync(postsDir)) return [];
  const metas = [];
  for (const e of fs.readdirSync(postsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mp = path.join(postsDir, e.name, 'meta.json');
    if (fs.existsSync(mp)) { try { metas.push({ dir: path.join(postsDir, e.name), meta: JSON.parse(fs.readFileSync(mp, 'utf-8')), metaPath: mp }); } catch {} }
  }
  return metas;
}

function fmt(n) { if (!n && n !== 0) return '-'; if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`; if (n >= 1000) return `${(n/1000).toFixed(1)}K`; return String(n); }

(async () => {
  try {
    console.log(`\nRunSound Analytics - ${config.artist.name} (last ${days} days)\n`);
    const posts = await fetchRecentPosts();
    console.log(`Found ${posts.length} posts`);
    const configDir = path.dirname(configPath);
    const localMetas = findPostMetas(configDir);
    const rows = [];
    for (const post of posts) {
      const isOurs = post.integration?.id === integrationId || post.content?.some(c => c.integration?.id === integrationId);
      if (integrationId && !isOurs) continue;
      const analytics = await fetchPostAnalytics(post.id);
      const stats = {
        postId: post.id,
        date: (post.publishedAt || post.date || '').slice(0, 10),
        status: post.state || post.status || '?',
        views: analytics?.views || analytics?.playCount || post.views || 0,
        likes: analytics?.likes || analytics?.diggCount || post.likes || 0,
        comments: analytics?.comments || post.comments || 0,
        shares: analytics?.shares || post.shares || 0,
        tiktokId: analytics?.tiktokId || analytics?.videoId || post.externalId || null
      };
      rows.push(stats);
      const m = localMetas.find(x => x.meta.postizPostId === post.id);
      if (m) {
        m.meta.stats = stats; m.meta.tiktokVideoId = stats.tiktokId || m.meta.tiktokVideoId;
        m.meta.lastChecked = new Date().toISOString();
        fs.writeFileSync(m.metaPath, JSON.stringify(m.meta, null, 2));
      }
    }
    console.log('\nDate         Views   Likes   Shares  Status');
    console.log('-'.repeat(60));
    for (const r of rows) console.log(`${r.date.padEnd(13)}${fmt(r.views).padStart(7)}  ${fmt(r.likes).padStart(7)}  ${fmt(r.shares).padStart(7)}  ${r.status}`);
    const reportsDir = path.join(path.dirname(configPath), 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const out = path.join(reportsDir, `analytics-${new Date().toISOString().slice(0,10)}.json`);
    fs.writeFileSync(out, JSON.stringify({ pulledAt: new Date().toISOString(), artist: config.artist.name, song: config.song.title, days, posts: rows }, null, 2));
    console.log(`\nSaved to ${out}\n`);
  } catch (err) { console.error(`\nError: ${err.message}`); process.exit(1); }
})();
