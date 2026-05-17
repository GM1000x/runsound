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
 * Cost: ~$0.04/image with gpt-image-1.5 (standard quality, 1024x1792)
 *       6 images ≈ $0.24 per campaign swap (one per arc role)
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
const COUNT      = parseInt(getArg('count') || '4', 10);   // 1 per arc × 4 arcs (default)
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
const model  = config.imageGen?.model  || process.env.IMAGE_MODEL || 'gpt-image-1';
// gpt-image-1 uses 'low'|'medium'|'high'; dall-e-3 uses 'standard'|'hd'
const quality = (model === 'dall-e-3') ? 'hd' : 'high';
const style  = config.imageGen?.style  || 'candid lifestyle photography, Pinterest aesthetic, authentic iPhone photo, soft natural light';
const extra  = config.imageGen?.extraPrompt || '';

// ─── Arc roles — mirrors pick-slides.js (4-slide structure) ──────────────────
// Pinterest/lifestyle style: real photography feel, intimate moments, natural light.
// Inspired by viral TikTok format: mirror selfies, silhouettes, candid life scenes.
// Each role has 3 prompt variations so the library has visual diversity.
const ARC_ROLES = [
  {
    role: 'hook',
    tags: ['hook', 'lifestyle', 'candid'],
    prompts: [
      'young woman in minimal apartment standing in front of full-length mirror, warm tungsten evening light, simple black outfit, gold jewellery, candid getting-ready moment, iPhone lifestyle photo, aesthetic Pinterest',
      'person sitting on bedroom floor against the bed, late night soft lamp light, cozy and intimate, looking thoughtful, candid unposed lifestyle moment',
      'person standing at floor-to-ceiling window in a city apartment at dusk, lights of the city below, moody warm interior light from behind, cinematic silhouette lifestyle shot',
    ],
  },
  {
    role: 'story',
    tags: ['story', 'intimate', 'warm'],
    prompts: [
      'two silhouettes slow dancing in a warmly lit kitchen at night, photographed from outside through a window, dark garden foreground, romantic warm glow inside, cinematic and intimate',
      'couple driving at golden hour, shot from passenger seat, sun streaming through windshield, warm haze, candid, slightly overexposed like film photo',
      'person sitting alone at a table in a dim restaurant or bar, single candle, warm bokeh lights in background, intimate atmosphere, candid lifestyle',
    ],
  },
  {
    role: 'peak',
    tags: ['peak', 'golden', 'silhouette'],
    prompts: [
      'silhouette of two people on a rooftop at sunset, city skyline behind them, golden and orange sky, romantic and cinematic, backlit',
      'person lying on bed staring at the ceiling, late afternoon golden light cutting across the room through blinds, emotional and still, candid intimate photography',
      'two people sitting close on a beach at dusk, seen from behind, calm water, soft gradient sky, warm golden and purple tones, peaceful and emotional',
    ],
  },
  {
    role: 'cta',
    tags: ['cta', 'minimal', 'aesthetic'],
    prompts: [
      'aesthetic nightstand flatlay — iPhone with white earbuds coiled, soft warm lamp glow, linen texture, minimal and clean, cozy evening atmosphere',
      'close-up of hands holding a warm coffee cup, soft morning window light, minimal table surface, clean Pinterest lifestyle composition',
      'open window with sheer curtain blowing in soft breeze, golden morning light flooding in, simple and cinematic, calm aesthetic',
    ],
  },
];

