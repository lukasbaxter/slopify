# Slopify

![Slopify playing the same song on a TV, a MacBook Pro, an iPad and an iPhone, with the music library on two hard drives beside them](docs/images/cover.jpg)

<p align="center">
  <a href="https://github.com/lukasbaxter/slopify/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/lukasbaxter/slopify?style=for-the-badge"></a>
  <a href="https://github.com/lukasbaxter/slopify/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/lukasbaxter/slopify/total?style=for-the-badge"></a>
  <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/github/license/lukasbaxter/slopify?style=for-the-badge"></a>
  <a href="https://github.com/lukasbaxter/slopify/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lukasbaxter/slopify/ci.yml?style=for-the-badge&label=ci"></a>
  <a href="https://github.com/lukasbaxter/slopify/actions/workflows/docker.yml"><img alt="Docker image" src="https://img.shields.io/github/actions/workflow/status/lukasbaxter/slopify/docker.yml?style=for-the-badge&label=docker&logo=docker&logoColor=white"></a>
  <a href="https://github.com/lukasbaxter/slopify/actions/workflows/home-assistant.yml"><img alt="Home Assistant integration checks" src="https://img.shields.io/github/actions/workflow/status/lukasbaxter/slopify/home-assistant.yml?style=for-the-badge&label=home%20assistant&logo=homeassistant&logoColor=white"></a>
  <br>
  <a href="docs/home-assistant.md"><img alt="Built for Home Assistant" src="https://img.shields.io/badge/built_for-Home_Assistant-18BCF2?style=for-the-badge&logo=homeassistant&logoColor=white"></a>
  <a href="https://hacs.xyz"><img alt="HACS custom repository" src="https://img.shields.io/badge/HACS-custom-41BDF5?style=for-the-badge"></a>
  <a href="https://github.com/lukasbaxter/slopify/pkgs/container/slopify"><img alt="Container: ghcr.io" src="https://img.shields.io/badge/ghcr.io-amd64_%7C_arm64-2496ED?style=for-the-badge&logo=docker&logoColor=white"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/apps-web_%7C_mac_%7C_windows_%7C_android_%7C_ios_%7C_tv-1DB954?style=for-the-badge">
  <br>
  <img alt="Last commit" src="https://img.shields.io/github/last-commit/lukasbaxter/slopify?style=for-the-badge">
  <img alt="Commit activity" src="https://img.shields.io/github/commit-activity/m/lukasbaxter/slopify?style=for-the-badge">
  <a href="https://github.com/lukasbaxter/slopify/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/lukasbaxter/slopify?style=for-the-badge"></a>
  <img alt="Repo size" src="https://img.shields.io/github/repo-size/lukasbaxter/slopify?style=for-the-badge">
  <a href="https://github.com/lukasbaxter/slopify/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/lukasbaxter/slopify?style=for-the-badge"></a>
</p>

Self-hosted music: one container and your music folder give your household
Spotify-style apps (web, Android, iPhone, Mac, Windows) with a shared session across
them, Chromecast and BluOS speakers driven by the server, and a Home Assistant
integration.

Free software under the [GNU AGPL v3](LICENSE). No telemetry, no accounts with
anyone: [what leaves your server](PRIVACY.md) lists every outside service and
how to turn it off. Not affiliated with Spotify.

## Quick start

You need Docker with Compose, and a folder of music (any layout; tags are
read from the files). The image runs on amd64 and arm64 (Raspberry Pi 4/5,
ARM NAS boxes).

1. Save this as `compose.yml` and change the music path:

   ```yaml
   services:
     slopify:
       image: ghcr.io/lukasbaxter/slopify:latest
       container_name: slopify
       restart: unless-stopped
       network_mode: host        # lets it find and play to Chromecast / BluOS speakers
       volumes:
         - /path/to/music:/music:ro
         - ./data:/data
       environment:
         PORT: "8080"
         TZ: Europe/London   # your time zone, for scheduled tasks
   ```

2. `docker compose up -d`
3. Open `http://<server>:8080`, sign in as `admin` / `admin` and choose a new
   password. The library scans on its own; a few thousand songs take a
   minute or two.
