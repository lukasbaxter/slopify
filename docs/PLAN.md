# Slopify: one container, your music folder, done

Status: PLAN (2026-09-17). Nothing here is built yet. Today Conduit runs on
Jellyfin + a relay + Meilisearch + Redis + nginx + Python hygiene scripts.
This is the plan to fold all of that into one image that any homelab user
can run with `docker compose up`, and to stop depending on Jellyfin.

## Why (what a day of measurement showed, 2026-09-16)

Every slow thing on the phone traced back to Jellyfin, not to the phone,
the network or the app:

| Jellyfin call | Measured | What the app needed it for |
|---|---|---|
| album list (500 of 3,226) | 5-12.5 s | Library tab, Search |
| artists (500) | 2.4-3.2 s | Home, Search |
| recently played / most played (IsPlayed sorts) | 1.5-4 s each | Home shelves |
| favourites for a 1,404-like account | 18-21 s | Liked Songs |
| rows by id, 150 at a time | 1.2-2.6 s per chunk | Liked Songs, playlists |
| lyrics | 10-300 ms, re-read from disk | lyrics view |
| covers | JPEG q90, Last-Modified = now, no max-age | every screen |
| audio transcode | flat-out chunked MP3, no ranges, no HLS for audio by default | phone streaming |

Plus: a stuck EF row made every update to one user 500 for days, the
Playback Reporting plugin threw every minute, `ChildCount` doubled a query,
and its 564 MB SQLite needed a VACUUM. We worked around all of it by moving
reads onto the relay (likes, liked rows, library lists, home, lyrics) and
putting nginx caches in front. That is the shape of the answer: **the
relay already is most of the server. Finish it.**

## The product

One image `slopify`. One compose file. The music folder is read
straight off disk by our own scanner and streamed straight off disk by our
own server; nothing else sits between the files and the app.

```yaml
services:
  conduit:
    image: ghcr.io/lukasbaxter/slopify
    ports: ["8080:8080"]
    volumes:
      - /path/to/music:/music:ro      # any layout; tags + folder covers + .lrc sidecars are enough
      - ./data:/data                  # database, artwork cache, transcode cache
    environment:
      PUBLIC_URL: https://music.example.com   # what phones and speakers reach
      # optional: Soulseek + Explo (leave unset = hidden)
      # SLSK_USER: ...
      # SLSK_PASS: ...
      # EXPLO_SPOTIFY_ID / EXPLO_SPOTIFY_SECRET / EXPLO_LISTENBRAINZ_TOKEN
```

First launch opens a setup page: create the admin account, pick the music
folder (already mounted), scan. Users are invited by link. TLS is the
reverse proxy's job (Caddy/nginx/CF tunnel), documented, not bundled.

The web app, the phone app, the desktop app and the speakers all talk to
this one process. Music gets into `/music` however the user likes (Lidarr,
slskd, rsync, a USB stick); the server only reads it.

## Architecture (single Node process, one SQLite file)

```
/music (ro) ──scan──► SQLite (WAL) ──► HTTP API + WebSocket session relay
                        │ tracks/albums/artists/genres
                        │ users/sessions/likes/playlists/plays/prefs
                        │ lyrics (in-memory map on top)
                        │ search: FTS5 + in-process fuzzy index (no Meilisearch)
                        └ artwork: pre-rendered 64/160/320/640 WebP+JPEG, content-hashed, immutable
/data/transcodes ◄── ffmpeg (HLS AAC segments + progressive MP3/Opus), cached per (track, profile)
```

Decisions, with the reason each way:

1. **Own ids, Jellyfin's as aliases.** Tracks get a content-derived id
   (see "If we were starting over"); an alias table maps every Jellyfin id
   (`MD5(UTF-16LE("MediaBrowser.Controller.Entities.Audio.Audio" + path))`,
   the formula the relay already uses) to it, so every existing like, play,
   playlist row and lyric key carries over and old client caches still
   resolve. The API accepts either id.
