#!/usr/bin/env node
/**
 * RunSound — Add lyric text overlays to slides
 *
 * Pure-JS version using Jimp (no native deps, works in Replit).
 *
 * Supports TWO text formats in texts.json:
 *   New format: [{headline: "...", body: "..."}, ...]  ← headline large, body small below
 *   Old format: ["slide text", ...]                    ← single text per slide (legacy)
 *
 * Layout (new format):
 *   - Headline: 128px font, centered at ~25% from top (3–5 words, emotional punch)
 *   - Body:      32px font, centered at ~58% from top (6–12 words, supporting emotion)
 *
 * Both texts use white fill + black outline (8-direction shadow).
 *
 * Usage:
 *   node add-text-overlay.js --input <dir> --config <config.json> [--texts <texts.json>]
 */

const Jimp = require('jimp');
const fs   = require('fs');
const path = require('path');

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}
const inputDir   = getArg('input');
const configPath = getArg('config');
const textsPath  = getArg('texts');

if (!inputDir || !configPath) {
  console.error('Usage: node add-text-overlay.js --input <dir> --config <config.json> [--texts <texts.json>]');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// ─── Legacy fallback: build texts from config hookLines ───────────────────────
function buildTextsFromConfig() {
  const { artist, song } = config;
  const hookLines  = song.hookLines || [];
  const songTitle  = song.title     || 'this song';
  const artistName = artist.name    || '';
  const fmt = t => t;
  return [
    { headline: hookLines[0] ? fmt(hookLines[0]) : 'this song has been\nin my head for weeks', body: '' },
    { headline: hookLines[1] ? fmt(hookLines[1]) : 'every single word\nhits different', body: 'when you\'ve been there' },
    { headline: hookLines[2] ? fmt(hookLines[2]) : 'the way this captures\nexactly how it feels', body: 'is actually insane' },
    { headline: hookLines[3] ? fmt(hookLines[3]) : 'how did they\nput this into words', body: 'so perfectly' },
    { headline: hookLines[4] ? fmt(hookLines[4]) : 'okay I\'m actually\nobsessed with this', body: '' },
    { headline: `${songTitle}\nby ${artistName}`, body: 'link in bio' }
  ];
}

// ─── Normalise texts array to [{headline, body}] ──────────────────────────────
function normaliseTexts(raw) {
  return raw.map(entry => {
    if (typeof entry === 'string') {
      // Legacy: single string — treat whole thing as headline, no body
      return { headline: entry, body: '' };
    }
    return { headline: entry.headline || '', body: entry.body || '' };
  });
}

// ─── Font size selection ──────────────────────────────────────────────────────
function pickFontSize(wordCount) {
  if (wordCount <= 4)  return 128;
  if (wordCount <= 12) return 64;
  return 32;
}

// ─── Load jimp font pair ──────────────────────────────────────────────────────
const fontCache = {};
async function loadFont(size, color) {
  const key = `${size}_${color}`;
  if (!fontCache[key]) {
    const constant = `FONT_SANS_${size}_${color}`;
    fontCache[key] = await Jimp.loadFont(Jimp[constant]);
  }
  return fontCache[key];
}

// ─── Print one text block with outline ───────────────────────────────────────
async function printText(image, text, fontSize, yCenter) {
  const { width, height } = image.bitmap;
  const clean = text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1FFFF}]/gu, '')
    .trim();
  if (!clean) return;

  const fontBlack = await loadFont(fontSize, 'BLACK');
  const fontWhite = await loadFont(fontSize, 'WHITE');

  const boxWidth = Math.round(width * 0.78);
  const boxX     = Math.round((width - boxWidth) / 2);

  const lineCount  = clean.split('\n').length;
  const lineHeight = Math.round(fontSize * 1.3);
  const blockH     = lineCount * lineHeight;

  let y = Math.round(yCenter - blockH / 2);
  const minY = Math.round(height * 0.08);
  const maxY = Math.round(height * 0.82) - blockH;
  y = Math.max(minY, Math.min(y, maxY));

  const printOpts = {
    text:       clean,
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
    alignmentY: Jimp.VERTICAL_ALIGN_TOP
  };

  // Black outline (8 directions)
  const outline = Math.max(2, Math.round(fontSize * 0.07));
  const offsets = [
    [-outline, 0], [outline, 0], [0, -outline], [0, outline],
    [-outline, -outline], [outline, -outline], [-outline, outline], [outline, outline]
  ];
  for (const [dx, dy] of offsets) {
    image.print(fontBlack, boxX + dx, y + dy, printOpts, boxWidth);
  }
  // White fill on top
  image.print(fontWhite, boxX, y, printOpts, boxWidth);
}

