#!/usr/bin/env node
/**
 * generate-smart-link.js — RunSound Smart Link Page Generator
 *
 * Generates a mobile-optimised landing page for a song campaign.
 * The link in TikTok bio points here — visitors pick their streaming platform.
 *
 * Reads:  config.json (song URLs, artist info)
 * Writes: <projectDir>/smart-link.html  (deploy this anywhere)
 *
 * Usage:
 *   node scripts/generate-smart-link.js --config runsound-marketing/config.json
 *
 * Deploy options:
 *   - Drag smart-link.html to Netlify Drop → get a URL instantly
 *   - GitHub Pages, Vercel, or serve from your own backend
 *   - Set the resulting URL as the TikTok bio link
 */

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(n) { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; }

const configPath = getArg('config');
if (!configPath || !fs.existsSync(configPath)) {
  console.error('Usage: node scripts/generate-smart-link.js --config <config.json>');
  process.exit(1);
}

const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const projectDir = path.dirname(configPath);
const outPath    = path.join(projectDir, 'smart-link.html');

const artist = config.artist?.name        || 'Artist';
const handle = config.artist?.tiktokHandle || '';
const song   = config.song?.title         || 'Song';
const genre  = config.song?.genre         || '';
const mood   = config.song?.mood          || '';

// ─── Streaming platforms config ───────────────────────────────────────────────
// Only platforms with a URL in config get rendered.
const PLATFORMS = [
  {
    key:   'spotifyUrl',
    name:  'Spotify',
    color: '#1DB954',
    bg:    '#1DB954',
    icon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>`,
  },
  {
    key:   'appleUrl',
    name:  'Apple Music',
    color: '#fff',
    bg:    '#fc3c44',
    icon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.064-2.31-2.18-3.043a5.022 5.022 0 00-1.726-.64c-.496-.088-1-.114-1.5-.14-.85-.041-1.7-.055-2.55-.07-.127-.003-.253-.006-.38-.009-.3-.008-.6-.015-.9-.023H9.482c-.3.008-.6.015-.9.023-.127.003-.253.006-.38.009-.85.015-1.7.029-2.55.07-.5.026-1.004.052-1.5.14a5.022 5.022 0 00-1.726.64C1.31 1.621.563 2.621.246 3.934A9.23 9.23 0 00.006 6.124C-.006 6.6 0 7.077 0 7.554v8.891c0 .478-.006.955.006 1.433.065 1.39.38 2.71 1.18 3.85.65.928 1.528 1.51 2.6 1.79.42.112.85.176 1.284.19.85.03 1.7.048 2.55.062.127.002.253.004.38.006.3.005.6.009.9.014h5.04c.3-.005.6-.009.9-.014.127-.002.253-.004.38-.006.85-.014 1.7-.032 2.55-.062a6.49 6.49 0 001.284-.19c1.072-.28 1.95-.862 2.6-1.79.8-1.14 1.115-2.46 1.18-3.85.012-.478.006-.955.006-1.433V7.554c0-.477.006-.954-.006-1.43zM12 17.5c-3.038 0-5.5-2.462-5.5-5.5S8.962 6.5 12 6.5s5.5 2.462 5.5 5.5-2.462 5.5-5.5 5.5zm5.75-9.978a1.286 1.286 0 110-2.572 1.286 1.286 0 010 2.572zM12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z"/></svg>`,
  },
  {
    key:   'youtubeUrl',
    name:  'YouTube Music',
    color: '#fff',
    bg:    '#FF0000',
    icon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.495 6.205a3.007 3.007 0 00-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 00.527 6.205a31.247 31.247 0 00-.522 5.805 31.247 31.247 0 00.522 5.783 3.007 3.007 0 002.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 002.088-2.088 31.247 31.247 0 00.5-5.783 31.247 31.247 0 00-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`,
  },
  {
    key:   'tidalUrl',
    name:  'Tidal',
    color: '#fff',
    bg:    '#000000',
    icon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996l4.004 4.004 4.004-4.004 4.004 4.004 4.004-4.004zM8.008 16.004l4.004-4.004 4.004 4.004 4.004-4.004-4.004-4.004-4.004 4.004-4.004-4.004-4.004 4.004z"/></svg>`,
  },
  {
    key:   'deezerUrl',
    name:  'Deezer',
    color: '#fff',
    bg:    '#a238ff',
    icon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.944 16.088H24v1.664h-5.056zm0-3.208H24v1.664h-5.056zm0-3.2H24v1.664h-5.056zm0-3.208H24v1.656h-5.056zM12.456 16.088h5.056v1.664h-5.056zm0-3.208h5.056v1.664h-5.056zm0-3.2h5.056v1.664h-5.056zM5.976 16.088h5.048v1.664H5.976zm0-3.208h5.048v1.664H5.976zM0 16.088h5.048v1.664H0z"/></svg>`,
  },
  {
    key:   'amazonUrl',
    name:  'Amazon Music',
    color: '#fff',
    bg:    '#00A8E1',
    icon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.7-3.182v.685zm3.186 7.705a.66.66 0 01-.77.074c-1.08-.895-1.274-1.308-1.87-2.164-1.787 1.82-3.051 2.366-5.368 2.366-2.741 0-4.873-1.69-4.873-5.075 0-2.645 1.43-4.44 3.472-5.324 1.768-.78 4.239-.92 6.127-1.133v-.423c0-.779.06-1.699-.396-2.372-.401-.601-1.168-.85-1.848-.85-1.255 0-2.37.643-2.645 1.978-.056.299-.274.594-.579.608l-3.24-.349c-.272-.062-.577-.282-.499-.7C4.868 1.597 8.056.5 10.93.5c1.468 0 3.386.391 4.546 1.503 1.468 1.37 1.329 3.195 1.329 5.183v4.695c0 1.41.584 2.031 1.135 2.793.19.275.232.603-.01.806l-2.786 2.315zm3.56 1.504c-.43.31-.864.511-1.26.556-.423.046-.912.07-1.396.023a.28.28 0 01-.259-.303.29.29 0 01.225-.254c.448-.1.946-.263 1.28-.433.315-.162.626-.393.941-.595.133-.083.265-.032.307.097.04.128-.032.258-.04.26zm-.14-1.498c-.07.042-.189.015-.259-.038-.308-.222-.568-.447-.864-.585-.302-.14-.647-.225-.975-.284-.188-.035-.322-.177-.288-.33.04-.16.244-.25.441-.206.39.08.815.239 1.184.453.376.218.703.516.93.794.085.105.093.244.01.309l.02-.113z"/></svg>`,
  },
  {
    key:   'soundcloudUrl',
    name:  'SoundCloud',
    color: '#fff',
    bg:    '#ff5500',
    icon:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.56 8.87V17h8.76c.92-.01 1.68-.78 1.68-1.72a1.71 1.71 0 00-1.56-1.72c.09-.28.14-.57.14-.87a3.75 3.75 0 00-3.75-3.75c-.44 0-.87.08-1.26.21A4.24 4.24 0 0011.56 8.87zM0 15.28a2.22 2.22 0 002.22 2.22 2.22 2.22 0 002.22-2.22V9.91A2.22 2.22 0 002.22 7.7 2.22 2.22 0 000 9.91v5.37zm6.89 1.3V8.4a.89.89 0 01.89-.89.89.89 0 01.89.89v8.18a.89.89 0 01-.89.89.89.89 0 01-.89-.89zm2.67.35V7.12a.89.89 0 01.89-.89.89.89 0 01.89.89v9.81a.89.89 0 01-.89.89.89.89 0 01-.89-.89z"/></svg>`,
  },
];

