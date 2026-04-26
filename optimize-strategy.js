/**
 * optimize-strategy.js
 *
 * The learning layer. Reads learning-history.json (from learn.js) +
 * recent Supabase UTM clicks + TikTok trend search, then asks GPT-4o
 * to generate a data-driven strategy.json that generate-slides.js uses.
 *
 * This is what makes RunSound worth paying for.
 *
 * Usage: npm run optimize
 * Output: runsound-marketing/strategy.json
 *
 * CHANGE LOG:
 *   - Now reads learning-history.json (patterns from learn.js) as primary input
 *   - Falls back to analytics/ folder if no learning history exists yet
 *   - GPT prompt now includes: best variant, top hook lines by streamingCTR,
 *     best posting time — all derived from actual streaming click data
 */

const fs    = require('fs');
const path  = require('path');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1] || 'runsound-marketing/config.json';

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);

// ─── Resolve API keys ─────────────────────────────────────────────────────────
const rawApiKey = config.imageGen.apiKey || '';
const apiKey = rawApiKey.startsWith('sk-')
  ? rawApiKey
  : (process.env[rawApiKey] || process.env.OPENAI_API_KEY || rawApiKey);

const openai = new OpenAI({ apiKey });

const rawUrl = config.tracking?.supabaseUrl || '';
const rawKey = config.tracking?.supabaseKey || '';
const supabaseUrl = rawUrl.startsWith('http')
  ? rawUrl
  : process.env[rawUrl] || process.env.SUPABASE_URL;
const supabaseKey = rawKey.startsWith('eyJ')
  ? rawKey
  : process.env[rawKey] || process.env.SUPABASE_SERVICE_KEY;

// ─── Load learning history (primary: from learn.js) ──────────────────────────
function loadLearningHistory() {
  const learningPath = path.join(projectDir, 'learning-history.json');
  if (fs.existsSync(learningPath)) {
    try {
      const h = JSON.parse(fs.readFileSync(learningPath, 'utf8'));
      console.log(`📚 Learning history loaded (${h.postsAnalyzed} posts, generated ${h.generatedAt?.slice(0, 10)})`);
      return h;
    } catch { /* fall through */ }
  }
  console.log('ℹ️  No learning-history.json yet — run "npm run learn" first for best results');
  return null;
}

// ─── Fallback: load raw analytics json files ──────────────────────────────────
function loadRawAnalytics() {
  // Support both reports/ (new) and analytics/ (legacy) folder names
  for (const dir of ['reports', 'analytics']) {
    const analyticsDir = path.join(projectDir, dir);
    if (!fs.existsSync(analyticsDir)) continue;

    const files = fs.readdirSync(analyticsDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-14);

    const posts = files.flatMap(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(analyticsDir, f), 'utf8'));
        return Array.isArray(data) ? data : (data.posts || [data]);
      } catch { return []; }
    });

    if (posts.length) {
      console.log(`📊 Loaded ${posts.length} posts from ${dir}/ (no learning history yet)`);
      return posts;
    }
  }
  return [];
}

// ─── Get recent smart link clicks from Supabase ───────────────────────────────
async function getSmartLinkClicks() {
  if (!supabaseUrl || !supabaseKey) {
    console.log('⚠️  Supabase not configured — skipping smart link data');
    return [];
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const slug     = config.song?.smartLinkSlug;
    if (!slug) return [];

    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('utm_clicks')
      .select('platform, clicked_at, campaign')
      .eq('slug', slug)
      .gte('clicked_at', since)
      .order('clicked_at', { ascending: false });

    if (error) throw error;

    const summary = {};
    for (const row of (data || [])) {
      summary[row.platform] = (summary[row.platform] || 0) + 1;
    }
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

  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const queries = [
    `trending TikTok music video visual style ${genre} ${monthYear}`,
    `viral TikTok music slideshow hook format ${mood} ${monthYear}`,
    `TikTok algorithm music content what works ${monthYear}`,
  ];

  console.log('🔍 Searching TikTok trends via Serper...');

  const results = await Promise.all(queries.map(async (q) => {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method:  'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ q, num: 5 }),
      });
      const data = await res.json();
      return (data.organic || []).slice(0, 4).map(r => r.snippet).filter(Boolean);
    } catch { return []; }
  }));

  const snippets = results.flat().filter(Boolean);
  if (!snippets.length) return null;

  console.log(`   ✅ ${snippets.length} trend signals found\n`);
  return `CURRENT TIKTOK TRENDS (${monthYear}):\n${snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

function loadPreviousStrategy() {
  const strategyPath = path.join(projectDir, 'strategy.json');
  if (fs.existsSync(strategyPath)) {
    try { return JSON.parse(fs.readFileSync(strategyPath, 'utf8')); } catch {}
  }
  return null;
}

// ─── Build analytics summary (fallback, no learning history) ─────────────────
function buildRawAnalyticsSummary(posts) {
  if (!posts.length) return 'No post data available yet.';

  const sorted = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0));
  const top3   = sorted.slice(0, 3);
  const bot3   = sorted.slice(-3);
  const avg    = fn => Math.round(posts.reduce((s, p) => s + (p[fn] || 0), 0) / posts.length);

  return `
