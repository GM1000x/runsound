#!/usr/bin/env node
/**
 * add-text-overlay.js — RunSound Text Overlay Engine
 *
 * Burns hook texts onto raw slide images with per-slide style variation,
 * matching what viral TikTok music carousels actually look like:
 *
 *   Slide 1 (hook)      — LARGE + OUTLINE, Bebas Neue, centered
 *   Slide 2-3 (story)   — Medium, Anton, light black bg box
 *   Slide 4-5 (climax)  — Larger, Bebas Neue, outline, bottom-third
 *   Slide 6 (CTA)       — Small/clean, Anton, white + light black bg
 *
 * Font stack:
 *   Bebas Neue  — bold condensed, the "TikTok Display" feel
 *   Anton       — heavy condensed, strong readability
 *
 * Text styles:
 *   outline     — white fill + thick black stroke (high contrast)
 *   lightBg     — semi-transparent black rect behind text block
 *   clean       — plain white, no stroke, small size
 *
 * Reads:  <input>/slide1_raw.png ... slide6_raw.png
 *         <texts> (path to texts.json — array of 6 strings)
 * Writes: <input>/slide1.png ... slide6.png
 *
 * Usage:
 *   node add-text-overlay.js \
 *     --input  runsound-marketing/posts/latest \
 *     --config runsound-marketing/config.json \
 *     --texts  runsound-marketing/posts/latest/texts.json
 *
 * Requires: @napi-rs/canvas
 */

require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; }

const inputDir   = getArg('input');
const configPath = getArg('config');
const textsPath  = getArg('texts');

if (!inputDir || !configPath || !textsPath) {
  console.error('Usage: node add-text-overlay.js --input <dir> --config <config.json> --texts <texts.json>');
  process.exit(1);
}