// ─── Build HTML ───────────────────────────────────────────────────────────────
function buildHTML() {
  const activePlatforms = PLATFORMS.filter(p => config.song?.[p.key]);

  const platformButtons = activePlatforms.map(p => `
        <a href="${config.song[p.key]}" class="platform-btn" style="background:${p.bg}" target="_blank" rel="noopener" data-platform="${p.name}">
          <span class="platform-icon">${p.icon}</span>
          <span class="platform-name">Listen on ${p.name}</span>
          <span class="platform-arrow">›</span>
        </a>`).join('\n');

  const noLinks = activePlatforms.length === 0
    ? `<p style="color:rgba(255,255,255,0.5);text-align:center;margin-top:2rem">No streaming links configured yet.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <meta name="theme-color" content="#0a0a0a">
  <title>${song} — ${artist}</title>
  <meta property="og:title" content="${song} — ${artist}">
  <meta property="og:description" content="Listen to ${song} by ${artist} on your favourite platform">
  <meta name="twitter:card" content="summary">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1.25rem;
      overflow-x: hidden;
    }

    /* Ambient glow behind artwork */
    .glow {
      position: fixed;
      inset: 0;
      background: radial-gradient(ellipse 80% 60% at 50% 20%, rgba(80,40,160,0.35) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .card {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 420px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
    }

    /* Artwork placeholder — square with gradient */
    .artwork {
      width: 180px;
      height: 180px;
      border-radius: 16px;
      background: linear-gradient(135deg, #6c3fcc 0%, #c0392b 50%, #e67e22 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 64px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.6);
      margin-bottom: 1.5rem;
      overflow: hidden;
      flex-shrink: 0;
    }
    .artwork img {
      width: 100%; height: 100%; object-fit: cover;
    }

    .song-title {
      font-size: 1.6rem;
      font-weight: 700;
      text-align: center;
      line-height: 1.2;
      letter-spacing: -0.02em;
      margin-bottom: 0.3rem;
    }

    .artist-name {
      font-size: 1rem;
      color: rgba(255,255,255,0.55);
      text-align: center;
      margin-bottom: 0.4rem;
    }

    .genre-badge {
      display: inline-block;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 100px;
      padding: 0.2rem 0.75rem;
      font-size: 0.72rem;
      color: rgba(255,255,255,0.5);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 2rem;
    }

    .platforms {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .platform-btn {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      padding: 0.9rem 1.1rem;
      border-radius: 14px;
      text-decoration: none;
      color: #fff;
      font-weight: 600;
      font-size: 0.95rem;
      transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      -webkit-tap-highlight-color: transparent;
    }

    .platform-btn:active {
      transform: scale(0.97);
      opacity: 0.9;
    }

    @media (hover: hover) {
      .platform-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      }
    }

    .platform-icon {
      width: 26px;
      height: 26px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .platform-icon svg {
      width: 22px;
      height: 22px;
    }

    .platform-name { flex: 1; }

    .platform-arrow {
      font-size: 1.1rem;
      opacity: 0.7;
    }

    .footer {
      margin-top: 2.5rem;
      text-align: center;
      font-size: 0.75rem;
      color: rgba(255,255,255,0.2);
      z-index: 1;
    }
    .footer a {
      color: rgba(255,255,255,0.3);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="glow"></div>
  <div class="card">
    <div class="artwork">🎵</div>
    <h1 class="song-title">${song}</h1>
    <p class="artist-name">${artist}${handle ? ` · <span style="opacity:0.7">${handle}</span>` : ''}</p>
    ${genre ? `<span class="genre-badge">${genre}</span>` : ''}
    <div class="platforms">
${platformButtons}
${noLinks}
    </div>
  </div>
  <div class="footer">
    Powered by <a href="https://runsound.se" target="_blank">RunSound</a>
  </div>

  <script>
    // Track clicks for analytics (optional — add your own analytics here)
    document.querySelectorAll('.platform-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const platform = btn.dataset.platform;
        if (typeof gtag !== 'undefined') gtag('event', 'click', { event_category: 'platform', event_label: platform });
        // Add any other analytics here
      });
    });
  </script>
</body>
</html>`;
}

// ─── Write output ─────────────────────────────────────────────────────────────
const html = buildHTML();
fs.writeFileSync(outPath, html, 'utf8');

const activePlatforms = PLATFORMS.filter(p => config.song?.[p.key]);

console.log('\n🔗 RunSound — Smart Link Generator');
console.log('====================================');
console.log(`   Artist:    ${artist}`);
console.log(`   Song:      ${song}`);
console.log(`   Platforms: ${activePlatforms.map(p => p.name).join(', ') || 'none — fill in URLs in config.json'}`);
console.log(`\n   Output:    ${outPath}`);
console.log(`\n   Next steps:`);
console.log(`   1. Fill in streaming URLs in config.json (appleUrl, tidalUrl, etc.)`);
console.log(`   2. Host smart-link.html at a public URL`);
console.log(`      → Netlify Drop:  drag smart-link.html to app.netlify.com/drop`);
console.log(`      → Or add to your RunSound backend at /l/<slug>`);
console.log(`   3. Set that URL as your TikTok bio link`);
console.log(`   4. RunSound CTA slide already says "🎵 link in bio"\n`);
