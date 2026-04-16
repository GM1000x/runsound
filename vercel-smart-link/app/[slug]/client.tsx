'use client'

interface Song {
  slug: string
  artist_name: string
  title: string
  cover_url: string | null
  spotify_url: string | null
  apple_url: string | null
}

async function trackClick(slug: string, destination: string) {
  await fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, destination }),
  }).catch(() => {}) // Never block redirect
}

export default function SmartLinkClient({ song }: { song: Song }) {
  const handleClick = async (destination: string, url: string) => {
    await trackClick(song.slug, destination)
    window.location.href = url
  }

  return (
    <main style={{
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      background: '#0a0a0a',
      color: '#fff',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      <div style={{ maxWidth: 400, width: '100%', textAlign: 'center' }}>

        {/* Cover art */}
        {song.cover_url ? (
          <img
            src={song.cover_url}
            alt={`${song.title} cover`}
            style={{
              width: 220, height: 220,
              borderRadius: 12,
              objectFit: 'cover',
              margin: '0 auto 28px',
              display: 'block',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          />
        ) : (
          <div style={{
            width: 220, height: 220,
            borderRadius: 12,
            background: '#222',
            margin: '0 auto 28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="white" style={{ opacity: 0.3 }}>
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
        )}

        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.3px', marginBottom: 6 }}>
          {song.title}
        </h1>
        <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.55)', marginBottom: 32 }}>
          {song.artist_name}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {song.spotify_url && (
            <button
              onClick={() => handleClick('spotify', song.spotify_url!)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                padding: '15px 20px', borderRadius: 50, fontSize: 15, fontWeight: 600,
                background: '#1DB954', color: '#000', border: 'none', cursor: 'pointer', width: '100%',
              }}
            >
              <SpotifyIcon />
              Listen on Spotify
            </button>
          )}

          {song.apple_url && (
            <button
              onClick={() => handleClick('apple', song.apple_url!)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                padding: '15px 20px', borderRadius: 50, fontSize: 15, fontWeight: 600,
                background: '#fc3c44', color: '#fff', border: 'none', cursor: 'pointer', width: '100%',
              }}
            >
              <AppleIcon />
              Listen on Apple Music
            </button>
          )}
        </div>

        <p style={{ marginTop: 32, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>
          runsound.fm
        </p>
      </div>
    </main>
  )
}

function SpotifyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
    </svg>
  )
}

function AppleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
    </svg>
  )
}