if (!fs.existsSync(textsPath)) {
  console.error(`texts.json not found: ${textsPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const texts  = JSON.parse(fs.readFileSync(textsPath, 'utf8'));

if (!Array.isArray(texts) || texts.length < 4) {
  console.error(`texts.json must be an array of 4 strings. Got: ${texts.length}`);
  process.exit(1);
}

// ─── Canvas dimensions (TikTok 9:16) ─────────────────────────────────────────
const W = 1080;
const H = 1920;

// ─── Font paths ───────────────────────────────────────────────────────────────
const FONTS_DIR          = path.join(process.cwd(), 'assets', 'fonts');
const FONT_ANTON_PATH    = path.join(FONTS_DIR, 'Anton-Regular.ttf');
const FONT_BEBAS_PATH    = path.join(FONTS_DIR, 'BebasNeue-Regular.ttf');

const FONT_URLS = {
  'Anton-Regular.ttf':   'https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf',
  'BebasNeue-Regular.ttf': 'https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf',
};

// ─── Per-slide style definitions ──────────────────────────────────────────────
//
// All slides: white text + thick black stroke (outline). No background boxes.
// Lowercase throughout — matches what viral TikTok carousels actually look like.
//
// font:     'Anton' (heavy condensed, great for TikTok readability)
// size:     font size in px
// position: 'center' | 'bottom' | 'top'
// vignette: true | false

const SLIDE_STYLES = [
  // Slide 1 — Hook: biggest text, centered, strong vignette
  { font: 'Anton', size: 88, position: 'center', vignette: true,  strokeWidth: 24, shadowBlur: 20 },
  // Slide 2 — Story: slightly smaller, center
  { font: 'Anton', size: 72, position: 'center', vignette: true,  strokeWidth: 20, shadowBlur: 16 },
  // Slide 3 — Peak/punchline: bigger again for emphasis, bottom-third
  { font: 'Anton', size: 82, position: 'bottom', vignette: true,  strokeWidth: 22, shadowBlur: 18 },
  // Slide 4 — CTA: smaller, clean, no vignette
  { font: 'Anton', size: 56, position: 'center', vignette: false, strokeWidth: 18, shadowBlur: 14 },
];

// ─── Download a file (follows redirects) ─────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    function get(u) {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
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
      console.log(' done');
    }
  }
}

// ─── Subtle vignette (darkens edges only) ────────────────────────────────────
function drawVignette(ctx) {
  const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.85);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

// ─── Outline style: white fill + thick black stroke + drop shadow ─────────────
function drawOutlineText(ctx, text, x, y, slideStyle) {
  const strokeWidth = slideStyle.strokeWidth || 22;
  const shadowBlur  = slideStyle.shadowBlur  || 18;

  ctx.shadowColor   = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur    = shadowBlur;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 3;

  ctx.lineWidth   = strokeWidth;
  ctx.strokeStyle = 'rgba(0,0,0,0.95)';
  ctx.lineJoin    = 'round';
  ctx.strokeText(text, x, y);

  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y);

  ctx.shadowColor   = 'transparent';
  ctx.shadowBlur    = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

// ─── Light bg style: semi-transparent dark box + white text ──────────────────
function drawLightBgText(ctx, lines, blockX, blockY, lineHeight, slideStyle) {
  const padX     = slideStyle.bgPadX  || 48;
  const padY     = slideStyle.bgPadY  || 28;
  const opacity  = slideStyle.bgOpacity || 0.55;
  const fontSize = slideStyle.size;

  // Measure widest line
  let maxWidth = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    if (m.width > maxWidth) maxWidth = m.width;
  }

  const totalH   = lines.length * lineHeight;
  const rectX    = blockX - maxWidth / 2 - padX;
  const rectY    = blockY - lineHeight / 2 - padY;
  const rectW    = maxWidth + padX * 2;
  const rectH    = totalH + padY * 2;

  // Rounded rect
  const r = 18;
  ctx.beginPath();
  ctx.moveTo(rectX + r, rectY);
  ctx.lineTo(rectX + rectW - r, rectY);
  ctx.quadraticCurveTo(rectX + rectW, rectY, rectX + rectW, rectY + r);
  ctx.lineTo(rectX + rectW, rectY + rectH - r);
  ctx.quadraticCurveTo(rectX + rectW, rectY + rectH, rectX + rectW - r, rectY + rectH);
  ctx.lineTo(rectX + r, rectY + rectH);
  ctx.quadraticCurveTo(rectX, rectY + rectH, rectX, rectY + rectH - r);
  ctx.lineTo(rectX, rectY + r);
  ctx.quadraticCurveTo(rectX, rectY, rectX + r, rectY);
  ctx.closePath();

  ctx.fillStyle = `rgba(0,0,0,${opacity})`;
  ctx.fill();

  // Draw each line of text
  lines.forEach((line, i) => {
    ctx.shadowColor   = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur    = 8;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, blockX, blockY + i * lineHeight);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur  = 0;
  });
}

// ─── Render one slide ─────────────────────────────────────────────────────────
async function renderSlide(slideIndex, rawPath, text, outPath, canvasModule) {
  const { createCanvas, loadImage } = canvasModule;

  const img        = await loadImage(rawPath);
  const canvas     = createCanvas(W, H);
  const ctx        = canvas.getContext('2d');
  const slideStyle = SLIDE_STYLES[slideIndex] || SLIDE_STYLES[0];

  // 1. Draw background image
  ctx.drawImage(img, 0, 0, W, H);

  // 2. Vignette
  if (slideStyle.vignette) drawVignette(ctx);

  // 3. Parse text lines — always lowercase, matching viral TikTok style
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 4. Font setup
  const fontSize   = slideStyle.size;
  const lineHeight = fontSize * 1.26;
  ctx.font         = `${fontSize}px "${slideStyle.font}"`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // 5. Calculate vertical position
  const totalTextH = lines.length * lineHeight;
  let centerY;
  if (slideStyle.position === 'top') {
    centerY = H * 0.22 + totalTextH / 2;
  } else if (slideStyle.position === 'bottom') {
    centerY = H * 0.75 + totalTextH / 2;
  } else {
    centerY = H / 2 - totalTextH / 2 + lineHeight / 2;
  }

  // 6. Draw: white text + black stroke on all slides
  lines.forEach((line, i) => {
    drawOutlineText(ctx, line, W / 2, centerY + i * lineHeight, slideStyle);
  });

  // 7. Save
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

  await ensureFonts();

  let canvasModule;
  try {
    canvasModule = require('@napi-rs/canvas');
  } catch (e) {
    console.error('❌ @napi-rs/canvas not installed. Run: npm install');
    process.exit(1);
  }

  const { GlobalFonts } = canvasModule;

  if (fs.existsSync(FONT_ANTON_PATH))  GlobalFonts.registerFromPath(FONT_ANTON_PATH,  'Anton');
  if (fs.existsSync(FONT_BEBAS_PATH))  GlobalFonts.registerFromPath(FONT_BEBAS_PATH,  'Bebas Neue');

  let success = 0;

  for (let i = 0; i < 6; i++) {
    const slideNum = i + 1;
    const rawPath  = path.join(inputDir, `slide${slideNum}_raw.png`);
    const outPath  = path.join(inputDir, `slide${slideNum}.png`);
    const text     = texts[i] || '';
    const s        = SLIDE_STYLES[i] || SLIDE_STYLES[0];

    if (!fs.existsSync(rawPath)) {
      console.error(`   ❌ slide${slideNum}_raw.png not found — skipping`);
      continue;
    }

    const preview = text.split('\n')[0].slice(0, 40);
    process.stdout.write(`   Slide ${slideNum}/6 [${s.font} ${s.size}px] — "${preview}"... `);

    try {
      await renderSlide(i, rawPath, text, outPath, canvasModule);
      console.log('✅');
      success++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  console.log(`\n✅ ${success}/6 slides rendered`);
  console.log(`   Styles: Bebas outline on 1,3,5 — Anton lightBg on 2,4,6`);
  console.log(`   Output: ${inputDir}/slide1.png ... slide6.png`);
  console.log(`\n   Next: npm run post\n`);
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
