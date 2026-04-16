#!/usr/bin/env node
/**
 * RunSound — Strip audio from assembled video
 *
 * Takes the video assembled with audio (for sync verification) and
 * produces a silent version ready to send to TikTok drafts.
 *
 * The artist then adds their song manually in TikTok at the hookTimestamp.
 *
 * Usage: node strip-audio.js --input runsound-marketing/posts/latest --config runsound-marketing/config.json
 *
 * Input:  slideshow_with_audio.mp4
 * Output: slideshow_silent.mp4  (this goes to TikTok)
 */

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegStatic);

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputDir = getArg('input');
const configPath = getArg('config');

if (!inputDir || !configPath) {
  console.error('Usage: node strip-audio.js --input <dir> --config <config.json>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const inputVideo = path.join(inputDir, 'slideshow_with_audio.mp4');
const outputVideo = path.join(inputDir, 'slideshow_silent.mp4');

if (!fs.existsSync(inputVideo)) {
  console.error(`❌ Input video not found: ${inputVideo}`);
  console.error(`   Run 'npm run assemble' first.`);
  process.exit(1);
}

console.log('\n🔇 Stripping audio from video...');
console.log(`   Input:  ${inputVideo}`);
console.log(`   Output: ${outputVideo}\n`);

ffmpeg(inputVideo)
  .noAudio()
  .videoCodec('copy')
  .output(outputVideo)
  .on('start', cmd => console.log(`   FFmpeg: ${cmd}`))
  .on('end', () => {
    const size = fs.statSync(outputVideo).size;
    console.log(`\n✅ Silent video ready: ${outputVideo} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    console.log(`\n📋 This file goes to TikTok drafts.`);
    console.log(`   When publishing from TikTok inbox:`);
    console.log(`   → Tap "Add sound"`);
    console.log(`   → Search for: "${config.song.title}" by ${config.artist.name}`);
    console.log(`   → Start the song at: ${config.song.hookTimestamp}`);
    console.log(`   → Publish!\n`);
    console.log(`Next step: npm run post\n`);
  })
  .on('error', err => {
    console.error(`❌ FFmpeg error: ${err.message}`);
    process.exit(1);
  })
  .run();
