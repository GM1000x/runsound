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
const COUNT      = parseInt(getArg('count') || '6', 10);   // 1 per arc × 6 arcs (default)
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
// CHARACTER SEED: prepended to every prompt to lock in the same person.
// Silhouette/back shots avoid face inconsistency across generations.
// All 4 slides feel like stills from the same short film.
//
// Rules:
//   - CHARACTER seed is identical on all 4 prompts
//   - Same environment/lighting throughout
//   - No props (no iPhones, coffee cups, earbuds, bags)
//   - CTA slide = environment-only, no person — creates a "breathe" moment

const CHARACTERS = [
  'a young woman with dark shoulder-length hair, wearing a loose white linen shirt and light jeans',
  'a young woman with long blonde hair, wearing an oversized beige knit sweater',
  'a young woman with short curly hair, wearing a soft grey t-shirt and high-waisted trousers',
];
// Pick a character randomly but consistently per campaign (based on song title hash)
function pickCharacter() {
  const hash = (song + artist).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return CHARACTERS[hash % CHARACTERS.length];
}

// VISUAL_FAMILIES: each family has 3 scene-variants per arc role.
// Each daily run picks one variant per role randomly — so the slides
// always feel cohesive (same character/world) but vary across runs.
// The variant index chosen is written to meta.json for CTR tracking.
const VISUAL_FAMILIES = [
  // ── Family 1: City apartment at night ────────────────────────────────────
  (ch) => ({
    name: 'city_night',
    hook: [
      `${ch}, silhouette standing at a large window in a dark city apartment at night, warm tungsten lamp behind her, city lights below, pensive and still, 35mm film`,
      `${ch}, sitting alone at a small kitchen table in a dark apartment, single overhead lamp, late night, hands resting on the table, staring into the distance, candid 35mm film`,
      `${ch}, lying on her back on the floor of a dark city apartment, one arm over her eyes, warm lamp glow from the side, late night stillness, shot on film from above`,
    ],
    build: [
      `${ch}, slowly walking away from the window in the same dark city apartment, soft lamplight on her back, city reflected behind her, intimate and quiet, 35mm film`,
      `${ch}, standing in the narrow hallway of the same apartment, one hand on the wall, looking down, late night, warm tungsten light from the room ahead, shot on film`,
      `${ch}, reaching to turn off the lamp in the same apartment, face half-lit in the last warm glow, late night, emotional, 35mm film`,
    ],
    story: [
      `${ch}, sitting on the wooden floor against the wall of the same dimly lit apartment, knees pulled to chest, soft lamp glow, emotional and quiet, 35mm film`,
      `${ch}, leaning on the windowsill of the same city apartment, chin resting on her arms, looking out at the city lights below, soft lamp, 35mm film`,
      `${ch}, curled on the edge of the bed in the same dark apartment, fully clothed, soft lamp in the corner, late night, intimate, 35mm film`,
    ],
    peak: [
      `${ch}, close portrait in the same dark apartment, single warm lamp, soft shadow on her face, eyes slightly downcast, raw emotion, intimate, 35mm film, no props`,
      `${ch}, close side profile in the dark apartment, face half-lit by the lamp, looking up at the ceiling, quiet and emotional, shot on film`,
      `${ch}, close portrait from behind her shoulder in the dark apartment, looking toward the glowing city window, cinematic and still, 35mm film`,
    ],
    release: [
      `${ch}, sitting at the window of the same apartment, first morning light just beginning outside, lamp still on, exhausted and still, 35mm film`,
      `${ch}, standing in the same apartment doorway, backlit by soft hallway light, looking back into the dark room, 35mm film`,
      `${ch}, sitting cross-legged on the floor of the same apartment, face tilted up, eyes closed, quiet relief, warm lamp, 35mm film`,
    ],
    cta: [
      `empty wooden floor of a dark city apartment, single warm tungsten lamp in the corner, city lights through the window, no people, no objects, late night stillness, 35mm film`,
      `the glow of a city at night seen through a large dark apartment window, curtain slightly open, no people, quiet and still, 35mm film`,
      `a single warm lamp on a wooden floor in a dark apartment, soft light spreading on the bare floor, no people, minimal and calm, 35mm film`,
    ],
  }),
  // ── Family 2: Golden hour outdoors ───────────────────────────────────────
  (ch) => ({
    name: 'golden_hour',
    hook: [
      `${ch}, walking alone down an empty sun-drenched street at golden hour, shot from behind, backlit by low sun, warm orange haze, long shadow, loose summer clothes, candid 35mm film`,
      `${ch}, sitting on a low wall in a quiet sun-drenched neighborhood at golden hour, face turned slightly away, bathed in warm orange light, loose clothes, candid 35mm film`,
      `${ch}, standing at the end of a sun-soaked alley at golden hour, looking up at the light, backlit, hair catching the sun, loose summer dress, candid shot on film`,
    ],
    build: [
      `${ch}, walking slowly through the same golden-lit neighborhood, one hand trailing along a warm stone wall, looking ahead, contemplative, candid 35mm film`,
      `${ch}, pausing on the same empty street at golden hour, turning to look back over her shoulder, warm backlight, candid and still, 35mm film`,
      `${ch}, stepping off a curb onto the same sun-drenched street, loose summer clothes, golden light from the side, motion captured, candid 35mm film`,
    ],
    story: [
      `${ch}, sitting on concrete steps in the same golden afternoon light, elbows on knees, looking into the distance, warm sun on her face, pensive, candid 35mm film`,
      `${ch}, lying in dry summer grass in the same golden late afternoon, one arm behind her head, eyes closed, sun on her face, peaceful and still, candid 35mm film`,
      `${ch}, sitting on a sun-warmed bench in the same neighborhood, legs stretched out, head tilted back to catch the last of the golden light, candid 35mm film`,
    ],
    peak: [
      `${ch}, standing alone at the end of the same empty street at sunset, facing away, sky orange and pink behind her, figure small, emotional and cinematic, 35mm film`,
      `${ch}, silhouette against a blazing orange sunset sky in the same open space, arms slightly out, still, emotional, 35mm film, wide shot`,
      `${ch}, close shot from behind in the same golden field, golden light catching the edges of her hair, sky glowing, quiet and emotional, 35mm film`,
    ],
    release: [
      `${ch}, sitting on the same concrete steps after sunset, dusk light, the street quiet and blue-toned, looking up, peaceful, 35mm film`,
      `${ch}, walking away down the same street in the last of the evening light, figure small, warm glow behind her fading, candid 35mm film`,
      `${ch}, lying in the same dry summer grass as dusk comes, looking up at the sky, arm outstretched, calm and open, 35mm film`,
    ],
    cta: [
      `an empty concrete step on a sun-soaked street, long golden shadows, warm afternoon light, nobody there, nostalgic and still, 35mm film`,
      `dry summer grass catching the last golden hour light, no people, warm and hazy, soft focus, 35mm film`,
      `an empty sun-warmed bench in a quiet neighborhood at golden hour, long shadow behind it, warm amber light, nobody there, candid 35mm film`,
    ],
  }),
  // ── Family 3: Late night drive ────────────────────────────────────────────
  (ch) => ({
    name: 'night_drive',
    hook: [
      `${ch}, in the passenger seat of a car at night, city lights streaming past the window, face half-lit by street lights, looking forward, shot from the back seat, cinematic, film grain`,
      `${ch}, looking out the side window of a moving car at night, blurred street lights outside, face soft and distant, candid shot from the passenger side, film grain`,
      `${ch}, leaning her head against the car window at night, eyes half-open, street lights passing, reflections on the glass, intimate and quiet, shot on film`,
    ],
    build: [
      `${ch}, sitting up straighter in the same car at night, looking ahead through the windshield at the road, street lights ahead, alert and emotional, shot on film`,
      `${ch}, turning to look out the back window of the same car at night, city lights receding, face quiet, 35mm film`,
      `${ch}, one hand resting on the window of the same moving car at night, fingers spread on the cold glass, city lights outside, 35mm film`,
    ],
    story: [
      `${ch}, alone in the same parked car at night, head resting back on the seat, eyes closed, single street light through the windshield, quiet and emotional, shot on film`,
      `${ch}, in the driver's seat of the same parked car at night, hands in her lap, staring ahead through the windshield, distant city glow, emotional stillness, shot on film`,
      `${ch}, sitting sideways in the passenger seat of the same parked car at night, knees up, looking out the side window at street lights, candid, shot on film`,
    ],
    peak: [
      `${ch}, driver's seat of the same car, hands on the wheel, face lit only by dashboard glow and passing street lights, emotional close shot, cinematic, film grain`,
      `${ch}, close portrait in the same car at night, face reflected faintly in the window, street lights passing behind her, raw and still, shot on film`,
      `${ch}, looking straight into the camera from the driver's seat of the same car at night, dashboard glow, honest and emotional, 35mm film portrait`,
    ],
    release: [
      `${ch}, stepping out of the same car at night onto an empty street, door still open, city quiet around her, looking up, 35mm film`,
      `${ch}, sitting on the hood of the same parked car at night, city lights in the distance, looking out, calm and open, shot on film`,
      `${ch}, leaning against the outside of the same car at night, arms crossed loosely, looking up at the sky, street light above, 35mm film`,
    ],
    cta: [
      `the empty passenger seat of a car at night, faint city lights through the window, dark interior, quiet and still, no people, 35mm film`,
      `a car windshield at night, city lights ahead on a wet road, no driver visible, open road, cinematic, 35mm film`,
      `the steering wheel of a parked car at night, dashboard glow, street light through the windshield, no people, still and quiet, 35mm film`,
    ],
  }),
];

