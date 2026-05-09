#!/usr/bin/env node
/**
 * generate-texts.js — RunSound Text Generator
 *
 * The missing link between hook generation and text overlay.
 *
 * 1. Loads strategy.json to find the recommended hook variant (A/B/C)
 * 2. Generates all three hook variants using generate-hooks.js logic
 * 3. Selects the recommended variant (or best by streamingCTR from history)
 * 4. Writes texts.json — the format add-text-overlay.js expects:
 *    an array of 6 strings, one per slide
 *
 * Usage:
 *   node scripts/generate-texts.js --config <config.json> --output <dir>
 *
 * Output:
 *   <output>/texts.json          ← used by add-text-overlay.js
 *   <output>/texts-A.json        ← all variant A texts (for reference)
 *   <output>/texts-B.json        ← all variant B texts
 *   <output>/texts-C.json        ← all variant C texts
 *   <output>/hooks-summary.json  ← summary of all variants
 */

const fs   = require('fs');
const path = require('path');

// ─── CLI args ─────────────────────────────���───────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i+1] : null; }

const configPath = getArg('config');
const outputDir  = getArg('output');

if (!configPath || !outputDir) {
  console.error('Usage: node scripts/generate-texts.js --config <config.json> --output <dir>');
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);
fs.mkdirSync(outputDir, { recursive: true });

const hl = config.song?.hookLines || [];
const st = config.song?.title     || 'this song';
const an = config.artist?.name    || '';

// ─── Load strategy.json ───────────────────────────────────────────────────────
function loadStrategy() {
  const p = path.join(projectDir, 'strategy.json');
  if (fs.existsSync(p)) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      return s;
    } catch {}
  }
  return null;
}

// ─── Load learning history for variant performance ────────────────────────────
function getBestVariantFromHistory() {
  const p = path.join(projectDir, 'learning-history.json');
  if (!fs.existsSync(p)) return null;
  try {
    const h = JSON.parse(fs.readFileSync(p, 'utf8'));
    return h.patterns?.bestVariant || null;
  } catch { return null; }
}

// ─── Word-wrap to 4 words per line ────────────────────────────────────────────
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

// ─── Build hook variants ────────────────────────────────���─────────────────────
function buildVariants(strategy) {
  const cta = `${st}\nby ${an}\n🎵 link in bio`;

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
    h0raw ? `"${h0raw.length > 30 ? h0raw.slice(0, 28) + '...' : h0raw}"\n\nwait.`
           : 'this came on shuffle\nand I had to\nstop walking',
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

  const variants = { A: vA, B: vB, C: vC };

  // Inject strategy's recommended hookLine into the best variant's slide 1
  if (strategy?.hookLine) {
    const best = (strategy.recommendedVariant || 'A').toUpperCase();
    if (variants[best]) {
      variants[best] = [...variants[best]];
      variants[best][0] = fmt(strategy.hookLine);
    }
  }

  return variants;
}

// ─── Select which variant to use ───────────────────────────────���─────────────
function selectVariant(strategy) {
  // 1. Strategy explicitly recommends a variant
  if (strategy?.recommendedVariant) {
    return strategy.recommendedVariant.toUpperCase();
  }
  // 2. Learning history shows which variant converts best
  const histBest = getBestVariantFromHistory();
  if (histBest) return histBest.toUpperCase();
  // 3. Default to A
  return 'A';
}

// ─── Save signals to meta.json for learn.js attribution ───────────────────────
function saveSignalsToMeta(strategy, selectedVariant) {
  const metaPath = path.join(outputDir, 'meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }
  meta.variant         = selectedVariant;
  meta.hookLine        = strategy?.hookLine        || null;
  meta.hookAngle       = strategy?.hookAngle       || null;
  meta.visualDirection = strategy?.visualDirection || null;
  meta.diagnosis       = strategy?.diagnosis       || null;
  meta.textsGeneratedAt = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n✍️  RunSound — Generate Texts');
console.log('==============================');
console.log(`   Artist: ${an}`);
console.log(`   Song:   ${st}`);

const strategy        = loadStrategy();
const selectedVariant = selectVariant(strategy);
const variants        = buildVariants(strategy);

console.log(`\n   Strategy loaded:     ${strategy ? 'yes' : 'no (using defaults)'}`);
console.log(`   Recommended variant: ${selectedVariant}`);
if (strategy?.hookLine) {
  console.log(`   Hook injected:       "${strategy.hookLine.slice(0, 60)}"`);
}

// Save all variants
for (const [key, texts] of Object.entries(variants)) {
  fs.writeFileSync(path.join(outputDir, `texts-${key}.json`), JSON.stringify(texts, null, 2));
}

// Write texts.json = selected variant (what add-text-overlay.js reads)
const selectedTexts = variants[selectedVariant] || variants['A'];
fs.writeFileSync(path.join(outputDir, 'texts.json'), JSON.stringify(selectedTexts, null, 2));

// Save hooks summary
const summary = {
  generatedAt:        new Date().toISOString(),
  song:               st,
  artist:             an,
  selectedVariant,
  strategyApplied:    !!strategy,
  variants: Object.fromEntries(
    Object.entries(variants).map(([k, v]) => [k, {
      selected:    k === selectedVariant,
      slide1:      v[0]?.replace(/\n/g, ' / '),
    }])
  ),
};
fs.writeFileSync(path.join(outputDir, 'hooks-summary.json'), JSON.stringify(summary, null, 2));

// Save signals for learn.js attribution
saveSignalsToMeta(strategy, selectedVariant);

console.log('\n📝 Variant previews:');
for (const [k, v] of Object.entries(variants)) {
  const mark = k === selectedVariant ? ' ← SELECTED' : '';
  console.log(`   ${k}: "${v[0]?.replace(/\n/g, ' / ').slice(0, 55)}"${mark}`);
}

console.log(`\n✅ texts.json written (Variant ${selectedVariant})`);
console.log(`   Next: npm run overlay\n`);
