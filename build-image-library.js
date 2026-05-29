#!/usr/bin/env node
/**
 * build-image-library.js — RunSound Image Library Generator
 *
 * Generates a set of AI images for a campaign using OpenAI's image API.
 * Images are generated ONCE per campaign (or when the artist swaps a song)
 * and then reused daily by pick-slides.js. This keeps the daily run cost at $0.
 *
 * BANK-FIRST STRATEGY (network flywheel):
 *   Before generating new images, checks the shared image_bank in Supabase.
 *   If the bank already has proven images for a given arc role, those are
 *   downloaded and reused — at zero API cost.
 *   Only generates new images for arc roles not covered by the bank.
 *   After generation, new images are uploaded to Supabase Storage and
 *   registered in image_bank so future artists can benefit from them too.
 *
 * Arc-aware generation: produces images for each narrative role
 * (hook, story, peak, cta) so pick-slides.js can match images to the
 * right slide position.
 *
 * Image naming convention:
 *   img-001_hook_lifestyle_candid.png
 *   img-002_story_intimate_warm.png
 *   ...
 * Tags in the filename are read by pick-slides.js for arc-matching.
 *
 * Usage:
 *   node build-image-library.js --config <config.json>
 *   node build-image-library.js --config <config.json> --count 4
 *   node build-image-library.js --config <config.json> --force
 *   node build-image-library.js --config <config.json> --no-bank    (skip bank lookup)
 *
 * Options:
 *   --count N     Total images to generate (default: 4, 1 per arc role)
 *   --force       Regenerate even if library already exists
 *   --dry-run     Show prompts without generating
 *   --no-bank     Skip image bank lookup; always generate fresh
 *
 * Cost (when bank is empty): ~$0.19/image with gpt-image-2 (high, 1024×1536)
 *       4 images ≈ $0.76 per first campaign (zero cost once bank has images)
 *
 * Requires: OPENAI_API_KEY in .env
 *           SUPABASE_URL + SUPABASE_SERVICE_KEY in .env (for bank)
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
const NO_BANK    = args.includes('--no-bank');

if (!configPath) {
  console.error('Usage: node build-image-library.js --config <config.json>');
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);
const libraryDir = path.join(projectDir, 'image-library');

const artist      = config.artist?.name        || 'Unknown Artist';
const song        = config.song?.title         || 'Unknown Song';
const genre       = config.song?.genre         || 'indie pop';
const mood        = config.song?.mood          || 'emotional, nostalgic';
const description = config.song?.description   || '';
const lyrics      = config.song?.lyrics        || '';
const model       = config.imageGen?.model     || process.env.IMAGE_MODEL || 'gpt-image-2-2026-04-21';
// gpt-image-1 uses 'low'|'medium'|'high'; dall-e-3 uses 'standard'|'hd'
const quality     = (model === 'dall-e-3') ? 'hd' : 'high';
const style       = config.imageGen?.style     || 'candid lifestyle photography, Pinterest aesthetic, authentic iPhone photo, soft natural light';
const extra       = config.imageGen?.extraPrompt || '';

// Extract a short lyric snippet for image grounding (first 200 chars, no line breaks)
const lyricSnippet = lyrics
  ? 'Song lyric excerpt: "' + lyrics.replace(/\s+/g, ' ').trim().slice(0, 200) + '".'
  : '';

// ─── Supabase client ──────────────────────────────────────────────────────────
let supabase = null;
try {
  if (!NO_BANK && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
} catch { /* supabase not installed — bank disabled */ }

// ─── Bank utils ───────────────────────────────────────────────────────────────
let bank = null;
try {
  if (supabase) bank = require('./bank-utils');
} catch { /* bank-utils not present — skip bank */ }