2. **Own scanner, not Jellyfin's.** `music-metadata` for tags (fast, every
   format), folder `cover.jpg`/embedded art, `.lrc` sidecars, multi-artist
   splitting with the delimiter + whitelist rules from `tools/library-hygiene`
   (they become server config, not a Python cron). Incremental: mtime + size
   per file, inotify/chokidar for live additions, full rescan on demand.
3. **Search in-process.** FTS5 for exact/prefix over 30k tracks is ~ms;
   a small fuzzy layer (trigram or `minisearch`) for typos. Drops the
   Meilisearch container. If a library is 300k tracks it is still fine.
4. **Lyrics**: sidecars + LrcLib fetch by duration (the `lyrics_check.py`
   logic, in Node, run per track at scan) into a table; served from RAM.
   Drops Redis.
5. **Artwork**: rendered once at scan with `sharp` to 4 sizes, WebP with
   JPEG fallback, named by content hash so clients and proxies cache them
   forever (`Cache-Control: immutable`). Missing art: MusicBrainz/CAA and
   Deezer lookups are an optional Explo job, not core.
6. **Streaming is HLS + byte ranges, not a custom protocol.** Originals
   served with `Range` (lossless, seekable, what speakers and the desktop
   want). Transcodes: HLS (AAC, 3 s segments) for everything; Safari plays
   it natively, Chrome/Android through hls.js in the client. Segments are
   produced by one ffmpeg per (track, bitrate) and cached, so the second
   listener costs nothing and a skipped song costs one or two segments.
   Prewarm = ask for the playlist early (already in the client).
7. **Accounts are ours.** users (argon2id), long-lived device tokens, roles
   (admin/user), invite links. Likes, playlists, play history, prefs,
   scrobbling tokens: the relay tables already exist. Optional later:
   Subsonic API compatibility so third-party apps work too.
8. **The session model stays** (single active player, mirroring, transfer,
   speakers through the desktop). It is the relay code, moved in.
9. **Explo and Soulseek live in the same image.** Lukas's rule: one
   container, set env vars, done. The image ships the `slskd` binary
   (self-contained .NET build) and the server supervises it as a child
   process when `SLSK_USER`/`SLSK_PASS` are set; its web UI is proxied at
   `/slskd` for the curious, but the app never needs it: the server drives
   slskd's own API (search, enqueue, transfers) to do what Music Requests +
   `sldl` do today (whole-release requests, artist/album matching, the
   "index.sldl" and cover-art gotchas already learned). Downloads land in a
   staging dir inside `/data`, get tagged/checked (the retag + LrcLib +
   cover rules), then move into `/music/<Artist>/<Album>/` and the scanner
   picks them up. Explo's other sources are env vars too: `EXPLO_SPOTIFY_*`
   (playlist import), `EXPLO_LISTENBRAINZ` (recs), Deezer (no key). Nothing
   set = the Explo tab is hidden and slskd never starts. `/music` must be
   writable for this; read-only otherwise.

## Identity, metadata, lyrics: the enrichment pipeline

Rule from Lukas: **every song has lyrics, and we know how sure we are that
a file is the song we think it is.** Tags lie (the wrong edit, a mislabeled
rip, a live version filed as the studio one; 2,393 mistimed lyric files
came from exactly that). So identity comes from the audio, not the tags.

### Stage 1: fingerprint (what IS this file)
- Chromaprint (`fpcalc`, shipped in the image) fingerprints every file at
  scan; the fingerprint is stored with the track.
- AcoustID lookup (free API key, set once by the admin: `ACOUSTID_KEY`)
  returns MusicBrainz recordings with scores. Tags are matched against
  those candidates: recording title/artist similarity, duration delta.
- No AcoustID hit: search MusicBrainz by tags (title, artist, duration),
  take the candidates, and **compare the actual audio** to them: fetch a
  30 s preview for each candidate (Deezer, no key; iTunes as a second
  source), fingerprint it, and match it against the file's fingerprint at
  any offset (Chromaprint sub-fingerprint matching). The candidate whose
  preview lines up is the song; none lining up means "unknown recording".

