#!/usr/bin/env node
/**
 * build-image-library.js — RunSound Image Library Generator
 *
 * Generates a set of AI images for a campaign using OpenAI's image API.
 * Images are generated ONCE per campaign (or when the artist swaps a song)
 * and then reused daily by pick-slides.js. This keeps the daily run cost at $0.
 *
 * Arc-aware generation: produces images for each narrative role
 * (hook, tension, peak, release, aftermath, cta) so pick-slides.js
 * can match images to the right slide position.
 *
 * Image naming convention:
 *   img-001_hook_dramatic_cinematic.png
 *   img-002_tension_moody_dark.png
 *   ...
 * Tags in the filename are read by pick-slides.js for arc-matching.
 *
 * Usage:
 *   node scripts/build-image-library.js --config <config.json>
 *   node scripts/build-image-library.js --config <config.json> --count 18
 *   node scripts/build-image-library.js --config <config.json> --force
 *
 * Options:
 *   --count N     Total images to generate (default: 18, 3 per arc role)
 *   --force       Regenerate even if library already exists
 *   --dry-run     Show prompts without generating
 *
 * Cost: ~$0.04/image with gpt-image-1 (standard quality, 1024x1792)
 *       18 images ≈ $0.72 per campaign swap
 *
 * Requires: OPENAI_API_KEY in .env
 */

require('dotenv').config();

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const OpenAI  = require('openai');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; }

const configPath = getArg('config');
const COUNT      = parseInt(getArg('count') || '18', 10);
const FORCE      = args.includes('--force');
const DRY_RUN    = args.includes('--dry-run');

if (!configPath) {
  console.error('Usage: node scripts/build-image-library.js --config <config.json>');
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);
const libraryDir = path.join(projectDir, 'image-library');

const artist = config.artist?.name   || 'Unknown Artist';
const song   = config.song?.title    || 'Unknown Song';
const genre  = config.song?.genre    || 'indie pop';
const mood   = config.song?.mood     || 'emotional, nostalgic';
const style  = config.imageGen?.style || 'cinematic photography, moody, film grain, 35mm';
const extra  = config.imageGen?.extraPrompt || '';

// ─── Arc roles — mirrors pick-slides.js ───────────────────────────────────────
const ARC_ROLES = [
  {
    role: 'hook',
    tags: ['hook', 'dramatic', 'cinematic'],
    prompt: 'striking, attention-grabbing, bold composition, first frame energy',
  },
  {
    role: 'tension',
    tags: ['tension', 'moody', 'dark'],
    prompt: 'moody, dark atmosphere, close and intimate, building emotion',
  },
  {
    role: 'peak',
    tags: ['peak', 'emotional', 'powerful'],
    prompt: 'peak emotional moment, raw and powerful, wide shot or dramatic close-up',
  },
  {
    role: 'release',
    tags: ['release', 'warm', 'golden'],
    prompt: 'soft light, warm golden tones, sense of release and relief',
  },
  {
    role: 'aftermath',
    tags: ['aftermath', 'dreamy', 'atmospheric'],
    prompt: 'quiet aftermath, dreamy and atmospheric, hazy light, stillness',
  },
  {
    role: 'cta',
    tags: ['cta', 'clean', 'minimal'],
    prompt: 'clean minimal composition, strong identity feel, clear and calm',
  },
];

// ─── Build image prompt for a given arc role ───────────────────────────────────
function buildPrompt(arcRole) {
  return [
    `${style}.`,
    `${arcRole.prompt}.`,
    `Mood: ${mood}.`,
    `Genre aesthetic: ${genre}.`,
    `No text, no words, no watermarks, no people looking directly at camera.`,
    `Portrait orientation (9:16), suitable for TikTok/Instagram.`,
    extra,
  ].filter(Boolean).join(' ');
}

