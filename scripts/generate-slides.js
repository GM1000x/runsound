#!/usr/bin/env node
/**
 * RunSound — Generate 6 TikTok slideshow images
 *
 * Generates 6 portrait images (1024x1536) using gpt-image-1.5.
 * Each slide shares the same base aesthetic but varies in style/mood
 * to create a cohesive 6-slide story around the song.
 *
 * Usage: node generate-slides.js --config runsound-marketing/config.json --output runsound-marketing/posts/YYYY-MM-DD-HHmm
 *
 * Auto-generates prompts from config if no --prompts file provided.
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const configPath = getArg('config');
const outputDir = getArg('output') || `runsound-marketing/posts/${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}`;
const promptsPath = getArg('prompts');

if (!configPath) {
  console.error('Usage: node generate-slides.js --config runsound-marketing/config.json --output runsound-marketing/posts/latest');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// ⚠️ Model safety check
if (config.imageGen?.model && !config.imageGen.model.includes('1.5')) {
  console.warn(`\n⚠️  WARNING: Model is "${config.imageGen.model}"`);
  console.warn(`   ALWAYS use "gpt-image-1.5" — other versions produce obviously AI-looking images.`);
  console.warn(`   Fix in config.json: "model": "gpt-image-1.5"\n`);
}

// Resolve API key from env if needed
const rawApiKey = config.imageGen.apiKey || '';
const apiKey = rawApiKey.startsWith('sk-')
  ? rawApiKey
  : (process.env[rawApiKey] || process.env.OPENAI_API_KEY || rawApiKey);

const openai = new OpenAI({ apiKey });
fs.mkdirSync(outputDir, { recursive: true });

// ─── Load AI strategy (feedback loop) ────────────────────────────────────────
function loadStrategy(projectDir) {
  const strategyPath = path.join(projectDir, 'strategy.json');
  if (fs.existsSync(strategyPath)) {
    try {
      const strategy = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
      console.log(`\n🧠 Strategy loaded (diagnosis: ${strategy.diagnosis})`);
      console.log(`   Hook angle: ${strategy.hookAngle}`);
      console.log(`   Visual: ${strategy.visualDirection}`);
      console.log(`   CTA: "${strategy.cta}"\n`);
      return strategy;
    } catch {
      return null;
    }
  }
  console.log('ℹ️  No strategy.json found — using default prompts');
  return null;
}

// ─── Auto-generate prompts from config + strategy ────────────────────────────
function buildPrompts(config, strategy) {
  const { artist, song, imageGen } = config;
  const base = imageGen.basePrompt;
  const mood = artist.mood || 'atmospheric';
  const genre = artist.genre || 'pop';

  // If we have an optimized strategy, use it
  const visualDirection = strategy?.visualDirection || '';
  const hookAngle = strategy?.hookAngle || `${mood} and emotionally direct`;
  const cta = strategy?.cta || 'Stream now — link in bio';

  // 6-slide story arc for music:
  // 1. HOOK     — emotional opening scene
  // 2. TENSION  — the feeling builds
  // 3. PEAK     — most intense moment
  // 4. RELEASE  — emotional exhale
  // 5. AFTERMATH — after the moment
  // 6. CTA      - artist/song identity shot

  const styleVariations = [
    // Slide 1 — Hook: catch attention in 1 second
    `${base} ${visualDirection} Golden hour light, long shadows. Opening frame — ${hookAngle}. Cinematic portrait.`,
    // Slide 2 — Tension: build the feeling
    `${base} ${visualDirection} Close-up detail, dramatic contrast. Intimate and tense. ${mood} atmosphere building.`,
    // Slide 3 — Peak: the emotional climax
    `${base} ${visualDirection} Wide dramatic shot, raw and honest. The emotional peak. ${hookAngle}.`,
    // Slide 4 — Release: exhale
    `${base} ${visualDirection} Soft focus, warm light. The moment after the intensity. A breath of release.`,
    // Slide 5 — Aftermath: feeling lingers
    `${base} ${visualDirection} Still and quiet. ${genre} aesthetic, evocative. The feeling settling.`,
    // Slide 6 — CTA: clean identity shot
    `${base} Clean, centred composition. Minimal and striking. Visual identity of the song. Text on screen: "${cta}"`
  ];

  return {
    base,
    strategy: strategy ? { hookAngle, visualDirection, cta } : null,
    slides: styleVariations
  };
}

// ─── Generate one image via OpenAI ───────────────────────────────────────────
async function generateOpenAI(prompt, outPath) {
  const res = await openai.images.generate({
    model: config.imageGen.model || 'gpt-image-1.5',
    prompt,
    n: 1,
    size: '1024x1536',
    quality: 'high',
    response_format: 'b64_json'
  });

  if (res.data[0].b64_json) {
    fs.writeFileSync(outPath, Buffer.from(res.data[0].b64_json, 'base64'));
  } else {
    throw new Error('No image data returned from OpenAI');
  }
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 2, delayMs = 3000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < retries) {
        console.log(`  ⚠️ Error: ${e.message}. Retrying (${attempt + 1}/${retries})...`);
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
      } else {
        throw e;
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const projectDir = path.dirname(configPath);
  const strategy = loadStrategy(projectDir);

  const prompts = promptsPath && fs.existsSync(promptsPath)
    ? JSON.parse(fs.readFileSync(promptsPath, 'utf-8'))
    : buildPrompts(config, strategy);

  if (!prompts.slides || prompts.slides.length !== 6) {
    console.error('ERROR: Need exactly 6 slide prompts');
    process.exit(1);
  }

  console.log(`\n🏬 Generating 6 slides for "${config.song.title}" by ${config.artist.name}`);
  console.log(`   Model: ${config.imageGen.model || 'gpt-image-1.5'}`);
  console.log(`   Output: ${outputDir}`);
  console.log(`   ⏱  Takes 3–9 minutes total (30–90s per slide)\n`);

  // Save prompts used for this run (for iteration reference)
  fs.writeFileSync(
    path.join(outputDir, 'prompts-used.json'),
    JSON.stringify(prompts, null, 2)
  );

  let success = 0;
  let skipped = 0;

  for (let i = 0; i < 6; i++) {
    const outPath = path.join(outputDir, `slide${i + 1}_raw.png`);

    // Resume: skip already-generated slides
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
      console.log(`  ⏭`  slide${i + 1}_raw.png already exists, skipping`);
      success++;
      skipped++;
      continue;
    }

    const fullPrompt = `${prompts.base}\n\n${prompts.slides[i]}`;

    try {
      console.log(`  Generating slide ${i + 1}/6...`);
      await withRetry(() => generateOpenAI(fullPrompt, outPath));
      console.log(`  ✅ slide${i + 1}_raw.png`);
      success++;
    } catch (e) {
      console.error(`  ❌ Slide ${i + 1} failed: ${e.message}`);
      console.error(`      Re-run to retry — completed slides will be skipped.`);
    }
  }

  console.log(`\n✨ ${success}/6 slides generated in ${outputDir}`);
  if (skipped > 0) console.log(`   (${skipped} skipped — already existed)`);

  if (success < 6) {
    console.error(`\n⚠️  ${6 - success} slides failed. Re-run to retry.`);
    process.exit(1);
  }

  // Save post metadata
  const meta = {
    artist: config.artist.name,
    song: config.song.title,
    generatedAt: new Date().toISOString(),
    outputDir,
    model: config.imageGen.model,
    hookTimestamp: config.song.hookTimestamp
  };
  fs.writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify(meta, null, 2));

  console.log(`\nNext step: npm run overlay`);
  console.log(`  (adds lyric text to each slide)\n`);
})();
