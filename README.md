# Slopify

Self-hosted music: one container, your music folder, Spotify-style apps
(web/phone, desktop with Chromecast + BluOS, a shared session across all of
them). Successor to Conduit, rebuilt on what that taught (see `docs/PLAN.md`).

## Run it

```yaml
services:
  slopify:
    image: ghcr.io/lukasbaxter/slopify:latest
    network_mode: host   # so it can find Chromecast / BluOS speakers; PORT picks the port
    volumes:                # bridge mode (ports: ["8080:8080"]) works too, but
      - /path/to/music:/music   # disables speaker discovery (set SPEAKERS=0)
      - ./data:/data
    environment:
      PORT: "8080"
      PUBLIC_URL: http://192.168.1.10:8080   # what speakers fetch audio from (LAN address)
      ADMIN_USER: admin
      ADMIN_PASS: admin   # you are asked to change it on first login
```

`docker compose up -d`, open http://host:8080, log in, it scans. Music gets
into `/music` however you like (Lidarr, slskd, rsync).

Two defaults to know about before pointing it at a library you care about:

- `SAVE_TO_LIBRARY=1` (default) **writes into the mounted library**: lyrics
  as `.lrc` sidecars, found covers as `<album>/cover.jpg`, artist pictures
  as `<artist>/artist.jpg`. Set `SAVE_TO_LIBRARY=0` to keep it untouched
  (then mounting `/music` read-only is fine).
- `HEADS=1` (default) copies the first seconds of every track into
  `CACHE_DIR` (which defaults to `CONFIG_DIR`/`/data`) at scan, so playback
  starts at SSD speed while a NAS wakes. Set `HEADS=0` to disable.

The container runs as the non-root `node` user (uid 1000). The volumes are
host mounts, so make sure `./data` — and `/path/to/music` when
`SAVE_TO_LIBRARY=1` — are writable by uid 1000 (`chown -R 1000` or matching
group permissions).

## Downloads: plug in your own arr stack (optional)

Slopify speaks Lidarr and slskd natively — no glue services. With a Lidarr
that manages the same music folder, the artist pages grow full
discographies with Request buttons, search gets an "Everywhere" shelf, the
Release Radar fills, generated playlists can fetch what the library lacks,
and a Downloads page shows where everything is. Requests simply monitor the
album in Lidarr; whatever you have watching Lidarr does the fetching — its
own indexers, [Soularr](https://github.com/mrusse/soularr) bridging slskd
for Soulseek, or both.

```yaml
    environment:
      # Lidarr: catalog + download queue
      LIDARR_URL: http://127.0.0.1:8686
      LIDARR_API_KEY: ...
      LIDARR_ROOT: /music              # the library as LIDARR's container sees it
      LIDARR_QUALITY_PROFILE: ""       # profile (name or id) for artists Slopify adds; blank = Lidarr's first
      LIDARR_METADATA_PROFILE: ""
      LIDARR_SEARCH_ON_REQUEST: "0"    # "1": every request also fires Lidarr's indexer search immediately
      # slskd: Weekly Exploration fetches single missing tracks directly
      SLSKD_URL: http://127.0.0.1:5030
      SLSKD_API_KEY: ...
      SLSKD_DOWNLOADS_DIR: /slskd-downloads  # slskd's finished-downloads folder, mounted here,
                                             # so fetched tracks move into the library and scan at once
```

In Lidarr add a Webhook notification (Settings → Connect → Webhook, on
Release Import + on Upgrade) pointed at
`http://<slopify>:8080/api/hooks/lidarr?key=<LIDARR_API_KEY>` — imported
albums become playable seconds later instead of at the next library scan.
Artists Slopify adds to Lidarr while browsing stay unmonitored; only a
Request monitors an album.

## Tasks

Settings → Admin has a Tasks list, Jellyfin-style: every recurring chore
on one line with its last run, live progress, a Run now button and its
schedule, editable in place — every N hours, daily at a time, weekly on a
day, on file change (tasks that watch the music folder), or off. Built in,
with their defaults: **Scan library** (daily 04:00; can also watch the
folder and scan two minutes after files change), **Fetch lyrics & artwork**
(hourly, `ENRICH_EVERY_H`), **Cut song heads** (daily 05:00, when
`HEADS=1`), **Discover new music** (Sundays 06:00 — an album each from
artists similar to your most played, via Deezer + Lidarr,
`DISCOVERY_PER_RUN`), and **Fill in discographies** (every 6 h,
`BACKLOG_EVERY_H`/`BACKLOG_PER_RUN`/`BACKLOG_ARTISTS_PER_RUN` — missing
studio albums and EPs of the artists you actually play). The background
chores never fill Lidarr's wanted list past `TASKS_WANTED_TARGET` (default
25), so a person's own request is always near the front of the line.

