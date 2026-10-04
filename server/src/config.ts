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
  // Foreground (someone pressed play) HLS transcodes running at once; excess
  // requests wait their turn. Warms have their own, lower cap.
  transcodeConcurrency: Math.max(1, Number(env('TRANSCODE_CONCURRENCY', '4')) || 4),
  // Fetched extras live in the library too: lyrics as .lrc sidecars, artist
  // pictures as <artist>/artist.jpg, found covers as <album>/cover.jpg - so
  // nothing external is ever fetched twice. Needs MUSIC_DIR writable;
  // SAVE_TO_LIBRARY=0 keeps the library untouched.
  saveToLibrary: env('SAVE_TO_LIBRARY', '1') !== '0',
  // Whole songs copied from the NAS to the cache when they are about to play,
  // least recently played dropped first past this size (0 = off).
  songCacheGb: Number(env('SONG_CACHE_GB', '0')),
  // A full walk of MUSIC_DIR at boot if asked; recurring scans are the
  // "Scan library" task (daily 04:00 by default, changeable in the admin
  // dashboard). SCAN_PAUSE_MS between files keeps a walk over a NAS gentle.
  scanOnBoot: env('SCAN_ON_BOOT', '1') !== '0',
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
  // How many proxy hops to trust for X-Forwarded-For. Default '1': exactly the
  // nginx in front of this container, so req.ip is the address nginx saw and a
  // client cannot mint rate-limit buckets by sending its own XFF. 'true' (only
  // when set explicitly) trusts every hop; 'false' trusts none; an integer is a
  // hop count. Caveat: routes that come through Cloudflare see CF's edge IP
  // unless nginx forwards CF-Connecting-IP — out of scope here.
  trustProxy: ((v: string): boolean | number => v === 'true' ? true : v === 'false' ? false : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 1)(env('TRUST_PROXY', '1')),
  publicUrl: env('PUBLIC_URL', '').replace(/\/+$/, ''),
  adminUser: env('ADMIN_USER', 'admin'),
  adminPass: env('ADMIN_PASS', 'admin'),
  logLevel: env('LOG_LEVEL', 'info'),
  loginRateMax: Number(env('LOGIN_RATE_MAX', '10')), // per IP per minute; raised for the E2E suite
  // Find and drive Chromecast / BluOS speakers on the server's network (needs host networking in Docker).
  speakers: env('SPEAKERS', '1') !== '0',
  // slskd (Soulseek) for the Weekly Exploration playlist: tracks the library
  // lacks are fetched through it. If slskd's finished-downloads folder is
  // also mounted into this container (SLSKD_DOWNLOADS_DIR), fetched tracks
  // are moved into the library and scanned right away; without it they stay
  // wherever slskd put them until something else brings them in.
  slskdUrl: env('SLSKD_URL', '').replace(/\/+$/, ''),
  slskdKey: env('SLSKD_API_KEY', ''),
  slskdDownloadsDir: env('SLSKD_DOWNLOADS_DIR', ''),
  // Lidarr runs acquisition: the artist page's full discography, "Request"
  // buttons, Release Radar, global search and the Downloads page all speak
  // its API directly. Point it at the same library this server scans and
  // add a Webhook notification in Lidarr to
  //   POST <slopify>/api/hooks/lidarr?key=<LIDARR_API_KEY>
  // so imported albums are playable seconds later. Anything that actually
  // fetches music (an indexer in Lidarr, Soularr bridging slskd, ...) is
  // configured in Lidarr itself, not here.
  lidarr: {
    url: env('LIDARR_URL', '').replace(/\/+$/, ''),
    apiKey: env('LIDARR_API_KEY', ''),
    // the library's path as LIDARR's container sees it (webhook paths and
    // added artists are translated from/to this root)
    root: env('LIDARR_ROOT', '/music'),
    // profile for artists this server adds: a name or an id; blank = Lidarr's first
    qualityProfile: env('LIDARR_QUALITY_PROFILE', ''),
    metadataProfile: env('LIDARR_METADATA_PROFILE', ''),
    // '1': a Request also fires Lidarr's own indexer search immediately
    // (for setups without Soularr); default leaves the first try to whatever
    // watches Lidarr's wanted list, Retry on the Downloads page searches.
    searchOnRequest: env('LIDARR_SEARCH_ON_REQUEST', '0') === '1',
  },
  // Scheduled tasks (the admin dashboard's Tasks section). Schedules ship
  // with each task and are changed in the dashboard (persisted in the
  // database); these envs seed the interval defaults and cap how much the
  // background chores (discovery, backlog) put on Lidarr's wanted list,
  // so a person's own request never waits behind them.
  tasks: {
    enrichEveryH: Number(env('ENRICH_EVERY_H', '1')),
    wantedTarget: Number(env('TASKS_WANTED_TARGET', '25')),
    discoveryPerRun: Number(env('DISCOVERY_PER_RUN', '10')),
    backlogEveryH: Number(env('BACKLOG_EVERY_H', '6')),
    backlogPerRun: Number(env('BACKLOG_PER_RUN', '10')),
    backlogArtistsPerRun: Number(env('BACKLOG_ARTISTS_PER_RUN', '5')),
    flacPerRun: Number(env('FLAC_PER_RUN', '40')),
  },
  // Lyric alignment on the GPU (the "Sync lyrics" task). Only the gpu image
  // ships the Python side; elsewhere the task says so and stands down.
  align: {
    python: env('ALIGN_PYTHON', '/opt/align/bin/python'),
    script: env('ALIGN_SCRIPT', ''), // default: aligner/align.py in the app
    model: env('ALIGN_MODEL', 'turbo'),
    writeModel: env('ALIGN_WRITE_MODEL', 'large-v3'), // writes lyrics for songs that have none
  },
  // Generated playlists: Claude through the Anthropic API.
  ai: {
    apiKey: env('ANTHROPIC_API_KEY', '') || undefined,
    model: env('AI_MODEL', 'claude-opus-5'),
  },
};
export type Config = typeof config;
