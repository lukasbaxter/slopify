# Design

The shared look of the app, ported from `ios/Slopify/Design` (the "current look"). Feature code
takes colours, type, spacing, icons, strings and shared views only from here (CONVENTIONS.md).
Every value traces to `ios/docs/UI.md`, the iOS port and the cited web file. iOS points = dp.

## Setup (done once, already wired)

```kotlin
// AppModel.create: before anything reads L()
Design.install(context, SharedPrefsStore(context))      // image + colour disk caches, locale tables
// AppModel
val themeStore = ThemeStore(account, scope)              // prefs.theme, live
Localizer.shared.follow(account.prefs, scope)            // prefs.language, live
ToastCenter.shared.follow(connectivity, lyricJobs, scope) // offline pill, lyric pill + toasts
Localizer.shared.refreshServerDefault(account.api)       // in start()
// MainActivity
SlopifyTheme(model.themeStore, model.account.api, model.player, model.connectivity) { RootView() }
// the shell keeps this current
ToastCenter.shared.layout.value = ToastLayout.Shell(miniPlayer = true)   // NowPlaying while it is open
```

`SlopifyTheme` provides `LocalTheme`, `LocalApiClient`, `LocalPlayer`, `LocalConnectivity`,
draws the page colour, sets the system bar icon colour, and layers sheets/dialogs and then
toasts above the whole app.

## Tokens (`design.theme`)

| Thing | Use |
|---|---|
| `Theme.current` (or `LocalTheme.current`) | every colour token: `fg`, `fgSub`, `fgDim`, `fgFaint`, `accent`, `accentInk`, `seekAccent`, `onAccent`, `onFg`, `page`, `bgBase`, `bgElevatedHi`, `chip`, `sheet`, `field`, `cardHover`, `danger`, `dangerBg`, `tint*` ... `theme.fg(0.08)` = `rgba(fg,.08)`; `theme.rgb.x` raw `RGB` |
| `DarkIsland { }` / `HeroIsland { }` / `ThemeInk { }` | light-theme islands: now playing, tiles, mini row / detail heroes (`fg-sub #d0d0d0`) / sheet from the mini player |
| `Theme.Fixed.*` | non-token colours: avatar fallbacks, offline pill, scrims, mix palette, Liked gradient, hero defaults, browse tiles |
| `ThemeStore` | `theme` / `colors` (StateFlow), `fallback`, `preset`, `set(colors)` (patches prefs) |
| `ThemeColors`, `ThemePreset.all`, `ThemePreset.matching` | the 4 colours, the 6 presets (Classic, Midnight, Ember, Orchid, Mono, Paper), "Custom" detection |
| `RGB` | `RGB.parse("#hex")`, `RGB.hex(0xRRGGBB)`, `strictHex`, `.mix`, `.colorMix`, `.hex`, `.color`, `.inkOn`, `.contrast` |
| `Radius` | `panel 8`, `art 4`, `row 6`, `rowArt 3`, `card 2`, `sheet 16`, `dialog 8` |
| `Spacing` | `gap 8`, `gutter 16`, `shelfGap 16` |
| `Shell` | `tabBar 49`, `miniPlayer 56`, `miniPlayerGap 8`, `topBar 56`, `header 48`, `contentBottom 137`, `trackRow 64` |
| `Motion` | `ease(ms)`, `sheet(ms)`, `sheetIn()`, `sheetOut()`, `drawerIn()`, `nowPlayingIn()`, `snapBack()`, `imageFade()`, `scrim()` |
| `Gestures` | long-press 450 ms / 10 dp, sheet and now-playing dismiss, skip-swipe thresholds, `sheetShouldDismiss` |
| `TextStyles.*` | same names as iOS `TextStyle`: `pageTitle`, `rowTitle`, `subLine`, `cardTitle`, `cardTitlePage`, `cardSub`, `tabLabel`, `barTitle`, `section*`, `chip`, `chipSmall`, `button`, `toast`, `mini*`, `qualityBadge`, `dialogTitle`, `menuHeading`, `mono`, Encore `titleLg...marginal`. Pass the colour on the `Text`. |

