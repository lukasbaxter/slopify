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
      SLSKD_URL: http://127.0.0.1:5030      # optional: slskd, for the Weekly Exploration downloads
      SLSKD_API_KEY: ...
```

`docker compose up -d`, open http://host:8080, log in, it scans. Music gets
into `/music` however you like (Lidarr, slskd, rsync); Slopify only reads it
(and writes covers/lyrics next to files if you let it).

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
