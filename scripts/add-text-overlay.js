#!/usr/bin/env node
/**
 * RunSound — Add lyric text overlays to slides
 *
 * Identical to Larry's proven overlay script with RunSound-specific defaults.
 * Uses node-canvas to render white text with black outline on each slide.
 *
 * Usage: node add-text-overlay.js --input runsound-marketing/posts/latest --config runsound-marketing/config.json
 *
 * Auto-uses hookLines from config if no --texts file provided.
 * Text is positioned at 28% from top — above the TikTok UI safe zone.
 *
 * TEXT RULES (from Larry — proven on 1M+ views):
 *   - Use \n for line breaks
 *   - 4-6 words per line max
 *   - REACTIONS not labels ("Wait... this actually hits" not "Sad song")
 *   - No emoji (canvas can't render them)
 *   - Short lines > long lines
 */

const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputDir = getArg('input');
const configPath = getArg('config');
const textsPath = getArg('texts');

if (!inputDir || !configPath) {
  console.error('Usage: node add-text-overlay.js --input <dir> --config <config.json> [--texts <texts.json>]');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

function buildTextsFromConfig(config) {
  const { artist, song } = config;
  const hookLines = song.hookLines || [];
  const songTitle = song.title || 'this song';
  const artistName = artist.name || '';
  const texts = [
    hookLines[0] ? formatLine(hookLines[0]) : `this song has been\nliving in my head\nfor weeks`,
    hookLines[1] ? formatLine(hookLines[1]) : `every single word\nhits different\nwhen you've been there`,
    hookLines[2] ? formatLine(hookLines[2]) : `the way this captures\nexactly how it feels\nis insane`,
    hookLines[3] ? formatLine(hookLines[3]) : `how did they\nput this into words\nso perfectly`,
    hookLines[4] ? formatLine(hookLines[4]) : `okay I'm actually\nobsessed with\nthis one`,
    `${songTitle}\nby ${artistName}\nlink in bio`
  ];
  return texts;
}

function formatLine(text) {
  if (text.includes('\n')) return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= 5) return text;
  const lines = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= 4 && words.indexOf(word) < words.length - 1) {
      lines.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) lines.push(current.join(' '));
  return lines.join('\n');
}

function wrapText(ctx, text, maxWidth) {
  const cleanText = text.replace(/[\u{1F300}-\u{1FACF}\u{2600}-\u{27BF}]/gu, '').trim();
  const manualLines = cleanText.split('\n');
  const wrappedLines = [];
  for (const line of manualLines) {
    if (ctx.measureText(line.trim()).width <= maxWidth) {
      wrappedLines.push(line.trim());
      continue;
    }
    const words = line.trim().split(/\s+/);
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(testLine).width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) wrappedLines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) wrappedLines.push(currentLine);
  }
  return wrappedLines;
}

amasync function addTextOverlay(imgPath, text, outPath) {
  const img = await loadImage(imgPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const wordCount = text.split(/\s+/).length;
  let fontSizePercent;
  if (wordCount <= 5) fontSizePercent = 0.075;
  else if (wordCount <= 12) fontSizePercent = 0.065;
  else fontSizePercent = 0.050;
  const fontSize = Math.round(img.width * fontSizePercent);
  const outlineWidth = Math.round(fontSize * 0.15);
  const maxWidth = img.width * 0.75;
  const lineHeight = fontSize * 1.3;
  ctx.font = `bold ${fontSize}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lines = wrapText(ctx, text, maxWidth);
  const totalHeight = lines.length * lineHeight;
  const startY = (img.height * 0.28) - (totalHeight / 2);
  const minY = img.height * 0.10;
  const maxY = img.height * 0.80 - totalHeight;
  const safeY = Math.max(minY, Math.min(startY, maxY));
  const x = img.width / 2;
  for (let i = 0; i < lines.length; i++) {
    const y = safeY + (i * lineHeight);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = outlineWidth;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(lines[i], x, y);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(lines[i], x, y);
  }
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`  ✅ ${path.basename(outPath)} - ${lines.length} lines`);
}

function findSlideFile(dir, num) {
  const candidates = [`slide${num}_raw.png`, `slide_${num}.png`, `slide${num}.png`];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

(async () => {
  const texts = textsPath && fs.existsSync(textsPath)
    ? JSON.parse(fs.readFileSync(textsPath, 'utf-8'))
    : buildTextsFromConfig(config);
  if (texts.length !== 6) { console.error('ERROR: Need 6 texts'); process.exit(1); }
  let success = 0;
  for (let i = 0; i < 6; i++) {
    const inputFile = findSlideFile(inputDir, i + 1);
    if (!inputFile) { console.error(`Slide ${i + 1} not found`); continue; }
    await addTextOverlay(inputFile, texts[i], path.join(inputDir, `slide${i + 1}.png`));
    success++;
  }
  console.log(`${success}/6 overlays done`);
})();
