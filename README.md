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
    volumes:
      - /path/to/music:/music
      - ./data:/data
    environment:
      PORT: "8080"
      PUBLIC_URL: http://192.168.1.10:8080   # what speakers fetch audio from (LAN address)
      ADMIN_USER: admin
      ADMIN_PASS: admin   # you are asked to change it on first login
```

`docker compose up -d`, open http://host:8080, log in, it scans. Music gets
into `/music` however you like (Lidarr, slskd, rsync); Slopify only reads it
(and writes covers/lyrics next to files if you let it).

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
with its last run, live progress and a Run now button. Built in: **Scan
library** (`SCAN_EVERY_H`), **Fetch lyrics & artwork** (`ENRICH_EVERY_H`),
**Cut song heads** (`HEADS_EVERY_H`, when `HEADS=1`), **Discover new music**
(`DISCOVERY_EVERY_H`/`DISCOVERY_PER_RUN` — an album each from artists
similar to your most played, via Deezer + Lidarr), and **Fill in
discographies** (`BACKLOG_EVERY_H`/`BACKLOG_PER_RUN`/`BACKLOG_ARTISTS_PER_RUN`
— missing studio albums and EPs of the artists you actually play). The
background chores never fill Lidarr's wanted list past `TASKS_WANTED_TARGET`
(default 25), so a person's own request is always near the front of the
line. Any interval set to 0 turns that schedule off; Run now always works.

## What works today

See `docs/STATUS.md`. Short version: scan your folder, browse/search, play (originals or HLS transcodes), lyrics (sidecars + LrcLib), artist pictures, likes, playlists, Home and history from your own plays, several devices sharing one session (mirror, control, hand over), Chromecast and BluOS speakers at home driven by the server so any phone or browser can pick them, accounts with invites and admin roles. Desktop app, phone shell and Soulseek are next.

## Develop

```
npm install
npm run fixtures        # generates a 30-track fake library in fixtures/music (needs ffmpeg)
MUSIC_DIR=fixtures/music DATA_DIR=./data npm run dev      # server on :8080
npm run dev -w web      # web on :5180, proxies /api to the server
npm test                # unit (vitest)
npm run e2e             # Playwright against the fixture library
```

Tests never touch a real library or account: they run against the fixture
folder and a data dir under /tmp.
