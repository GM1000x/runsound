#!/usr/bin/env node
/**
 * RunSound — Add lyric text overlays to slides
 *
 * Pure-JS version using Jimp (no native deps, works in Replit).
 * Uses jimp bitmap fonts: 128px (short), 64px (medium), 32px (long).
 * Simulates black outline by printing black at 8 pixel offsets, then white on top.
 *
 * Usage:
 *   node add-text-overlay.js --input <dir> --config <config.json> [--texts <texts.json>]
 *
 * TEXT RULES (Larry-proven):
 *   - Use \n for line breaks
 *   - 4-6 words per line max
 *   - REACTIONS not labels ("Wait this actually hits" not "Sad song")
 *   - Short lines > long lines
 *   - No emoji (bitmap fonts can't render them)
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

// ─── Build 6-slide texts from config hookLines ────────────────────────────────
function formatLine(text) {
  if (text.includes('\n')) return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= 5) return text;
  const lines = [];
  let current = [];
  for (let i = 0; i < words.length; i++) {
    current.push(words[i]);
    if (current.length >= 4 && i < words.length - 1) {
      lines.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) lines.push(current.join(' '));
  return lines.join('\n');
}

function buildTextsFromConfig() {
  const { artist, song } = config;
  const hookLines  = song.hookLines || [];
  const songTitle  = song.title     || 'this song';
  const artistName = artist.name    || '';
  return [
    hookLines[0] ? formatLine(hookLines[0]) : `this song has been\nliving in my head\nfor weeks`,
    hookLines[1] ? formatLine(hookLines[1]) : `every single word\nhits different\nwhen you've been there`,
    hookLines[2] ? formatLine(hookLines[2]) : `the way this captures\nexactly how it feels\nis insane`,
    hookLines[3] ? formatLine(hookLines[3]) : `how did they\nput this into words\nso perfectly`,
    hookLines[4] ? formatLine(hookLines[4]) : `okay I'm actually\nobsessed with\nthis one`,
    `${songTitle}\nby ${artistName}\nlink in bio`
  ];
}

function pickFontSize(wordCount) {
  if (wordCount <= 4)  return 128;
  if (wordCount <= 12) return 64;
  return 32;
}

const fontCache = {};
async function loadFont(size, color) {
  const key = `${size}_${color}`;
  if (!fontCache[key]) {
    const constant = `FONT_SANS_${size}_${color}`;
    fontCache[key] = await Jimp.loadFont(Jimp[constant]);
  }
  return fontCache[key];
}

async function addTextOverlay(imgPath, text, outPath) {
  const image = await Jimp.read(imgPath);
  const { width, height } = image.bitmap;
  const clean = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1FFFF}]/gu, '').trim();
  const wordCount = clean.split(/\s+/).length;
  const fontSize   = pickFontSize(wordCount);
  const fontBlack  = await loadFont(fontSize, 'BLACK');
  const fontWhite  = await loadFont(fontSize, 'WHITE');
  const boxWidth  = Math.round(width * 0.75);
  const boxX      = Math.round((width - boxWidth) / 2);
  const lineCount     = clean.split('\n').length;
  const lineHeight    = Math.round(fontSize * 1.3);
  const estimatedH    = lineCount * lineHeight;
  let y = Math.round(height * 0.28 - estimatedH / 2);
  const minY = Math.round(height * 0.10);
  const maxY = Math.round(height * 0.80) - estimatedH;
  y = Math.max(minY, Math.min(y, maxY));
  const printOpts = { text: clean, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER, alignmentY: Jimp.VERTICAL_ALIGN_TOP };
  const outline = Math.max(2, Math.round(fontSize * 0.08));
  const offsets = [[-outline,0],[outline,0],[0,-outline],[0,outline],[-outline,-outline],[outline,-outline],[-outline,outline],[outline,outline]];
  for (const [dx,dy] of offsets) { image.print(fontBlack, boxX+dx, y+dy, printOpts, boxWidth); }
  image.print(fontWhite, boxX, y, printOpts, boxWidth);
  await image.writeAsync(outPath);
  console.log(`  ✅ slide${path.basename(outPath,'.png').replace(/\D/g,'')} — "${clean.replace(/\n/g,' / ').substring(0,60)}"`);
}

function findSlideFile(dir,num) {
  for (const name of [`slide${num}_raw.png`,`slide_${num}.png`,`slide${num}.png`]) {
    const p=path.join(dir,name); if(fs.existsSync(p)) return p;
  }
  return null;
}

(async () => {
  const texts = (textsPath && fs.existsSync(textsPath)) ? JSON.parse(fs.readFileSync(textsPath,'utf-8')) : buildTextsFromConfig();
  if (texts.length !== 6) { console.error('ERROR: Need exactly 6 text entries'); process.exit(1); }
  console.log('\n📝 Adding lyric overlays (jimp / pure-JS)...\n');
  fs.writeFileSync(path.join(inputDir,'texts-used.json'),JSON.stringify(texts,null,2));
  let success=0;
  for (let i=0;i<6;i++) {
    const num=i+1;
    const inputFile=findSlideFile(inputDir,num);
    if (!inputFile) { console.error(`  ❌ Slide ${num}: not found`); continue; }
    const outPath=path.join(inputDir,`slide${num}.png`);
    try { await addTextOverlay(inputFile,texts[i],outPath); success++; }
    catch(err) { console.error(`  ❌ Slide ${num} failed: ${err.message}`); }
  }
  console.log(`\n✨ ${success}/6 overlays complete!`);
  if (success < 6) process.exit(1);
  console.log('\nNext step: npm run post\n');
})();
