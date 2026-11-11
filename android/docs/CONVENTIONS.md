# Slopify Android: rules for everyone working on it

Native Kotlin + Jetpack Compose client for the Slopify server. No WebView, no JS.
The model is the native iPhone app in `ios/`: same architecture, same contracts, same screens.
The UI stays the same as the web app's phone layout (web/src). Do not invent layouts, labels,
sections or features. When unsure, read the cited web source and the iOS port, and match them.

Specs live with the iOS app and apply here unchanged:
- `ios/docs/API.md`: server contract.
- `ios/docs/UI.md`: screens and visuals.
- `ios/docs/DECISIONS.md`: owner decisions (they override UI.md).
- `docs/TASKS.md` (this folder): who owns what here, status, shared contracts.

Ground truth when the docs are unclear: `server/src`, then `web/src/api/*.js`, then the iOS code.

## Ownership (strict)
- You own only the folders your task names. Do not edit files outside them.
- The lead owns `app/` (Route, Navigator, AppModel, shell), `core/`, `player/Player.kt`,
  `design/` until the design task starts, the Gradle files, `Makefile` and `docs/`.
  Need a change there (model field, endpoint, shared component)? Do not edit it. Put the request
  in your final report under **Requests**, work around it locally in your folder in the
  meantime (a private extension or helper) marked `// TODO(lead): <what>`.
- Never edit `ios/docs/*`. Report errors in them under **Spec issues**.
- Never touch anything outside `android/` (server, web, mobile, ios, tv, CI).
- No git commits, no pushes, no installs on a device. The lead commits.

## Build and test
- JDK 17 and the Android SDK. `make` finds them (JAVA_HOME / ANDROID_HOME, else the usual
  install spots); `local.properties` is git-ignored.
- `make build` (debug APK) must pass before you report done.
- `make test` runs the JVM unit tests; `make test ONLY='*YourAreaTest'` runs yours. Add tests
  under `app/src/test/.../<your area>/` for logic (parsing, state machines, formatting).
  UI does not need screenshot tests.
- `make install` puts the debug APK on the attached device (owner only).
- Zero warnings. The Kotlin compiler treats warnings as errors, so a warning fails the build.
- Network tests never hit a real server: `MockWebServer` (see `core/StubServer.kt` in tests)
  with JSON copied from API.md, or a fake `SocketTransport` for the socket.
- Time-dependent code takes its clock and scope from the caller so tests run on virtual time
  (`runTest`, `backgroundScope`, `advanceTimeBy`). No `Thread.sleep` in logic tests.
- The emulator only when a test truly needs instrumentation: headless
  (`emulator -no-window -no-audio`), always with a kill timer, never left running. Never end
  your turn while a build, test or emulator runs in the background.

## Code style
- Kotlin, Compose, Material 3 only as plumbing (the look comes from `design/`).
- Coroutines + `StateFlow` for observable state. Core stores run on the app scope (Main);
  network IO suspends, parsing big frames runs on `Dispatchers.Default`.
- Libraries: AndroidX, kotlinx (coroutines, serialization), OkHttp. Media3 for the player.
  Anything else needs the lead.
- JSON: `SlopifyJson` only. Wire names exactly as the server sends them (`@SerialName` for
  PascalCase queue items, snake_case releases); decoding as tolerant as the iOS app.
- One main type per file where reasonable; files named after it.
- Colours, type, spacing, icons only from `design/` tokens. No hex literals in feature code.
- User-facing strings only through `L("key")` (design) using the web's keys from
  `web/src/locales`. Never hardcode English. Core never builds UI text: it reports structured
  values (for example `LyricJobEvent`, `LyricJobStage`) and the UI words them.
- Never hardcode server addresses, account names, user names or IPs. Everything comes from the
  signed-in server. Tests use `example.com` hosts and `MockWebServer`.
- Comments explain *why*, short. No essays, no em dashes.

## Names (all features share one module)
- Every helper that is not one of your screens is `private`/`internal` or carries your area
  prefix (`HomeShelfModel`, `SearchDebouncer`). Same for test fakes (`HomeFakeApi`).
- Screen composables keep the iOS names (`HomeView`, `AlbumView`, ...), one package per area
  under `features/`.

## Report format (your final message)
1. **Done**: what works, file list.
2. **Verified**: exact commands run and their result.
3. **Not done / stubbed**: honest list, with `TODO` locations.
4. **Requests**: changes you need in lead-owned files, precise (type, field, signature).
5. **Spec issues**: anything in API.md/UI.md that was wrong or missing.
Do not claim something works unless you built and tested it.

## Shell and insets (one rule)
- The shell (`app/MainShell`) draws every page full screen and passes **no insets** (no
  Scaffold padding). The mini player and the tab bar float over the bottom of the page.
- Top: each screen handles the status bar itself. Root pages pad their header by
  `WindowInsets.statusBars`; detail pages use `DetailScaffold` (it adds `56 + top inset`). Never
  add the status bar twice.
- Bottom: scrolling content ends with `shellContentPadding()` (design: `Shell.contentBottom` +
  navigation bar inset). `shellTabBarHeight()` / `shellChromeHeight()` (app) give the tab bar and
  tab bar + mini player heights for anything pinned to the bottom.
- Layers (now playing, queue, drawer) are full screen too and pad both insets themselves.
- Every tab root and every page on a stack stays composed while it is on the stack (like the iOS
  ZStack of NavigationStacks), so plain `remember` / `rememberSaveable` state and list scroll
  survive pushes and tab switches. Screens need no app-lifetime state holders for that.
- Lit-tab tap on a root: `ScrollToTopEffect(Tab.X) { listState.animateScrollToItem(0) }`.
- Lists opened from the Home root: `nav.pushFromHome(route)` and mark the tile with
  `Modifier.homeZoomSource(route)`; the shell zooms from it and closes on a swipe down.
- Now playing / queue / drawer: `nav.setNowPlayingOpen`, `setQueueOpen`, `setDrawerOpen`. The
  shell slides now playing and the queue in (`Motion.nowPlayingIn`) and out, closes them on
  system back, and has a fallback swipe-down that yields to a screen consuming the drag itself.
  `AccountDrawer()` is always composed and shows itself from `nav.drawerOpen`. The device sheet
  is local state of the mini player / now playing (as on iOS); the shell hosts none.

## Parallel builds (every task)
- Always pass your task name: `make build TASK=<task>`, `make test TASK=<task> ONLY='*YourTest'`.
  It builds into `build-<task>/` with its own Gradle cache, so parallel agents never wait on locks.
- Run Gradle in the foreground only. Never end your turn while a build, test or emulator runs.
- Emulator (AVD `slopify`): headless (`-no-window -no-audio`), with a kill timer, shut down before you finish.
  Only one agent may use it at a time; prefer JVM tests and Compose previews.
- Names: every helper type that is not one of your stub screens is `private`/`internal` to your file
  or prefixed with your area (`HomeShelfModel`, `SearchFakeApi`). Shared helpers belong in design/.