4. Add your household in Settings › Accounts (or send them an invite), and
   get the apps from the [releases page](https://github.com/lukasbaxter/slopify/releases).

`docker compose logs slopify` says what it found: your music folder, the
speakers' address, anything it could not do. Most first-run problems are
spelled out there.

### Good to know

- **Your music folder is read-only to Slopify** unless you ask otherwise.
  `SAVE_TO_LIBRARY=1` writes found lyrics and artwork next to your files
  (drop the `:ro` then).
- **It runs as uid 1000.** It sets up `./data` itself; the music needs to be
  readable by that user. `PUID` / `PGID` pick a different user.
- **Speakers need host networking.** With Docker's default network
  (`ports: ["8080:8080"]` instead of `network_mode: host`) everything else
  works, but no speakers are found and Home Assistant needs the address typed
  in. Speakers fetch audio from the server's LAN address, worked out on its
  own; set `PUBLIC_URL` if the log shows the wrong one.
- **Outside your home**, put it behind HTTPS: [reverse proxy setup](docs/reverse-proxy.md).

## More

- [Configuration](docs/configuration.md): every setting.
- [HTTPS and a reverse proxy](docs/reverse-proxy.md): Caddy, nginx, Traefik.
- [Backups and upgrades](docs/backup-and-upgrade.md): what to keep, pinning versions, moving machines.
- [Downloads with Lidarr and slskd](docs/downloads.md): discographies, requests, the Tasks list.
- [Sync lyrics on a GPU](docs/lyric-sync.md): the GPU image.
- [Home Assistant](docs/home-assistant.md): the integration, installed with HACS.
- [iPhone](docs/iphone.md): the Home Screen web app, or the app through SideStore.

Home Assistant, in two clicks:

[![Open your Home Assistant instance and open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=lukasbaxter&repository=slopify&category=integration)
[![Open your Home Assistant instance and start setting up Slopify.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=slopify)

## What it does

- Browse and search your library; play the original files or a quality you
  pick per device (adaptive on a weak signal); lyrics (your `.lrc` files, else LrcLib), artist pictures and
  banners, album art.
- Spotify's playback basics: volume normalization (every song measured once,
  played at -14 LUFS; albums keep their own balance), crossfade and gapless
  playback on computers and Android, and a sleep timer that works on any device.
- Likes, playlists, history and a Home page built from your own listening;
  Popular per artist from ListenBrainz.
- One session per person across every device: start on the phone, carry on
  at the desk, control one from another.
- Chromecast and BluOS speakers driven by the server, so any phone or browser
  can pick them, and speaker groups.
- DIY speakers: anything answering the small `slopify-speaker/1` HTTP API on
  port 7780 is found and played to like the others (the protocol is
  documented at `BridgeTransport` in `server/src/speakers/transports.ts`).
- Accounts with invites and admin roles; sign-ins revocable per device.
- Optional: Lidarr and slskd for filling the library, ListenBrainz
  scrobbling and weekly playlists, generated playlists (Claude), synced
  lyrics on a GPU.
- Imports your Spotify listening history.

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

## License

Slopify is free software: you can redistribute it and/or modify it under the
terms of the [GNU Affero General Public License v3](LICENSE) or (at your option)
any later version. If you run a modified Slopify that other people use over a
network, offer them its source (set `SOURCE_URL`).

The Home Assistant integration (`custom_components/slopify`) is licensed under
the [Apache License 2.0](custom_components/slopify/LICENSE), like Home Assistant.

Third-party software and its licenses: [NOTICE](NOTICE) and
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Contributing, security, conduct

- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, tests, pull requests.
- [SECURITY.md](SECURITY.md): report vulnerabilities privately.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): Contributor Covenant 2.1.

Slopify is not affiliated with, endorsed by or connected to Spotify AB.
"Spotify" is a trademark of Spotify AB.

Cover image: rendered in Blender on free assets, credits in [docs/images/CREDITS.md](docs/images/CREDITS.md).