// ─── Download a URL to a file ─────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// ─── Generate one image ────────────────────────────────────────────────────────
async function generateImage(openai, prompt, arcRole, index) {
  const tags     = arcRole.tags.join('_');
  const filename = `img-${String(index).padStart(3, '0')}_${tags}.png`;
  const destPath = path.join(libraryDir, filename);

  if (fs.existsSync(destPath) && !FORCE) {
    console.log(`   ⏭  ${filename} already exists — skipping (use --force to regenerate)`);
    return filename;
  }

  if (DRY_RUN) {
    console.log(`   [dry-run] ${filename}`);
    console.log(`            "${prompt.slice(0, 100)}..."`);
    return filename;
  }

  const response = await openai.images.generate({
    model:   'dall-e-3',
    prompt,
    n:       1,
    size:    '1024x1792',
    quality: 'standard',
  });

  const imageUrl = response.data[0].url;
  await downloadFile(imageUrl, destPath);
  console.log(`   ✅ ${filename}`);
  return filename;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎨 RunSound — Build Image Library');
  console.log('===================================');
  console.log(`   Artist:  ${artist}`);
  console.log(`   Song:    ${song}`);
  console.log(`   Genre:   ${genre}`);
  console.log(`   Mood:    ${mood}`);
  console.log(`   Style:   ${style}`);
  console.log(`   Count:   ${COUNT} images`);
  console.log(`   Output:  ${libraryDir}`);
  console.log(`   Force:   ${FORCE}`);
  console.log('');

  // Check for existing library
  if (fs.existsSync(libraryDir) && !FORCE) {
    const existing = fs.readdirSync(libraryDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    if (existing.length >= COUNT) {
      console.log(`✅ Library already has ${existing.length} images. Use --force to regenerate.\n`);
      return;
    }
    console.log(`   Found ${existing.length} existing images, generating up to ${COUNT} total...`);
  }

  if (!DRY_RUN && !process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not set in .env');
    process.exit(1);
  }

  fs.mkdirSync(libraryDir, { recursive: true });

  const openai = DRY_RUN ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Distribute COUNT images across arc roles (round-robin)
  const plan = [];
  for (let i = 0; i < COUNT; i++) {
    plan.push(ARC_ROLES[i % ARC_ROLES.length]);
  }

  console.log('🖼  Generating images...\n');

  // Estimate cost
  const costPerImage = 0.04;
  const existingCount = fs.existsSync(libraryDir)
    ? fs.readdirSync(libraryDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).length
    : 0;
  const toGenerate = FORCE ? COUNT : Math.max(0, COUNT - existingCount);
  console.log(`   Estimated cost: ~$${(toGenerate * costPerImage).toFixed(2)} (${toGenerate} new images @ $${costPerImage}/img)\n`);

  let generated = 0;
  let skipped   = 0;

  for (let i = 0; i < plan.length; i++) {
    const arcRole = plan[i];
    const prompt  = buildPrompt(arcRole);

    try {
      const filename = await generateImage(openai, prompt, arcRole, i + 1);
      if (filename) {
        const existed = fs.existsSync(path.join(libraryDir, filename)) && !FORCE;
        if (existed) skipped++;
        else generated++;
      }
    } catch (err) {
      console.error(`   ❌ Failed to generate image ${i + 1}: ${err.message}`);
      // Continue with remaining images
    }

    // Small delay to avoid rate limiting
    if (!DRY_RUN && i < plan.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Save library metadata
  const meta = {
    generatedAt: new Date().toISOString(),
    artist,
    song,
    genre,
    mood,
    style,
    count: COUNT,
    generated,
    skipped,
    images: fs.readdirSync(libraryDir)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => ({
        file: f,
        tags: path.basename(f, path.extname(f))
          .replace(/^img[-_]\d+[-_]?/, '')
          .split(/[-_]/)
          .filter(Boolean),
      })),
  };
  fs.writeFileSync(path.join(libraryDir, 'library.json'), JSON.stringify(meta, null, 2));

  console.log(`\n✅ Library complete`);
  console.log(`   ${generated} generated, ${skipped} skipped`);
  console.log(`   Total: ${meta.images.length} images in ${libraryDir}`);
  console.log(`\n   Next: npm run pick\n`);
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
