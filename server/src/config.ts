// Everything the container needs, from the environment. Defaults are the
// homelab defaults: mount your music at /music, keep state in /data.
import path from 'node:path';

const env = (k: string, d: string) => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  musicDir: path.resolve(env('MUSIC_DIR', '/music')),
  // Three places: config (the database, avatars, imports: small, precious),
  // cache (song heads, transcodes, artwork sizes: all rebuildable, on the SSD)
  // and the music itself (MUSIC_DIR, may be a NAS).
  dataDir: path.resolve(env('CONFIG_DIR', env('DATA_DIR', '/data'))),
  cacheDir: path.resolve(env('CACHE_DIR', env('CONFIG_DIR', env('DATA_DIR', '/data')))),
  // Heads (the first HEAD_SECONDS of every song mirrored to the cache so
  // playback starts at SSD speed while a NAS wakes). HEADS=0 turns the whole
  // machinery off: no cutting at scan, every byte read from MUSIC_DIR.
  headsEnabled: env('HEADS', '1') !== '0',
  headSeconds: Number(env('HEAD_SECONDS', '5')),
  // HLS transcodes under CACHE_DIR/transcodes; the nightly trim drops the
  // oldest-used past this size.
  transcodeCacheGb: Number(env('TRANSCODE_CACHE_GB', '60')),
  // Whole songs copied from the NAS to the cache when they are about to play,
  // least recently played dropped first past this size (0 = off).
  songCacheGb: Number(env('SONG_CACHE_GB', '0')),
  // A full walk of MUSIC_DIR at boot and every SCAN_EVERY_H hours (0 = never);
  // SCAN_PAUSE_MS between files keeps a walk over a NAS gentle.
  scanOnBoot: env('SCAN_ON_BOOT', '1') !== '0',
  scanEveryH: Number(env('SCAN_EVERY_H', '6')),
  scanPauseMs: Number(env('SCAN_PAUSE_MS', '0')),
  // New music lands in INCOMING_DIR (SSD) and is moved to NAS_DIR (see ingest.ts).
  ingest: {
    incomingDir: env('INCOMING_DIR', ''),
    nasDir: env('NAS_DIR', env('MUSIC_DIR', '/music')),
    everyMin: Number(env('INGEST_EVERY_MIN', '10')),
    settleMin: Number(env('INGEST_SETTLE_MIN', '10')),
    deleteAfter: env('INGEST_DELETE', '0') === '1',
    deleteSettleMin: Number(env('INGEST_DELETE_SETTLE_MIN', '60')), // nothing written in a folder this long before it is deleted
  },
  publicUrl: env('PUBLIC_URL', '').replace(/\/+$/, ''),
  adminUser: env('ADMIN_USER', 'admin'),
  adminPass: env('ADMIN_PASS', 'admin'),
  logLevel: env('LOG_LEVEL', 'info'),
  loginRateMax: Number(env('LOGIN_RATE_MAX', '10')), // per IP per minute; raised for the E2E suite
  // Find and drive Chromecast / BluOS speakers on the server's network (needs host networking in Docker).
  speakers: env('SPEAKERS', '1') !== '0',
  // slskd (Soulseek) for the Weekly Exploration playlist: tracks the library lacks are fetched through it.
  slskdUrl: env('SLSKD_URL', '').replace(/\/+$/, ''),
  slskdKey: env('SLSKD_API_KEY', ''),
  // Music Requests (Spotify lookups + the album download queue) for the artist
  // page's full discography, "Request" buttons, Release Radar and global search.
  musicRequestsUrl: env('MUSIC_REQUESTS_URL', '').replace(/\/+$/, ''),
  // Generated playlists: Claude through the Anthropic API.
  ai: {
    apiKey: env('ANTHROPIC_API_KEY', '') || undefined,
    model: env('AI_MODEL', 'claude-opus-5'),
  },
};
export type Config = typeof config;
