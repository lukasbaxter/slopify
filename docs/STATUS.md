# Status (2026-09-17)

Built and green (30 unit tests, 14 Playwright flows on desktop + phone viewports, Docker image in CI):

| Phase | What | Where |
|---|---|---|
| 1 | Monorepo, CI, Docker, fixture library generator | root, `.github/workflows/ci.yml`, `fixtures/generate.mjs` |
| 2 | SQLite schema, content-addressed ids, scanner (tags, covers, .lrc), artwork sizes | `server/src/{db,ids,scanner,artwork,lyrics}.ts` |
| 3 | Accounts: argon2id, device tokens, admin/user roles, invites, forced first password | `server/src/auth.ts` |
| 4 | Library/search/lyrics/artwork API, streaming (ranges + cached HLS), likes/playlists/plays/home/prefs, admin scan | `server/src/{library,stream,social,admin}.ts` |
| 5-6 | Web app: login, Home, Search, Library, album/artist/playlist/Liked, player (hls.js), now playing with synced lyrics, settings, admin; phone + desktop layouts | `web/src` |
| 7 | Server-owned session over WebSocket: mirror, control in place, transfer, offline newest-wins | `server/src/session.ts`, `web/src/state/session.ts` |
| 8 | Lyrics for every song: LrcLib by duration, instrumental, missing queue with retries, cached | `server/src/enrich.ts` |

Running for real: `.85:8090` against the full library (read-only), first scan in progress.

Not built yet (in order):
- Identity from audio: fpcalc fingerprints are wired (`enrich.ts`), AcoustID/MusicBrainz lookup + certainty states + preview comparison + review page are not.
- Metadata/cover/portrait fetching (MusicBrainz, Cover Art Archive, Deezer) and write-back.
- Desktop app (Electron) with Cast + BluOS control; server-side speaker control at home.
- Phone shell (Expo) with hardware volume buttons.
- slskd inside the image + requests (Explo).
- History/stats page, theming, virtualised lists, Lighthouse pass, security review, Subsonic API.
- Import from Jellyfin (users, favourites, play counts, playlists) via the alias table.
