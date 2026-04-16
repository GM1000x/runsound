# RunSound — Automated TikTok Marketing for Music Artists

Automate your entire TikTok music marketing pipeline:
**generate → overlay → assemble → strip → post → track → iterate**

---

## Setup

### 1. Install dependencies
```bash
npm install
```

> **node-canvas** requires system libraries. If `npm install` fails:
>
> **Ubuntu/Replit:**
> ```bash
> sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
> npm install
> ```
>
> **macOS:**
> ```bash
> brew install pkg-config cairo pango libpng jpeg giflib librsvg
> npm install
> ```

### 2. Initialise project structure
```bash
npm run init
```

### 3. Add your assets
- Copy your song MP3 to `runsound-marketing/assets/song.mp3`
- Copy your cover art to `runsound-marketing/assets/cover.jpg`

### 4. Fill in config
Edit `runsound-marketing/config.json`:
- Artist name, genre, mood, target audience
- Song title, Spotify URL, Apple Music URL
- OpenAI API key
- Postiz API key + TikTok integration ID
- Supabase URL + key

### 5. Analyse audio (finds best hook moment automatically)
```bash
npm run whisper
```
This transcribes your MP3, finds the most energetic 15 seconds, and writes the `hookTimestamp` and `hookLines` to config.

### 6. Validate config
```bash
npm run onboard
```

---

## Daily Workflow

```bash
npm run generate   # Generate 6 slides with gpt-image-1.5 (~5 min)
npm run overlay    # Add lyric text to slides
npm run assemble   # Create video with audio for sync check
# 👀 Watch slideshow_with_audio.mp4 to verify sync
npm run strip      # Remove audio → slideshow_silent.mp4
npm run post       # Send silent video to TikTok drafts
```

### In TikTok (30 seconds):
1. Open TikTok inbox → find your draft
2. Tap **Add sound**
3. Search for your song
4. Start audio at **[hookTimestamp from config]**
5. Tap **Post**

---

## Analytics & Iteration

```bash
npm run analytics  # Connect posts to TikTok video IDs, pull stats
npm run report     # Daily report: views + Spotify clicks + recommendations
```

---

## The Loop

```
Generate slides → Post draft → Artist adds music → Publish
       ↑                                                 ↓
  Iterate on                                    Track Spotify
  winning format                                  clicks (UTM)
       ↑                                                ↓
   Daily report ←──── Which content converts best? ────┘
```

---

## Files

```
runsound/
├── scripts/
│   ├── onboarding.js        Init & validate config
│   ├── whisper-sync.js      Analyse MP3, find hook moment
│   ├── generate-slides.js   Generate 6 images with gpt-image-1.5
│   ├── add-text-overlay.js  Add lyric text (node-canvas)
│   ├── assemble-video.js    Combine slides + audio for sync check
│   ├── strip-audio.js       Remove audio → TikTok-ready draft
│   ├── post-to-tiktok.js    Upload to TikTok via Postiz
│   ├── check-analytics.js   Connect posts to TikTok IDs, pull stats
│   └── daily-report.js      Analytics report + recommendations
├── runsound-marketing/
│   ├── config.json          Your artist + song + API keys
│   ├── assets/
│   │   ├── song.mp3         Your song (max 25MB for Whisper)
│   │   └── cover.jpg        Cover art
│   └── posts/               Generated content
└── package.json
```