### Stage 2: the certainty scale
Every track carries `identity` = a score 0-1 and a state:

| state | means | how |
|---|---|---|
| verified | audio matches a known recording | AcoustID ≥ 0.90 or preview match, duration within 2 s |
| likely | tags match a recording, audio not checked yet | MB search agrees on title+artist, duration within 3 s |
| uncertain | candidates disagree or nothing matches well | anything else; queued for review |
| mismatch | audio says a different recording than the tags | AcoustID/preview picks recording X, tags say Y |

The score feeds everything downstream: metadata is only written to the
file (or shown as canonical) from `verified`/`likely`; a `mismatch`
proposes the corrected tags and, above 0.95, applies them (the old tags
are kept in the DB so it can be undone). An admin page lists `uncertain`
and `mismatch` with the candidates side by side and a "play the preview /
play the file" button; a decision there is remembered per file hash.

### Stage 3: metadata and images, ours
- Canonical metadata from MusicBrainz for the identified recording/release
  (artist credits with join phrases, release date, disc/track numbers,
  MBIDs stored). Genres from MB tags + Last.fm/Deezer as fallback.
- Cover art: folder `cover.jpg` if it is the right release (same MBID or
  same track list), else Cover Art Archive by release MBID, else Deezer/
  iTunes by the identified release; the chosen file is written to the album
  folder as `cover.jpg` and pre-rendered. Artist portraits: fanart.tv/
  Deezer/TheAudioDB, stored in `/data/art/artists/`.
- Nothing is fetched twice: every external answer is cached in SQLite with
  its date, rate limits are respected per source (MusicBrainz 1 req/s), and
  the whole pass is resumable.

### Stage 4: lyrics for every song
Order, per verified/likely track:
1. `.lrc` sidecar that fits (its timestamps end inside the track's
   duration and, when synced lyrics exist online, agree with them within
   0.6 s; the `lyrics_check.py` rule).
2. LrcLib `/api/get` by artist + title + album + **duration** (the one
   answer that is timed for this recording), synced preferred.
3. LrcLib `/api/search` candidates, filtered by duration within 3 s, then
   by the identified recording's alternate titles (MB aliases: "(Remaster)"
   etc.).
4. Plain (unsynced) lyrics from the same sources if nothing synced exists.
5. Genius/Musixmatch are not scraped (terms); an admin can paste lyrics.
6. Tracks the MB recording marks instrumental (or whose preview/fingerprint
   matches an instrumental) are stored as **instrumental**, which counts as
   resolved and shows "Instrumental" instead of "no lyrics".

Anything left is `lyrics: missing` in a visible queue with a retry
schedule (daily for a week, then weekly); the library page shows the
number, the goal being zero. The MB MBID is the key for retries so a
future LrcLib upload is found without a rescan.

### Where it runs
All of it is a background job in the server (a queue table, one worker,
resumable, visible on the admin page: N verified, N likely, N uncertain,
N missing lyrics). New files go through it minutes after they land;
the whole library is worked through once at first scan (27k tracks at
MusicBrainz's 1 req/s = a few hours of AcoustID/MB lookups, spread
across the first night). Fingerprinting itself is local and fast.

## If we were starting over (what this month taught)

Things that cost real days, and the shape that avoids them:

1. **Ids that survive renames.** Jellyfin's path-hash id broke the moment
   the retag pass renamed files (2,956 orphaned lyric files). The server's
   track id is its own (content-derived: audio fingerprint hash, falling
   back to a random id kept in a path map), with an alias table holding the
   Jellyfin id for the migration. Paths are data, not identity.
2. **One backend, one token.** The client talks to Jellyfin *and* the relay
   with different auth and two caches; likes lived in three places and
   clobbered each other. One API, one device token per client (named,
   revocable from a page; the stray "Web Player (1)" tab should have been a
   click to kick), one cache layer.
3. **The server owns the session.** Today each client computes the mirrored
   position from the active player's report + its own clock, so device
   clock skew, late relay messages and a Cast rebuffer all became visible
   jumps. The server keeps the session state (track, position anchored to
   *server* time, playing, device, queue) and clients send intents
   (play/seek/transfer) and render the state; time is synced to the
   server's clock once per connection.
