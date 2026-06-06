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

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

// ─── Supabase client — used to restore image library after Railway redeploys ───
let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
} catch { /* Supabase not available — will fail gracefully below */ }

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
  { slot: 1, role: 'hook',    tags: ['dramatic', 'striking', 'cinematic', 'lifestyle', 'candid'] },
  { slot: 2, role: 'build',   tags: ['intimate', 'warm', 'moody', 'romantic', 'real'] },
  { slot: 3, role: 'story',   tags: ['emotional', 'pensive', 'quiet', 'candid', 'real'] },
  { slot: 4, role: 'peak',    tags: ['emotional', 'golden', 'soft', 'atmospheric', 'silhouette'] },
  { slot: 5, role: 'release', tags: ['still', 'calm', 'open', 'light', 'space'] },
  { slot: 6, role: 'cta',     tags: ['clean', 'minimal', 'cozy', 'still', 'aesthetic'] },
];

// ─── Restore image library from Supabase Storage ─────────────────────────────
// Called when local image-library directory is missing (e.g. after Railway redeploy).
// Downloads manifest + all images from artist-images/{campaignId}/library/.
async function restoreLibraryFromStorage(libraryDir) {
  const campaignId = config.campaign?.id;
  if (!supabase || !campaignId) return false;

  console.log(`☁️  Local library missing — restoring from Supabase Storage...`);

  // Download manifest
  const { data: manifestBlob, error: manifestErr } = await supabase.storage
    .from('artist-images')
    .download(`${campaignId}/library/manifest.json`);

  if (manifestErr || !manifestBlob) {
    console.warn(`   ⚠️  No manifest found in Storage: ${manifestErr?.message || 'not found'}`);
    return false;
  }

  const manifest = JSON.parse(await manifestBlob.text());
  if (!manifest.images?.length) return false;

  fs.mkdirSync(libraryDir, { recursive: true });

  let downloaded = 0;
  for (const img of manifest.images) {
    const storagePath = `${campaignId}/library/${img.file}`;
    const { data, error } = await supabase.storage.from('artist-images').download(storagePath);
    if (error || !data) { console.warn(`   ⚠️  ${img.file}: ${error?.message}`); continue; }
    fs.writeFileSync(path.join(libraryDir, img.file), Buffer.from(await data.arrayBuffer()));
    downloaded++;
    process.stdout.write('.');
  }

  // Write library.json (strip publicUrl, keep file/safeZone/tags)
  const libraryMeta = {
    ...manifest,
    images: manifest.images.map(({ publicUrl, ...rest }) => rest),
  };
  fs.writeFileSync(path.join(libraryDir, 'library.json'), JSON.stringify(libraryMeta, null, 2));

  console.log(`\n   ✅ Restored ${downloaded}/${manifest.images.length} images`);
  return downloaded > 0;
}

// ─── Load image library ───────────────────────────────────────────────────────
async function loadLibrary() {
  const libraryDir = path.join(projectDir, 'image-library');
  if (!fs.existsSync(libraryDir) || fs.readdirSync(libraryDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).length === 0) {
    const restored = await restoreLibraryFromStorage(libraryDir);
    if (!restored) {
      console.error(`❌ Image library not found: ${libraryDir}`);
      console.error('   Run "npm run library" first to generate the image library.');
      process.exit(1);
    }
  }

  // Load safeZone metadata from library.json if available
  const libraryMeta = (() => {
    const p = path.join(libraryDir, 'library.json');
    try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; } catch { return {}; }
  })();
  const safeZoneMap = {};
  for (const img of (libraryMeta.images || [])) {
    if (img.file && img.safeZone) safeZoneMap[img.file] = img.safeZone;
  }

  const images = fs.readdirSync(libraryDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => {
      const full   = path.join(libraryDir, f);
      const base   = path.basename(f, path.extname(f));
      const tags   = base.replace(/^img[-_]\d+[-_]?/, '').split(/[-_]/).filter(Boolean);
      return { file: f, path: full, tags, safeZone: safeZoneMap[f] || 'bottom' };
    });

  if (images.length < 1) {
    console.error(`❌ No images in library.`);
    console.error('   Run "npm run library" to generate images.');
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

// ─── Pick 4 images using arc-position logic ───────────────────────────────────
// ALWAYS uses each image only once when the library has enough unique images.
// Falls back to duplicates only if library has fewer images than arc slots.
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
  const hasEnoughUnique = library.length >= ARC_ROLES.length;

  for (const arcRole of ARC_ROLES) {
    const scored = library
      .map((img, idx) => {
        let score = scoreImage(img, arcRole, recentlyUsed);
        if (usedIdx.has(idx)) {
          // Enough unique images → hard block reuse (-9999 = effectively impossible)
          // Too few images → soft penalty only (-60), allow reuse as last resort
          score += hasEnoughUnique ? -9999 : -60;
        }
        return { img, idx, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (hasEnoughUnique && usedIdx.has(best.idx)) {
      console.warn(`   ⚠️  Slide ${arcRole.slot} [${arcRole.role}]: forced to reuse image — library may have fewer than ${ARC_ROLES.length} unique images`);
    }
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
async function main() {
  console.log('\n🎨 RunSound — Pick Slides');
  console.log('==========================');
  console.log(`   Config:  ${configPath}`);
  console.log(`   Output:  ${outputDir}`);

  const library = await loadLibrary();
  const history = loadPickHistory();
  const picks   = pickSlides(library, history);

  copySlides(picks, outputDir);
  updateMeta(picks, outputDir, config);

  history.picks.push({
    usedAt: new Date().toISOString(),
    files:  picks.map(p => p.file),
    output: outputDir,
  });
  savePickHistory(history);

  console.log(`\n✅ ${picks.length} slides copied to ${outputDir}`);
  console.log(`   Next: npm run texts\n`);
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