// ─── Visual families — 3 cohesive worlds, each with 4 matching scenes ────────
// All 4 slides in a family share the same protagonist, environment and light.
// One family is chosen randomly per campaign run so the carousel feels like
// a single story, not 4 unrelated photos.
//
// Rules for every prompt:
//   - Same person throughout (silhouette or no face — no conflicting faces)
//   - Same environment/lighting family
//   - No props that break the world (no iPhones, coffee cups, earbuds)
//   - CTA slide = quiet, still moment in the same world — NOT a flatlay
const VISUAL_FAMILIES = [
  // Family 1: City apartment at night — moody, warm tungsten, intimate
  [
    { role: 'hook',  tags: ['hook', 'city', 'night'],    prompt: 'young woman silhouette standing at a large window in a dark city apartment at night, warm tungsten light from a single lamp behind her, city lights below, she is looking out, pensive and still, candid lifestyle photography, shot on film' },
    { role: 'story', tags: ['story', 'intimate', 'warm'], prompt: 'same young woman sitting on the floor against the wall in the same dimly lit apartment, knees pulled to chest, soft lamp glow, late night atmosphere, emotional and quiet, candid film photography' },
    { role: 'peak',  tags: ['peak', 'emotional', 'dark'], prompt: 'close portrait of a young woman in a dark room, single warm lamp, soft shadow on her face, eyes slightly downcast, raw emotion, intimate and cinematic, shot on 35mm film, no phone or props' },
    { role: 'cta',   tags: ['cta', 'still', 'night'],    prompt: 'empty spot on a bed in a dark apartment, single warm lamp glowing softly, rumpled linen, late night stillness, no people, no objects — just light and texture, cinematic and calm' },
  ],
  // Family 2: Golden hour outdoors — warm, sun-soaked, bittersweet
  [
    { role: 'hook',  tags: ['hook', 'golden', 'outdoor'], prompt: 'young woman walking alone down an empty street at golden hour, backlit by low sun, warm orange haze, long shadow, candid shot from behind, loose summer clothes, emotional and free' },
    { role: 'story', tags: ['story', 'golden', 'warm'],   prompt: 'same young woman sitting on concrete steps in golden afternoon light, elbows on knees, looking into the distance, warm sun on her face, pensive, candid film photograph' },
    { role: 'peak',  tags: ['peak', 'sunset', 'golden'],  prompt: 'silhouette of a young woman standing alone in an open field at sunset, sky orange and pink, figure small against the horizon, emotional and cinematic, shot on 35mm film' },
    { role: 'cta',   tags: ['cta', 'golden', 'still'],    prompt: 'an empty park bench in golden late afternoon light, long shadows across concrete, nobody on it, warm and nostalgic atmosphere, no objects, just light and space' },
  ],
  // Family 3: Late night drive — cinematic, dark, liberating
  [
    { role: 'hook',  tags: ['hook', 'night', 'drive'],   prompt: 'young woman in the passenger seat of a car at night, city lights streaming past the window, face half-lit by street lights, looking forward, shot from the back seat, cinematic and moody, film grain' },
    { role: 'story', tags: ['story', 'night', 'car'],    prompt: 'same young woman alone in a parked car at night, head resting back on the seat, eyes closed, street light through the windshield, quiet and emotional, intimate car interior, shot on film' },
    { role: 'peak',  tags: ['peak', 'night', 'road'],    prompt: 'point of view from a car on an empty night road, headlights on wet tarmac, city lights far ahead, nobody visible, open road, cinematic and emotional, wide angle' },
    { role: 'cta',   tags: ['cta', 'night', 'still'],    prompt: 'a car window at night, rain drops on the glass, blurred city lights outside, no people, quiet and still, emotional atmosphere, film photography look' },
  ],
];

// Pick visual family based on mood — ensures slides match the song's feeling.
// Falls back to a random eligible family if no strong mood signal found.
function chooseFamilyIndex() {
  const m = (mood + ' ' + genre).toLowerCase();
  // Summer / sunny / warm / bright / uplifting → golden hour outdoors (family 2)
  if (/summer|sun|sunny|golden|warm|bright|happy|joy|uplifting|energetic|day|beach|road/.test(m)) return 1;
  // Night / dark / late / melancholic / sad / rain / city → late night drive (family 3)
  if (/night|dark|late|melanchol|sad|heartbreak|loss|rain|city|drive|alone/.test(m)) return 2;
  // Default: city apartment at night (family 1) — works for most moods
  return 0;
}
const FAMILY_INDEX = chooseFamilyIndex();
const CHOSEN_FAMILY = VISUAL_FAMILIES[FAMILY_INDEX];

