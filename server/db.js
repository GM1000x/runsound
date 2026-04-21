/**
 * RunSound — SQLite database setup
 * Uses built-in node:sqlite (Node 22+) — no native compilation needed
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'runsound.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent performance
db.exec("PRAGMA journal_mode = WAL;");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`CREATE TABLE IF NOT EXISTS artists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
        genre       TEXT,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
          )`);

db.exec(`CREATE TABLE IF NOT EXISTS songs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_slug  TEXT NOT NULL,
      slug         TEXT NOT NULL,
        title        TEXT NOT NULL,
          cover_url    TEXT,
            spotify_url  TEXT,
              apple_url    TEXT,
                youtube_url  TEXT,
                  tidal_url    TEXT,
                    amazon_url   TEXT,
                      deezer_url   TEXT,
                        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
                        )`);

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_artist_slug ON songs(artist_slug, slug)`);

db.exec(`CREATE TABLE IF NOT EXISTS clicks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_slug  TEXT NOT NULL,
      song_slug    TEXT NOT NULL,
        platform     TEXT NOT NULL,
          utm_source   TEXT,
            utm_medium   TEXT,
              utm_campaign TEXT,
                clicked_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
                  user_agent   TEXT
                  )`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_clicks_campaign   ON clicks(utm_campaign)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_clicks_artist     ON clicks(artist_slug)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_clicks_platform   ON clicks(platform)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_clicks_clicked_at ON clicks(clicked_at)`);

// ─── Queries ──────────────────────────────────────────────────────────────────

const getSong = db.prepare(`
  SELECT songs.*, artists.name as artist_name FROM songs
    LEFT JOIN artists ON songs.artist_slug = artists.slug
      WHERE songs.artist_slug = ? AND songs.slug = ?
      `);

const logClick = db.prepare(`
  INSERT INTO clicks (artist_slug, song_slug, platform, utm_source, utm_medium, utm_campaign, user_agent)
    VALUES (@artist_slug, @song_slug, @platform, @utm_source, @utm_medium, @utm_campaign, @user_agent)
    `);

const getClicksByCampaign = db.prepare(`
  SELECT
      utm_campaign,
          platform,
              COUNT(*) as clicks,
                  MIN(clicked_at) as first_click,
                      MAX(clicked_at) as last_click
                        FROM clicks
                          WHERE artist_slug = ? AND clicked_at >= datetime('now', ?)
                            GROUP BY utm_campaign, platform
                              ORDER BY clicks DESC
                              `);

const getClickSummary = db.prepare(`
  SELECT
      utm_campaign,
          COUNT(*) as total_clicks,
              COUNT(DISTINCT platform) as platforms_used
                FROM clicks
                  WHERE artist_slug = ? AND clicked_at >= datetime('now', ?)
                    GROUP BY utm_campaign
                      ORDER BY total_clicks DESC
                      `);

const upsertArtist = db.prepare(`
  INSERT INTO artists (slug, name, genre)
    VALUES (@slug, @name, @genre)
      ON CONFLICT(slug) DO UPDATE SET name=excluded.name, genre=excluded.genre
      `);

const upsertSong = db.prepare(`
  INSERT INTO songs (artist_slug, slug, title, cover_url, spotify_url, apple_url, youtube_url, tidal_url, amazon_url, deezer_url)
    VALUES (@artist_slug, @slug, @title, @cover_url, @spotify_url, @apple_url, @youtube_url, @tidal_url, @amazon_url, @deezer_url)
      ON CONFLICT(artist_slug, slug) DO UPDATE SET
          title=excluded.title,
              cover_url=excluded.cover_url,
                  spotify_url=excluded.spotify_url,
                      apple_url=excluded.apple_url,
                          youtube_url=excluded.youtube_url,
                              tidal_url=excluded.tidal_url,
                                  amazon_url=excluded.amazon_url,
                                      deezer_url=excluded.deezer_url
                                      `);

module.exports = {
    db,
    getSong,
    logClick,
    getClicksByCampaign,
    getClickSummary,
    upsertArtist,
    upsertSong
};
