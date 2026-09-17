# Slopify

Self-hosted music: one container, your music folder, Spotify-style apps
(web/phone, desktop with Chromecast + BluOS, a shared session across all of
them). Successor to Conduit, rebuilt on what that taught (see `docs/PLAN.md`).

## Run it

```yaml
services:
  slopify:
    image: ghcr.io/lukasbaxter/slopify:latest
    ports: ["8080:8080"]
    volumes:
      - /path/to/music:/music
      - ./data:/data
    environment:
      PUBLIC_URL: https://music.example.com
      ADMIN_USER: admin
      ADMIN_PASS: admin   # you are asked to change it on first login
```

`docker compose up -d`, open http://host:8080, log in, it scans. Music gets
into `/music` however you like (Lidarr, slskd, rsync); Slopify only reads it
(and writes covers/lyrics next to files if you let it).

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
