# Design

The shared look of the app. Feature code takes colours, type, spacing, icons, strings and
shared views only from here (CONVENTIONS.md). Every value traces to `docs/UI.md` and the cited
web file.

## Setup (shell, once)

```swift
let themeStore = ThemeStore(account: model.account)
root
  .themed(themeStore)                          // \.theme, ThemeStore, colour scheme
  .environment(\.apiClient, model.account.api) // CoverImage / Avatar URLs
Localizer.shared.follow(model.account)         // prefs.language, live
await Localizer.shared.refreshServerDefault(api: model.account.api)
ToastCenter.shared.themeStore = themeStore
ToastCenter.shared.layout = .shell(miniPlayer: true)   // .nowPlaying while it is open
```

## Tokens

| Thing | Use |
|---|---|
| `@Environment(\.theme) var theme` | every colour token: `theme.fg`, `fgSub`, `fgDim`, `accent`, `accentInk`, `seekAccent`, `onAccent`, `page`, `bgBase`, `chip`, `sheet`, `field`, `cardHover`, `danger`, `dangerBg`, `tint*` ... `theme.fg(0.08)` = `rgba(fg,.08)`; `theme.rgb.x` raw `RGB` |
| `.darkIsland()` / `.heroIsland()` / `.themeInk()` | light-theme islands: now playing, tiles, mini row / detail heroes (`fg-sub #d0d0d0`) / sheet from the mini player |
| `Theme.Fixed.*` | non-token colours: avatar fallbacks, offline pill, scrims, mix palette, Liked gradient, hero defaults |
| `ThemeStore` | `theme`, `colors`, `preset`, `set(_:)` (patches prefs) |
| `ThemeColors`, `ThemePreset.all`, `ThemePreset.matching` | the 4 colours, the 6 presets, "Custom" detection |
| `RGB` | `RGB(hex:)`, `.mix`, `.colorMix`, `.hex`, `.color`, `.inkOn`, `.contrast` |
| `Radius` | `panel 8`, `art 4`, `row 6`, `rowArt 3`, `card 2`, `sheet 16`, `dialog 8` |
| `Spacing` | `gap 8`, `gutter 16`, `shelfGap 16` |
| `Shell` | `tabBar 49`, `miniPlayer 56`, `topBar 56`, `header 48`, `contentBottom 137`, `trackRow 64` |
| `Motion` | `ease(d)`, `sheet(d)`, `sheetIn`, `sheetOut`, `drawerIn`, `nowPlayingIn`, `snapBack`, `imageFade` |
| `Gestures` | long-press 450 ms / 10 pt, sheet and now-playing dismiss, skip-swipe thresholds |
| `TextStyle` + `.textStyle(_:)` | `pageTitle`, `rowTitle`, `subLine`, `cardTitle`, `tabLabel`, `barTitle`, `section*`, `chip`, `button`, `toast`, `mini*`, `dialogTitle`, Encore `titleLg...marginal` |

## Colour from artwork

| Thing | Use |
|---|---|
| `ArtworkColor.shared.vibrant(url)` | now playing `--np` (raw) |
| `.mini(url)` | mini player card (`clampLightness`) |
| `.hero(url)` | detail `--hero` (`heroTint`, phone) |
| `.palette(url)` | 3 visualizer stops |
| `ColorMath.phoneHero(hex)`, `.detailHero(...)`, `.blurhashAverage`, `.clampLightness`, `.heroTint` | the pure maths (tested against the JS) |

## Images

| Thing | Use |
|---|---|
| `CoverImage(.init(album), size: 48, shape: .rounded(3) / .circle, placeholder: .chip/.cardHover/.note/.none)` | any artwork; give it a frame |
| `CoverSource` | `.album`, `.track`, `.playlist` (cover hash busts cache), `.artist`, `.banner`, `.folder`, `.user`, `.url` |
| `LikedCover(heart: 0.45)` | Liked Songs tile |
| `Avatar(userId:name:size:drawer:)` | user picture with initial fallback |
| `ImageLoader.shared` | `image(url)`, `cached(url)`, `evict(url)` |

