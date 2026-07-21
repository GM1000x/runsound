/**
 * GET /api/templates          — list all templates (optionally filtered by genre)
 * GET /api/templates/:id      — single template detail
 * GET /api/templates/match    — best template for an artist (by campaign ID + token)
 *
 * Template library: 10 proven visual styles for music TikTok content.
 * Each template defines:
 *   - Visual structure (how slides are laid out)
 *   - Color tone profile (dark/bright/warm/cool)
 *   - Text style (how words appear on screen)
 *   - Genre affinity (which genres convert best)
 *   - Hook archetype affinity (which hook types pair best visually)
 *   - Adaptation rules (how to personalise via artist color + genre)
 *
 * Cost model: No DALL-E calls needed. Templates are pre-defined structures
 * combined with artist's own artwork + GPT-generated text overlays only.
 * Cost per post: ~$0.01–0.02 (text only) vs $0.30–0.50 (DALL-E).
 */

const express = require('express');
const router  = express.Router();

// ─── Template definitions ────────────────────────────────────────────────────
// These are battle-tested visual formats scraped from high-performing music TikToks.
// Each template is adapted per artist via:
//   1. dominant_color extracted from their Spotify/uploaded artwork
//   2. genre → tone mapping (dark_moody for metal/ambient, bright for pop, etc.)
//   3. GPT-generated text overlays (hook text from generate-texts.js)