There is also **Upgrade to FLAC** (`FLAC_PER_RUN` per run). **Warning:**
setting the three slskd envs (`SLSKD_URL`, `SLSKD_API_KEY`,
`SLSKD_DOWNLOADS_DIR`) enables it, hourly by default, and it **replaces
lossy files in your library** with lossless ones as it finds them. If you
want slskd for Weekly Exploration but not that, set the task to Off in the
Tasks UI.

Every task's ⋯ menu holds its own settings (pace, how much per run, which
parts to fetch, ...). They are saved in the database and apply from the
task's next step, even mid-run; the env values above only seed the defaults.

### Sync lyrics (GPU image)

**Sync lyrics** (daily 01:00) lines lyrics up with the vocals on an NVIDIA
GPU. Demucs isolates the voice, then Whisper finds when each *known* line
is sung (forced alignment: nothing is transcribed or invented). Plain
lyrics get timestamps when a song aligns confidently. Synced lyrics are
checked: a file that is consistently early or late (timed to another
version or intro) is shifted as a whole, and anything doubtful is left
alone. Every change is recorded with the original, and **Undo all
changes** in the task's menu puts everything back. With `SAVE_TO_LIBRARY=1`
the new timing is written to the song's `.lrc`; a `.lrc` that came with
your music is kept once as `<name>.orig.lrc`.

It needs the GPU image and the card passed in:

```yaml
services:
  slopify:
    image: ghcr.io/lukasbaxter/slopify:gpu   # or build with --target gpu
    deploy:
      resources:
        reservations:
          devices:
            - driver: cdi
              device_ids: [nvidia.com/gpu=all]
              capabilities: [gpu]
```

(NVIDIA driver plus the container toolkit with CDI on the host; on older
setups `driver: nvidia, count: 1` works too.) The first run downloads the
models (~1.7 GB) into `CACHE_DIR/models`. It peaks around 4.5 GB of VRAM,
and **GPU power** in its menu decides how much it takes: Light, Normal,
High or Full. The lower levels work in bursts with the model unloaded in
between, and pause entirely while anything (Jellyfin, Immich) is encoding
on the card. On an RTX 4060 a song takes about a tenth of its own length.

## All configuration

Everything comes from the environment (`server/src/config.ts`). Defaults
are the homelab defaults: music at `/music`, state in `/data`.

