#!/usr/bin/env node
/**
 * pick-slides.js — RunSound Slide Picker
 *
 * Selects 6 images from the campaign's image library and copies them
 * to the output directory as slide1_raw.png ... slide6_raw.png.
 *
 * Smart rotation: tracks which images were used recently so the same
 * photo never appears in back-to-back posts. Images used in the last
 * 7 days are deprioritised unless the library is too small.
 *
 * Arc-position logic: assigns each slide a narrative role
 * (hook → tension → peak → release → aftermath → cta) and picks
 * images whose tags best match each role when tag data is available.
 *
 * Usage:
 *   node scripts/pick-slides.js --config <config.json> --output <dir>
 *
 * Output:
 *   <output>/slide1_raw.png … slide6_raw.png
 *   <output>/meta.json  (updated with picks)
 *   <output>/picks.json (which images were chosen and why)
 */

const fs   = require('fs');
const path = require('path');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i+1] : null; }

const configPath = getArg('config');
const outputDir  = getArg('output');

if (!configPath || !outputDir) {
  console.error('Usage: node scripts/pick-slides.js --config <config.json> --output <dir>');
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);

fs.mkdirSync(outputDir, { recursive: true });

// ─── Arc roles — the 6-slide narrative structure ──────────────────────────────
const ARC_ROLES = [
  { slot: 1, role: 'hook',      tags: ['dramatic', 'striking', 'attention', 'bold', 'cinematic'] },
  { slot: 2, role: 'tension',   tags: ['moody', 'dark', 'intense', 'close', 'intimate'] },
  { slot: 3, role: 'peak',      tags: ['emotional', 'peak', 'raw', 'wide', 'powerful'] },
  { slot: 4, role: 'release',   tags: ['soft', 'warm', 'light', 'gentle', 'golden'] },
  { slot: 5, role: 'aftermath', tags: ['quiet', 'still', 'dreamy', 'atmospheric', 'hazy'] },
  { slot: 6, role: 'cta',       tags: ['clean', 'minimal', 'identity', 'brand', 'clear'] },
];

// ─── Load image library ───────────────────────────────────────────────────────
function loadLibrary() {
  const libraryDir = path.join(projectDir, 'image-library');
  if (!fs.existsSync(libraryDir)) {
    console.error(`❌ Image library not found: ${libraryDir}`);
    console.error('   Run "npm run library" first to generate the image library.');
    process.exit(1);
  }

  const images = fs.readdirSync(libraryDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => {
      const full   = path.join(libraryDir, f);
      const base   = path.basename(f, path.extname(f));
      // Tag format: img-001_golden_moody_cinematic.png → tags from underscores
      const tags   = base.replace(/^img[-_]\d+[-_]?/, '').split(/[-_]/).filter(Boolean);
      return { file: f, path: full, tags };
    });

  if (images.length < 6) {
    console.error(`❌ Not enough images in library: ${images.length} (need ≥6)`);
    console.error('   Run "npm run library" to add more images.');
    process.exit(1);
  }

  console.log(`📚 Image library: ${images.length} images`);
  return images;
}

// ─── Load pick history (to avoid repeating recent images) ─────────────────────
function loadPickHistory() {
  const histPath = path.join(projectDir, 'pick-history.json');
  if (fs.existsSync(histPath)) {
    try { return JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch {}
  }
  return { picks: [] };
}

function savePickHistory(history) {
  const histPath = path.join(projectDir, 'pick-history.json');
  // Keep last 30 days of history
  const cutoff   = Date.now() - 30 * 24 * 60 * 60 * 1000;
  history.picks  = history.picks.filter(p => new Date(p.usedAt).getTime() > cutoff);
  fs.writeFileSync(histPath, JSON.stringify(history, null, 2));
}

// ─── Score an image for a given arc slot ──────────────────────────────────────
function scoreImage(image, arcRole, recentlyUsed) {
  let score = 100;

  // Penalise recently-used images
  const usedDaysAgo = recentlyUsed[image.file];
  if (usedDaysAgo !== undefined) {
    if (usedDaysAgo < 3) score -= 80;       // used in last 3 days → strongly avoid
    else if (usedDaysAgo < 7) score -= 40;  // used in last 7 days → deprioritise
    else if (usedDaysAgo < 14) score -= 10; // used in last 14 days → slight penalty
  }

  // Boost if image tags match arc role tags
  const imageTags = image.tags.map(t => t.toLowerCase());
  const roleTags  = arcRole.tags.map(t => t.toLowerCase());
  const matches   = imageTags.filter(t => roleTags.includes(t)).length;
  score += matches * 15;

  // Small random jitter to avoid always picking same order
  score += Math.random() * 10;

  return score;
}

// ─── Pick 6 images using arc-position logic ───────────────────────────────────
function pickSlides(library, history) {
  // Build recently-used map: filename → days ago
  const recentlyUsed = {};
  const now          = Date.now();
  for (const pick of history.picks) {
    const daysAgo = (now - new Date(pick.usedAt).getTime()) / (1000 * 60 * 60 * 24);
    for (const f of (pick.files || [])) {
      if (recentlyUsed[f] === undefined || daysAgo < recentlyUsed[f]) {
        recentlyUsed[f] = daysAgo;
      }
    }
  }

  const chosen  = [];
  const usedIdx = new Set();

  for (const arcRole of ARC_ROLES) {
    // Score all unused images for this arc slot
    const scored = library
      .map((img, idx) => ({ img, idx, score: usedIdx.has(idx) ? -999 : scoreImage(img, arcRole, recentlyUsed) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    chosen.push({ slot: arcRole.slot, role: arcRole.role, ...best.img, score: best.score });
    usedIdx.add(best.idx);
  }

  return chosen;
}

// ─── Copy images to output dir ────────────────────────────────────────────────
function copySlides(picks, outputDir) {
  console.log('\n📋 Slide picks:');
  for (const pick of picks) {
    const dest = path.join(outputDir, `slide${pick.slot}_raw.png`);
    fs.copyFileSync(pick.path, dest);
    console.log(`   Slide ${pick.slot} [${pick.role.padEnd(9)}] ${pick.file}`);
  }
}

// ─── Update meta.json ─────────────────────────────────────────────────────────
function updateMeta(picks, outputDir, config) {
  const metaPath = path.join(outputDir, 'meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }

  meta.artist      = config.artist?.name;
  meta.song        = config.song?.title;
  meta.pickedAt    = new Date().toISOString();
  meta.outputDir   = outputDir;
  meta.model       = config.imageGen?.model || 'gpt-image-1.5';
  meta.slideCount  = picks.length;

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Save picks detail
  const picksPath = path.join(outputDir, 'picks.json');
  fs.writeFileSync(picksPath, JSON.stringify({ pickedAt: meta.pickedAt, picks }, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n🎨 RunSound — Pick Slides');
console.log('==========================');
console.log(`   Config:  ${configPath}`);
console.log(`   Output:  ${outputDir}`);

const library = loadLibrary();
const history = loadPickHistory();
const picks   = pickSlides(library, history);

copySlides(picks, outputDir);
updateMeta(picks, outputDir, config);

// Save pick history
history.picks.push({
  usedAt: new Date().toISOString(),
  files:  picks.map(p => p.file),
  output: outputDir,
});
savePickHistory(history);

console.log(`\n✅ 6 slides copied to ${outputDir}`);
console.log(`   Next: npm run texts\n`);
