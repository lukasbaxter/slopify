# Task board

Lead owns: `App/`, `Core/` (except `Core/Session/SessionClient.swift`), `Design/` until the design
task starts, `project.yml`, `Makefile`, `docs/` (except API.md/UI.md authorship).

| Task | Owns | Status |
|---|---|---|
| session | `Core/Session/SessionClient.swift`, `Core/Session/Socket*.swift` (new files ok), `SlopifyTests/Session/` | running |
| player | `Player/`, `SlopifyTests/Player/` | running |
| design | `Design/`, `Slopify/Resources/Icons*`, `Slopify/Resources/Locales/`, `SlopifyTests/Design/` | waiting for UI.md |
| features-* | `Features/<Area>/`, `SlopifyTests/<Area>/` | waiting for design |

## Shared contracts (lead-owned, ask to change)
- `Core/API/APIClient.swift`, `Core/API/Endpoints.swift`: REST + media URLs.
- `Core/Auth/Account.swift`: sign-in, token, main/home address, prefs (`account.prefs`, `patchPrefs`).
- `Core/Stores/Likes.swift`: hearts everywhere.
- `Core/Session/SessionModels.swift`: NowPlaying, QueueItem, RosterPlayer, LanDevice, Command.
- `Core/Session/SessionClient.swift` public surface (session task implements).
- `Player/Player.swift` public surface (player task implements).
- `App/Route.swift`: navigation.

## Lead request queue
- signin: Account.signIn keep main when only home answers; findServer parallel probe 6s/3s;
  Account.register(base:invite:username:password:); Theme.Fixed field border #3e3e3e;
  URL scheme / associated domain for invite links (project.yml); locale keys for server screen.
- home: Route.dailyMix carry mix number + seed artist, Route.topSongs colour index; Endpoints
  radar() + requestAlbum(_:), Release.artistName; shared library store; shared track-menu builder
  (candidates: HomeMenus.swift, Detail's menu).
- search: Theme.Fixed browse tile + search field colours (SearchColors.swift); Route.charts;
  Endpoints requestAlbum, albums(limit:), artists(limit:), browse timeout 8s; percent-encode "/"
  in genre paths (BUG); Likes.toggle throws; lyric-job store; downloads store.
- SHARED TRACK MENU: Home, Search, Library, Detail each built one. Lead merges into Design after
  library + detail report.
- nowplaying: Player.clearError(), recFlags, deliveredProfile, outputLag(); Likes.toggle throws;
  MainShell: drop .sheet(deviceSheetOpen) (sheet presented locally), queue as sibling cover,
  MiniPlayer always shown ("Nothing playing"); lyrics/sync endpoints + move NowPlayingLyricJobs
  to Core/Stores and resume after sign-in; shared top-artists cache for "Daily Mix {n}".
- detail: Endpoints requestAlbum; Likes.toggle throws / set state; Theme.Fixed.verified #4cb3ff;
  shared: DetailTrackMenu (best base for the shared menu), OutlinePill, SectionHeader hint,
  FocalImage, page cache, lyric-sync job store (3 copies now), playlists store; offline store +
  app-wide offline flag; Player.prewarm.
- library: LibraryStore owned by AppModel; .libraryChanged object = prefs patch; folder cover
  endpoint with X-Slopify-Rev; CoverSource.folder cover hash; Likes.toggle throws + loaded flag;
  promote LibraryTrackMenu / LibraryLyricJobs; offline store; Player.prewarm.
  OWNER CALL: "Drag to reorder" item added to playlist ⋯ sheet (web has no entry point).
- OWNER DECIDED (11-10): playlist reorder = long-press to drag. Hold lifts the row, drag moves it,
  letting go without moving opens the song menu (same as the library drag). Remove the
  "Drag to reorder" ⋯ item and the edit-mode List. Library agent does it after the menu agent lands.

## Device round 1 (owner, 11-11)
- [library] playlist: scroll blocked when finger starts on a row; hold+drag lifts but never drops.
- [lead] Liked Songs tile heart green → white (IconView tintAll). DONE
- [nowplaying] lyrics: scroll up closes now playing; only the chevron may close it.
- [nowplaying] lyrics background nearly black.
- [player] after a daily mix, a playlist song would not start.
- [nowplaying] long title ("There's Still a Light in the House", Valley) overflows the whole page right.
- [lead] Home tab always lands on the Home root. DONE
- [lead] Lists opened from the Home root (albums, playlists, Liked, mixes, Top Songs, Radar, See all)
  use the iOS 18 zoom transition: swipe down hides them back into the tile. Artist pages push
  normally. Deployment target now iOS 18. DONE (App/HomeZoom.swift)