| Env | Default | What it does |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8080` | Listen port |
| `MUSIC_DIR` | `/music` | The library (may be a NAS mount) |
| `CONFIG_DIR` / `DATA_DIR` | `/data` | Database, avatars, imports — small, precious. `CONFIG_DIR` wins if both set |
| `CACHE_DIR` | = `CONFIG_DIR` | Song heads, transcodes, artwork sizes — rebuildable, put it on an SSD |
| `HEADS` | `1` | Copy the first seconds of every track into the cache at scan; `0` disables |
| `HEAD_SECONDS` | `5` | Length of those heads |
| `TRANSCODE_CONCURRENCY` | `4` | Foreground HLS transcodes allowed at once; extra requests wait. |
| `TRANSCODE_CACHE_GB` | `60` | HLS transcode cache cap; nightly trim drops oldest-used |
| `SAVE_TO_LIBRARY` | `1` | Write `.lrc` / `cover.jpg` / `artist.jpg` into `MUSIC_DIR`; `0` keeps the library untouched |
| `SONG_CACHE_GB` | `0` | Whole songs copied to cache before playing; `0` = off |
| `SCAN_ON_BOOT` | `1` | Full library walk at boot |
| `SCAN_PAUSE_MS` | `0` | Pause between files during a scan (gentle on a NAS) |
| `INCOMING_DIR` | (unset) | Ingest: new music lands here (SSD) and is moved to `NAS_DIR` |
| `NAS_DIR` | = `MUSIC_DIR` | Ingest destination |
| `INGEST_EVERY_MIN` | `10` | Ingest sweep interval |
| `INGEST_SETTLE_MIN` | `10` | A file must be this old before it moves |
| `INGEST_DELETE` | `0` | Delete emptied incoming folders |
| `INGEST_DELETE_SETTLE_MIN` | `60` | Folder quiet this long before deletion |
| `PUBLIC_URL` | (unset) | URL speakers fetch audio from (LAN address) |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | First account; password change forced on first login |
| `LOG_LEVEL` | `info` | Fastify log level |
| `TRUST_PROXY` | `1` | How many proxy hops to trust for the client IP (`true`/`false`/hop count). Keep `1` behind a single nginx; rate limits key on the resulting IP. |
| `LOGIN_RATE_MAX` | `10` | Login attempts per IP per minute |
| `SPEAKERS` | `1` | Chromecast / BluOS discovery (needs host networking in Docker); `0` = off |
| `SLSKD_URL` / `SLSKD_API_KEY` / `SLSKD_DOWNLOADS_DIR` | (unset) | slskd for Weekly Exploration; setting all three also enables Upgrade to FLAC (see Tasks) |
| `LIDARR_URL` / `LIDARR_API_KEY` | (unset) | Lidarr integration (discographies, requests, downloads page) |
| `LIDARR_ROOT` | `/music` | The library as Lidarr's container sees it |
| `LIDARR_QUALITY_PROFILE` / `LIDARR_METADATA_PROFILE` | (blank) | Profiles for artists Slopify adds; blank = Lidarr's first |
| `LIDARR_SEARCH_ON_REQUEST` | `0` | `1`: a request also fires Lidarr's indexer search immediately |
| `ENRICH_EVERY_H` | `1` | Fetch lyrics & artwork interval |
| `TASKS_WANTED_TARGET` | `25` | Cap on what background chores put on Lidarr's wanted list |
| `DISCOVERY_PER_RUN` | `10` | Albums per Discover run |
| `BACKLOG_EVERY_H` / `BACKLOG_PER_RUN` / `BACKLOG_ARTISTS_PER_RUN` | `6` / `10` / `5` | Fill-in-discographies pace |
| `FLAC_PER_RUN` | `40` | Upgrade-to-FLAC tracks per run |
| `ANTHROPIC_API_KEY` | (unset) | Powers Generated playlists (Claude) |
| `AI_MODEL` | `claude-opus-5` | Model for Generated playlists |
| `ALIGN_MODEL` | `turbo` | Whisper model for Sync lyrics (gpu image) |
| `ALIGN_PYTHON` / `ALIGN_SCRIPT` | gpu image paths | Where the aligner lives, if you run it outside the gpu image |

## What works today

See `docs/STATUS.md`. Short version: scan your folder, browse/search, play (originals or HLS transcodes), lyrics (sidecars + LrcLib), artist pictures, likes, playlists, Home and history from your own plays, several devices sharing one session (mirror, control, hand over), Chromecast and BluOS speakers at home driven by the server so any phone or browser can pick them, accounts with invites and admin roles. Desktop app, phone shell and Soulseek are next.

## Develop

```
npm install
npm run fixtures        # generates a 30-track fake library in fixtures/music (needs ffmpeg)
MUSIC_DIR=$PWD/fixtures/music CONFIG_DIR=$PWD/data npm run dev   # server on :8080
# (absolute paths: npm runs the dev script with server/ as its cwd)
npm run dev -w web      # web on :5180, proxies /api to the server
npm test                # unit (vitest)
npm run e2e             # Playwright against the fixture library
```

Tests never touch a real library or account: they run against the fixture
folder and a data dir under /tmp.
