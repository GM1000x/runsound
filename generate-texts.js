#!/usr/bin/env node
/**
 * generate-texts.js — RunSound Text Generator
 *
 * Generates hook text for TikTok carousels using ε-greedy archetype selection.
 *
 * FOUR HOOK ARCHETYPES (4 slides each):
 *   A — social_proof         "Showed someone + their reaction"
 *   B — contrarian           "They doubted it → heard it → changed their mind"
 *   C — mystery              Minimal / curiosity gap
 *   D — lifestyle_placement  "This is the type of song i play when..."
 *
 * LEARNING LOOP (Supabase-first, works on Railway ephemeral filesystem):
 *   - hook_weights per archetype stored in campaigns.hook_weights (campaign-specific)
 *   - hook_bank in Supabase stores cross-artist archetype performance per genre family
 *   - New artists inherit the cross-artist prior and blend it with their own data
 *   - learn-hooks.js updates campaign weights weekly based on streaming_ctr
 *   - check-analytics.js updates hook_bank after each analytics sync
 *   - This script reads weights → picks via ε-greedy (80% exploit / 20% explore)
 *   - Chosen archetype written to texts-meta.json for post-to-tiktok.js attribution
 *
 * WEIGHT PRIORITY:
 *   If campaign has ≥7 posts worth of data → use campaign weights directly.
 *   Otherwise → blend hook_bank cross-artist prior with campaign data.
 *   This prevents random variance on early posts from over-fitting.
 *
 * RunSound optimises for STREAMING CLICKS not views.
 * The archetype that drives the most smart-link clicks wins.
 *
 * Usage:
 *   node generate-texts.js --config <config.json> --output <dir>
 *   node generate-texts.js --config <config.json> --output <dir> --campaign-id <uuid>
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i+1] : null; }

const configPath = getArg('config');
const outputDir  = getArg('output');
const campaignId = getArg('campaign-id') || null;

if (!configPath || !outputDir) {
  console.error('Usage: node generate-texts.js --config <config.json> --output <dir>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.mkdirSync(outputDir, { recursive: true });

const st     = config.song?.title          || 'this song';
const an     = config.artist?.name         || '';
const ta     = config.song?.targetAudience || '';
const lyrics = config.song?.lyrics         || '';  // Optional — used to enrich hooks if provided

// ─── Archetypes ───────────────────────────────────────────────────────────────
const ARCHETYPES = {
  A: 'social_proof',
  B: 'contrarian',
  C: 'mystery',
  D: 'lifestyle_placement',
};

const DEFAULT_WEIGHTS = { A: 1.0, B: 1.0, C: 1.0, D: 1.0 };

// ─── Bank utils (optional — gracefully skipped if not present) ────────────────
let bank = null;
try { bank = require('./bank-utils'); } catch { /* bank-utils not present */ }

// ─── Load hook_weights — merges campaign-specific data with cross-artist bank ──
// Priority:
//   1. If campaign has ≥7 posts: use campaign weights (enough individual data)
//   2. Otherwise: blend hook_bank cross-artist prior with campaign weights
//      (protects early posts from random variance, inherits network flywheel data)
async function loadWeightsFromSupabase() {
  const id = campaignId || config.campaign?.id;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return DEFAULT_WEIGHTS;

  let sb = null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  } catch {
    return DEFAULT_WEIGHTS;
  }

  // ── Load campaign-specific weights ────────────────────────────────────────
  let campaignWeights = { ...DEFAULT_WEIGHTS };
  let postCount = 0;

  if (id) {
    try {
      const { data } = await sb
        .from('campaigns')
        .select('hook_weights')
        .eq('id', id)
        .single();

      if (data?.hook_weights && Object.keys(data.hook_weights).length) {
        campaignWeights = { ...DEFAULT_WEIGHTS, ...data.hook_weights };
      }

      // Count posts to know how much to trust campaign weights
      const { count } = await sb
        .from('post_log')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', id);
      postCount = count || 0;
    } catch { /* use defaults */ }
  }

  // ── Load cross-artist hook bank weights ───────────────────────────────────
  let bankWeights = { ...DEFAULT_WEIGHTS };
  if (bank && sb) {
    try {
      const genreFamily = deriveGenreFamily();
      bankWeights = await bank.getHookWeightsFromBank(sb, genreFamily);
    } catch { /* use defaults */ }
  }

  // ── Merge: blend bank prior with campaign data based on post count ─────────
  const merged = bank
    ? bank.mergeHookWeights(campaignWeights, bankWeights, postCount)
    : campaignWeights;

  return merged;
}

