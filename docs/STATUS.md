# Status (2026-09-17)

Built and green (33 unit tests, Playwright on desktop + phone viewports, Docker image in CI):

| Phase | What | Where |
|---|---|---|
| 1 | Monorepo, CI, Docker, fixture library generator | root, `.github/workflows/ci.yml`, `fixtures/generate.mjs` |
| 2 | SQLite schema, content-addressed ids, scanner (tags, covers, .lrc), artwork sizes | `server/src/{db,ids,scanner,artwork,lyrics}.ts` |
| 3 | Accounts: argon2id, device tokens, admin/user roles, invites, forced first password | `server/src/auth.ts` |
| 4 | Library/search/lyrics/artwork API, streaming (ranges + cached HLS), likes/playlists/plays/home/prefs, admin scan | `server/src/{library,stream,social,admin}.ts` |
| 5-6 | Web app: Conduit's UI, file for file (components, styles, player, phone + desktop layouts); its data layer is `web/src/api/{slopify,search,session}.js` over `/api`. Settings has an admin section (scan, fetch, speakers, accounts, invites) | `web/src` |
| 7 | Session socket `/api/ws`: presence, one active player, commands routed to it, queue fan-out, likes/offsets/prefs; state anchored to the server clock, persisted, newest event wins | `server/src/session.ts` |
| 8 | Lyrics for every song: LrcLib by duration, instrumental, missing queue with retries, cached. Artist portraits + banners from Deezer | `server/src/enrich.ts` |
| 9 | Speakers driven by the server: Chromecast + BluOS found on its network (mDNS + port sweep), one ServerPlayer per account (queue, transport, the speaker's clock, end-of-track advance), offered to every client anywhere. Needs `network_mode: host` | `server/src/speakers/` |

| 10 | Desktop app (`desktop/`, Electron: the web build in a window, Cast + BluOS driven from the machine, server speakers listed too) and phone shell (`mobile/`, Expo WebView with hardware volume buttons); `v*` tags build dmg/exe/apk | `desktop/`, `mobile/`, `.github/workflows/release.yml` |
| 12 | ListenBrainz in the app: scrobbling (a play counts after half the track), Weekly Exploration (missing tracks fetched through slskd, then the scan, then the playlist), Weekly Jams, Daily Jams, on a schedule in-process; admin button to run now | `server/src/explore.ts` |
| 11 | Import from Conduit/Jellyfin: playlists in order, likes with their dates, listening history (`tools/import-conduit.py`); done for lukasbaxter + henrybaxter 2026-09-17 | `tools/` |

Running for real: `.85:8090` (host network) behind nginx at music.baxtergroup.io, full library scanned (27k tracks), enrichment running.

Not built yet (in order):
- Identity from audio: fpcalc fingerprints are wired (`enrich.ts`), AcoustID/MusicBrainz lookup + certainty states + preview comparison + review page are not.
- Metadata/cover fetching (MusicBrainz, Cover Art Archive) and write-back.
- Native iOS build (the phone shell is Android-only on CI; iOS needs a developer account).
- slskd inside the image + requests (Explo).
- Global search / discography / similar / popular / release radar / requests (Explo, Spotify, Deezer): the pages exist, the data sources are not wired.
- Lighthouse pass, security review, Subsonic API.
- Import the other Jellyfin accounts (the import tool does one account at a time, on request).