RECENT POST PERFORMANCE (last 14 days, ${posts.length} posts):
Average views: ${avg('views')}
Average smart link clicks: ${avg('clicks')}

TOP 3 POSTS:
${top3.map(p => `- "${p.caption || p.hookLine || 'untitled'}" | views: ${p.views || 0} | clicks: ${p.clicks || 0}`).join('\n')}

BOTTOM 3 POSTS:
${bot3.map(p => `- "${p.caption || p.hookLine || 'untitled'}" | views: ${p.views || 0} | clicks: ${p.clicks || 0}`).join('\n')}
`.trim();
}

// ─── Build learning summary (rich: has streamingCTR per variant/hook) ─────────
function buildLearningSummary(history) {
  const { summary, patterns, topPosts } = history;

  const variantLines = (patterns.variantRanking || [])
    .map(v => `  ${v.variant}: avgCTR=${(v.avgCTR * 100).toFixed(3)}% avgScore=${v.avgScore} (${v.posts} posts)`)
    .join('\n');

  const hookLines = (patterns.topHookLines || []).slice(0, 3)
    .map((h, i) => `  ${i + 1}. "${h.hookLine?.slice(0, 70)}" — CTR ${(h.avgCTR * 100).toFixed(3)}%`)
    .join('\n');

  const topPostLines = (topPosts || []).slice(0, 3)
    .map(p =>
      `  - [${p.signals?.variant}] views:${p.metrics?.views} streams:${p.metrics?.streamingClicks} ` +
      `CTR:${((p.metrics?.streamingCTR || 0) * 100).toFixed(3)}% ` +
      `hook:"${(p.signals?.hookLine || '').slice(0, 50)}"`
    )
    .join('\n');

  return `
LEARNING DATA (${history.postsAnalyzed} posts, last ${history.daysBack} days):
Total views:            ${summary.totalViews}
Total streaming clicks: ${summary.totalStreamingClicks}
Average streaming CTR:  ${(summary.avgStreamingCTR * 100).toFixed(3)}%

VARIANT PERFORMANCE (ranked by streaming CTR — the metric that matters):
${variantLines || '  No variant data yet'}

TOP HOOK LINES BY STREAMING CTR:
${hookLines || '  No hook line data yet'}

BEST POSTING TIME:  ${patterns.bestTimeBucket || 'unknown'}
BEST DAY OF WEEK:   ${patterns.bestDayOfWeek || 'unknown'}

TOP 3 BEST POSTS:
${topPostLines || '  No post data yet'}
`.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function optimizeStrategy() {
  console.log('🧠 RunSound Strategy Optimizer');
  console.log('================================\n');

  // Load data sources in parallel
  const [smartLinkClicks, trendData] = await Promise.all([
    getSmartLinkClicks(),
    searchTikTokTrends(config.artist?.genre || 'music', config.artist?.mood || 'emotional'),
  ]);

  const learningHistory  = loadLearningHistory();
  const previousStrategy = loadPreviousStrategy();
  const hookLines        = config.song?.hookLines || [];

  // Build analytics section for the prompt
  let analyticsSummary;
  if (learningHistory) {
    analyticsSummary = buildLearningSummary(learningHistory);
  } else {
    const rawPosts = loadRawAnalytics();
    analyticsSummary = buildRawAnalyticsSummary(rawPosts);
  }

  const clicksSummary = smartLinkClicks.length
    ? `Smart link clicks by platform (last 14 days): ${smartLinkClicks.map(c => `${c.platform}: ${c.clicks}`).join(', ')}`
    : 'No smart link click data available yet.';

  const previousStrategyText = previousStrategy
    ? `\nPREVIOUS STRATEGY USED:\nHook angle: ${previousStrategy.hookAngle}\nVisual: ${previousStrategy.visualDirection}\nCTA: ${previousStrategy.cta}\nResult: ${previousStrategy.resultSummary || 'unknown'}`
    : '';

  const learningNote = learningHistory
    ? `\nDATA SOURCE: Full learning history with per-post streaming CTR. Prioritize the variant and hook lines with highest streaming CTR — these are proven converters.`
    : `\nDATA SOURCE: Raw analytics only (no per-post CTR). Run "npm run learn" after "npm run analytics" to unlock per-post streaming attribution.`;

  console.log('🤖 Asking GPT-4o to analyze and optimize...\n');

  const prompt = `You are a music marketing strategist specializing in TikTok content optimization for independent artists. Your goal is to maximize streaming clicks (Spotify / Apple Music), not just views.

