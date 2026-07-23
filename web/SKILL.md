# RunSound Skills — Music Marketing for AI Agents

> **One skill. Every music promotion tool your agent needs.**
> Find creators, send DMs, generate hooks, schedule posts, pitch playlists — all billed per call from one credit balance.

## Setup

```bash
npx runsound install
```

Or add directly to your agent:

```
$set up https://run-sound.com/SKILL.md
```

---

## Authentication

Every call requires your RunSound API key:

```
RUNSOUND_API_KEY=rs_live_xxxxxxxxxxxx
```

Get your key at **run-sound.com/settings/api** after adding credits.

---

## How It Works

1. Tell your agent what you want: *"Promote my new track, budget $20"*
2. The agent calls `/api/skills/discover` to find the right skills
3. Skills run against your artist account and Spotify track
4. Credits are debited per call — you only pay for what runs
5. Results are returned as structured JSON your agent can act on

---

## Core Skills

### 🚀 full-campaign ⭐ RECOMMENDED
Run a complete music promotion campaign end-to-end in a single call. Generates hooks, scouts TikTok creators matched to your song, queues personalized DMs, and activates sound tracking — all automatically.

**Input:**
```json
{
  "skill": "full-campaign",
  "spotify_url": "https://open.spotify.com/track/...",
  "artist_name": "My Artist",
  "song_title": "My Song",
  "follower_min": 1000,
  "follower_max": 100000,
  "creator_limit": 30,
  "hooks_count": 5
}
```
**Output:** Hooks, matched creators, trending formats, queued DMs, tracking status, next steps.
**Cost:** $0.02 per action (scout + DM + track combined)

**Example agent prompt:** *"Promote my new track [spotify url], find 30 creators and run a full campaign"*

---

### 💸 creator-offers ⭐ NEW
Pay TikTok creators directly — no middleman, no platform cut. Set a budget, and creators get paid automatically the moment they post with your sound.

**Recommended pricing:** $10–25 per post for micro-creators (5k–20k followers). This gives you 10–20 algorithm chances for the same budget as one mid-size creator — and micro-creators have higher engagement rates.

**Input:**
```json
{
  "skill": "creator-offers",
  "track_name": "My Song",
  "spotify_url": "https://open.spotify.com/track/...",
  "payout_per_post_usd": 15,
  "max_creators": 10
}
```
**Output:** Offer created, escrow funded, invite link ready to send in DMs. Payment releases automatically when sound-tracker confirms each post.
**Cost:** $0.05 per offer created (API fee only — 100% of your creator budget goes to creators)

**Example agent prompt:** *"Create a $150 creator offer for my track — $15 per post, 10 micro-creators"*

---

### 🎯 creator-scout
Find TikTok creators whose content matches your song's energy, genre and mood.

**Input:**
```json
{
  "skill": "creator-scout",
  "spotify_url": "https://open.spotify.com/track/...",
  "follower_min": 1000,
  "follower_max": 50000,
  "limit": 100
}
```
**Output:** Array of creators with username, followers, engagement rate, bio, email (if available), content categories.
**Cost:** $0.01 per creator found

---

### 📨 dm-outreach
Send personalized TikTok DMs to creators. GPT writes a unique message per creator based on their bio and your song.

**Input:**
```json
{
  "skill": "dm-outreach",
  "campaign_id": "uuid",
  "creator_usernames": ["@username1", "@username2"],
  "song_title": "My Song",
  "artist_name": "My Artist"
}
```
**Output:** Delivery status per creator.
**Cost:** $0.03 per DM sent

---

### 🪝 hook-generator
Generate viral TikTok hooks for a track based on trending formats in your genre.

**Input:**
```json
{
  "skill": "hook-generator",
  "spotify_url": "https://open.spotify.com/track/...",
  "count": 5,
  "formats": ["pov", "storytime", "before-after"]
}
```
**Output:** Array of hooks with caption, format type, trending score.
**Cost:** $0.05 per hook generated

---

### 📅 post-scheduler
Schedule and post content to TikTok at optimal times.

**Input:**
```json
{
  "skill": "post-scheduler",
  "campaign_id": "uuid",
  "posts": [
    {
      "caption": "...",
      "image_url": "...",
      "scheduled_for": "2026-07-22T08:00:00Z"
    }
  ]
}
```
**Output:** Scheduled post IDs and confirm times.
**Cost:** $0.05 per post scheduled

---

### 🎵 sound-tracker
Monitor TikTok to detect when creators use your sound in their videos.

