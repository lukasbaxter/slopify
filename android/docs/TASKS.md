# Task board (Android)

Lead owns: `app/`, `core/`, `player/Player.kt`, `design/` until the design task starts, the Gradle
files, `Makefile`, `docs/`. Paths below are under
`app/src/main/java/com/lukasbaxter/slopify/android/` (tests mirror them under `app/src/test/...`).

| Task | Owns | Status |
|---|---|---|
| foundation | `core/`, `app/`, `player/Player.kt`, `player/NoopPlayer.kt`, stubs | done |
| player | `player/` (Media3 implementation of `Player`), its tests | waiting |
| design | `design/`, `res/drawable*`, `res/font*`, locale loading behind `L()` | waiting |
| features-* | `features/<area>/`, tests in `<area>/` | waiting for design |

## Shared contracts (lead-owned, ask to change)
- `core/api/ApiClient.kt`: REST (`get`, `call`, `send`, `upload`), `ApiError`, media URLs
  (`artUrl`, `imageUrl`, `hlsUrl`, `wholeFileUrl`, `downloadUrl`, `avatarUrl`, `webSocketUrl`).
- `core/api/Endpoints.kt`: every endpoint the iOS app has, as `suspend fun ApiClient.x()`.
- `core/model/*`: REST shapes; `SlopifyJson`; `Prefs` (`Map<String, JsonElement>`).
- `core/auth/Account.kt`: `state` (SignedOut / PasswordChange / SignedIn), `user`, `saved`,
  `activeBase`, `onHome`, `prefs`; `findServer`, `signIn(base, main, ...)`, `register`, `tryDemo`,
  `changePassword`, `signOut`, `setHome`, `chooseAddress`, `patchPrefs` / `patchPrefsThrowing`,
  `applyRemotePrefs`. `api` is the one ApiClient; it moves between main and home.
- `core/auth/Address.kt`, `HomeProof.kt`, `NetworkMonitor.kt`.
- `core/session/SessionModels.kt`: NowPlaying, QueueItem, RosterPlayer, LanDevice, OutputDevice,
  NameId, SleepState; `Command` (Command.kt).
- `core/session/SessionClient.kt`: `state: StateFlow<SessionState>` (connection, clientId, players,
  lanDevices, activeClientId, queues, lastSession, sleep, offsets, isActiveHere, remoteActive);
  `connect`, `disconnect`, `move`, `claim`, `report`, `publishQueue`, `send(command, to)`,
  `sendPrefs`, `setSleep`, `setSleepEndOfTrack`, `sleepDone`, `sendOffset`, `serverNow`,
  `playhead`, `onForeground` / `onBackground`; callbacks `onCommand`, `onLike`, `onPrefs`,
  `onSignedOut`.
- `core/stores/Likes.kt` (`state: StateFlow<LikesState>`, `set`, `toggle`, `toggleThrowing`,
  `refresh`, `remote`), `Connectivity.kt` (`offline`), `LyricJobStore.kt` (`jobs`, `order`,
  `revision`, `pill`, `events`, `sync`).
- `player/Player.kt`: the Player interface (`state: StateFlow<PlayerState>`,
  `progress: StateFlow<PlayerProgress>`, play / queue / transport / modes / transfer, `prewarm`,
  `localFile`, `likes`, `onOfflinePlay`).
- `app/Route.kt`, `app/Navigator.kt`: navigation. `push`, `pushFromHome`, `open` (closes layers
  first), `select` (lit tab pops to root, then scrolls to top; Home always lands on its root),
  `pop`, `back` (system back: top layer first), layer flags. `AppModel` / `LocalAppModel` for DI.

## Not ported yet (lead backlog)
- Offline store (downloads for offline, offline index, play log) and `Player.localFile` wiring.
- Library store (playlists, saved albums, layout; reacts to `AppModel.libraryChanged`).
- Theme store (prefs-driven colours) and the locale loader behind `L()`.
- Toast centre (offline pill, lyric-sync pill, `LyricJobEvent` toasts).
- Store id: `com.lukasbaxter.slopify.android` is a placeholder until the owner picks one.

## Lead request queue
(empty)