## Colour from artwork (`design.color`)

| Thing | Use |
|---|---|
| `ArtworkColor.shared.vibrant(url)` | now playing `--np` (raw) |
| `.mini(url)` | mini player card (`clampLightness`) |
| `.hero(url)` | detail `--hero` (`heroTint`, phone) |
| `.palette(url)` | 3 visualizer stops |
| `ColorMath.phoneHero(hex)`, `.detailHero(...)`, `.blurhashAverage`, `.clampLightness`, `.heroTint`, `.vibrant(px)`, `.palette(px)` | the pure maths, tested against the JS (`ColorFixtures.json`) |

## Images (`design.image`)

| Thing | Use |
|---|---|
| `CoverImage(CoverSource.of(album), 48.dp, Modifier.size(48.dp), shape = CoverShape.Rounded(3.dp) / Circle, placeholder = Chip/CardHover/Note/None)` | any artwork; give it a size |
| `CoverSource` | `AlbumArt`, `TrackArt`, `PlaylistArt` (cover hash busts cache), `ArtistArt`, `Banner`, `Folder`, `User`, `Url`; `CoverSource.of(album/track/playlist/artist)` |
| `LikedCover(heart = 0.45f)` | Liked Songs tile (white heart) |
| `Avatar(userId, name, size, drawer)` | user picture with initial fallback |
| `ImageLoader.shared` | `image(url)`, `cached(url)`, `data(url)`, `evict(url)` (OkHttp disk cache 512 MB + memory LRU, `Accept: image/webp,image/jpeg`, in-flight sharing) |

## Icons (`design.icons`)

`IconView(Icon.Heart, filled = liked, size = 24.dp, tint = theme.fgSub)`; `tintAll = true` paints
the fixed-colour parts too. All 88 web glyphs are in `Icon` (generated: `node android/tools/gen-icons.mjs`
reads `ios/Slopify/Design/Icons/IconData.swift`, so both apps draw the same paths). Composites:
`RepeatGlyph(RepeatGlyphMode.Off/All/One)`, `ShuffleGlyph(ShuffleGlyphMode.Off/On/Smart)`,
`DownloadGlyph(DownloadGlyphState.None/Busy(p)/Part/Done)`, `NowPlayingBars()`. `drawIcon(spec, ...)`
paints a glyph inside a custom `Canvas`.

## Strings

`L("Added to {name}", "name" to x)` (package `design`), `LBold(key)` for `<b>` markup (an
`AnnotatedString`), `Localizer.shared` (`language`, `locale`, `setUserPick`, `languages`). The
language follows `prefs.language`, else the server default (`/api/i18n`), else the phone's
languages. Locale JSON: `android/tools/sync-locales.sh` copies `web/src/locales/*.json` to
`res/raw/locale_*.json`.

## Components (`design.components`, `design.sheets`, `design.overlay`)