// ─── Film grain effect ────────────────────────────────────────────────────────
// Adds subtle analogue noise (2–3% intensity) to make slides feel organic.
// Applied after text overlay, before saving.
function addFilmGrain(image, intensity = 0.025) {
  const maxDelta = Math.round(255 * intensity); // ~6 at 2.5%
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function(x, y, idx) {
    // Apply same delta to all three channels → luminance noise (not colour noise)
    const delta = Math.floor(Math.random() * (maxDelta * 2 + 1)) - maxDelta;
    this.bitmap.data[idx]     = Math.max(0, Math.min(255, this.bitmap.data[idx]     + delta));
    this.bitmap.data[idx + 1] = Math.max(0, Math.min(255, this.bitmap.data[idx + 1] + delta));
    this.bitmap.data[idx + 2] = Math.max(0, Math.min(255, this.bitmap.data[idx + 2] + delta));
    // idx+3 = alpha — leave unchanged
  });
}

// ─── Add overlay (headline + body) to one slide ───────────────────────────────
async function addTextOverlay(imgPath, slideText, outPath) {
  const image = await Jimp.read(imgPath);
  const { height } = image.bitmap;

  const headlineRaw = (slideText.headline || '').replace(/\\n/g, '\n');
  const bodyRaw     = (slideText.body     || '').replace(/\\n/g, '\n');

  const headlineWords = headlineRaw.split(/\s+/).length;
  const headlineFontSize = pickFontSize(headlineWords);

  // Headline: centred at 28% from top
  if (headlineRaw.trim()) {
    await printText(image, headlineRaw, headlineFontSize, Math.round(height * 0.28));
  }

  // Body: centred at 62% from top (always 32px — readable but not competing with headline)
  if (bodyRaw.trim()) {
    await printText(image, bodyRaw, 32, Math.round(height * 0.62));
  }

  // Film grain — subtle analogue texture (2.5% intensity)
  addFilmGrain(image, 0.025);

  await image.writeAsync(outPath);
  const hPreview = headlineRaw.replace(/\n/g, ' / ').substring(0, 35);
  const bPreview = bodyRaw.replace(/\n/g, ' / ').substring(0, 35);
  const num = path.basename(outPath, '.png').replace(/\D/g, '');
  console.log(`  ✅ slide${num} — "${hPreview}"${bPreview ? ` | ${bPreview}` : ''}`);
}

// ─── Find slide input file ────────────────────────────────────────────────────
function findSlideFile(dir, num) {
  for (const name of [`slide${num}_raw.png`, `slide_${num}.png`, `slide${num}.png`]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const defaultTextsPath = path.join(inputDir, 'texts.json');
  const resolvedTextsPath = (textsPath && fs.existsSync(textsPath))
    ? textsPath
    : (fs.existsSync(defaultTextsPath) ? defaultTextsPath : null);

  const rawTexts = resolvedTextsPath
    ? JSON.parse(fs.readFileSync(resolvedTextsPath, 'utf-8'))
    : buildTextsFromConfig();

  const texts = normaliseTexts(rawTexts);

  if (texts.length !== 6) {
    console.error('ERROR: Need exactly 6 text entries (one per slide)');
    process.exit(1);
  }

  const isNewFormat = rawTexts[0] && typeof rawTexts[0] === 'object';
  console.log('\n📝 Adding text overlays (jimp / pure-JS)...\n');
  console.log(`Format:   ${isNewFormat ? 'headline + body (new)' : 'single text (legacy)'}`);
  console.log('Fonts:    128px headline / 32px body (white + black outline)');
  console.log('Position: headline at 28%, body at 62% from top');
  console.log('Grain:    2.5% luminance noise (analogue texture)\n');

  // Save texts used for reference / A-B iteration
  fs.writeFileSync(path.join(inputDir, 'texts-used.json'), JSON.stringify(texts, null, 2));

  let success = 0;
  for (let i = 0; i < 6; i++) {
    const num       = i + 1;
    const inputFile = findSlideFile(inputDir, num);
    if (!inputFile) {
      console.error(`  ❌ Slide ${num}: no raw file found in ${inputDir}`);
      continue;
    }
    const outPath = path.join(inputDir, `slide${num}.png`);
    try {
      await addTextOverlay(inputFile, texts[i], outPath);
      success++;
    } catch (err) {
      console.error(`  ❌ Slide ${num} failed: ${err.message}`);
    }
  }

  console.log(`\n✨ ${success}/6 overlays complete!`);
  if (success < 6) process.exit(1);
  console.log('\nNext step: npm run post');
  console.log('  (posts the carousel to TikTok via Postiz)\n');
})();