## Icons

`IconView(.heart, filled: liked, size: 24)` takes the foreground style. All web glyphs are in
`Icon` (generated: `node ios/tools/gen-icons.mjs` writes `Icons/IconData.swift`).
Composites: `RepeatGlyph(mode: .off/.all/.one)`, `ShuffleGlyph(mode: .off/.on/.smart)`,
`DownloadGlyph(state: .none/.busy(progress:)/.part/.done)`, `NowPlayingBars()`.

## Strings

`L("Added to {name}", ["name": x])`, `LBold(key)` for `<b>` markup, `Localizer.shared`
(`language`, `locale`, `setUserPick`, `languages`). Locale JSON: `ios/tools/sync-locales.sh`.

## Components

| View / modifier | What |
|---|---|
| `.pressable(.row/.fade/.dim, onTap:onLongPress:onTouchDown:)` | tap + 450 ms long-press with haptic, press feedback |
| `.onLongPressMenu {}`, `.pressDim()`, `ButtonStyle .pressFade/.pressRow/.pressPlain`, `Haptics.tick()` | press helpers |
| `TrackRow(track:showArt:number:isCurrent:isPlaying:isDownloaded:isUnavailable:isHighlighted:subtitle:snippet:onTap:onMore:onArt:onTouchDown:onSnippet:)` | shared track row (5.4) |
| `MediaCard(source, title:subtitle:round:style:missing:request:action:)` | album / artist tile (6.0.7) |
| `Shelf(items:style:) { cell }`, `CardGrid(items:) { cell }` | horizontal shelf, 2-col grid |
| `SectionHeader(title, style: .home/.search/.artist/.detail, first:, showAll:)` | `.shelf-head` |
| `DetailScaffold(title:heroColor:barStyle:onBack:) { ... }` | detail page with the fading top bar (2.6) |
| `HeroHeader(color:title:coverSize:onTitleTap:) { cover } meta: { ... }`, `HeroOwner` | album/playlist hero (6.3.2) |
| `ActionRow(heroColor:artist:) { leading } trailing: { ... }` | colour band + action row (6.3.3) |
| `.reportsHeroHeight()`, `.shellContentPadding()`, `\.detailTopInset` | custom heroes, root scroll padding |
| `BigPlayButton(playing:action:)`, `IconButton(.icon, on:label:action:)`, `FollowPill`, `RequestPill`, `PrimaryButton`, `SecondaryButton` | buttons |
| `Chip(title, on:small:action:)`, `ChipRow { }` | pills |
| `ErrorBanner(message:compact:onTap:)` + `.pageBanner()`, `PlaceholderNote` | banners |
| `SkeletonRows(count:art:)`, `SkeletonTitle`, `.skeletonPulse()` | loading |
| `Marquee(text)`, `FittedTitle(text:)` | scrolling line, title ladder |
| `QualityBadge(format:small:)`, `DeliveredFormat.delivered/label` | quality tag |
| `TextField(...).textFieldStyle(.slopify(focused:))`, `SearchField(placeholder:text:)` | inputs |
| `.contextMenuSheet($menu)` with `MenuSheet(header: MenuHeader, items: [MenuItem])` | context menus (5.5); `MenuItem.separator/.heading`, `offlineSubset`, `tidy` |
| `.bottomSheet(item:)`, `.bottomSheet(isPresented:)`, `BottomSheetFrame`, `@Environment(\.closeSheet)` | any bottom sheet (device sheet, sleep timer) |
| `MenuList(header:items:onPick:)` | menu rows inside a custom sheet |
| `.nameDialog($dialog)` (`NameDialog`), `.confirmDialog($dialog)` (`ConfirmDialog`) | dialogs (2.10) |
| `.overlayCover(item:) { item, close in }` | transparent full-screen presentation (custom modals) |
| `ToastCenter.shared.show(text, seconds:)`, `.offline`, `.lyricSync`, `.layout` | toast + pills above everything |
| `ToastView`, `OfflinePill`, `LyricSyncPill` | the pill views themselves |
