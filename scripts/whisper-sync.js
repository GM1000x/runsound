#!/usr/bin/env node
/**
 * RunSound — Whisper Audio Analyser
 *
 * Sends the artist's MP3 to OpenAI Whisper to:
 *   1. Transcribe all lyrics with word-level timestamps
 *   2. Identify the best 15-second hook window
 *   3. Suggest the hookTimestamp for config.json
 *   4. Generate per-slide text suggestions
 *
 * Usage: node whisper-sync.js --config runsound-marketing/config.json
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const args = process.argv.slice(2);
function getArg(name) { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null; }

const configPath = getArg('config');
if (!configPath) { console.error('Usage: node whisper-sync.js --config <path>'); process.exit(1); }

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const openai = new OpenAI({ apiKey: config.imageGen.apiKey });

function formatTimestamp(s) { const m = Math.floor(s/60); return `${m}:${Math.floor(s/60 % 60).toString().padStart(2,'0')}`; }

function findBestHookWindow(segs, dur = 15) {
  if (!segs?.length) return 0;
  const total = segs[segs.length-1].end;
  const startMin = total * 0.15;
  let bestScore = -1, bestStart = startMin;
  for (let t = startMin; t < total - dur; t += 1) {
    const words = segs.filter(s => s.start >= t && s.end <= t + dur).reduce((sum, s) => sum + (s.text?.trim().split(/\s+/).length || 0), 0);
    if (words > bestScore) { bestScore = words; bestStart = t; }
  }
  return bestStart;
}

function extractHookLines(segs, start, dur = 15) {
  return segs.filter(s => s.start >= start && s.end <= start + dur)
    .map(s => s.text?.trim()).filter(l => l && l.length > 10);
}

function generateBasePrompt(artist) {
  const moodStyles = {
    melancholic: 'moody, blue and grey tones, soft bokeh, cinematic',
    sad: 'moody, desaturated colors, rain or fog',
    energetic: 'vibrant, high contrast, dynamic lighting',
    happy: 'warm golden tones, sunlight, bright and airy',
    romantic: 'warm pinks and purples, soft focus, dreamy',
    dark: 'dramatic shadows, noir, deep colors',
    nostalgic: 'film grain, warm vintage tones',
    uplifting: 'bright, golden hour lighting'
  };
  const moodStyle = moodStyles[artist.mood?.toLowerCase()] || 'atmospheric, cinematic';
  return `iPhone photo, ${moodStyle}. Natural phone camera quality, realistic lighting. Portrait 9:16. No text, no logos.`;
}

(async () => {
  const mp3Path = config.song.mp3Path;
  if (!fs.existsSync(mp3Path)) { console.error(`❌ MP3 not found: ${mp3Path}`); process.exit(1); }

  console.log(`\nAnalysing: ${path.basename(mp3Path)}\n`);
  console.log('Sending to OpenAI Whisper...');

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(mp3Path),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment']
  });

  console.log('Transcription complete!\n');
  const segs = transcription.segments || [];
  console.log('Full lyrics:\n' + transcription.text + '\n');

  const hookStart = findBestHookWindow(segs);
  const hookTs = formatTimestamp(hookStart);
  const hookLines = extractHookLines(segs, hookStart);

  console.log(`Best hook window: ${hookTs} (${hookStart.toFixed(1)}s - ${(hookStart+15).toFixed(1)}s)\n`);
  console.log('Hook lines:');
  hookLines.forEach((l, i) => console.log(`  Slide ${i+1}: "${l}"`));

  config.song.hookTimestamp = hookTs;
  config.song.hookLines = hookLines.slice(0, 6);
  config.song.whisperTranscript = { fullText: transcription.text, segments: segs.map(s => ({ start: s.start, end: s.end, text: s.text?.trim() })) };

  if (!config.imageGen.basePrompt) {
    config.imageGen.basePrompt = generateBasePrompt(config.artist);
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\nConfig updated: ${configPath}`);
  console.log(`Hook timestamp: ${hookTs} - use this when adding sound in TikTok\n`);
  console.log('Next: npm run generate\n');
})();