ARTIST PROFILE:
Name: ${config.artist?.name || 'Unknown'}
Genre: ${config.artist?.genre || 'Unknown'}
Mood: ${config.artist?.mood || 'Unknown'}
Target Audience: ${config.artist?.targetAudience || 'Unknown'}

SONG:
Title: ${config.song?.title || 'Unknown'}
Available hook lines in config:
${hookLines.map((l, i) => `  ${i + 1}. "${l}"`).join('\n')}
${previousStrategyText}

${analyticsSummary}

STREAMING PLATFORM CLICKS (Supabase):
${clicksSummary}
${trendData ? `\n${trendData}` : '\nNo trend data available.'}
${learningNote}

Based on ALL of this data, provide a JSON strategy for the NEXT post.

RULES:
1. streamingCTR is the primary signal. If a variant or hook line has a higher CTR, double down on it.
2. If Variant B or C has higher CTR than A, recommend that variant in the "recommendedVariant" field.
3. Use trend data only to adjust visual direction — never let trends override a proven hook format.
4. If views are high but streamingCTR is low, the hook is attracting the wrong audience — suggest a more targeted angle.
5. If streamingCTR is 0 across all posts, there is likely a funnel problem (smart link, caption, CTA) — diagnose it.

Respond with ONLY valid JSON in this exact format:
{
  "hookLine": "The specific hook line from the list above that should lead this post",
  "hookAngle": "One sentence: the emotional angle to lean into",
  "visualDirection": "One sentence: the visual style adjustment",
  "cta": "The exact CTA text for the final slide",
  "recommendedVariant": "A, B, or C — whichever has the best streaming CTR, or A if unknown",
  "postingNote": "One insight about timing or caption strategy based on the data",
  "diagnosis": "One of: SCALE | FIX_CTA | FIX_HOOK | FIX_VISUAL | FIX_FUNNEL | RESET | INSUFFICIENT_DATA",
  "reasoning": "2-3 sentences explaining what the data shows and why you recommend this direction",
  "resultSummary": "Brief performance summary to store for next optimization cycle"
}`;

  try {
    const response = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.4,
      response_format: { type: 'json_object' },
    });

    const strategy = JSON.parse(response.choices[0].message.content);

    // Attach metadata
    strategy.generatedAt       = new Date().toISOString();
    strategy.basedOnPosts      = learningHistory?.postsAnalyzed || 0;
    strategy.hasLearningData   = !!learningHistory;
    strategy.avgStreamingCTR   = learningHistory?.summary?.avgStreamingCTR || null;
    strategy.songTitle         = config.song?.title;

    const strategyPath = path.join(projectDir, 'strategy.json');
    fs.writeFileSync(strategyPath, JSON.stringify(strategy, null, 2));

    console.log('✅ Strategy optimized!\n');
    console.log(`🔬 Diagnosis:          ${strategy.diagnosis}`);
    console.log(`🏆 Recommended variant: ${strategy.recommendedVariant || 'A'}`);
    console.log(`🎯 Hook:               "${strategy.hookLine}"`);
    console.log(`🎨 Visual:             ${strategy.visualDirection}`);
    console.log(`📢 CTA:                "${strategy.cta}"`);
    console.log(`💡 Insight:            ${strategy.postingNote}`);
    console.log(`\n🧠 Reasoning: ${strategy.reasoning}`);
    console.log(`\n💾 Saved to: ${strategyPath}\n`);

    return strategy;

  } catch (err) {
    console.error(`❌ Strategy optimization failed: ${err.message}`);

    const fallback = {
      hookLine:           hookLines[0] || '',
      hookAngle:          'Use the most emotionally direct version of the hook',
      visualDirection:    config.imageGen?.basePrompt || 'Cinematic, emotionally raw',
      cta:                'Stream now — link in bio',
      recommendedVariant: 'A',
      postingNote:        'Post at 7:30 AM or 9:00 PM for best reach',
      diagnosis:          'INSUFFICIENT_DATA',
      reasoning:          'Optimization failed. Using defaults.',
      resultSummary:      'Fallback strategy used',
      generatedAt:        new Date().toISOString(),
      basedOnPosts:       0,
      hasLearningData:    false,
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
