/**
 * optimize-strategy.js
 *
 * The learning layer. Reads recent post analytics + Supabase UTM clicks,
 * sends to GPT-4, and outputs a strategy.json that generate-slides.js uses
 * to make smarter content decisions.
 *
 * This is what makes RunSound worth paying for.
 *
 * Usage: npm run optimize
 * Output: runsound-marketing/strategy.json
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// Parse CLI args
const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1] || 'runsound-marketing/config.json';

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);

// Resolve API key from env if needed
const rawApiKey = config.imageGen.apiKey || '';
const apiKey = rawApiKey.startsWith('sk-')
  ? rawApiKey
  : (process.env[rawApiKey] || process.env.OPENAI_API_KEY || rawApiKey);

const openai = new OpenAI({ apiKey });

// Resolve Supabase credentials
const supabaseUrl = config.tracking?.supabaseUrl?.startsWith('http')
  ? config.tracking.supabaseUrl
  : process.env[config.tracking?.supabaseUrl] || process.env.SUPABASE_URL;

const supabaseKey = config.tracking?.supabaseKey?.startsWith('eyJ')
  ? config.tracking.supabaseKey
  : process.env[config.tracking?.supabaseKey] || process.env.SUPABASE_SERVICE_KEY;

async function getRecentAnalytics() {
  // Load all analytics JSON files from the last 14 days
  const analyticsDir = path.join(projectDir, 'analytics');
  if (!fs.existsSync(analyticsDir)) return [];

  const files = fs.readdirSync(analyticsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-14); // last 14 files

  return files.flatMap(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(analyticsDir, f), 'utf8'));
      return Array.isArray(data) ? data : [data];
    } catch {
      return [];
    }
  });
}

async function getSmartLinkClicks() {
  if (!supabaseUrl || !supabaseKey) {
    console.log('⚠️  Supabase not configured — skipping smart link data');
    return [];
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const slug = config.song?.smartLinkSlug;
    if (!slug) return [];

    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('utm_clicks')
      .select('platform, clicked_at, source')
      .eq('slug', slug)
      .gte('clicked_at', since)
      .order('clicked_at', { ascending: false });

    if (error) throw error;

    // Summarize by platform
    const summary = {};
    (data || []).forEach(row => {
      summary[row.platform] = (summary[row.platform] || 0) + 1;
    });

    return Object.entries(summary).map(([platform, clicks]) => ({ platform, clicks }));
  } catch (err) {
    console.log(`⚠️  Could not fetch Supabase data: ${err.message}`);
    return [];
  }
}

// ─── TikTok Trend Search via Serper ──────────────────────────────────────────
async function searchTikTokTrends(genre, mood) {
  const serperKey = process.env.SERPER_API_KEY;

  if (!serperKey) {
    console.log('ℹ️  SERPER_API_KEY not set — skipping trend search');
    return null;
  }

  const now = new Date();
  const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const queries = [
    `trending TikTok music video visual style ${genre} ${monthYear}`,
    `viral TikTok music slideshow hook format ${mood} ${monthYear}`,
    `TikTok algorithm music content what works ${monthYear}`
  ];

  console.log('🔍 Searching TikTok trends via Serper...');

  const results = await Promise.all(queries.map(async (q) => {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q, num: 5 })
      });
      const data = await res.json();
      return {
        query: q,
        snippets: (data.organic || []).slice(0, 4).map(r => r.snippet).filter(Boolean)
      };
    } catch (err) {
      console.log(`  ⚠️  Search failed for "${q}": ${err.message}`);
      return { query: q, snippets: [] };
    }
  }));

  const allSnippets = results.flatMap(r => r.snippets).filter(Boolean);
  if (!allSnippets.length) return null;

  console.log(`  ✅ Found ${allSnippets.length} trend signals\n`);

  return `
CURRENT TIKTOK TRENDS (${monthYear}):
${allSnippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`.trim();
}

function loadPreviousStrategy() {
  const strategyPath = path.join(projectDir, 'strategy.json');
  if (fs.existsSync(strategyPath)) {
    try {
      return JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function buildAnalyticsSummary(posts) {
  if (!posts.length) return 'No post data available yet.';

  const sorted = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0));
  const top3 = sorted.slice(0, 3);
  const bottom3 = sorted.slice(-3);

  const avgViews = Math.round(posts.reduce((s, p) => s + (p.views || 0), 0) / posts.length);
  const avgClicks = Math.round(posts.reduce((s, p) => s + (p.clicks || 0), 0) / posts.length);

  return `
RECENT POST PERFORMANCE (last 14 days, ${posts.length} posts):
Average views: ${avgViews}
Average smart link clicks: ${avgClicks}

TOP 3 PERFORMING POSTS:
${top3.map(p => `- "${p.caption || p.hookLine || 'untitled'}" | views: ${p.views || 0} | clicks: ${p.clicks || 0} | likes: ${p.likes || 0}`).join('\n')}

BOTTOM 3 PERFORMING POSTS:
${bottom3.map(p => `- "${p.caption || p.hookLine || 'untitled'}" | views: ${p.views || 0} | clicks: ${p.clicks || 0} | likes: ${p.likes || 0}`).join('\n')}
`.trim();
}

async function optimizeStrategy() {
  console.log('🧠 RunSound Strategy Optimizer');
  console.log('================================');
  console.log('📊 Loading recent analytics...');

  const [posts, smartLinkClicks, trendData] = await Promise.all([
    getRecentAnalytics(),
    getSmartLinkClicks(),
    searchTikTokTrends(config.artist?.genre || 'music', config.artist?.mood || 'emotional')
  ]);

  const previousStrategy = loadPreviousStrategy();
  const analyticsSummary = buildAnalyticsSummary(posts);

  const clicksSummary = smartLinkClicks.length
    ? `Smart link clicks by platform: ${smartLinkClicks.map(c => `${c.platform}: ${c.clicks}`).join(', ')}`
    : 'No smart link click data available yet.';

  const hookLines = config.song?.hookLines || [];
  const previousStrategyText = previousStrategy
    ? `\nPREVIOUS STRATEGY USED:\nHook angle: ${previousStrategy.hookAngle}\nVisual direction: ${previousStrategy.visualDirection}\nCTA: ${previousStrategy.cta}\nResult: ${previousStrategy.resultSummary || 'unknown'}`
    : '';

  console.log(`📈 Loaded ${posts.length} posts for analysis`);
  if (trendData) console.log('📡 Trend data loaded');
  console.log('🤖 Asking GPT-4 to analyze and optimize...\n');

  const prompt = `You are a music marketing strategist specializing in TikTok content optimization for independent artists.

ARTIST PROFILE:
Name: ${config.artist?.name || 'Unknown'}
Genre: ${config.artist?.genre || 'Unknown'}
Mood: ${config.artist?.mood || 'Unknown'}
Target Audience: ${config.artist?.targetAudience || 'Unknown'}

SONG:
Title: ${config.song?.title || 'Unknown'}
Available hook lines in config:
${hookLines.map((l, i) => `\n  ${i + 1}. "${l}"`).join('')}
${previousStrategyText}

ANALYTICS DATA:
${analyticsSummary}

STREAMING CLICKS:
${clicksSummary}
${trendData ? `\n${trendData}` : '\nNo trend data available — base recommendations on analytics only."}

Based on ALL of this data — the artist's own performance AND current TikTok trends — provide a JSON strategy for the NEXT post.

Rules:
- Artist analytics come first. If a specific hook format drove clicks, double down on it.
- Use trend data to inform the VISUAL direction — what aesthetic is TikTok's algorithm currently rewarding in this genre?
- If trends mention a specific visual style (dark/moody, film grain, close-up, etc.) that fits the artist's mood, incorporate it into visualDirection.
- Never chase trends that contradict the artist's established mood or genre identity.
- If views are low, suggest a stronger hook angle informed by what's currently viral in the niche.

Respond with ONLY valid JSON in this exact format:
{
  "hookLine": "The specific hook line from the list above that should lead this post (or a variation)",
  "hookAngle": "One sentence describing the emotional angle to lean into (e.g. 'lean into the longing, not the anger')",
  "visualDirection": "One sentence adjusting the visual style (e.g. 'darker, more cinematic, avoid bright colors')",
  "cta": "The exact CTA ext for slide 6 (e.g. 'Stream now — link in bio')",
  "postingNote": "One insight about timing or caption strategy based on the data",
  "diagnosis": "One of: SCALE | FIX_CTA | FIX_HOOK | RESET | INSUFFICIENT_DATA",
  "reasoning": "2-3 sentences explaining what the data shows and why you're recommending this direction",
  "resultSummary": "Brief summary of current performance to store for next optimization cycle"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      response_format: { type: 'json_object' }
    });

    const strategy = JSON.parse(response.choices[0].message.content);

    // Add metadata
    strategy.generatedAt = new Date().toISOString();
    strategy.basedOnPosts = posts.length;
    strategy.songTitle = config.song?.title;

    // Save strategy
    const strategyPath = path.join(projectDir, 'strategy.json');
    fs.writeFileSync(strategyPath, JSON.stringify(strategy, null, 2));

    console.log('✅ Strategy optimized!\n');
    console.log(`� Diagnosis: ${strategy.diagnosis}`);
    console.log(`🎯 Hook: "${strategy.hookLine}"`);
    console.log(`🎨 Visual: ${strategy.visualDirection}`);
    console.log(`📢 CTA: "${strategy.cta}"`);
    console.log(`💡 Insight: ${strategy.postingNote}`);
    console.log(`\n🧠 Reasoning: ${strategy.reasoning}`);
    console.log(`\n💾 Saved to: ${strategyPath}`);

    return strategy;

  } catch (err) {
    console.error(`❌ Strategy optimization failed: ${err.message}`);

    // Fall back to default strategy if AI fails
    const fallback = {
      hookLine: hookLines[0] || '',
      hookAngle: 'Use the most emotionally direct version of the hook',
      visualDirection: config.imageGen?.basePrompt || 'Cinematic, emotionally raw',
      cta: 'Stream now — link in bio',
      postingNote: 'Post at 7:30 AM or 9:00 PM for best reach',
      diagnosis: 'INSUFFICIENT_DATA',
      reasoning: 'Not enough data yet to optimize. Using defaults.',
      resultSummary: 'Fallback strategy used',
      generatedAt: new Date().toISOString(),
      basedOnPosts: 0
    };

    const strategyPath = path.join(projectDir, 'strategy.json');
    fs.writeFileSync(strategyPath, JSON.stringify(fallback, null, 2));
    console.log('⚠️  Using fallback strategy');
    return fallback;
  }
}

optimizeStrategy().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