// ─── ε-greedy variant selection ───────────────────────────────────────────────
// 80% exploit: pick the variant with the highest streaming-click weight
// 20% explore: pick a random variant (keeps testing all archetypes)
function selectVariant(weights) {
  const keys    = Object.keys(weights);
  const explore = Math.random() < 0.20;

  if (explore) {
    const picked = keys[Math.floor(Math.random() * keys.length)];
    console.log(`   Strategy: EXPLORE (random) → Variant ${picked} (${ARCHETYPES[picked]})`);
    return picked;
  }

  const best = keys.reduce((a, b) => weights[a] >= weights[b] ? a : b);
  console.log(`   Strategy: EXPLOIT (best) → Variant ${best} (${ARCHETYPES[best]}, weight: ${weights[best].toFixed(2)})`);
  return best;
}

// ─── Genre helper — detects broad genre family from config ───────────────────
function deriveGenreFamily() {
  const g = (config.song?.genre || config.artist?.genre || '').toLowerCase();
  const m = (config.song?.mood  || '').toLowerCase();
  if (/house|techno|edm|dance|electronic|trance|club|disco|drum|bass/.test(g + ' ' + m)) return 'dance';
  if (/hip.hop|rap|trap|drill/.test(g + ' ' + m)) return 'hiphop';
  if (/r.b|soul|neo.soul/.test(g + ' ' + m))      return 'rnb';
  if (/country|folk|bluegrass/.test(g + ' ' + m)) return 'country';
  return 'pop'; // default
}

// ─── Listener POV helper ──────────────────────────────────────────────────────
function deriveListenerPOV() {
  const t = ta.toLowerCase();
  if (/\b(men|guys|boys|male|man|guy|boyfriend|brother)\b/.test(t)) {
    return { pronoun: 'he', descriptor: 'my best friend', possessive: 'his' };
  }
  return { pronoun: 'she', descriptor: 'my best friend', possessive: 'her' };
}

// ─── Lifestyle moment helper (for archetype D) ────────────────────────────────
// Derives a relatable life scenario from song mood keywords.
// Can be overridden via config.song.lifestyleMoment.
function deriveLifestyleMoment() {
  if (config.song?.lifestyleMoment) return config.song.lifestyleMoment;
  const m = (config.song?.mood || '').toLowerCase();
  if (/summer|golden|warm|beach|road/.test(m))  return 'on a late summer drive\nwith the windows down';
  if (/night|dark|late|city/.test(m))           return 'on a late night\nwhen you can\'t sleep';
  if (/romantic|love|couple|wedding/.test(m))   return 'when someone special\nis on their way';
  if (/sad|cry|heartbreak|loss/.test(m))        return 'when you need to\nfeel it all the way through';
  if (/nostalgia|memory|old|past/.test(m))      return 'when you miss\nhow things used to be';
  return 'when you need\nthe right song';
}