// ─── Family + variant selection ───────────────────────────────────────────────
// Mood biases toward the right family (70% weight) but allows other families
// 30% of the time so we explore across runs and gather comparative data.
function chooseFamilyIndex() {
  const m = (mood + ' ' + genre).toLowerCase();
  const r = Math.random();
  if (/summer|sun|sunny|golden|warm|bright|happy|joy|uplifting|energetic|day|beach/.test(m)) {
    return r < 0.7 ? 1 : (r < 0.85 ? 0 : 2);  // 70% golden, 15% apartment, 15% drive
  }
  if (/night|dark|late|melanchol|sad|heartbreak|loss|rain|city|drive|alone/.test(m)) {
    return r < 0.7 ? 2 : (r < 0.85 ? 0 : 1);  // 70% drive, 15% apartment, 15% golden
  }
  // No strong mood signal — explore all families equally
  return Math.floor(r * 3);
}

// Pick a random variant index (0–2) for each arc role independently.
// Written to meta.json so CTR data can be tied back to each visual choice.
function pickVariants() {
  const r = () => Math.floor(Math.random() * 3);
  return { hook: r(), build: r(), story: r(), peak: r(), release: r(), cta: r() };
}

const FAMILY_INDEX  = chooseFamilyIndex();
const CHARACTER     = pickCharacter();
const FAMILY_DATA   = VISUAL_FAMILIES[FAMILY_INDEX](CHARACTER);
const VARIANTS      = pickVariants();

console.log(`🎨 Visual family: ${FAMILY_DATA.name} | variants hook:${VARIANTS.hook} build:${VARIANTS.build} story:${VARIANTS.story} peak:${VARIANTS.peak} release:${VARIANTS.release} cta:${VARIANTS.cta}`);

// Build ARC_ROLES from chosen family + variants (6-slide structure)
const ARC_ROLES = [
  { role: 'hook',    tags: ['hook'],    prompts: [FAMILY_DATA.hook[VARIANTS.hook]]       },
  { role: 'build',   tags: ['build'],   prompts: [FAMILY_DATA.build[VARIANTS.build]]     },
  { role: 'story',   tags: ['story'],   prompts: [FAMILY_DATA.story[VARIANTS.story]]     },
  { role: 'peak',    tags: ['peak'],    prompts: [FAMILY_DATA.peak[VARIANTS.peak]]       },
  { role: 'release', tags: ['release'], prompts: [FAMILY_DATA.release[VARIANTS.release]] },
  { role: 'cta',     tags: ['cta'],     prompts: [FAMILY_DATA.cta[VARIANTS.cta]]         },
];

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
    visualFamily: FAMILY_DATA.name,
    visualVariants: VARIANTS,
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
