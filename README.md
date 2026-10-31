# Slopify

Spotify, but it's your music on your server. One Docker container, point it at
your music folder, and everyone in the house gets their own account with
likes, playlists, lyrics and a Home page. Start a song on your phone and
finish it on the speakers.

<p align="center">
  <a href="https://slopify.lukasbaxter.ca"><img alt="Try the live demo" src="docs/images/try-demo.svg" width="420"></a>
  <br>
  <sub>No sign-up, 30-second clips.</sub>
</p>

<p align="center">
  <a href="https://github.com/lukasbaxter/slopify/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/lukasbaxter/slopify?style=for-the-badge"></a>
  <a href="https://github.com/lukasbaxter/slopify/pkgs/container/slopify"><img alt="Container: ghcr.io" src="https://img.shields.io/badge/ghcr.io-amd64_%7C_arm64-2496ED?style=for-the-badge&logo=docker&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/github/license/lukasbaxter/slopify?style=for-the-badge"></a>
</p>

<p align="center">
  <img alt="A playlist" src="docs/images/screen-desktop-playlist.jpg" width="32%">
  <img alt="Synced lyrics" src="docs/images/screen-desktop-lyrics.jpg" width="32%">
  <img alt="The Mirror visualizer" src="docs/images/screen-desktop-viz.jpg" width="32%">
</p>
<p align="center">
  <img alt="Your Library on iPhone" src="docs/images/screen-phone-library.png" width="24%">
  <img alt="A playlist on iPhone" src="docs/images/screen-phone-playlist.png" width="24%">
  <img alt="Now playing on iPhone" src="docs/images/screen-phone-playing.png" width="24%">
  <img alt="Lyrics on iPhone" src="docs/images/screen-phone-lyrics.png" width="24%">
</p>

## Install

Needs Docker and a folder of music. Any folder layout works, it reads the tags.
Runs on amd64 and arm64 (Raspberry Pi 4/5 is fine).

```yaml
# compose.yml
services:
  slopify:
    image: ghcr.io/lukasbaxter/slopify:latest
    container_name: slopify
    restart: unless-stopped
    network_mode: host          # needed to find Chromecast / Bluesound speakers
    volumes:
      - /path/to/music:/music:ro
      - ./data:/data
    environment:
      PORT: "8080"
      TZ: America/Vancouver
```

```
docker compose up -d
```

Open `http://<server>:8080`, log in with `admin` / `admin`, set a password.
The library scans by itself. Add people in Settings › Accounts or send them
an invite link.

- Your music stays read-only. Slopify keeps its stuff in `./data`.
- Runs as uid 1000; set `PUID` / `PGID` if your files need a different user.
- Using `ports: ["8080:8080"]` instead of host networking works too, you just
  lose speaker discovery.
- Outside your house, put it behind HTTPS: [reverse proxy guide](docs/reverse-proxy.md).
- If something's off, `docker compose logs slopify` usually says why.

## Apps

| Platform | How |
|---|---|
| Web | Any browser, nothing to install |
| Android | `.apk` from [releases](https://github.com/lukasbaxter/slopify/releases/latest) |
| iPhone / iPad | Add to Home Screen from Safari, or the `.ipa` through SideStore ([how](docs/iphone.md)) |
| Mac | `.dmg` from releases (Apple Silicon) |
| Windows | Installer or portable `.exe` from releases |
| Linux | Web app |
| Android TV / Google TV | Build it from [`tv/`](tv/README.md) |

Every app shares one session per person, so any device can see and control
what's playing on the others.

In 22 languages. Set `LANGUAGE` in compose for everyone (e.g. `de`, `ja`,
`pt-BR`), or let each person pick in Settings. Default follows the device.

## Works with

| | |
|---|---|
| **Chromecast** | Play to any Cast speaker, TV or group, from any device |
| **Bluesound / BluOS** | Same, plus grouping and volume |
| **DIY speakers** | Anything that speaks the small `slopify-speaker/1` HTTP API on port 7780 shows up as a speaker (see `server/src/speakers/transports.ts`) |
| **Home Assistant** | Every person and speaker becomes a media player. Install with HACS ([guide](docs/home-assistant.md)) |
| **Soulseek (slskd)** | Weekly Exploration downloads and Upgrade to FLAC ([guide](docs/downloads.md)) |
| **Lidarr** | Full discographies and requests from inside the app ([guide](docs/downloads.md)) |
| **Spotify import** | Upload your Spotify data download: playlists, Liked Songs, saved albums and listening history come over. Anything you don't have gets requested |
| **ListenBrainz** | Scrobbling and weekly discovery playlists, per person |
| **LrcLib** | Lyrics, if you don't have your own `.lrc` files. Can also sync them on a GPU ([guide](docs/lyric-sync.md)) |
| **Claude** | Optional: type a vibe, get a playlist from your library (`ANTHROPIC_API_KEY`) |

Nothing phones home. [PRIVACY.md](docs/PRIVACY.md) lists every outside service it
talks to and how to turn each one off.

## Docs

[Configuration](docs/configuration.md) ·
[Reverse proxy](docs/reverse-proxy.md) ·
[Backups and upgrades](docs/backup-and-upgrade.md) ·
[Downloads](docs/downloads.md) ·
[Home Assistant](docs/home-assistant.md) ·
[iPhone](docs/iphone.md) ·
[Lyric sync](docs/lyric-sync.md)

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

AGPL v3 ([LICENSE](LICENSE)). The Home Assistant integration in
`custom_components/slopify` is Apache 2.0. Third-party licenses are in
[NOTICE](docs/NOTICE) and [THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md).

Bugs and ideas: [issues](https://github.com/lukasbaxter/slopify/issues).
Security stuff: [SECURITY.md](.github/SECURITY.md). Contributing:
[CONTRIBUTING.md](.github/CONTRIBUTING.md).

Built by Lukas with a lot of help from Claude. Not affiliated with Spotify.