// ─── Extract a punchy lyric fragment for use in hooks ────────────────────────
// Finds the shortest meaningful line in the lyrics — preferably 3–7 words,
// avoiding intros/outros ("ooh", "yeah", "mmm", verse/chorus headers etc).
// Returns null if lyrics are empty or no good fragment found.
// Used to make the mystery and lifestyle archetypes more song-specific.
function deriveLyricFragment() {
  if (!lyrics) return null;

  const lines = lyrics
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    // Remove section headers like [Verse], [Chorus], (x2), etc.
    .filter(l => !/^\[|\(x\d|\bverse\b|\bchorus\b|\bbridge\b|\bpre-chorus\b|\bintro\b|\boutro\b/i.test(l))
    // Remove filler lines (ooh, yeah, mmm, la la, na na)
    .filter(l => !/^(ooh+|yeah+|mmm+|la\s+la|na\s+na|hey+|uh+|ah+)\b/i.test(l))
    // Keep lines between 2 and 8 words — punchy, not full sentences
    .filter(l => {
      const wc = l.split(/\s+/).length;
      return wc >= 2 && wc <= 8;
    });

  if (!lines.length) return null;

  // Prefer lines from the first half of the song (usually the hook/opening image)
  const preferred = lines.slice(0, Math.ceil(lines.length / 2));
  const pool = preferred.length ? preferred : lines;

  // Pick a random one for variety across posts
  return pool[Math.floor(Math.random() * pool.length)].toLowerCase();
}

// ─── Word-wrap to ~4 words per line ──────────────────────────────────────────
function fmt(t) {
  if (!t || t.includes('\n')) return t || '';
  const words = t.trim().split(/\s+/);
  if (words.length <= 4) return t;
  const lines = []; let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    if (cur.length >= 4 && i < words.length - 1) { lines.push(cur.join(' ')); cur = []; }
  });
  if (cur.length) lines.push(cur.join(' '));
  return lines.join('\n');
}