const TEMPLATES = [
  {
    id:          'dark_cinematic',
    name:        'Dark Cinematic',
    description: 'Full-bleed dark artwork with centered bold white text. High contrast, cinematic mood.',
    color_tone:  'dark_moody',
    text_style:  'large_bold_centered',
    slide_count: 4,
    preview_emoji: '🎬',
    why_it_works: 'High contrast makes text instantly readable. The dark mood matches introspective/emotional music.',
    best_for_genres: ['indie', 'alternative', 'ambient', 'electronic', 'metal', 'r&b', 'soul'],
    best_for_archetypes: ['mystery', 'raw_lyric', 'contrarian'],
    slides: [
      { role: 'hook',    layout: 'full_bleed_dark', text_position: 'center', font_weight: 'bold', font_size: 'xl' },
      { role: 'build',   layout: 'full_bleed_dark', text_position: 'center', font_weight: 'regular', font_size: 'lg' },
      { role: 'payoff',  layout: 'full_bleed_dark', text_position: 'center', font_weight: 'bold', font_size: 'xl' },
      { role: 'cta',     layout: 'artwork_bottom',  text_position: 'top', font_weight: 'bold', font_size: 'md' },
    ],
    adapt: {
      color_source: 'artwork_darken',  // pull dominant dark tone from artwork
      overlay_opacity: 0.7,
      text_color: '#FFFFFF',
    },
  },

  {
    id:          'lyrics_slideshow',
    name:        'Lyrics Slideshow',
    description: 'One lyric line per slide, large and centered. Pulls viewers through all slides.',
    color_tone:  'warm_golden',
    text_style:  'lyrics_line_by_line',
    slide_count: 4,
    preview_emoji: '🎵',
    why_it_works: 'Forces completion — each slide is incomplete without the next. High save/share rate.',
    best_for_genres: ['pop', 'indie-pop', 'singer-songwriter', 'country', 'r&b'],
    best_for_archetypes: ['raw_lyric', 'question_hook', 'lifestyle_placement'],
    slides: [
      { role: 'hook',    layout: 'gradient_overlay', text_position: 'center', font_weight: 'bold', font_size: 'xl', text_source: 'lyric_line_1' },
      { role: 'build',   layout: 'gradient_overlay', text_position: 'center', font_weight: 'regular', font_size: 'xl', text_source: 'lyric_line_2' },
      { role: 'payoff',  layout: 'gradient_overlay', text_position: 'center', font_weight: 'bold', font_size: 'xl', text_source: 'lyric_line_3' },
      { role: 'cta',     layout: 'artwork_centered', text_position: 'bottom', font_weight: 'bold', font_size: 'md', text_source: 'cta' },
    ],
    adapt: {
      color_source: 'artwork_warm',
      overlay_opacity: 0.5,
      text_color: '#FFFFFF',
    },
  },

  {
    id:          'aesthetic_minimal',
    name:        'Aesthetic Minimal',
    description: 'Clean white/light background, small lowercase text. Quiet confidence.',
    color_tone:  'cool_minimal',
    text_style:  'small_subtitle',
    slide_count: 4,
    preview_emoji: '🤍',
    why_it_works: 'Stands out in a sea of loud content. Appeals to audiences who curate carefully.',
    best_for_genres: ['indie-folk', 'ambient', 'classical', 'jazz', 'lo-fi', 'singer-songwriter'],
    best_for_archetypes: ['mystery', 'artist_identity', 'lifestyle_placement'],
    slides: [
      { role: 'hook',   layout: 'white_bg',  text_position: 'center', font_weight: 'light', font_size: 'lg', font_case: 'lowercase' },
      { role: 'build',  layout: 'white_bg',  text_position: 'center', font_weight: 'light', font_size: 'md', font_case: 'lowercase' },
      { role: 'payoff', layout: 'white_bg',  text_position: 'center', font_weight: 'regular', font_size: 'lg', font_case: 'lowercase' },
      { role: 'cta',    layout: 'artwork_small_centered', text_position: 'below_artwork', font_weight: 'light', font_size: 'sm' },
    ],
    adapt: {
      color_source: 'artwork_light_extract',
      overlay_opacity: 0.0,
      text_color: '#1a1a1a',
      bg_color_override: '#FAFAFA',
    },
  },

  {
    id:          'neon_energy',
    name:        'Neon Energy',
    description: 'Dark background, electric neon accent colors, energetic bold text.',
    color_tone:  'colorful_vibrant',
    text_style:  'large_bold_centered',
    slide_count: 4,
    preview_emoji: '⚡',
    why_it_works: 'Stops the scroll immediately. Energy matches the music — high alignment between visual and audio.',
    best_for_genres: ['pop', 'dance', 'edm', 'hip-hop', 'trap', 'electronic'],
    best_for_archetypes: ['social_proof', 'contrarian', 'series_hook'],
    slides: [
      { role: 'hook',   layout: 'dark_neon_border', text_position: 'center', font_weight: 'black', font_size: 'xxl' },
      { role: 'build',  layout: 'dark_neon_fill',   text_position: 'center', font_weight: 'bold',  font_size: 'xl' },
      { role: 'payoff', layout: 'dark_neon_border', text_position: 'center', font_weight: 'black', font_size: 'xxl' },
      { role: 'cta',    layout: 'artwork_neon_frame', text_position: 'bottom', font_weight: 'bold', font_size: 'md' },
    ],
    adapt: {
      color_source: 'artwork_saturate',
      overlay_opacity: 0.8,
      text_color: '#FFFFFF',
      accent_source: 'artwork_complementary',
    },
  },

  {
    id:          'grain_vintage',
    name:        'Grain & Vintage',
    description: 'Film grain texture overlay, muted tones, serif or retro type.',
    color_tone:  'warm_golden',
    text_style:  'scattered_overlay',
    slide_count: 4,
    preview_emoji: '📷',
    why_it_works: 'Nostalgia and authenticity signal "this is art, not an ad." Very high save rate.',
    best_for_genres: ['indie', 'folk', 'country', 'blues', 'soul', 'singer-songwriter', 'americana'],
    best_for_archetypes: ['lifestyle_placement', 'artist_identity', 'raw_lyric'],
    slides: [
      { role: 'hook',   layout: 'grain_overlay_dark', text_position: 'top_left', font_weight: 'regular', font_size: 'xl', font_family: 'serif' },
      { role: 'build',  layout: 'grain_overlay_mid',  text_position: 'center',   font_weight: 'light',   font_size: 'lg', font_family: 'serif' },
      { role: 'payoff', layout: 'grain_overlay_dark', text_position: 'bottom',   font_weight: 'bold',    font_size: 'xl', font_family: 'serif' },
      { role: 'cta',    layout: 'grain_artwork',      text_position: 'center',   font_weight: 'regular', font_size: 'md' },
    ],
    adapt: {
      color_source: 'artwork_desaturate_warm',
      overlay_opacity: 0.4,
      grain_intensity: 0.3,
      text_color: '#F5E6D3',
    },
  },

  {
    id:          'text_only_bold',
    name:        'Text Only Bold',
    description: 'Solid color background, nothing but big text. Manifesto energy.',
    color_tone:  'dark_moody',
    text_style:  'large_bold_centered',
    slide_count: 4,
    preview_emoji: '✊',
    why_it_works: 'No visual distraction — the words carry everything. Forces engagement with the message.',
    best_for_genres: ['hip-hop', 'rap', 'spoken-word', 'punk', 'metal', 'indie'],
    best_for_archetypes: ['contrarian', 'question_hook', 'series_hook'],
    slides: [
      { role: 'hook',   layout: 'solid_color_bg', text_position: 'center', font_weight: 'black', font_size: 'xxl' },
      { role: 'build',  layout: 'solid_color_bg', text_position: 'center', font_weight: 'bold',  font_size: 'xl' },
      { role: 'payoff', layout: 'solid_color_bg', text_position: 'center', font_weight: 'black', font_size: 'xxl' },
      { role: 'cta',    layout: 'solid_color_artwork_inset', text_position: 'top', font_weight: 'bold', font_size: 'md' },
    ],
    adapt: {
      color_source: 'artwork_dominant',
      overlay_opacity: 1.0,
      text_color: '#FFFFFF',
      bg_source: 'artwork_dominant_dark',
    },
  },

  {
    id:          'split_artwork',
    name:        'Split Artwork',
    description: 'Left: artwork. Right: text. Clean editorial layout.',
    color_tone:  'cool_minimal',
    text_style:  'small_subtitle',
    slide_count: 4,
    preview_emoji: '📰',
    why_it_works: 'Editorial feel — looks like a music magazine. Signals quality and credibility.',
    best_for_genres: ['pop', 'r&b', 'indie-pop', 'jazz', 'soul'],
    best_for_archetypes: ['artist_identity', 'social_proof', 'lifestyle_placement'],
    slides: [
      { role: 'hook',   layout: 'split_50_50',     text_position: 'right_center', font_weight: 'bold',    font_size: 'xl' },
      { role: 'build',  layout: 'split_70_30',     text_position: 'right_center', font_weight: 'regular', font_size: 'lg' },
      { role: 'payoff', layout: 'split_50_50',     text_position: 'right_center', font_weight: 'bold',    font_size: 'xl' },
      { role: 'cta',    layout: 'artwork_full_bg', text_position: 'center',       font_weight: 'bold',    font_size: 'md' },
    ],
    adapt: {
      color_source: 'artwork_complementary',
      overlay_opacity: 0.0,
      text_color: '#1a1a1a',
      bg_color_override: '#FFFFFF',
    },
  },

  {
    id:          'black_white_contrast',
    name:        'Black & White Contrast',
    description: 'Desaturated artwork, pure black/white palette. Timeless, serious.',
    color_tone:  'black_white',
    text_style:  'large_bold_centered',
    slide_count: 4,
    preview_emoji: '🖤',
    why_it_works: 'Removes color distraction — emotion comes purely from composition and words.',
    best_for_genres: ['classical', 'jazz', 'ambient', 'post-rock', 'metal', 'blues'],
    best_for_archetypes: ['mystery', 'raw_lyric', 'artist_identity'],
    slides: [
      { role: 'hook',   layout: 'bw_full_bleed', text_position: 'center', font_weight: 'bold',    font_size: 'xl' },
      { role: 'build',  layout: 'bw_full_bleed', text_position: 'center', font_weight: 'regular', font_size: 'lg' },
      { role: 'payoff', layout: 'bw_full_bleed', text_position: 'center', font_weight: 'bold',    font_size: 'xl' },
      { role: 'cta',    layout: 'bw_artwork',    text_position: 'bottom', font_weight: 'bold',    font_size: 'md' },
    ],
    adapt: {
      color_source: 'desaturate',
      overlay_opacity: 0.5,
      text_color: '#FFFFFF',
    },
  },

  {
    id:          'bright_pop',
    name:        'Bright Pop',
    description: 'Saturated pastel or vibrant colors, playful type, lots of energy.',
    color_tone:  'bright_energetic',
    text_style:  'large_bold_centered',
    slide_count: 4,
    preview_emoji: '🌈',
    why_it_works: 'Optimistic and fun — instantly approachable. Perfect for building early audience.',
    best_for_genres: ['pop', 'indie-pop', 'bubblegum', 'k-pop', 'dance'],
    best_for_archetypes: ['series_hook', 'lifestyle_placement', 'social_proof'],
    slides: [
      { role: 'hook',   layout: 'bright_gradient', text_position: 'center', font_weight: 'black', font_size: 'xxl' },
      { role: 'build',  layout: 'bright_solid',    text_position: 'center', font_weight: 'bold',  font_size: 'xl' },
      { role: 'payoff', layout: 'bright_gradient', text_position: 'center', font_weight: 'black', font_size: 'xxl' },
      { role: 'cta',    layout: 'bright_artwork',  text_position: 'bottom', font_weight: 'bold',  font_size: 'md' },
    ],
    adapt: {
      color_source: 'artwork_saturate_bright',
      overlay_opacity: 0.2,
      text_color: '#1a1a1a',
    },
  },

  {
    id:          'face_reaction',
    name:        'Face Reaction',
    description: 'Artist or fan face fill the frame, text overlay at top/bottom.',
    color_tone:  'warm_golden',
    text_style:  'large_bold_centered',
    slide_count: 4,
    preview_emoji: '😮',
    why_it_works: 'Faces drive the highest initial-frame retention on TikTok. Human connection is instant.',
    best_for_genres: ['pop', 'r&b', 'hip-hop', 'indie', 'country'],
    best_for_archetypes: ['social_proof', 'contrarian', 'question_hook'],
    requires_face_image: true,
    slides: [
      { role: 'hook',   layout: 'face_fill_text_top',    text_position: 'top',    font_weight: 'bold',    font_size: 'xl' },
      { role: 'build',  layout: 'face_fill_text_bottom', text_position: 'bottom', font_weight: 'regular', font_size: 'lg' },
      { role: 'payoff', layout: 'face_fill_text_top',    text_position: 'top',    font_weight: 'bold',    font_size: 'xl' },
      { role: 'cta',    layout: 'artwork_with_face',     text_position: 'bottom', font_weight: 'bold',    font_size: 'md' },
    ],
    adapt: {
      color_source: 'face_image_tone',
      overlay_opacity: 0.3,
      text_color: '#FFFFFF',
    },
  },
];

