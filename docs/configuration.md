# Configuration

Everything is set in the environment (the `environment:` block in compose;
`server/src/config.ts` has the details). Music at `/music`, state in `/data`.
Task schedules and per-task settings live in the app (Settings › Tasks); the
environment values for them only seed the defaults.

| Env | Default | What it does |
| --- | --- | --- |
| `PUID` / `PGID` | `1000` / `1000` | The user the server runs as. The container makes `/data` and `CACHE_DIR` belong to it on start; give it read access to your music (and write access if `SAVE_TO_LIBRARY=1`) |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8080` | Listen port |
| `MUSIC_DIR` | `/music` | The library (may be a NAS mount) |
| `CONFIG_DIR` / `DATA_DIR` | `/data` | Database, avatars, imports — small, precious. `CONFIG_DIR` wins if both set |
| `CACHE_DIR` | = `CONFIG_DIR` | Song heads, transcodes, artwork sizes — rebuildable, put it on an SSD |
| `HEADS` | `1` | Copy the first seconds of every track into the cache at scan; `0` disables |
| `HEAD_SECONDS` | `5` | Length of those heads |
| `TRANSCODE_CONCURRENCY` | `4` | Foreground HLS transcodes allowed at once; extra requests wait. |
| `TRANSCODE_CACHE_GB` | `60` | HLS transcode cache cap; nightly trim drops oldest-used |
| `SAVE_TO_LIBRARY` | `0` | `1` writes found lyrics and artwork into `MUSIC_DIR` (`.lrc` sidecars, `<album>/cover.jpg`, `<artist>/artist.jpg`) so they travel with your files. Needs the library writable by `PUID`; if it is not, the server says so and keeps them to itself |
| `SONG_CACHE_GB` | `0` | Whole songs copied to cache before playing; `0` = off |
| `SCAN_ON_BOOT` | `1` | Full library walk at boot |
| `SCAN_PAUSE_MS` | `0` | Pause between files during a scan (gentle on a NAS) |
| `INCOMING_DIR` | (unset) | Ingest: new music lands here (SSD) and is moved to `NAS_DIR` |
| `NAS_DIR` | = `MUSIC_DIR` | Ingest destination |
| `INGEST_EVERY_MIN` | `10` | Ingest sweep interval |
| `INGEST_SETTLE_MIN` | `10` | A file must be this old before it moves |
| `INGEST_DELETE` | `0` | Delete emptied incoming folders |
| `INGEST_DELETE_SETTLE_MIN` | `60` | Folder quiet this long before deletion |
| `PUBLIC_URL` | this machine's LAN address | Address speakers fetch audio from, e.g. `http://192.168.1.10:8080`. Worked out on its own with host networking (the log says which); set it if that guess is wrong |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | First account; password change forced on first login |
| `LOG_LEVEL` | `info` | Fastify log level |
| `TRUST_PROXY` | `1` | How many proxy hops to trust for the client IP (`true`/`false`/hop count). Keep `1` behind a single nginx; rate limits key on the resulting IP. |
| `LOGIN_RATE_MAX` | `10` | Login attempts per IP per minute |
| `SPEAKERS` | `1` | Chromecast / BluOS discovery (needs host networking in Docker); `0` = off |
| `MDNS` | `1` | Announce the server on the LAN (`_slopify._tcp`) so Home Assistant finds it; `0` = off |
| `BLUOS_GROUPS` | `slopify` | BluOS speakers are grouped only by Slopify's speaker groups; a group made elsewhere (the BluOS app) is unlinked within a minute. `keep` leaves those alone |
| `SOURCE_URL` | this repository | The source code link every app shows in Settings › About; point it at your fork if you run a modified Slopify (the AGPL asks you to offer your users its source) |
| `SERVER_NAME` | `Slopify on <host>` | Name the announced server is shown under (`Slopify` on Docker's default network) |
| `SLSKD_URL` / `SLSKD_API_KEY` / `SLSKD_DOWNLOADS_DIR` | (unset) | slskd for Weekly Exploration; setting all three also enables Upgrade to FLAC (see Tasks) |
| `LIDARR_URL` / `LIDARR_API_KEY` | (unset) | Lidarr integration (discographies, requests, downloads page) |
| `LIDARR_ROOT` | `/music` | The library as Lidarr's container sees it |
| `LIDARR_QUALITY_PROFILE` / `LIDARR_METADATA_PROFILE` | (blank) | Profiles for artists Slopify adds; blank = Lidarr's first |
| `LIDARR_SEARCH_ON_REQUEST` | `0` | `1`: a request also fires Lidarr's indexer search immediately |
| `THEAUDIODB_KEY` | `123` | TheAudioDB key for wide artist photos (artist page banners); `123` is its free public key, empty turns it off. A `backdrop.jpg` / `fanart.jpg` in the artist's folder is used first |
| `ENRICH_EVERY_H` | `1` | Fetch lyrics & artwork interval |
| `TASKS_WANTED_TARGET` | `25` | Cap on what background chores put on Lidarr's wanted list |
| `DISCOVERY_PER_RUN` | `10` | Albums per Discover run |
| `BACKLOG_EVERY_H` / `BACKLOG_PER_RUN` / `BACKLOG_ARTISTS_PER_RUN` | `6` / `10` / `5` | Fill-in-discographies pace |
| `FLAC_PER_RUN` | `40` | Upgrade-to-FLAC tracks per run |
| `ANTHROPIC_API_KEY` | (unset) | Powers Generated playlists (Claude) |
| `AI_MODEL` | `claude-opus-5` | Model for Generated playlists |
| `ALIGN_MODEL` | `turbo` | Whisper model that lines lyrics up (gpu image) |
| `ALIGN_PYTHON` / `ALIGN_SCRIPT` | gpu image paths | Where the aligner lives, if you run it outside the gpu image |