// ─── Slide texts per archetype ────────────────────────────────────────────────
// lyricFrag (optional): a short punchy phrase extracted from the song's actual lyrics.
// When present it's woven into archetypes C and D to make the hook song-specific
// rather than generic. Without lyrics it falls back to the generic template.
function buildTexts(variant) {
  const cta       = `${st}\nby ${an}\nlink in bio`;
  const song      = st.toLowerCase();
  const pov       = deriveListenerPOV();
  const genre     = deriveGenreFamily();
  const moment    = deriveLifestyleMoment();
  const lyricFrag = deriveLyricFragment();  // null if no lyrics provided

  // Genre-aware reaction words for archetype A
  // Each 'follow' is a complete standalone line — no suffix appended
  const reaction = {
    dance:   { hit: 'turned it up immediately',  follow: `${pov.pronoun} grabbed my phone\nto see what was playing`,  close: 'this one hits different at night.' },
    hiphop:  { hit: 'went silent for a second',  follow: `${pov.pronoun} replayed it\nfour times`,                    close: 'this is the one right now.' },
    rnb:     { hit: 'closed her eyes',           follow: `${pov.pronoun} asked me\nto play it again`,                 close: 'you\'ll understand when you hear it.' },
    country: { hit: 'pulled over to listen',     follow: `${pov.pronoun} didn\'t say\na word`,                        close: 'this song just gets it.' },
    pop:     { hit: 'cried',                     follow: `${pov.pronoun} sent it\nto three people instantly`,          close: 'this is the song for right now.' },
  }[genre];

  const texts = {
    // A — Social proof: genre-aware reaction (4 slides)
    A: [
      `showed ${pov.descriptor}\n${song} at 2am\n${pov.pronoun} ${reaction.hit}`,
      reaction.follow,
      reaction.close,
      cta,
    ],

    // B — Contrarian: "They doubted it → heard it → changed their mind" (4 slides)
    B: [
      `${pov.descriptor} said\nthis type of song\nwasn't for ${pov.pronoun}`,
      `halfway through\n${pov.pronoun} went quiet`,
      `some songs just\nchange people's minds`,
      cta,
    ],

    // C — Mystery: curiosity gap.
    // If lyrics available: open with an actual lyric line — more specific and intriguing.
    // Fallback: generic mystery template.
    C: lyricFrag ? [
      `"${fmt(lyricFrag)}"`,
      `this song knows\nsomething about you\nyou haven't said out loud`,
      `you'll know exactly\nwhat i mean.`,
      cta,
    ] : [
      `wait.\nlisten.`,
      `this song knows\nsomething about you\nyou haven't said out loud`,
      `you'll know exactly\nwhat i mean.`,
      cta,
    ],

    // D — Lifestyle placement: places the song in a vivid life scenario (4 slides)
    // If lyrics available: slide 2 quotes a lyric line to ground the moment.
    // Inspired by viral "this is the type of music i play whilst..." TikTok format.
    D: lyricFrag ? [
      `this is the type of song\ni play\n${moment}`,
      `"${fmt(lyricFrag)}"`,
      `you'll understand\nwhen you hear it.`,
      cta,
    ] : [
      `this is the type of song\ni play\n${moment}`,
      `there are songs\nyou save\nfor certain moments.`,
      `this is one of them.`,
      cta,
    ],
  };

  return texts[variant] || texts.A;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n✍️  RunSound — Generate Texts');
  console.log('==============================');
  console.log(`   Artist:      ${an}`);
  console.log(`   Song:        ${st}`);
  console.log(`   Genre:       ${deriveGenreFamily()} (${config.song?.genre || 'unset'})`);
  console.log(`   Campaign ID: ${campaignId || config.campaign?.id || 'none'}`);
  if (ta) console.log(`   Audience:    ${ta}`);
  console.log(`   Bank:        ${bank ? 'enabled ✅' : 'disabled (bank-utils not found)'}`);
  const previewFrag = deriveLyricFragment();
  if (previewFrag) console.log(`   Lyric frag:  "${previewFrag.slice(0, 50)}"`);
  else             console.log(`   Lyric frag:  none (no lyrics provided — using generic templates)`);

  const weights          = await loadWeightsFromSupabase();
  console.log(`\n   Hook weights: A=${weights.A?.toFixed(2)} B=${weights.B?.toFixed(2)} C=${weights.C?.toFixed(2)} D=${weights.D?.toFixed(2)}`);

  const selectedVariant   = selectVariant(weights);
  const selectedArchetype = ARCHETYPES[selectedVariant];
  const selectedTexts     = buildTexts(selectedVariant);

  // Write selected texts (used by add-text-overlay.js)
  fs.writeFileSync(path.join(outputDir, 'texts.json'), JSON.stringify(selectedTexts, null, 2));

  // Write all variants for reference
  for (const v of Object.keys(ARCHETYPES)) {
    fs.writeFileSync(
      path.join(outputDir, `texts-${v}.json`),
      JSON.stringify(buildTexts(v), null, 2)
    );
  }

  // Write texts-meta.json — read by post-to-tiktok.js to tag post_log.hook_archetype
  const textsMeta = {
    generatedAt:     new Date().toISOString(),
    variant:         selectedVariant,
    hook_archetype:  selectedArchetype,
    genre_family:    deriveGenreFamily(),
    weights_used:    weights,
    song:            st,
    artist:          an,
    campaign_id:     campaignId || config.campaign?.id || null,
    slide1_preview:  selectedTexts[0]?.replace(/\n/g, ' / '),
  };
  fs.writeFileSync(path.join(outputDir, 'texts-meta.json'), JSON.stringify(textsMeta, null, 2));

  // Also patch meta.json if it already exists (set by earlier pipeline steps)
  const metaPath = path.join(outputDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      existing.variant        = selectedVariant;
      existing.hook_archetype = selectedArchetype;
      fs.writeFileSync(metaPath, JSON.stringify(existing, null, 2));
    } catch {}
  }

  console.log(`\n✅ Variant ${selectedVariant} (${selectedArchetype}) selected`);
  console.log(`   Slide 1: "${selectedTexts[0]?.replace(/\n/g, ' / ').slice(0, 60)}"`);
  console.log(`   Next: npm run overlay\n`);
})();