// ─── Genre → template affinity scoring ───────────────────────────────────────
function scoreTemplateForGenre(template, genre) {
  if (!genre) return 0.5;
  const g = genre.toLowerCase();
  // Exact match in best_for_genres
  if (template.best_for_genres.some(bg => g.includes(bg) || bg.includes(g))) return 1.0;
  // Color tone fallback match
  const toneGenreMap = {
    dark_moody:       ['metal', 'ambient', 'goth', 'drone', 'noise'],
    bright_energetic: ['pop', 'dance', 'edm', 'kids'],
    warm_golden:      ['folk', 'country', 'blues', 'soul', 'gospel'],
    cool_minimal:     ['classical', 'jazz', 'contemporary'],
    colorful_vibrant: ['hip-hop', 'trap', 'electronic', 'future-bass'],
    black_white:      ['post-rock', 'experimental'],
  };
  const toneGenres = toneGenreMap[template.color_tone] || [];
  if (toneGenres.some(tg => g.includes(tg) || tg.includes(g))) return 0.7;
  return 0.3; // generic fallback score
}

// ─── GET /api/templates ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { genre, archetype, color_tone } = req.query;

  let results = TEMPLATES;

  if (color_tone) {
    results = results.filter(t => t.color_tone === color_tone);
  }
  if (archetype) {
    results = results.filter(t => t.best_for_archetypes.includes(archetype));
  }

  // Sort by genre affinity if genre provided
  if (genre) {
    results = results
      .map(t => ({ ...t, _score: scoreTemplateForGenre(t, genre) }))
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...t }) => t);
  }

  res.json({ ok: true, templates: results });
});

// ─── GET /api/templates/match ─────────────────────────────────────────────────
// Returns the best template for a specific campaign/artist
router.get('/match', async (req, res) => {
  const { genre, archetype } = req.query;

  const scored = TEMPLATES
    .map(t => {
      let score = scoreTemplateForGenre(t, genre);
      if (archetype && t.best_for_archetypes.includes(archetype)) score += 0.5;
      return { ...t, _score: score };
    })
    .sort((a, b) => b._score - a._score);

  const [best, second, third] = scored;
  res.json({
    ok:           true,
    recommended:  best,
    alternatives: [second, third].filter(Boolean).map(({ _score, ...t }) => t),
  });
});

// ─── GET /api/templates/:id ───────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const template = TEMPLATES.find(t => t.id === req.params.id);
  if (!template) return res.status(404).json({ ok: false, error: 'Template not found' });
  res.json({ ok: true, template });
});

module.exports = router;
module.exports.TEMPLATES = TEMPLATES;
module.exports.scoreTemplateForGenre = scoreTemplateForGenre;