**Input:**
```json
{
  "skill": "sound-tracker",
  "campaign_id": "uuid",
  "tiktok_sound_url": "https://www.tiktok.com/music/...",
  "creator_usernames": ["@username1"]
}
```
**Output:** List of creators who have posted with your sound, video URLs, view counts.
**Cost:** $0.01 per creator checked

---

### 🎧 playlist-pitcher
Find Spotify playlist curators in your genre and send personalized pitches.

**Input:**
```json
{
  "skill": "playlist-pitcher",
  "spotify_url": "https://open.spotify.com/track/...",
  "genre": "Indie Pop",
  "limit": 20
}
```
**Output:** Pitches sent, curator names, playlist sizes.
**Cost:** $0.10 per pitch sent

---

### 📰 press-pitcher
Find music blogs, Substack writers and playlist curators covering your genre and send pitches.

**Input:**
```json
{
  "skill": "press-pitcher",
  "spotify_url": "https://open.spotify.com/track/...",
  "genre": "Hip-Hop",
  "limit": 10
}
```
**Output:** Pitches sent, outlet names, estimated reach.
**Cost:** $0.10 per pitch sent

---

### 📦 release-kit
Generate a complete release marketing package: press release, bio, social captions, pitch templates.

**Input:**
```json
{
  "skill": "release-kit",
  "spotify_url": "https://open.spotify.com/track/...",
  "artist_name": "My Artist",
  "release_date": "2026-08-01",
  "artist_bio": "..."
}
```
**Output:** Press release (markdown), short bio, 10 social captions, email pitch template.
**Cost:** $0.25 per kit

---

### 🎤 gig-pitcher
Scans your city for live music venues that fit your genre and vibe — then writes a personalized booking pitch for every one it finds. You get as many pitches as there are relevant venues.

**Input:**
```json
{
  "skill": "gig-pitcher",
  "city": "Stockholm",
  "country": "Sweden",
  "genre": "indie pop",
  "artist_name": "My Artist",
  "artist_bio": "Indie pop artist with 3 EPs and 50k monthly Spotify listeners.",
  "spotify_url": "https://open.spotify.com/artist/..."
}
```
**Output:** All relevant venues found in your city, each with a personalized booking pitch email ready to send. Number of pitches depends on how many fitting venues exist.
**Cost:** $0.25 per pitch generated

**Example agent prompt:** *"Find gig opportunities for me in Gothenburg, I play jazz"*

---

### 📈 trend-matcher
Match your song to currently trending TikTok formats, sounds and hashtags.

**Input:**
```json
{
  "skill": "trend-matcher",
  "spotify_url": "https://open.spotify.com/track/...",
  "genre": "Pop"
}
```
**Output:** Top 5 matching trend formats with hook templates and hashtag sets.
**Cost:** $0.05 per analysis

---

## Discover Skills

Your agent can find the right skill for any task:

```
GET https://run-sound.com/api/skills/discover?q=find creators for my track
```

Returns ranked skill suggestions with descriptions and pricing.

---

## Run a Skill

```
POST https://run-sound.com/api/skills/run
Authorization: Bearer rs_live_xxxxxxxxxxxx
Content-Type: application/json

{
  "skill": "creator-scout",
  "spotify_url": "https://open.spotify.com/track/...",
  "limit": 50
}
```

---

## Check Balance

```
GET https://run-sound.com/api/credits/balance
Authorization: Bearer rs_live_xxxxxxxxxxxx
```

```json
{
  "credits": 4.82,
  "currency": "USD",
  "low_balance_warning": false
}
```

---

## Add Credits

Top up at **run-sound.com/settings/credits** or via API with Stripe:

```
POST https://run-sound.com/api/credits/topup
Authorization: Bearer rs_live_xxxxxxxxxxxx

{ "amount_usd": 10 }
```

Returns a Stripe Checkout URL.

---

## Third-Party Skills

RunSound is an open platform. Independent developers can list their own music marketing skills — sync pitching, radio promotion, music video production, and more.

**Browse all skills:** run-sound.com/skills
**Submit a skill:** run-sound.com/developers

Revenue split: **70% to skill developer / 30% to RunSound**

---

## Example Agent Prompts

> *"Promote my Spotify track [url] with a $15 budget. Find matching creators, send DMs, and report back."*

> *"Generate 10 TikTok hooks for [url] in a storytime format."*

> *"Scout 50 fitness creators for my new EDM track and start outreach."*

> *"Build a full release kit for my track dropping next Friday."*

---

## Supported Agents

RunSound skills work with Claude Code, Claude Desktop (via MCP), Cursor, Goose, Codex, and any agent that can read markdown and make HTTP requests.

**MCP server:** `run-sound.com/mcp`
**Docs:** `run-sound.com/docs`
**Support:** `support@run-sound.com`