// Build ARC_ROLES from the chosen family (compatible with rest of pipeline)
const ARC_ROLES = CHOSEN_FAMILY.map(f => ({
  role:    f.role,
  tags:    f.tags,
  prompts: [f.prompt],  // single prompt per role in a family
}));

// ─── Build image prompt for a given arc role ───────────────────────────────────
function buildPrompt(arcRole, variationIndex) {
  const basePrompts = arcRole.prompts || [arcRole.prompt || ''];
  const base = basePrompts[variationIndex % basePrompts.length];
  return [
    `Candid lifestyle photograph, Pinterest aesthetic, real photography.`,
    `${base}.`,
    `Mood: ${mood}.`,
    description ? `Song context: ${description}.` : '',
    lyricSnippet,
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
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
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
    return { filename, safeZone: 'bottom', alreadyExisted: true };
  }

  if (DRY_RUN) {
    console.log(`   [dry-run] ${filename}`);
    console.log(`            "${prompt.slice(0, 100)}..."`);
    return { filename, safeZone: 'bottom' };
  }

  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.images.generate({
        model,
        prompt,
        n:       1,
        size:    '1024x1536', // portrait for TikTok (gpt-image-1 max portrait)
        quality,
        // response_format not supported by gpt-image-1 — b64_json is returned by default
      });

      const b64    = response.data[0].b64_json;
      const buffer = Buffer.from(b64, 'base64');
      fs.writeFileSync(destPath, buffer);

      // Detect safe text zone — avoids placing text on faces
      process.stdout.write(`   ✅ ${filename} — detecting safe text zone...`);
      const safeZone = await detectSafeTextZone(openai, destPath);
      console.log(` ${safeZone}`);

      return { filename, safeZone, destPath };
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
  console.log(`   Count:   ${COUNT} images`);
  console.log(`   Bank:    ${bank && supabase ? 'enabled ✅' : 'disabled (no Supabase or --no-bank)'}`);
  console.log(`   Output:  ${libraryDir}`);
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

  // ── Ensure Supabase Storage bucket exists ──────────────────────────────────
  if (bank && supabase) {
    await bank.initStorage(supabase);
  }

  // ── Distribute COUNT images across arc roles (round-robin) ─────────────────
  const plan = [];
  for (let i = 0; i < COUNT; i++) {
    plan.push(ARC_ROLES[i % ARC_ROLES.length]);
  }

  // ── Try to fill as many slots as possible from the image bank ──────────────
  const bankImages = {};  // arcRole → bank image row
  if (bank && supabase && !FORCE) {
    const neededRoles = [...new Set(plan.map(r => r.role))];
    console.log(`🏦 Checking image bank for ${neededRoles.join(', ')}...`);

    const bankResults = await bank.pickBankImages(supabase, neededRoles);
    for (const role of neededRoles) {
      if (bankResults[role]) {
        bankImages[role] = bankResults[role];
        console.log(`   ✅ ${role}: bank hit (id: ${bankResults[role].id.slice(0, 8)}..., ctr: ${(bankResults[role].avg_ctr || 0).toFixed(4)})`);
      } else {
        console.log(`   ➕ ${role}: not in bank — will generate`);
      }
    }
    console.log('');
  }

  let generated  = 0;
  let bankHits   = 0;
  let skipped    = 0;
  const safeZones  = {};   // filename → safeZone
  const bankIds    = [];   // image_bank UUIDs used in this library (for post attribution)

  for (let i = 0; i < plan.length; i++) {
    const arcRole = plan[i];
    const tags    = arcRole.tags.join('_');
    const filename = `img-${String(i + 1).padStart(3, '0')}_${tags}.png`;
    const destPath = path.join(libraryDir, filename);

    // ── Try bank first ──────────────────────────────────────────────────────
    const bankImg = bankImages[arcRole.role];
    if (bankImg && !FORCE) {
      if (fs.existsSync(destPath)) {
        console.log(`   ⏭  ${filename} already on disk — skipping download`);
        safeZones[filename] = bankImg.safe_zone || 'bottom';
        bankIds.push(bankImg.id);
        bankHits++;
        continue;
      }

      if (!DRY_RUN) {
        try {
          process.stdout.write(`   🏦 ${filename} — downloading from bank...`);
          await bank.downloadFromUrl(bankImg.public_url, destPath);
          safeZones[filename] = bankImg.safe_zone || 'bottom';
          bankIds.push(bankImg.id);
          bankHits++;
          console.log(` ✅ ${bankImg.safe_zone || 'bottom'}`);
          continue;  // Skip generation for this slot
        } catch (dlErr) {
          console.log(` ⚠️  download failed (${dlErr.message}) — generating fresh`);
          // Fall through to generation
        }
      } else {
        console.log(`   [dry-run] ${filename} → bank hit`);
        bankHits++;
        continue;
      }
    }

    // ── Generate new image ──────────────────────────────────────────────────
    // Pick a random variation within this arc role's prompt array so each
    // campaign gets visually different images (not always the same iPhone/earphones).
    const numVariations = arcRole.prompts?.length || 1;
    const variationIndex = Math.floor(Math.random() * numVariations);
    const prompt = buildPrompt(arcRole, variationIndex);

    // Estimate cost before generating
    const costPerImage = 0.19;
    if (!DRY_RUN && generated === 0) {
      const toGenerate = plan.length - bankHits;
      console.log(`   Estimated generation cost: ~$${(toGenerate * costPerImage).toFixed(2)} (${toGenerate} new images @ $${costPerImage}/img)\n`);
    }

    try {
      const result = await generateImage(openai, prompt, arcRole, i + 1);
      if (result) {
        const { safeZone, alreadyExisted } = result;
        if (alreadyExisted) {
          skipped++;
        } else {
          generated++;
          safeZones[filename] = safeZone;

          // ── Upload newly generated image to bank ───────────────────────────
          if (bank && supabase && !DRY_RUN && fs.existsSync(destPath)) {
            process.stdout.write(`   📤 ${filename} — uploading to bank...`);
            const bankResult = await bank.uploadToBank(supabase, destPath, {
              arcRole:  arcRole.role,
              tags:     arcRole.tags,
              safeZone: safeZone,
              genre,
              mood,
            });
            if (bankResult) {
              bankIds.push(bankResult.id);
              console.log(` ✅ registered (id: ${bankResult.id.slice(0, 8)}...)`);
            } else {
              console.log(` ⚠️  upload failed — image still usable locally`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`   ❌ Failed to generate image ${i + 1}: ${err.message}`);
    }

    // Delay between requests — gpt-image-2 high quality: ~5 img/min, need ≥12s gap
    if (!DRY_RUN && i < plan.length - 1 && !bankImages[plan[i + 1]?.role]) {
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  // ── Save library metadata ──────────────────────────────────────────────────
  // Includes bank IDs for later attribution in check-analytics.js
  const meta = {
    generatedAt: new Date().toISOString(),
    artist,
    song,
    genre,
    mood,
    style,
    count: COUNT,
    generated,
    bankHits,
    skipped,
    imageBankIds: bankIds,  // UUIDs of bank images used — for post attribution
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
  console.log(`   ${bankHits} from bank (free), ${generated} generated, ${skipped} skipped`);
  console.log(`   Total: ${meta.images.length} images in ${libraryDir}`);
  if (bankIds.length) {
    console.log(`   Bank IDs recorded: ${bankIds.length}`);
  }
  console.log(`\n   Next: npm run pick\n`);

  if (meta.images.length === 0 && !DRY_RUN) {
    console.error('💥 Fatal: 0 images in library. All generation attempts failed. Check OPENAI_API_KEY and model name above.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
