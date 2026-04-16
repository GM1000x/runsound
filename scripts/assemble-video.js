#!/usr/bin/env node
/**
 * RunSound — Assemble 6 slides into video with audio
 *
 * Takes slide1.png through slide6.png and the artist's MP3,
 * creates a video where each slide shows for 3 seconds with the song
 * starting at hookTimestamp. Used to verify lyric sync before posting.
 *
 * Usage: node assemble-video.js --input runsound-marketing/posts/latest --config runsound-marketing/config.json
 *
 * Output:
 *   slideshow_with_audio.mp4  — for sync verification (you watch this)
 *   slideshow_silent.mp4      — created by strip-audio.js, goes to TikTok
 */

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegStatic);

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputDir = getArg('input');
const configPath = getArg('config');

if (!inputDir || !configPath) {
  console.error('Usage: node assemble-video.js --input <dir> --config <config.json>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Parse hookTimestamp "0:47" → seconds (47)
function timestampToSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

const SLIDE_DURATION = 3; // seconds per slide
const TOTAL_DURATION = 6 * SLIDE_DURATION; // 18 seconds
const hookStart = timestampToSeconds(config.song.hookTimestamp || '0:00');
const mp3Path = config.song.mp3Path;
const outputPath = path.join(inputDir, 'slideshow_with_audio.mp4');

if (!fs.existsSync(mp3Path)) {
  console.error(`❌ MP3 not found: ${mp3Path}`);
  process.exit(1);
}

// Verify all 6 slides exist
for (let i = 1; i <= 6; i++) {
  const slidePath = path.join(inputDir, `slide${i}.png`);
  if (!fs.existsSync(slidePath)) {
    console.error(`❌ Missing slide: ${slidePath}`);
    console.error(`   Run 'npm run overlay' first.`);
    process.exit(1);
  }
}

console.log(`\n🎬 Assembling video...`);
console.log(`   Slides: ${inputDir}/slide1-6.png`);
console.log(`   Audio:  ${mp3Path} (starting at ${config.song.hookTimestamp})`);
console.log(`   Duration: ${TOTAL_DURATION}s (${SLIDE_DURATION}s per slide)`);
console.log(`   Output: ${outputPath}\n`);

// Build FFmpeg concat input file
const concatFile = path.join(os.tmpdir(), `runsound_concat_${Date.now()}.txt`);
let concatContent = '';
for (let i = 1; i <= 6; i++) {
  const slidePath = path.resolve(path.join(inputDir, `slide${i}.png`));
  concatContent += `file '${slidePath}'\nduration ${SLIDE_DURATION}\n`;
}
// Add last image again (FFmpeg concat requires this)
concatContent += `file '${path.resolve(path.join(inputDir, 'slide6.png'))}'\n`;
fs.writeFileSync(concatFile, concatContent);

ffmpeg()
  .input(concatFile)
  .inputOptions(['-f concat', '-safe 0'])
  .input(mp3Path)
  .inputOptions([`-ss ${hookStart}`])  // Start audio at hook timestamp
  .outputOptions([
    '-c:v libx264',
    '-preset fast',
    '-crf 23',
    '-c:a aac',
    '-b:a 192k',
    `-t ${TOTAL_DURATION}`,
    '-pix_fmt yuv420p',
    '-movflags +faststart',
    '-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2'
  ])
  .output(outputPath)
  .on('start', () => console.log('   Processing...'))
  .on('progress', p => {
    if (p.percent) process.stdout.write(`\r   Progress: ${Math.round(p.percent)}%`);
  })
  .on('end', () => {
    fs.unlinkSync(concatFile); // Clean up temp file
    const size = fs.statSync(outputPath).size;
    console.log(`\n\n✅ Video assembled: ${outputPath} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    console.log(`\n👀 Watch this video to verify lyric sync.`);
    console.log(`   The song starts at ${config.song.hookTimestamp}.`);
    console.log(`   The text on screen should match what you hear.\n`);
    console.log(`If sync looks good → npm run strip`);
    console.log(`If sync is off    → edit song.hookTimestamp in config.json and re-run\n`);
  })
  .on('error', err => {
    if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
    console.error(`\n❌ FFmpeg error: ${err.message}`);
    process.exit(1);
  })
  .run();