| View / modifier | What |
|---|---|
| `Modifier.pressable(PressFeedback.Row/Fade/Dim/None, onLongPress =, onTouchDown =) { tap }` | tap + 450 ms long-press with haptic, press feedback; `PressState` + `Modifier.pressDim(state)` for card art; `Modifier.onLongPressMenu {}` |
| `TrackRow(track, showArt, number, isCurrent, isPlaying, isDownloaded, isUnavailable, isHighlighted, subtitle, snippet, onMore, onArt, onTouchDown, onSnippet) { tap }` | shared track row (5.4); swipe right adds to the queue (`SwipeToQueueBox`, uses `LocalPlayer`); `artistLine(track)` |
| `MediaCard(source, title, subtitle, round, style = CardStyle.Home/Page, missing, request) { open }` | album / artist tile (6.0.7); a slot form takes any art |
| `Shelf(items, style) { cell }`, `CardGrid(items) { cell }` | horizontal shelf, 2-col grid |
| `SectionHeader(title, style = SectionStyle.Home/Search/Artist/Detail, first, showAll)` | `.shelf-head` |
| `DetailScaffold(title, heroColor, barStyle = DetailBarStyle.*, onBack) { item {...}; items(...) }` | detail page (a `LazyColumn`) with the fading top bar (2.6) |
| `HeroHeader(color, title, coverSize, onTitleTap, cover = {}) { meta }`, `HeroOwner` | album/playlist hero (6.3.2) |
| `ActionRow(heroColor, artist, leading = {}) { trailing }` | colour band + action row (6.3.3) |
| `Modifier.reportsHeroHeight()`, `shellContentPadding()`, `LocalDetailTopInset` | custom heroes, root list padding |
| `BigPlayButton(playing) {}`, `IconButton(Icon.X, label, on) {}`, `FollowPill`, `RequestPill`, `PrimaryButton`, `SecondaryButton` | buttons |
| `Chip(title, on, small) {}`, `ChipRow { }` | pills |
| `ErrorBanner(message, compact, onTap)` + `Modifier.pageBanner()`, `PlaceholderNote` | banners |
| `SkeletonRows(count, art)`, `SkeletonTitle()`, `Modifier.skeletonPulse()` | loading |
| `Marquee(text, style =, color =)` (never wider than offered), `FittedTitle(text)` | scrolling line, title ladder |
| `QualityBadge(format, small)`, `DeliveredFormat.delivered/label` | quality tag |
| `SlopifyTextField(value, onValueChange, placeholder)`, `SearchField(placeholder, text, onTextChange)` | inputs |
| `ContextMenuSheet(menu) { menu = null }` with `MenuSheet(MenuHeader, listOf(MenuItem(...)))` | context menus (5.5); `MenuItem.separator/heading`, `offlineSubset`, `tidy` |
| `TrackMenu.items(state, actions)`, `rememberTrackMenuBuilder { dialog = it }.sheet(track)` | the shared track menu, wired to likes, prefs, player, nav, lyric jobs, share |
| `BottomSheet(item) { }`, `BottomSheet(visible) { }`, `BottomSheetFrame`, `LocalCloseSheet.current { then }` | any bottom sheet (device sheet, sleep timer) |
| `MenuList(header, items) { pick }` | menu rows inside a custom sheet |
| `NameDialogHost(dialog) { dialog = null }` (`NameDialog`), `ConfirmDialogHost(dialog) {}` (`ConfirmDialog`) | dialogs (2.10) |
| `OverlayCover(item, onDismiss) { item, close -> }`, `OverlayLayer { }` | full-screen layer above the app (custom modals) |
| `ToastCenter.shared.show(text, seconds)`, `.offline`, `.lyricSync`, `.layout` | toast + pills above everything |
| `ToastView`, `OfflinePill`, `LyricSyncPill` | the pill views themselves |
| `ShareSheet.present(context, url, title)` | Android share sheet (copies the link when nothing can take it) |

Sheets and dialogs are shown by composing their host while the value is non-null, e.g.

```kotlin
var menu by remember { mutableStateOf<MenuSheet?>(null) }
var dialog by remember { mutableStateOf<NameDialog?>(null) }
val builder = rememberTrackMenuBuilder { dialog = it }
TrackRow(t, onMore = { menu = builder.sheet(t) }) { play(t) }
ContextMenuSheet(menu) { menu = null }
NameDialogHost(dialog) { dialog = null }
```

## Differences from iOS

- Sheets, dialogs and toasts are layers in the design root, not separate windows; system back
  closes the top sheet or dialog. `ConfirmDialog` uses the platform (Material) alert.
- `DetailScaffold` is a `LazyColumn` (content is `LazyListScope`), so long track lists stay lazy.
- The artist back disc is black 50 % without the iOS blur material.
- `TrackMenuBuilder` reads playlists from `AppModel.library` (`LibraryStore`); "downloaded" comes
  from `Player.localFile` until the offline store exists.
- Text sizes are `sp`, so the phone's font scale applies (iOS uses fixed sizes).
