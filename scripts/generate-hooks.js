#!/usr/bin/env node
/**
 * generate-hooks.js — RunSound Hook Generator
 *
 * Generates three hook variants (A, B, C) for today's carousel.
 *
 * CHANGE LOG:
 *   - Now reads strategy.json to use the optimizer's recommended hookLine
 *     and recommendedVariant as slide 1 of the best-performing variant.
 *   - If strategy says "Variant B converts best", the recommended hook
 *     leads Variant B's slide 1. Variant A still leads with the raw lyric.
 *   - Saves signals (hookLine, variant, hookAngle) to meta.json so
 *     learn.js can attribute streaming clicks back to the creative choice.
 *
 * Usage:
 *   node scripts/generate-hooks.js --input <dir> --config <config.json>
 *
 * Output:
 *   <input>/texts-A.json
 *   <input>/texts-B.json
 *   <input>/texts-C.json
 *   <input>/hooks-summary.json
 */

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ga   = n => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : null; };

const inputDir   = ga('input');
const configPath = ga('config');

if (!inputDir || !configPath) {
  console.error('Usage: node generate-hooks.js --input <dir> --config <config.json>');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const hl  = cfg.song.hookLines || [];
const st  = cfg.song.title     || 'this song';
const an  = cfg.artist.name    || '';

// ─── Load strategy.json if available ─────────────────────────────────────────
function loadStrategy() {
  const strategyPath = path.join(path.dirname(configPath), 'strategy.json');
  if (fs.existsSync(strategyPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
      console.log(`🧠 Strategy loaded:`);
      console.log(`   Recommended variant: ${s.recommendedVariant || 'A'}`);
      console.log(`   Hook line:           "${(s.hookLine || '').slice(0, 60)}"`);
      console.log(`   Diagnosis:           ${s.diagnosis || 'unknown'}\n`);
      return s;
    } catch { /* fall through */ }
  }
  console.log('ℹ️  No strategy.json — using raw hook lines from config\n');
  return null;
}

// ─── Word-wrap hook text to 4 words per line ──────────────────────────────────
function fmt(t) {
  if (!t || t.includes('\n')) return t || '';
  const words = t.trim().split(/\s+/);
  if (words.length <= 4) return t;
  const lines = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    if (cur.length >= 4 && i < words.length - 1) { lines.push(cur.join(' ')); cur = []; }
  });
  if (cur.length) lines.push(cur.join(' '));
  return lines.join('\n');
}

const cta = `${st}\nby ${an}\nlink in bio`;

// ─── Build the three base variants from config hook lines ─────────────────────
function buildBaseVariants(hl) {
  const h0 = hl[0] ? fmt(hl[0]) : 'this song has been\nliving in my head\nfor weeks';
  const h1 = hl[1] ? fmt(hl[1]) : 'every single word\nhits different\nwhen you\'ve been there';
  const h2 = hl[2] ? fmt(hl[2]) : 'the way this captures\nexactly how it feels\nis insane';
  const h3 = hl[3] ? fmt(hl[3]) : 'how did they\nput this into words\nso perfectly';
  const h4 = hl[4] ? fmt(hl[4]) : 'okay I\'m actually\nobsessed with\nthis one';

  const h0raw = (hl[0] || '').toLowerCase();

  // Variant A — Direct lyrics (raw, authentic)
  const vA = [h0, h1, h2, h3, h4, cta];

  // Variant B — Emotional reaction arc
  const vB = [
    'you know that feeling\nwhen a song puts\nwords to it',
    h0raw ? `"${h0raw.length > 30 ? h0raw.slice(0, 28) + '...' : h0raw}"\n\nwait.` : 'this came on shuffle\nand I had to\nstop walking',
    h2 || 'the bridge alone\nis worth\neverything',
    h3 || 'I\'ve replayed this\nmore times than\nI can count',
    'not okay.\nnot even close\nto okay.',
    cta,
  ];

  // Variant C — Minimal / mystery
  const vC = [
    'wait.\nlisten.',
    hl[0] ? hl[0].trim().split(/\s+/).slice(0, 3).join(' ') : 'bad weather.',
    '...',
    'yeah.\nthat one.',
    'you need this\nsong.',
    cta,
  ];

  return { A: vA, B: vB, C: vC };
}

// ─── Apply strategy: put recommended hook line at slide 1 of best variant ─────
function applyStrategy(variants, strategy) {
  if (!strategy?.hookLine) return variants;

  const best     = (strategy.recommendedVariant || 'A').toUpperCase();
  const hookText = fmt(strategy.hookLine);

  // Clone so we don't mutate the original
  const updated = { ...variants };
  updated[best] = [...variants[best]];
  updated[best][0] = hookText; // Replace slide 1 with optimizer-recommended hook

  console.log(`   ✅ Injected recommended hook into Variant ${best} slide 1`);
  return updated;
}

// ─── Save signals to meta.json for learn.js attribution ───────────────────────
function saveSignalsToMeta(strategy) {
  if (!strategy) return;
  const metaPath = path.join(inputDir, 'meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }

  // Store the creative signals so learn.js can attribute clicks back to them
  meta.hookLine        = strategy.hookLine        || null;
  meta.hookAngle       = strategy.hookAngle       || null;
  meta.visualDirection = strategy.visualDirection || null;
  meta.diagnosis       = strategy.diagnosis       || null;

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const strategy = loadStrategy();
const base     = buildBaseVariants(hl);
const variants = applyStrategy(base, strategy);

const V = {
  A: { name: 'Lyric',   description: 'Direct lyrics — raw, authentic hook',            texts: variants.A },
  B: { name: 'Emotion', description: 'Emotional reactions — relatable journey',        texts: variants.B },
  C: { name: 'Minimal', description: 'Ultra-short — curiosity and mystery',            texts: variants.C },
};

// Mark the recommended variant in the summary
const recommended = (strategy?.recommendedVariant || 'A').toUpperCase();

Object.entries(V).forEach(([k, v]) => {
  fs.writeFileSync(path.join(inputDir, `texts-${k}.json`), JSON.stringify(v.texts, null, 2));
});

const summary = {
  generated:          new Date().toISOString(),
  song:               st,
  artist:             an,
  recommendedVariant: recommended,
  strategyApplied:    !!strategy,
  variants:           Object.fromEntries(
    Object.entries(V).map(([k, v]) => [k, {
      name:        v.name,
      description: v.description,
      recommended: k === recommended,
      slide1:      v.texts[0].replace(/\n/g, ' / '),
    }])
  ),
};

fs.writeFileSync(path.join(inputDir, 'hooks-summary.json'), JSON.stringify(summary, null, 2));

// Save signals to meta for learn.js
saveSignalsToMeta(strategy);

console.log(`Hook Generator — ${an} / ${st}`);
console.log(`${'─'.repeat(50)}`);
Object.entries(V).forEach(([k, v]) => {
  const star = k === recommended ? ' ← RECOMMENDED' : '';
  console.log(`\nVariant ${k} — ${v.name}: ${v.description}${star}`);
  v.texts.forEach((t, i) => console.log(`  Slide ${i + 1}: "${t.replace(/\n/g, ' / ')}"`));
});
console.log(`\nSaved: texts-A.json, texts-B.json, texts-C.json, hooks-summary.json\n`);