// ─── Build image prompt for a given arc role ───────────────────────────────────
// arcRole.prompts is an array; index selects which variation to use.
function buildPrompt(arcRole, variationIndex) {
  const basePrompts = arcRole.prompts || [arcRole.prompt || ''];
  const base = basePrompts[variationIndex % basePrompts.length];
  return [
    `Candid lifestyle photograph, Pinterest aesthetic, real photography.`,
    `${base}.`,
    `Mood: ${mood}.`,
    `Inspired by ${genre} music.`,
    `Shot on iPhone or 35mm film, natural light, ultra-realistic photographic quality, not illustrated, not AI-looking.`,
    `No text, no words, no watermarks, no logos.`,
    `Portrait orientation for TikTok/mobile.`,
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

// ─── Face detection — find safe text zone using GPT-4o Vision ─────────────────
// Returns 'top' | 'bottom' | 'center' — where text is safe to place.
// Costs ~$0.001 per image. Falls back to 'bottom' on any error.
async function detectSafeTextZone(openai, imagePath) {
  try {
    const b64 = fs.readFileSync(imagePath).toString('base64');
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${b64}`, detail: 'low' },
          },
          {
            type: 'text',
            text: 'This is a portrait image for TikTok. Are there human faces in it? Where is the most empty/dark/blurred area safe for white text overlay — top third, middle third, or bottom third? Reply with only one word: top, middle, or bottom.',
          },
        ],
      }],
    });

    const answer = res.choices[0]?.message?.content?.trim().toLowerCase() || 'bottom';
    if (answer.includes('top'))    return 'top';
    if (answer.includes('middle')) return 'center';
    return 'bottom';
  } catch {
    return 'bottom'; // safe default
  }
}

// ─── Generate one image (with retry on 429) ───────────────────────────────────
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

  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.images.generate({
        model,
        prompt,
        n:       1,
        size:    '1024x1792', // portrait for TikTok
        quality,
        // response_format not supported by gpt-image-2 — b64_json is returned by default
      });

      const b64    = response.data[0].b64_json;
      const buffer = Buffer.from(b64, 'base64');
      fs.writeFileSync(destPath, buffer);

      // Detect safe text zone — avoids placing text on faces
      process.stdout.write(`   ✅ ${filename} — detecting safe text zone...`);
      const safeZone = await detectSafeTextZone(openai, destPath);
      console.log(` ${safeZone}`);

      return { filename, safeZone };
    } catch (err) {
      const is429 = err?.status === 429 || err?.message?.includes('429') || err?.message?.toLowerCase().includes('rate limit');
      if (is429 && attempt < MAX_RETRIES) {
        const wait = attempt * 20000; // 20s, 40s, 60s
        console.log(`   ⏳ Rate limited — waiting ${wait / 1000}s before retry ${attempt}/${MAX_RETRIES - 1}...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎨 RunSound — Build Image Library');
  console.log('===================================');
  console.log(`   Artist:  ${artist}`);
  console.log(`   Song:    ${song}`);
  console.log(`   Genre:   ${genre}`);
  console.log(`   Mood:    ${mood}`);
  console.log(`   Model:   ${model}`);
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

  // Estimate cost — gpt-image-2 high quality 1024×1792 ≈ $0.19/image (Batch API) or $0.37 (standard)
  const costPerImage = 0.19;
  const existingCount = fs.existsSync(libraryDir)
    ? fs.readdirSync(libraryDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f)).length
    : 0;
  const toGenerate = FORCE ? COUNT : Math.max(0, COUNT - existingCount);
  console.log(`   Estimated cost: ~$${(toGenerate * costPerImage).toFixed(2)} (${toGenerate} new images @ $${costPerImage}/img)\n`);

  let generated  = 0;
  let skipped    = 0;
  const safeZones = {}; // filename → safeZone

  for (let i = 0; i < plan.length; i++) {
    const arcRole = plan[i];
    // variationIndex cycles through the prompts array within each arc role
    const variationIndex = Math.floor(i / ARC_ROLES.length);
    const prompt  = buildPrompt(arcRole, variationIndex);

    try {
      const result = await generateImage(openai, prompt, arcRole, i + 1);
      if (result) {
        const { filename, safeZone } = typeof result === 'string'
          ? { filename: result, safeZone: 'bottom' }
          : result;
        const existed = fs.existsSync(path.join(libraryDir, filename)) && !FORCE;
        if (existed) skipped++;
        else generated++;
        if (safeZone) safeZones[filename] = safeZone;
      }
    } catch (err) {
      console.error(`   ❌ Failed to generate image ${i + 1}: ${err.message}`);
      // Continue with remaining images
    }

    // Delay between requests — gpt-image-2 high quality: ~5 img/min, need ≥12s gap
    if (!DRY_RUN && i < plan.length - 1) {
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  // Save library metadata — including safeZone per image for text placement
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
        file:     f,
        safeZone: safeZones[f] || 'bottom',
        tags:     path.basename(f, path.extname(f))
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

  // Hard fail if nothing was generated — lets the pipeline know something went wrong
  if (meta.images.length === 0 && !DRY_RUN) {
    console.error('💥 Fatal: 0 images in library. All generation attempts failed. Check OPENAI_API_KEY and model name above.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
