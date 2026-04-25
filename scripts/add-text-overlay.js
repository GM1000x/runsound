#!/usr/bin/env node
/**
 * add-text-overlay.js — RunSound Text Overlay Engine
 *
 * Burns hook texts onto raw slide images with:
 *   - Poppins Bold (headline) + Poppins Regular (body/CTA)
 *   - Dark gradient for readability
 *   - Black stroke outline on text
 *   - Subtle film grain (luminance noise, 2.2% strength)
 *
 * Reads:  <input>/slide1_raw.png ... slide6_raw.png
 *         <texts>   (path to texts.json — array of 6 strings)
 * Writes: <input>/slide1.png ... slide6.png
 *
 * Usage:
 *   node scripts/add-text-overlay.js \
 *     --input  runsound-marketing/posts/2025-01-15 \
 *     --config runsound-marketing/config.json \
 *     --texts  runsound-marketing/posts/2025-01-15/texts.json
 *
 * Requires: @napi-rs/canvas  (already in package.json)
 *           Poppins font files (auto-downloaded if missing)
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; }

const inputDir   = getArg('input');
const configPath = getArg('config');
const textsPath  = getArg('texts');

if (!inputDir || !configPath || !textsPath) {
  console.error('Usage: node scripts/add-text-overlay.js --input <dir> --config <config.json> --texts <texts.json>');
  process.exit(1);
}

if (!fs.existsSync(textsPath)) {
  console.error(`texts.json not found: ${textsPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const texts  = JSON.parse(fs.readFileSync(textsPath, 'utf8'));

if (!Array.isArray(texts) || texts.length < 6) {
  console.error(`texts.json must be an array of 6 strings. Got: ${texts.length}`);
  process.exit(1);
}

// ─── Canvas dimensions (TikTok 9:16) ─────────────────────────────────────────
const W = 1080;
const H = 1920;

// ─── Font paths ───────────────────────────────────────────────────────────────
const FONTS_DIR      = path.join(process.cwd(), 'assets', 'fonts');
const FONT_BOLD_PATH = path.join(FONTS_DIR, 'Poppins-Bold.ttf');
const FONT_REG_PATH  = path.join(FONTS_DIR, 'Poppins-Regular.ttf');

const FONT_URLS = {
  'Poppins-Bold.ttf':    'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf',
  'Poppins-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Regular.ttf',
};

// ─── Download a file ──────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    // Follow redirects
    function get(u) {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

// ─── Ensure fonts are available ───────────────────────────────────────────────
async function ensureFonts() {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  for (const [filename, url] of Object.entries(FONT_URLS)) {
    const dest = path.join(FONTS_DIR, filename);
    if (!fs.existsSync(dest)) {
      process.stdout.write(`   Downloading ${filename}...`);
      await downloadFile(url, dest);
      console.log(' ✅');
    }
  }
}

// ─── Film grain ────────────────────────────────────────────────────────────────
function addFilmGrain(ctx, strength = 0.022) {
  const imageData = ctx.getImageData(0, 0, W, H);
  const data      = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 2 * 255 * strength;
    data[i]     = Math.max(0, Math.min(255, data[i]     + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);
}

// ─── Gradient overlay for text readability ────────────────────────────────────
function drawGradient(ctx, position) {
  if (position === 'bottom') {
    const grad = ctx.createLinearGradient(0, H * 0.45, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  } else if (position === 'center') {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,    'rgba(0,0,0,0.3)');
    grad.addColorStop(0.35, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.65, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1,    'rgba(0,0,0,0.3)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  } else { // top
    const grad = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    grad.addColorStop(0, 'rgba(0,0,0,0.8)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
}

// ─── Draw text with stroke ────────────────────────────────────────────────────
function drawStrokedText(ctx, text, x, y, strokeWidth = 8) {
  ctx.lineWidth   = strokeWidth * 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.lineJoin    = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

// ─── Detect if a slide is a CTA (last slide) ─────────────────────────────────
function detectPosition(text, slideIndex) {
  if (slideIndex === 5) return 'center'; // CTA slide
  if (slideIndex === 0) return 'bottom'; // Hook slide — text near bottom
  return 'bottom';
}

// ─── Render one slide ─────────────────────────────────────────────────────────
async function renderSlide(canvas, createCanvas, loadImage, registerFont, slideIndex, rawPath, text, outPath) {
  // Load raw image
  const img = await loadImage(rawPath);
  const ctx = canvas.getContext('2d');

  // Draw background image
  ctx.drawImage(img, 0, 0, W, H);

  // Determine text position
  const position = detectPosition(text, slideIndex);

  // Draw gradient
  drawGradient(ctx, position);

  // Parse text: first line(s) = headline, last line after blank = body (if any)
  const lines = text.split('\n').map(l => l.trim());

  // Split into headline lines and optional body
  // Body is recognised as: last 1-2 lines that are italic-style or follow emoji
  let headlineLines = lines;
  let bodyLines     = [];

  // Heuristic: if text has 4+ lines, treat last line as body
  if (lines.length >= 4) {
    bodyLines     = [lines[lines.length - 1]];
    headlineLines = lines.slice(0, lines.length - 1);
  }

  // Font sizes
  const headlineFontSize = slideIndex === 5 ? 72 : 90;  // CTA slide slightly smaller
  const bodyFontSize     = 46;
  const lineHeight       = headlineFontSize * 1.12;
  const bodyLineHeight   = bodyFontSize * 1.3;

  // Total text block height
  const totalH = headlineLines.length * lineHeight +
                 (bodyLines.length > 0 ? bodyLineHeight + 20 : 0);

  // Y anchor
  let startY;
  if (position === 'bottom') {
    startY = H - 220 - totalH;
  } else {
    startY = H / 2 - totalH / 2;
  }

  // Draw headline
  registerFont(FONT_BOLD_PATH, { family: 'Poppins', weight: 'bold' });
  ctx.font      = `bold ${headlineFontSize}px Poppins`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  headlineLines.forEach((line, i) => {
    drawStrokedText(ctx, line, W / 2, startY + i * lineHeight, 9);
  });

  // Draw body
  if (bodyLines.length > 0) {
    registerFont(FONT_REG_PATH, { family: 'Poppins', weight: 'normal' });
    ctx.font      = `${bodyFontSize}px Poppins`;
    ctx.fillStyle = 'rgba(230,230,230,0.95)';

    const bodyStartY = startY + headlineLines.length * lineHeight + 20;
    bodyLines.forEach((line, i) => {
      drawStrokedText(ctx, line, W / 2, bodyStartY + i * bodyLineHeight, 5);
    });
  }

  // Film grain
  addFilmGrain(ctx);

  // Save
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buffer);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎨 RunSound — Text Overlay');
  console.log('===========================');
  console.log(`   Input:  ${inputDir}`);
  console.log(`   Texts:  ${textsPath}`);
  console.log('');

  // Ensure fonts
  await ensureFonts();

  // Dynamic import of @napi-rs/canvas
  let canvasModule;
  try {
    canvasModule = require('@napi-rs/canvas');
  } catch (e) {
    console.error('❌ @napi-rs/canvas not installed. Run: npm install');
    process.exit(1);
  }

  const { createCanvas, loadImage, GlobalFonts } = canvasModule;

  // Register fonts
  if (fs.existsSync(FONT_BOLD_PATH)) {
    GlobalFonts.registerFromPath(FONT_BOLD_PATH, 'Poppins');
  }
  if (fs.existsSync(FONT_REG_PATH)) {
    GlobalFonts.registerFromPath(FONT_REG_PATH, 'Poppins');
  }

  const registerFont = () => {}; // fonts registered globally above

  let success = 0;

  for (let i = 0; i < 6; i++) {
    const slideNum = i + 1;
    const rawPath  = path.join(inputDir, `slide${slideNum}_raw.png`);
    const outPath  = path.join(inputDir, `slide${slideNum}.png`);
    const text     = texts[i] || '';

    if (!fs.existsSync(rawPath)) {
      console.error(`   ❌ ${path.basename(rawPath)} not found — skipping`);
      continue;
    }

    process.stdout.write(`   Slide ${slideNum}/6 — "${text.split('\n')[0].slice(0, 40)}"... `);

    try {
      const canvas = createCanvas(W, H);
      await renderSlide(canvas, createCanvas, loadImage, registerFont, i, rawPath, text, outPath);
      console.log('✅');
      success++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  console.log(`\n✅ ${success}/6 slides rendered`);
  console.log(`   Output: ${inputDir}/slide1.png ... slide6.png`);
  console.log(`\n   Next: npm run post\n`);
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