4. **The server owns the session; any client can be the hands.** (Lukas's
   call, 2026-09-17.) At home the server itself discovers and drives the
   LAN speakers, so a phone can send music to the Node with no desktop
   running. Away from home (a friend's BluOS speaker), the client that is
   on that LAN (desktop app or phone shell) discovers and drives it, and
   reports what it is doing to the server like any other player: the
   speaker is just that client's output. **Offline**: a client that cannot
   reach the server keeps playing whatever audio it has (its own queue,
   cached tracks, a speaker it is already driving) and keeps acting on its
   own; every action (play, pause, seek, next, transfer, like) is an event
   stamped with the client's server-synced clock. When the two talk again
   the newest event wins and becomes the session; the server rebroadcasts
   it and the client that lost falls in line. That timestamped event log is
   also the telemetry (see 9).
5. **A state machine for playback.** Most bugs were state combinations:
   "device switched but nothing loaded", "playing but element paused",
   "transfer half done". Explicit states (idle / loading / playing /
   paused / transferring / mirroring) with allowed transitions, in a
   module a fifth the size of today's `usePlayer.js`.
6. **HLS from day one, no chunked transcodes.** Ranges for originals, HLS
   for everything else, one seek model (server-side offset). Yesterday's
   iOS-won't-play, nginx rate shaping and restart-at-offset code all go.
7. **Hygiene is a server job, not crons, behind an admin page.** Retag,
   cover, lyric and rename passes were Python scripts with JSON state in a
   home dir; they become queued, resumable, logged jobs, and the search
   index is updated by the scanner instead of a 10-minute full resync.
   **Roles**: `admin` and `user`. The first admin comes from env
   (`ADMIN_USER`/`ADMIN_PASS`, default `admin`/`admin`, the setup page
   forces a change on first login); admins promote or demote other users,
   invite by link, see the jobs, the identity/lyrics queues, slow endpoints
   and connected devices. Users see their own library, likes, devices.
8. **Client caches with a version, in IndexedDB.** localStorage silently
   dropped the 1,400-row liked cache at the 5 MB limit; lists are cached in
   IndexedDB keyed by the server's library version and only refetched when
   it changes.
9. **Telemetry built in.** The phone diag to the relay and the desktop
   trace file found every hard bug this week, but were bolted on mid-fire.
   The server keeps a per-request timing log and a client diag endpoint;
   the admin page shows slow endpoints.
10. **A fixture library and CI from the start.** Probes were one-offs run
    against production (one of them, run as Lukas, took over his session).
    "Fixture library" = a tiny fake music folder checked into the repo
    (30 short generated/royalty-free tracks with real tags, a couple of
    folder covers, `.lrc` sidecars, one deliberately mistagged file, one
    instrumental) so the automated tests on GitHub Actions can start a
    server against it and exercise scan, search, streaming, lyrics,
    identity and the session model on every push, without touching the
    real library or any real account. The release workflow builds on
    every PR too (it took five runs to ship 0.1.0).
11. **No hand-edited proxy config.** Six special nginx locations grew in one
    night (art cache, rate shaping, gzip, keep-alive). The server sets its
    own cache headers and compression; a reverse proxy in front is generic.
12. **Ship the visualizer's speaker-sync last.** Calibration, shadow
    streams and Milkdrop consumed days before the basics were fast.

## Migration for us (no big bang)

The client already goes through `src/api/jellyfin.js` + `src/api/search.js`.
The server implements the same routes the client uses today under `/jf`
(Items, Users/AuthenticateByName, Audio/{id}/stream|main.m3u8, Images) plus
the `/relay/*` ones, so the client switches by base URL, then the Jellyfin
shapes are trimmed to what we actually use.

1. Server reads `/mnt/wd_nvme1/music`, ids match; import users (names, the
   `henryb`/`henrybaxter` cases), favourites + play counts once from
   Jellyfin's API; playlists from `playlist.xml`. The relay's SQLite comes
   along as-is.
2. Point the web build at the server; keep Jellyfin running for video.
3. Desktop + phone point at the server. Speakers fetch from `PUBLIC_URL`.
4. Retire the relay container, Meili, Redis, the hygiene cron, the nginx
   image/transcode locations. Jellyfin keeps the video library only.

## The perf checklist, mapped to this

From the list that started this: what is done, what the server makes
possible, what is a client task.

| Item | State |
|---|---|
| Cache API responses | client memo + persisted lists (6 h); server: ETag + `Cache-Control` on every list, `immutable` on art |
| Index the database | own schema, indexes on (album, disc, track), (artist), (uid, at) for plays/likes |
| Compress images | q72/82 now; pre-rendered WebP at scan in the server |
| Loading skeletons | done on the phone |
| Cache expensive queries | relay memo/SQLite cache now; server keeps counts (album track counts, play totals) as columns, not live aggregates |
| N+1 queries | today's `Items?Ids=` chunks and per-album counts; server answers lists in one query |
| Debounce input | search does |
| Code splitting | visualizer is split; History, Settings, Calibrate, the desktop-only device code next |
| CDN | not for a homelab; nginx/Caddy caching in front is documented |
| Server-side caching | relay memo now; server: list caches invalidated by scan events |
| Paginate large lists | album list is one 395 KB gz blob; server: cursor pagination + client virtualised lists |
| Lighthouse audit | run one against the phone build and fix what it lists |
| Compress payloads | gzip on /relay now; brotli in the server |
| Unnecessary re-renders | React profiler pass on Home and the track list (Player state changes every 250 ms: isolate) |
| Minify JS/CSS | Vite does |
| Lazy loading | cards/rows lazy; below-the-fold shelves render on scroll |
| Defer non-critical scripts | audiomotion/Calibrate already dynamic |
| Unused dependencies | castv2/bonjour only in Electron; audit the web bundle |
| DB connection pooling | n/a (SQLite, single process, WAL) |

## Decisions taken (2026-09-17, Lukas)
- Server-owned session with offline autonomy and timestamped-event
  reconciliation (item 4 above): yes.
- Own ids + Jellyfin aliases (3), one backend/one token/IndexedDB caches
  (4), playback state machine (5), HLS only (6): yes.
- Admin page + roles with env-seeded first admin (7): yes.
- Client diagnostics + server request timing (9): yes.
- Fixture library in CI (10): yes.

## Order of work

1. **Server skeleton** in `server/`: SQLite schema, scanner (tags, covers,
   lyrics), id formula, static originals with Range, artwork sizes,
   Chromaprint fingerprints stored at scan.
   Point the web build's `/jf` at it read-only alongside Jellyfin; compare
   lists and ids against Jellyfin's for our library (a script).
2. **Search + Home + Library + Liked + playlists** on the server (port the
   relay routes; FTS5 + fuzzy). Retire Meili.
3. **Streaming**: HLS transcodes with the segment cache; hls.js in the
   client for non-Safari; kill the nginx `/universal` shaping.
4. **Accounts + session relay** moved in; importer from Jellyfin; the
   phone/desktop/web switch over; Jellyfin becomes video-only.
5. **Packaging**: Dockerfile (Node + ffmpeg + slskd binary), compose,
   setup page, GHCR publish in the release workflow, README for homelab
   users; Explo + Soulseek behind env. Health: one `/healthz` that also
   reports slskd's state.
6. **Enrichment pipeline**: AcoustID/MB identity + certainty states,
   preview-fingerprint comparison, metadata/cover/portrait fetch, lyrics
   cascade, admin review page, the missing-lyrics queue.
7. Perf pass from the table (pagination/virtualisation, Lighthouse,
   re-render profile, bundle audit).

Open questions for Lukas: ship Subsonic compatibility (other apps, more
users)? WebP vs JPEG-only for art (Safari fine either way)? Name of the
image: `slopify` vs just `conduit`?
