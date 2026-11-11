# Slopify iOS: UI spec (phone layout)

What this is: the phone layout of the Slopify web client (`web/src`), written down so the native SwiftUI app can rebuild it screen for screen without reading the JSX/CSS. The owner wants the native UI to look and behave the same as the web app, so treat every value here as a target, not a suggestion.

- Reference viewport: 393 x 852 pt (iPhone 15/16, `playwright.config.ts` project `phone`: `viewport {393, 852}, isMobile, hasTouch`).
- The phone layout is CSS `@media (max-width: 760px)` and JS `isMobile` (`web/src/App.jsx:269`) / `usePhone()` (`web/src/components/TrackRow.jsx:27`). Everything wider is the desktop layout, which this document ignores.
- CSS px = iOS pt (1:1). Durations are in seconds as in CSS (`.25s` = 250 ms).
- Cascade order matters in the web build: `app.css` first, then `mobile-nowplaying.css`, `mobile-home-search.css`, `mobile-library.css` (`web/src/main.jsx:7-10`). When two values are listed for the same thing, the one from the later file wins. This document already picked the winner unless it says otherwise.
- **UNSURE** marks anything inferred rather than read in the code.
- Source references are `path:line`. Paths starting `web/`, `mobile/`, `server/`, `tools/` or `docs/` are relative to the repo root (`~/Projects/slopify`); shorter ones (`components/…`, `styles/…`, `api/…`, `player/…`, `offline/…`, `App.jsx`) are relative to `web/src`. Line numbers are from the 2026-11-10 tree.
- The web app copies Spotify's iOS app on purpose (the code comments cite Spotify's Encore tokens). When in doubt, Spotify iOS is the visual reference the web app was chasing.

## Contents

1. Screen inventory and navigation
2. Design tokens and the app shell (tabs, header, drawer, detail top bar, toasts, dialogs, gestures, safe areas, sign-in and server screens)
3. Player (mini player, now playing, queue, lyrics, visualizer)
4. Devices, casting and remote control
5. Library, track rows, menus, downloads/offline
6. Home, Search and detail pages
7. Settings, profile, stats, admin, themes
8. Language / i18n
9. Icons
10. Open questions and risks
## 1. Screen inventory and navigation

### 1.1 Map

```
Launch
 ├─ Server address (first launch; native shell screen)            2.12
 ├─ Can't reach server / offline-with-nothing                     2.12
 ├─ Sign in  ─┬─ invite sign-up (?invite=)                        2.12
 │            └─ Choose a new password (default password)         2.12
 └─ Main shell (tab bar + floating mini player)                   2.3
     ├─ Tab: Home (root)                                          6.1
     ├─ Tab: Search (root: Browse / Recent / Results)             6.2
     ├─ Tab: Your Library (root)                                  5.2
     │     └─ Naming page (new playlist / folder / rename)        5.2.10
     ├─ Pushed detail pages (any tab; slide in from the right)
     │     Album · Artist · Playlist · Liked Songs · Daily Mix / Your Top Songs ·
     │     Genre / Charts (Browse) · Release Radar · See all (Albums / Artists / Your top artists) ·
     │     Profile · Listening history · Downloads · Settings (+ Scrobbling sub-page)
     ├─ Account drawer (avatar)                                   2.7
     ├─ Now playing (full screen; Album / Lyrics modes)           3.2
     │     ├─ Queue page (full screen)                            3.3
     │     ├─ ⋯ track sheet (+ Add to playlist, artists, sleep timer sub-sheets)   3.2.7
     │     └─ Device sheet                                        4.3
     ├─ Device sheet (from the mini player)                       4.3
     ├─ Context-menu sheets (long-press / ⋯ anywhere)             5.5, 5.6
     ├─ Settings option sheets (quality, crossfade, language, theme)  7.2.4
     └─ Dialogs: New playlist name, Edit details, Generate playlist (AI), Logs, Calibrate*   2.10, 6.3.11, 6.4, 7.6.2, 4.7
```

`*` Calibrate and the Visualizer exist in the code but cannot be reached from the phone layout (sections 3.2.6, 4.7). Decide with the owner before building them.

### 1.2 Screen table

| # | Screen | Kind | How you get there | How you leave | Section |
|---|---|---|---|---|---|
| 1 | Server address | full screen | first launch; Settings > Server address; can't-reach screen | Connect / Cancel | 2.12 |
| 2 | Can't reach server | full screen | server not answering at launch | Try again; Server address | 2.12 |
| 3 | Sign in | full screen | no saved session; any 401 | Log in | 2.12 |
| 4 | Invite sign-up | variant of 3 | invite link `?invite=` | Create account | 2.12 |
| 5 | Choose a new password | full screen | account on the default password | Save and continue | 2.12 |
| 6 | Home | tab root | Home tab; app start | tabs | 6.1 |
| 7 | Search | tab root, 4 states (browse, recent, results, no results) | Search tab | tabs; Cancel returns to browse | 6.2 |
| 8 | Your Library | tab root (list or grid; chips; find field) | Library tab | tabs | 5.2 |
| 9 | Naming page | full-screen overlay | Library `+` > Playlist / Folder; folder Rename | Cancel / Create | 5.2.10 |
| 10 | Album | pushed | album card/row, track menu Go to album, now playing album link, share link | Back | 6.3.2-6.3.4 |
| 11 | Artist | pushed | artist name links, cards, menus | Back | 6.3.7 |
| 12 | Playlist | pushed | library row, shortcut, search | Back | 6.3.2-6.3.4 |
| 13 | Liked Songs | pushed | library first row, shortcut | Back | 6.3.5 |
| 14 | Daily Mix / Your Top Songs {year} | pushed | Home Made For You / Your Top Songs tiles | Back | 6.3.6 |
| 15 | Genre / Charts | pushed | Search browse tiles | Back | 6.3.8 |
| 16 | Release Radar | pushed | Home Release Radar heading | Back | 6.3.9 |
| 17 | See all: Albums / Artists / Your top artists | pushed | shelf headings | Back | 6.3.10 |
| 18 | Profile | pushed | drawer header; Settings profile row | Back | 7.4 |
| 19 | Listening history (stats) | pushed | drawer | Back | 7.5 |
| 20 | Downloads (server album requests) | pushed | drawer | Back | 5.9 |
| 21 | Settings | pushed | drawer; Profile ⋯; History links | Back | 7.2 |
| 22 | Settings > Scrobbling | in-page sub-page with its own bar | Settings row | its back button | 7.2.3 |
| 23 | Account drawer | left drawer over everything | avatar on a root tab | scrim tap, swipe left, a row | 2.7 |
| 24 | Now playing | full-screen cover (rises from the bottom) | tap the mini player | chevron, swipe down, Back | 3.2 |
| 25 | Now playing: Lyrics mode | mode of 24 | lyrics button | chevron (back to Album mode) | 3.2.5, 3.4 |
| 26 | Queue | full-screen page (rises) | queue button in now playing | chevron | 3.3 |
| 27 | Device sheet ("Connect to a device") | bottom sheet | device button (mini player, now playing) | scrim, drag down, pick a row | 4.3 |
| 28 | Context-menu sheet (+ stacked sub-sheets) | bottom sheet | long-press 450 ms on a row/card/tile; ⋯ buttons | scrim, drag down (top-level only), pick | 5.5, 5.6 |
| 29 | Now playing ⋯ sheet, sleep-timer sub-sheet | bottom sheet | ⋯ in now playing | as 28 | 3.2.7 |
| 30 | Settings option sheets (phone quality, quality elsewhere, crossfade, language, theme) | bottom sheet | Settings rows | as 28 | 7.2.4 |
| 31 | Library create sheet | bottom sheet | Library `+` | as 28 | 5.2.10 |
| 32 | New playlist name dialog | centred dialog | track menu > Add to playlist > New playlist | Cancel / Create / backdrop | 2.10 |
| 33 | Edit details (playlist) | dialog | playlist ⋯ > Edit details | Cancel / Save | 6.3.11 |
| 34 | Generate playlist (AI) | dialog | Library `+` > Generated playlist (AI); playlist ⋯ > Regenerate | close / done | 6.4 |
| 35 | Logs | dialog | Settings > Logs | close | 7.6.2 |
| 36 | Speaker calibration | overlay | not reachable on phone | | 4.7 |
| 37 | Visualizer mode of now playing | mode of 24 | not reachable on phone | | 3.7 |

Always-present overlays: the mini player (3.1), the tab bar (2.4), the offline pill (2.9), the lyrics-sync pill (2.9, 3.4.5), toasts (2.9).

Count: 22 distinct full screens/pages (1-22, counting Search and Library as one screen each), 2 full-screen modal layers (now playing with its Lyrics mode, queue), 1 drawer, 5 kinds of bottom sheet, 4 reachable dialogs, plus 2 unreachable (calibration, visualizer).

### 1.3 Navigation rules (summary)

- Three tabs; one global back stack whose entries remember their tab (2.4, 2.5).
- Back: chevron on pushed pages, left-edge swipe (x < 28, dx > 70), and closing now playing / queue first.
- Long-press = context menu everywhere (450 ms, 10 pt slop). Exception: Your Library rows in the normal (tree) view lift at 380 ms for drag-to-reorder, and open their menu only if released without moving more than 8 pt (5.2.9, 5.2.11).
- Sheets slide up (0.2 s), follow a downward drag and close past 100 pt (or a 40 pt flick); now playing and the queue rise from the bottom (0.3 s); now playing closes on a 140 pt drag (60 pt flick).
- Tapping the lit tab scrolls its root to the top, or returns to the root from a pushed page (2.4).

---

## 2. Design tokens and the app shell

### 2.1 Colour tokens (default dark theme)

Source: `web/src/styles/app.css:5-46`. Themes (including the light "paper" themes) override these at runtime through `applyTheme()` in `web/src/api/prefs.js`; see section 7 for every theme's values. Build the native palette as a set of named tokens with these names so a theme can swap them.

| Token | Value | Used for |
|---|---|---|
| `--black` | `#000000` | Desktop app background; sign-in page background on phone |
| `--bg-base` | `#121212` | Phone app background, header, sticky bars |
| `--bg-highlight` | `#1f1f1f` | |
| `--bg-elevated` | `#1f1f1f` | Cards, banners |
| `--bg-elevated-hi` | `#2a2a2a` | Menus, chips/pills (inactive), modal dialogs |
| `--card` | `#181818` | |
| `--card-hover` | `#282828` | |
| `--tint` | `#ffffff1a` (white 10%) | Secondary button background |
| `--tint-hi` | `#ffffff24` (white 14%) | Row hover |
| `--tint-press` | `#ffffff36` (white 21%) | |
| `--fg` | `#ffffff` | Primary text |
| `--fg-dim` | `#b3b3b3` | Secondary text |
| `--fg-chrome` | `#a9a9a9` | |
| `--fg-sub` | `#a7a7a7` | Sub-lines (artist under title), inactive tab labels |
| `--fg-faint` | `#727272` | |
| `--fg-rgb` | `255,255,255` | Used as `rgba(var(--fg-rgb), a)` for translucent white |
| `--accent` | `#1ed760` | Primary green (play buttons, active chips, toasts) |
| `--accent-hover` | `#3be477` | |
| `--accent-press` | `#1abc54` | Pressed big play button |
| `--accent-ink` | `#1ed760` | Green used as a text/icon colour (active shuffle/repeat, casting) |
| `--accent-on-dark` | `#1ed760` | |
| `--accent-rgb` | `30,215,96` | |
| `--seek-accent` | `#1db954` | ONLY the liked heart fill (and desktop seek fill) |
| `--danger` | `#f3727f` | Error text |
| `--danger-bg` | `#2a1618` | Error banner background |
| `--on-fg` | `#000000` | Text on a white button |
| `--on-accent` | `#000000` | Text/icons on the green |
| `--page` | `#121212` | Page colour (`--page-rgb` `18,18,18`) |
| `--chip` | `#2a2a2a` | Chips, shortcut tiles, search field in Library, image placeholders |
| `--field` | `#1f1f1f` | Text field background |
| `--sheet` | `#282828` | Bottom sheets (context menus) |
| `--green` | `#1ed760` | |

Radii and spacing tokens: `--r-panel 8`, `--r-art 4`, `--r-row 6`, `--gap 8`. Standard easing `--ease: cubic-bezier(.3, 0, 0, 1)`. Phone sheets and pushes use `cubic-bezier(.2,.7,.2,1)` (native equivalent: a fast ease-out; **UNSURE** of the exact SwiftUI spring that matches, use `.timingCurve(0.2, 0.7, 0.2, 1, duration:)`).

Light themes: places that sit on artwork colour keep the dark tokens so text stays white: the detail hero, now playing (`.fs`), Browse tiles, the calibration card, the detail top bar when the page has a hero, and the mini player row (`web/src/styles/app.css:50-58`, `1271`). The mini player's device sheet takes the theme's own colours back (`--theme-fg`, `--theme-fg-dim`, `--theme-on-fg`; `app.css:1272`).

Other fixed colours that are not tokens:
- Avatar fallback: `#509bf5` disc, black initial, 14/700 (`app.css:712-715`); in the drawer header the fallback disc is `#535353` with a white initial (`app.css:1216`).
- Offline pill `#3a3a3a`; scrims `rgba(0,0,0,.55)` (drawer) and `rgba(0,0,0,.6)` (sheets, dialogs).
- Mix tile palette (Home): `#e8115b #1e3264 #8d67ab #e13300 #148a08 #0d73ec #7d4b32 #ba5d07` (`web/src/components/Home.jsx:43`), see section 6.

### 2.2 Typography

- Font: the system font. CSS stack `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`, base `400 16px/1.5` (`app.css:84-90`). On iOS that is SF Pro: use the system font in SwiftUI, never a bundled one. No custom fonts anywhere. Monospace only for colour hex values in Settings and admin inputs (`ui-monospace, SFMono-Regular, Menlo`).
- Antialiased text, no text selection on chrome (inputs and lyric lines stay selectable) (`app.css:1407-1410`, `mobile-home-search.css:11-12`).
- Type scale (Encore, `app.css:97-104`): title-lg 48/700 ls -2; title-md 32/700 ls -1; title-sm 24/700; body 16/400; body-b 16/700; small 14/400; small-b 14/700; marginal 12/400. The phone mostly uses: page titles 24/700 ls -0.3, row titles 16/400, sub-lines 13/400 `--fg-sub`, card titles 14/700, tab labels 10/500.

### 2.3 Phone shell layout

Source: `web/src/App.jsx:1538-1812`, `web/src/styles/app.css:1195-1475`, `web/src/styles/mobile-nowplaying.css:125-145`, `web/src/styles/mobile-home-search.css:4-70`.

Z-order, bottom to top:

| Layer | z-index | Notes |
|---|---|---|
| Page content (scroll view) | 0 | Fills the screen; scrolls under the floating mini player and tab bar |
| Detail top bar (`.mobile-topbar`) | 40 | Only on pushed (detail) pages |
| Tab bar | 46 | Fixed to the bottom |
| Mini player | 47 | Fixed just above the tab bar |
| Offline pill | 60 | |
| Header on the Home tab (holds the avatar and drawer) | 60 | |
| Toast | 100 | |
| Lyrics-sync pill | 99 | |
| Modal dialogs (`.modal-back`) | 130 | |
| Queue / right panel (full screen on phone) | 150 | |
| Now playing (`.fs`) | 200 | Full screen (`app.css:1001`); sheets opened from it sit above it |
| Account drawer scrim / drawer | 199 / 200 | |
| Context-menu scrim / sheet / sub-sheet | 299 / (sheet) / 301 | |
| Device sheet | 300 | |

Vertical structure of a root tab page (Home / Search / Library):

1. Status-bar safe area (`env(safe-area-inset-top)`), page colour behind it.
2. Header (`.navbar`): min height 48 + top inset, horizontal padding 16, gap 12, background `--bg-base`. Contents left to right: 32x32 round avatar, then the page title 24/700 letter-spacing -0.3 (`Search` or `Your Library`). On the Home tab the header collapses to height 0 and the avatar floats at `top: 8 + inset`, `left: 16` over Home's sticky chip row (the chips are padded 56 on the left to make room), so avatar + chips read as one row (`mobile-home-search.css:61-71`). On the Search tab, once the search field is focused (Cancel button visible) the header collapses to 0 too (`mobile-home-search.css:115-116`).
3. Scrolling content. Bottom padding = `24 + 56 + 8 + 49 + bottom inset` (= 137 + inset) so the last row clears the mini player and tab bar (`mobile-nowplaying.css:139`).
4. Mini player, floating (section 3): fixed, `bottom: 49 + bottom inset`, full width, padding `24 8 0`, with a gradient behind it from transparent to `rgba(page, .92)` at 24 pt to `--page` (`mobile-nowplaying.css:132`). The card itself is 56 tall with an 8 margin below.
5. Tab bar (below).

On a pushed detail page the header is hidden (`.app.mobile-detail .navbar { display: none }`) and the floating detail top bar takes its place; the tab bar and mini player stay.

The desktop "app menu" (three dots), history arrows and brand are hidden on the phone (`app.css:1201`, `1224-1225`).

### 2.4 Bottom tab bar

Source: `web/src/App.jsx:171-180` (glyphs), `1781-1798`; CSS `app.css:1243-1247`, `mobile-nowplaying.css:133`.

- Three equal columns: Home, Search, Your Library (labels are i18n keys `Home`, `Search`, `Your Library`).
- Height `49 + bottom inset`; padding top 6, bottom `4 + inset`; items aligned to the top. Background `--page` (solid; the CSS gradient from app.css is overridden by mobile-nowplaying.css).
- Each item: vertical stack, gap 2, padding 2/0; 24x24 glyph; label 10 pt weight 500. Colour `--fg-sub` (#a7a7a7) when off, `--fg` (white) when on. Pressed: opacity 0.6.
- Glyphs: Spotify's outline glyph when off, the filled glyph when on (SVG paths in `App.jsx:172-180`, components `TabHome`, `TabSearch`, `TabLib`).
- Tapping:
  - an unlit tab: switches to that tab's root (Home and Search push a history entry; Library shows the library page).
  - the lit tab while on its root page: smooth-scrolls the page to the top (on the Library root this currently does nothing, because it scrolls the hidden `.content` instead of the library list; see 5.1).
  - the lit tab while on a detail page pushed inside it: goes to that tab's root (`App.jsx:1786-1790`).
- Lit tab rule ("per-tab stacks", `App.jsx:388-395`, `425`): a detail page opened from Your Library keeps Library lit; Home/Search light by the root view. Each history entry remembers which tab it was opened from, and going Back restores that tab's highlight.

### 2.5 Navigation model (history stack)

Source: `web/src/App.jsx:398-530`, `774`.

- One linear history stack of entries `{view: 'home'|'search', detail, seeAll, tab, scroll}`. `detail` is the open page (kinds: Album, Artist, Playlist (also Liked Songs and mixes), Radar, Browse, Downloads, History, Settings, Profile; see section 1). `seeAll` is `albums | artists | topArtists`.
- Opening any page pushes an entry (a page that merely refreshes, for example a playlist streaming its rows in, updates the current entry instead). Forward entries are dropped on push.
- Each entry stores its scroll offset; Back restores it (retrying up to 12 times at 80 ms while lists fill in). A newly pushed page always starts at the top.
- Back sources: the round back chevron on detail pages, the left-edge swipe (below), and Android/system back. The native app should map this to a `NavigationStack` per tab only if it reproduces this exact behaviour: switching tabs does not keep separate stacks in the web app; it is one global stack in which each entry remembers its tab. **UNSURE** whether the owner would accept true per-tab stacks; the web code comments call it "Spotify's per-tab navigation stacks" but implements one stack.
- Now playing is its own history step: Back closes it and returns to the page underneath. "Go to artist/album" from now playing replaces the player's step with the new page (so Back from that page goes to the page the player was opened from, not back into the player) (`App.jsx:278-299`).
- Push animation: the new detail page slides in from the right, `translateX(100%) -> 0`, 0.2 s, `cubic-bezier(.2,.7,.2,1)`, transform only (`mobile-home-search.css:46-47`). There is no animated pop (Back just shows the previous page). **UNSURE** whether a native pop animation is acceptable; a standard iOS pop is the closest match to "slides like a native stack".
- A share link (`?album=`, `?artist=`, `?track=`) opens that page after sign-in; a track opens its album with that row highlighted (`App.jsx:845-865`). Native: universal links / URL scheme with the same parameters.

### 2.6 Detail-page top bar

Source: `web/src/App.jsx:1374-1394`, `1546-1555`; CSS `app.css:1226-1231`, `mobile-home-search.css:31-36`, `mobile-library.css:143, 214-217`.

- Fixed at the top, full width, height `56 + top inset`, padding-top = inset, z 40. Three columns `48 | 1fr | 48`. Touches pass through except on the back button.
- Back button: 32x32 circle at left margin 16, 18x18 chevron (path in `App.jsx:1551`; size `mobile-library.css:305`), white. Background `rgba(0,0,0,.5)` with an 8 pt background blur (`mobile-library.css:304`), but only on artist pages (artist photo behind it); every other page shows a bare chevron with no disc. Once fully scrolled (`--topbar` = 1) the disc goes transparent. Background transition 0.15 s.
- Bar background: a layer whose colour is `mix(heroColour 55%, --page 45%)` (CSS `color-mix(in srgb, var(--topbar-bg) 55%, var(--page))`), where heroColour is the page's `--hero` colour (album/playlist colour, section 6; fallback `#121212`). Its opacity follows scroll: `progress = clamp((scrollTop - 40) / span, 0, 1)` with `span = max(120, heroHeight - 60)` (160 if no hero).
- Title: centred, 16/700, white, one line with ellipsis, opacity `clamp(progress * 2 - 1, 0, 1)` (invisible until halfway, then fades in). Text = the page's name, or `Albums` / `Artists` / `Your top artists` on see-all pages.
- Exceptions: Liked Songs never shows the bar colour or title (`mobile-library.css:143`); Settings shows the bar solid (`--bg-base`, title always visible); Settings sub-pages hide the bar entirely and draw their own header (section 7). Light themes: a page without a hero gets a plain bar in the page colour.
- Detail pages pad their first block by `56 + top inset` so content starts under the bar.

### 2.7 Account drawer (avatar menu)

Source: `web/src/App.jsx:1585-1640`; CSS `app.css:1205-1223`, `712-735`.

Opened by tapping the avatar in the header (any root tab). It is Spotify's left drawer:

- Scrim: full screen `rgba(0,0,0,.55)`, fades in 0.25 s, z 199; tap closes.
- Drawer: fixed left, full height, width `min(82% of screen width, 340)`, background `--page`, shadow `0 0 60 rgba(0,0,0,.7)`, z 200, slides in from the left (`translateX(-100%) -> 0`, 0.25 s, `cubic-bezier(.2,.7,.2,1)`). Padding top `24 + inset`, bottom `24 + inset`. Vertical column, scrolls if needed. Closing has no animation in the web app (it just disappears). **UNSURE**: a slide-out is probably fine.
- Swipe left on the drawer to close: horizontal move < -50 and |dx| > 1.5 x |dy| (`App.jsx:1605-1611`). Escape / any tap outside also closes.
- Header row (`.who`, a button that opens Profile): padding `8 20 20`, gap 12, margin-bottom 8. 56x56 round avatar (user image, or initial on `#535353`, 22/700); name 20/700; below it `View profile` 13 `--fg-sub`, margin-top 2. If no name: `Signed in`.
- Rows (padding `14 20`, gap 16, 16 pt text, 24x24 line icon stroke 1.8, round caps/joins, white):
  1. `Listening history` (opens History)
  2. `Downloads` (opens Downloads)
  3. `Settings` (opens Settings)
  4. `Log out`: pushed to the bottom of the drawer (`margin-top: auto`).
  (Profile row and the server address line are desktop-only and hidden on the phone. Update rows only exist in the desktop app.)
- Icon paths: `App.jsx:1619-1636` (`MenuIco` with a single path each).

Log out ends the server session (best effort) and clears all account data held in memory and the saved session, then shows sign-in (`App.jsx:759-766`). Any 401 anywhere does the same (`slopify:unauthorized`, `App.jsx:768-772`).

### 2.8 Gestures (global)

All from `web/src/App.jsx`. Thresholds are in pt.

| Gesture | Where | Rule | Result | Source |
|---|---|---|---|---|
| Long-press | any row/card/tile that has a context menu | still for 450 ms, finger moves < 10 in x and y; not on inputs, sliders, or elements marked `data-own-press` (Library rows, which use hold-to-drag) | opens that item's context menu sheet; haptic tick (`vibrate(10)`); the lift after the press is swallowed (does not play the row) | `1395-1432` |
| Horizontal swipe on the mini player | the mini player card (not the device sheet, menus, inputs, volume) | abs(dx) > 60, abs(dy) < 40, within 600 ms | left = next track, right = previous | `1433-1449` |
| Swipe down on now playing | anywhere on now playing except a scrolled lyrics pane, the visualizer, sheets, inputs | the view follows the finger (`translateY(dy)`, only when dy > 0 and more vertical than horizontal) | release with dy > 140, or dy > 60 within 300 ms: animate to `translateY(100%)` over 0.25 s `cubic-bezier(.2,.7,.2,1)` then close at 200 ms; otherwise snap back over 0.25 s | `1450-1480` |
| Swipe down on a bottom sheet | context-menu sheets and the device sheet (not sub-sheets), only when the sheet is scrolled to the top, not on sliders | sheet follows the finger | release with dy > 100, or dy > 40 within 300 ms: close; otherwise snap back (0.2 s ease-out) | `1481-1514` |
| Left-edge swipe | touch starting at x < 28 | dx > 70, abs(dy) < 60, within 700 ms; not while now playing or the queue is open | Back | `1515-1530` |
| Tap lit tab | tab bar | | scroll to top / pop to root | `1786-1790` |

Touch feel (`app.css:1399-1431`): no tap highlight, no callouts, no hover tints. Pressed state is a background `rgba(255,255,255,.08)` on rows (track rows, library rows, shortcuts, queue rows, history rows, menu items); artwork dims to brightness 0.8 on cards/tiles/shortcut art; buttons in the tab bar and now-playing controls go to opacity 0.6. No rubber-band on the shell, content scroll views contain their overscroll. No scrollbars.

Keyboard: Space toggles play/pause when not typing (`App.jsx:776-797`); irrelevant on iPhone unless a hardware keyboard is attached.

Hardware volume buttons: when the music plays on another device (remote mode), the shell turns volume button presses into volume steps for that device (`player.volumeStep(±1)`, `App.jsx:1176-1181`, `1295-1310`). When it plays on the phone, the buttons control the phone as usual. The native app must do the same (observe `AVAudioSession.outputVolume` or use an `MPVolumeView` trick while remote). **UNSURE** of the best native technique; the behaviour is the requirement.

### 2.9 Toasts, pills, banners, loading

- Toast (`.toast`, `app.css:781-786`): fixed, centred horizontally, `bottom: 96` (150 when a lyrics-sync pill is showing, `.toast.lifted`), background `--accent` green, text `--on-accent` black 14/500, padding 12/16, radius 8, shadow `0 4 12 rgba(0,0,0,.5)`, z 100. Shows 2.2 s by default (some messages 5 s); a new toast replaces the old one and restarts the timer (`App.jsx:657-666`). No enter/exit animation. Note: on the phone 96 pt from the bottom overlaps the floating mini player; that is what the web app does today. **UNSURE** whether this is intended; keep it unless the owner says otherwise.
  Common toast texts (i18n keys): `Added to Liked Songs`, `Removed from Liked Songs`, `Added to Your Library`, `Removed from Your Library`, `Added to {name}`, `Created {name}`, `Removed from playlist`, `Playlist updated`, `Deleted {name}`, `Profile picture updated`, `Not saved: {error}`, `Could not save settings: {error}`, `Excluded from your taste profile`, `Included in your taste profile`, `Downloading...`, `Converting to WAV...`, `{name} is ready offline ({n} songs)`, `{name} is ready offline (1 song)`, `{name}: {done} of {total} songs downloaded, {failed} failed (Update download to retry)`, `That song isn't in this library`.
- Offline pill (`.offline-banner`, `app.css:1828`; `App.jsx:191-207`): shown whenever the app is offline. Text `Offline · downloaded music only`. Centred, 8 pt above the top of the mini player (or 16 from the bottom with no player), `#3a3a3a` background, white 12/600, padding 5/12, fully rounded, shadow `0 2 8 rgba(0,0,0,.4)`, ignores touches, z 60.
- Lyrics-sync pill (`web/src/components/LyricSyncStatus.jsx`, `app.css:772-779`): while lyric sync jobs run. Fixed `bottom: 96`, centred, max width `min(560, screen - 32)`, padding 10/16, fully rounded, background `--bg-elevated-hi`, 13 pt; a 14x14 spinner ring (2 pt border white 20%, top segment `--accent`, 0.8 s linear rotation) then `**Syncing lyrics** · {title} — {stage}` plus ` · {n} more` when several. Details in section 3.
- Error banner (`.banner.error`, `app.css:499-500`): padding 12/16, radius 8, background `--danger-bg` `#2a1618`, text `--danger` `#f3727f` 14 pt.
- Boot screen (`.boot`): centred `Starting Slopify...` in `--fg-dim` on black (`App.jsx:1532`, `app.css:749`). Native: the launch screen, then this text only if session restore takes noticeable time.
- Crash screen (`web/src/main.jsx:15-29`): black, padding 24, heading `Slopify stopped`, the error message at 80% opacity, a green pill `Reload` button (`#1db954`, black 700 text, padding 10/18). Native equivalent optional.
- Skeleton rows while a track list loads (`app.css:501-510`): rows min-height 64, 48x48 `--chip` square radius 4, two bars (`--chip`, 12 tall at 55% width, 10 tall at 35%, radius 6), pulsing opacity 1 -> 0.45 -> 1 over 1.4 s ease-in-out on the phone (`mobile-home-search.css:49`). Title placeholder `.sk-title`: 60% wide, 22 tall, radius 6.

### 2.10 Dialogs

`New playlist` name dialog (`App.jsx:1768-1779`, `app.css:853-860`), used when "Add to playlist > New playlist" is picked for a track:
- Backdrop `rgba(0,0,0,.6)`, z 130, centred card; tap on the backdrop cancels.
- Card: `--bg-elevated-hi` `#2a2a2a`, radius 8, padding 24, width `min(420, screen - 32)`, gap 16, shadow `0 16 24 rgba(0,0,0,.3)`.
- Title `New playlist` 20 pt (weight default bold for h3, **UNSURE** 700).
- Text field prefilled with the track's album name (or `My Playlist`), all text selected on focus, autofocus; padding 12/14, radius 4, border 1 `#555`, background `--field`, 15 pt; focused border white.
- Buttons right-aligned, gap 8: `Cancel` (secondary: 1 pt border `#7a7a7a`, fully rounded, padding 8/16, 14/700) and `Create` (white pill, black 700 text, padding 10/24; disabled at 40% when the name is blank).
- On create: playlist made with that track, toast `Added to {name}`.

Other dialogs (Generate playlist, Edit details, Logs, Calibrate) are described in their sections.

### 2.11 Safe areas and the iOS status bar

- The web app runs edge to edge (`viewport-fit=cover`, status bar style `black-translucent`, `web/index.html`). All chrome adds `env(safe-area-inset-*)` itself: header top, detail top bar top, hero top padding (`56 + inset`), tab bar bottom, sheets' bottom padding, drawer top/bottom, now playing top/bottom. In SwiftUI: draw backgrounds under the safe areas and pad content by the insets in the same places.
- Status bar content is light (white) everywhere. Portrait only (`manifest.webmanifest`: `portrait-primary`).
- The `--ios-shim` workaround (`App.jsx:1129-1174`, `mobile-nowplaying.css:255-271`) only exists for an iOS 18 PWA viewport bug; not needed natively.
- Page background colour is `--page` (`#121212`) under everything (`mobile-home-search.css:8`); the sign-in page is pure black.

### 2.12 Sign-in, first password, invite, demo, server address

#### Server address screen (native shell today)

Today the phone app is a React Native shell (`mobile/App.js`) around the web page; it owns the server-address screen, which the native app must reproduce. English only (no i18n in the shell). Source: `mobile/App.js:575-655`, `mobile/address.js`.

- Shown on first launch, from Settings > `Server address` (section 7), and from the can't-reach screen.
- Full screen black `#000`, keyboard-avoiding scroll view; content centred vertically, padding 24 horizontal / 64 vertical, max width 480.
- Title `Your Slopify server` white 24/700, margin-bottom 24.
- Label `Server address` white 14/600, margin-bottom 8. Field: placeholder `music.example.com` (`#6a6a6a`), text white 16, background `#1f1f1f`, radius 6, border 1 `#3e3e3e`, padding 12, margin-bottom 20; no autocap/autocorrect, URL keyboard, return key Go submits; autofocus when empty.
- Hint `With or without https:// in front. Slopify works it out.` `#b3b3b3` 13/18 line height, margin-bottom 20.
- Optional suggestion (when the server reported a public address different from the typed LAN one): `Away from home your server is at {host}. ` + green 700 `Use it` link (`#1ed760`); tapping moves the typed address into the home field and puts the public one in the main field.
- Label `Home network address`, field with placeholder `Filled in for you after you sign in`. Hint: (`Found by the app. ` when auto-filled) + `At home, Slopify streams straight over your Wi-Fi from this address, and switches by itself when you leave. Leave it empty to always use the server address.`
- Error text `#f3727f` 14, margin-bottom 16. Messages: `Enter the address of your Slopify server.`, `That server address doesn’t look right. Try something like music.example.com.`, `That home address doesn’t look right. Try something like 192.168.1.10:8080.`, `No Slopify server answered at {host}. Check the address, and that the phone can reach it.`
- Buttons row right-aligned, gap 8: `Cancel` (only when editing; text `#b3b3b3` 600, padding 10/16) and `Connect` (green `#1ed760` pill, black 700 text, padding 10/22; shows a black spinner while probing, 60% opacity).
- Address rules (`mobile/address.js`): trim; if no scheme, a bare IPv4, a `.local` name or a one-word host gets `http://`, everything else `https://`; lower-case host; drop default ports and trailing slashes. Without a typed scheme both `https` and `http` are tried in parallel (`GET {addr}/api/healthz` must return `{ok: true}`, 6 s timeout for the main address, 3 s for home). Either address answering is enough to save.
- Home/away switching: at home the app uses the home address, away the main one, switching without reloading or interrupting playback (`App.jsx:1269-1294`).

Can't-reach screen (`mobile/App.js:515-526`): black, centred, gap 16. Title `You are offline` or `Can’t reach your server` (white 20/700); text `Slopify opens again by itself when you are back online.` or `{host} is not answering. Slopify keeps trying.` (`#b3b3b3` 15/21); green `Try again` pill (min width 140, spinner for up to 8 s); `Server address` text link (`#b3b3b3` 600). A plain `#b3b3b3` activity spinner on black while loading. Note: the web app with downloads also works offline (offline pill), so this screen should only appear when there is nothing usable offline. **UNSURE** how the native app should merge these two behaviours.

#### Sign-in form

Source: `web/src/App.jsx:89-169`; CSS `app.css:749-762`, `1381-1396`.

- Page: pure black, content aligned to the top, padding-top `80 + inset`. Form full width, padding 0/24, vertical gap 16.
- Logo mark: 40x40 white circle-and-waves glyph (path in `App.jsx:137`), centred, margin-bottom 8.
- `Slopify` heading, centred, 28/800, letter-spacing -0.5, white.
- Subtitle `Your library, on any speaker in the house.` centred 15 `--fg-sub`, margin-bottom 16.
- Fields (label above, 14 white, gap 8): `Username` (autofocus, no autocap/autocorrect, username autofill) and `Password` (secure, current-password autofill; new-password for an invite). Input: background `--page` `#121212`, border 1 `#727272`, radius 4, padding 14, 16 pt white; focused border white, no outline.
- (Desktop only: a `Server` field. On the native app the server comes from the server-address screen.)
- Error: the error banner (2.9) with margin 0.
- Button: green `--accent` pill, black 16/700, min height 48, margin-top 8. Text `Log in`, `Logging in…` while busy; disabled (30% opacity) until a username is typed.
- Invite link (`/?invite=code`): the same form becomes sign-up. Hint `You have been invited. Pick a username and a password (8 characters or more).` (12 `--fg-dim`), button `Create account` / `Creating account…`. Registers (`POST /api/auth/register {invite, username, password}`) then signs in.
- Demo server: before showing the form, the web app asks the server for a demo guest session; if one is granted it signs straight in and the form never shows (`Starting Slopify...` meanwhile) (`App.jsx:98-106`).
- After sign-in, if the account must change its default password, the Choose-a-new-password screen shows; nothing else works until it is done.

#### Choose a new password

Source: `App.jsx:40-74`. Same page style as sign-in, no logo.
- Heading `Choose a new password`; subtitle `The default password only opens this page. Pick a new one for {name}.` (`{name}` = user name or `this account`).
- Fields `New password` (autofocus) and `Again`, both new-password autofill.
- Validation: `Use 8 characters or more.`; `The two passwords differ.`; server errors in the banner.
- Button `Save and continue` / `Saving…`, disabled while empty.

### 2.13 Background behaviour that affects the UI

- Live updates: other devices' likes, playlist changes, prefs (theme, quality, language) arrive over the session socket and apply instantly (`App.jsx:689-726`). A language picked on another device applies at the next quiet moment (nothing playing here, no touches for 2 minutes) (`App.jsx:300-312`, `1215-1227`).
- Instant paint: the app paints from the last-run copies (albums, artists, playlists, saved albums, liked rows, likes, prefs, the last 40 album/artist pages opened) and refreshes behind (`App.jsx:544-563`, `825-842`). Native should cache the same and never show an empty page for something seen before.
- Phone streaming quality differs from other devices (section 7). Lossless on the phone goes over HLS (`App.jsx:313-324`).

---

## 3. Player

Scope: the phone (viewport 393x852, `@media (max-width: 760px)`) mini player, the full-screen Now Playing page, the Queue page, Lyrics, the (unreachable on phone) Visualizer, the quality badge, marquee titles, and the playback rules behind the buttons. All values are CSS px = iOS pt.

Paths are relative to `web/src/`. CSS cascade note: `styles/mobile-nowplaying.css` loads after `styles/app.css` (`main.jsx:9-12`), so when both set the same property with the same specificity, **mobile-nowplaying.css wins**. The values below are the ones that win.

### 3.0 Tokens used in this section

The defaults are in `styles/app.css:5-46`. At runtime `api/prefs.js:42-97 applyTheme()` overwrites them from the account theme (default theme `{accent:#1ed760,bg:#121212,surface:#1f1f1f,fg:#ffffff}`), so treat these as theme-driven values.

| Token | Default value | Notes |
|---|---|---|
| `--fg` | `#fff` | `--fg-rgb` = `255,255,255` |
| `--fg-sub` | `#a7a7a7` | secondary text |
| `--fg-dim` | `#b3b3b3` | quality badge (lossy), sync banner text |
| `--on-fg` | `#000` | glyph colour on a white (`--fg`) circle |
| `--accent` / `--accent-ink` | `#1ed760` | "on" state of shuffle/repeat/lyrics, casting device, lossless badge, current queue row |
| `--seek-accent` | `#1db954` in CSS, but applyTheme sets it to the theme accent (`#1ed760`) | filled liked heart |
| `--page` | `#121212` | `--page-rgb` = `18,18,18` |
| `--chip` | `#2a2a2a` | fallback card tint |
| `--sheet` | `#282828` | bottom sheets, lifted queue row |
| `--card-hover` | `#282828` | image placeholder background |
| `--danger` / `--danger-bg` | `#f3727f` / `#2a1618` | player error bar |
| font | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`, base 16/1.5, antialiased (`app.css:83-89`) | use SF Pro |

**Light themes.** The mini player card (`app.css:1250`) and the whole Now Playing page (`.fs`, `app.css:51-57`) always force the dark token set (white text). The queue page (`.rightpanel` without `with-bg`) does **not**: it uses the theme's own light tokens.

**Touch feedback, phone-wide** (`app.css:1408-1425`): no tap highlight, no callouts. `.qrow:active` and `.ctxitem:active` get background `rgba(fg,.08)`. `.icon-btn:active` and `.fs-controls button:active` get opacity `.6`. Hover states are disabled.

---

### 3.1 Mini player (floating card)

Sources: `components/Player.jsx:190-444`, `styles/mobile-nowplaying.css:125-164`, `styles/app.css:582-651, 1249-1273`, `App.jsx:1434-1450`.

The mini player is **always rendered on the phone**, even with nothing playing. It then shows "Nothing playing", a placeholder square and a disabled play button (`Player.jsx:283-286, 343`).

#### 3.1.1 Placement and container

| Property | Value | Source |
|---|---|---|
| Container `.app.mobile .player` | `position: fixed; left:0; right:0; bottom: calc(49px + env(safe-area-inset-bottom)); z-index: 47` | mobile-nowplaying.css:132 |
| Container padding | `24px 8px 0`. The top 24 px is a fade zone. | :132 |
| Container background | `linear-gradient(to bottom, transparent 0, rgba(page-rgb,.92) 24px, var(--page) 100%)`. Lists scroll under it. | :132 |
| Tab bar below it | fixed, bottom 0, z 46, height `49 + safe-bottom`, background `--page` | :133, app.css:1243 |
| Scroll content bottom padding | `calc(24px + 56px + 8px + 49px + env(safe-area-inset-bottom))` = 137 + inset | :139 |
| Card `.player-row` | CSS grid with columns `minmax(0,1fr) auto auto`, `align-items: center`, gap 0, **height 56**, padding `0 8px`, margin `0 0 8px` (8 pt gap above the tab bar), **corner radius 6**, `overflow: hidden`, `position: relative` | :141 |
| Card background | `color-mix(in srgb, var(--mini, var(--chip)) 55%, #000)`, i.e. 55% cover tint + 45% black. Animated with `transition: background .3s`. | :141 |
| Card colour `--mini` | `rgb(clampLightness(vibrantColor(artUrl)))`. The art URL is the cover at `maxHeight 128`. Null when there is no art or extraction fails, which falls back to `--chip` (#2a2a2a). | Player.jsx:206, 213-219 |

On a 393 pt screen with a 34 pt bottom inset, the card's bottom edge sits 49 + 34 + 8 = 91 pt above the screen bottom, and the card spans 91 to 147 pt.

**Card colour algorithm.** `vibrantColor` is in `api/colors.js:21-59`:
1. Draw the cover at 40x40.
2. For each pixel, compute HSL. Skip pixels with lightness < .08 or > .92.
3. Bin by the top 4 bits of R, G and B: `key = (r>>4)<<8 | (g>>4)<<4 | (b>>4)`.
4. Score each bin as `count * (0.15 + meanSat) * (meanL in (.2,.75) ? 1 : .35)`.
5. Return the mean RGB of the best bin. The result is cached per URL.

`clampLightness` (`Player.jsx:91-108`) converts to HSL, clamps L into [0.18, 0.30] keeping hue and saturation, and converts back. RGB is returned unchanged when L is already in range.

#### 3.1.2 Contents, left to right

Grid order: `.player-now` (column 1), `.player-right` (CSS `order: 2`, column 2), `.player-controls` (`order: 3`, column 3).

| Element | Layout | Typography / colour | Source |
|---|---|---|---|
| `.player-now` | flex, center, gap **8**, min-width 0 | | mobile-nowplaying.css:142 |
| Cover `.player-art` | **40x40**, radius 4, object-fit cover, placeholder background `--card-hover` | | :143, app.css:587 |
| Meta `.player-meta` | flex column, gap 1 px, flexible, min-width 0 | | :144 |
| Title `.player-title` | single line, truncated with an ellipsis (**not** a marquee) | **13 / 600**, line-height 1.25, `--fg` | :145 |
| Artist `.player-artist` | single line, ellipsis. Plain text on phone, not tappable. Uses `nowPlaying.artist`, else artist names joined with ", " | **13 / 400**, line-height 1.25, `rgba(fg,.7)` | :146, Player.jsx:294-295 |
| "Playing on X" line (replaces the artist line when the sound is elsewhere) | flex, center, gap 6. Cast glyph 13x13 (`CastGlyph`, Player.jsx:137-145, stroke 2) followed by a Marquee span with `t('Playing on {name}')` | colour `--accent-ink` (!important). The font resolves to **13/400**: mobile-nowplaying's `.player-artist` overrides app.css's 12/600 for `.player-elsewhere`. **UNSURE** whether 12/600 was intended. | Player.jsx:288-289, app.css:1272-1273 |
| Heart | hidden on phone (`.player-now .trackrow-like {display:none}`) | | :147 |
| Device button (`.player-right .devicebtn`) | **44x44**, glyph 24x24 centered. Only the DevicePicker is visible in `.player-right`; lyrics, queue, volume and expand are hidden. | `--fg`; `--accent-ink` when casting (`active.kind !== 'local'`) | :148-152, DevicePicker.jsx:196 |
| Play/Pause (`.player-buttons .play`) | **44x44**, no background, margin-right **-8**. Glyph **20x20** (16-viewBox paths inline in Player.jsx:345-353). Disabled at opacity .3 when nothing is playing. | `--fg`. No press scale. | :155-159, app.css:601 |
| Shuffle / Prev / Next / Repeat | hidden on phone | | :155 |
| Progress line `.player-seek` | absolute: left 8, right 8, bottom 0, **height 2**, radius 1, pointer-events none. Played part `--fg`, unplayed `rgba(fg,.25)`. No thumb. Not interactive. | | :160-164 |

The "Playing on" label comes from `elsewhereLabel()` (`Player.jsx:118-135`):
- If another of my clients is the active player, the label is that client's name, or the speaker's name if that client drives a speaker.
- If this client plays to a speaker (any `kind` other than local or relay), the label is the speaker's name.
- Otherwise there is no label.

The desktop's green "Playing on" bar (`PlayingElsewhereBar`) is hidden on the phone (`app.css:1271`).

The progress line reads `usePlayhead(player)`, which re-reads `positionNow()` every 250 ms while playing (`player/playhead.js:8-21`): `pct = position / duration * 100`.

The error bar `.player-error` sits above the card when `player.error` is set. Background `--danger-bg`, text `--danger`, 14 px, padding 8 16, radius 4, margin-bottom 8. Tapping it clears the error (`Player.jsx:257-261`, `app.css:583`). Its `title` is the key 'Dismiss'.

#### 3.1.3 Gestures on the card

| Gesture | Exact behaviour | Source |
|---|---|---|
| Tap anywhere on the card except a button, input, link or `[role=button]` | Opens full-screen Now Playing. Tapping the cover also opens Now Playing; on phone the cover has no album action. | Player.jsx:268, 280 |
| Tap Play | `player.toggle()` | :343 |
| Tap device | opens the device sheet (covered by the casting section) | :412 |
| Horizontal swipe to skip | See the next table. | App.jsx:1434-1450, Player.jsx:223-245 |

**Swipe-to-skip.** The decision is made in App on `touchstart`/`touchend` on window.

| Rule | Value |
|---|---|
| Starts inside | `.player-row`, but not inside `.devicemenu, .ctxmenu, .ctxmenu-scrim, input, .dm-volume` |
| Skip condition | `abs(dx) > 60` AND `abs(dy) < 40` AND duration `< 600 ms` |
| Direction | left (dx < 0) is `next()`, right is `previous()` |

The visual follow is on `.player-now` only. The art, title and artist move; the device and play buttons stay put.
- It runs only with exactly one touch, and not inside the same exclusion list.
- If vertical movement exceeds horizontal before 6 px of horizontal travel, the gesture is abandoned.
- After `abs(dx) > 6` the row follows the finger with no transition:
  - `translateX(clamp(dx, -80, 80))`
  - `opacity = 1 - min(80, |dx|)/200` (minimum 0.6)
- On release with the skip condition met:
  1. Animate `transform .18s ease-out, opacity .18s ease-out` to `translateX(-120%)` (left swipe) or `+120%`, opacity 0.
  2. After 180 ms, jump with no transition to `translateX(+40px)` for a left swipe (`-40px` for a right swipe), i.e. the new item enters from the opposite side.
  3. On the next frame, animate `.2s ease-out` back to 0 and opacity 1.
- On release without a skip: animate `.18s ease-out` back to 0 and opacity 1.

The global long-press (450 ms) also applies, but the card has no `contextmenu` handler, so it does nothing there.

i18n keys: 'Nothing playing', 'Playing on {name}', 'Go to album' (title attr), 'Pause', 'Play', 'Dismiss', 'Remove from Liked Songs' / 'Save to Liked Songs' (heart, hidden on phone).

---

### 3.2 Full-screen Now Playing (`.fs`)

Sources: `components/FullScreen.jsx:121-378`, `styles/mobile-nowplaying.css:5-111`, `styles/app.css:1001-1065, 1346-1373, 1465-1471`, `App.jsx:266-299, 1451-1480`.

#### 3.2.1 Container, background, open/close

| Property | Value | Source |
|---|---|---|
| Layer | `position: fixed; inset: 0; z-index: 200`. Covers the mini player (47), tab bar (46) and queue page (150). | app.css:1001 |
| Layout | flex column, padding 0. Safe areas are handled by the children: top row and bottom block. | mobile-nowplaying.css:11 |
| Background, Album tab | `linear-gradient(180deg, var(--np,#535353) 0%, color-mix(in srgb, var(--np,#535353) 55%, var(--page)) 45%, var(--page) 100%)`. Not blurred; `.fs-bg` is `display:none`. | :11-12 |
| `--np` | `rgb(vibrantColor(art))`, **not** lightness-clamped (unlike the mini player). `art` is the displayed cover URL, so it is recomputed when the 320 px copy is swapped for the 640 px one. Null gives `#535353`. | FullScreen.jsx:245-246 |
| Open animation | `rise-in .3s cubic-bezier(.2,.7,.2,1)`: `translateY(100%)` to none | app.css:1465-1466 |
| Close via chevron | add class `.closing`: `transform: translateY(100%); transition: transform .25s ease-in`. Unmount after **250 ms** (`slideOut`). | mobile-nowplaying.css:108, Player.jsx:79-85 |
| History | Opening pushes a history entry (`{np:true}`). Back (Android, browser) closes the page. Closing from the UI pops the entry. "Go to artist/album" replaces the entry and closes the page, then navigates. | App.jsx:283-299, 446-447 |
| Initial tab on phone | always **Album** (desktop remembers the last tab) | FullScreen.jsx:124 |

**Swipe down to close** (`App.jsx:1451-1480`):
- Only when the touch starts on the page with one finger.
- Never when it starts inside `.viz, .ctxmenu, .devicemenu, .rightpanel, input`.
- Inside `.fs-lyrics`, only when that pane's `scrollTop` is 0.
- While moving: if `dy > 0` and `abs(dx) < dy`, the whole page follows with no transition (`translateY(dy)`).
- On release, set the transition `transform .25s cubic-bezier(.2,.7,.2,1)`. Close if `dy > 140`, or if the gesture took `< 300 ms` and `dy > 60`: animate to `translateY(100%)` and close after 200 ms. Otherwise snap back to 0.

#### 3.2.2 Top row `.fs-top` (mobile-nowplaying.css:13-23)

| Element | Value |
|---|---|
| Row | grid `44px minmax(0,1fr) 44px`, align center, padding `calc(4px + env(safe-area-inset-top)) 16px 0`, min-height 56 |
| Chevron-down (left) | 44x44 circle hit area, glyph **24x24** `--fg`. Inline SVG at `FullScreen.jsx:266`; the same path as `ChevronDown` in `RightPanel.jsx:28-32`. Tap: on the **Lyrics** tab it switches to the Album tab; otherwise it closes the page (slide down). |
| Centre, Album tab | two lines, centered, padding `0 4px`. Line 1 `<small>` is the context kind: **11 / 500**, letter-spacing `.08em` (0.88 pt), UPPERCASE, `rgba(fg,.7)`, ellipsis. Line 2 `<b>` is the context name: **13 / 700**, `--fg`, ellipsis. Line-height 1.25. |
| Centre, Lyrics tab | Line 1 `<b>`: track title, 13/700 `--fg`. Line 2 `<small>`: artist, **13 / 400**, `--fg-sub`, normal case, no letter-spacing (`.fs-from-artist`). |
| More "⋯" (right) | 44x44, glyph `G.dots` 24x24 `--fg`. Disabled (opacity .35) when there is no track. Tap opens the track sheet (3.2.7). |
| Desktop tabs (Album/Lyrics/Visualizer icons), divider, collapse button | **hidden on phone** (`.fs-tabs, .fs-close, .fs-output {display:none}`) |

**"Playing from"** text comes from `usePlayingFrom()` (`Player.jsx:23-59`). There are always two lines:

| Context id | Line 1 | Line 2 |
|---|---|---|
| none / unknown / lookup fails | 'PLAYING FROM' | 'Your Library' |
| `liked` or `__liked__` | 'PLAYING FROM PLAYLIST' | 'Liked Songs' |
| `radar` | 'PLAYING FROM PLAYLIST' | 'Release Radar' |
| `browse:<id>` | 'PLAYING FROM GENRE' | the genre tile's name (cached list `slopify.browse`), else 'Genre' |
| `mix:<artistId>` | 'PLAYING FROM PLAYLIST' | 'Daily Mix {n}', where n is the 1-based index of the seed in the persisted home top-artists list (first 16). Otherwise '{name} Mix' from the artist name, else 'Daily Mix'. |
| a library item | `MusicArtist` gives 'PLAYING FROM ARTIST'; `MusicAlbum` gives 'PLAYING FROM ALBUM'; anything else 'PLAYING FROM PLAYLIST' | item name |

#### 3.2.3 Stage `.fs-stage`, Album tab (mobile-nowplaying.css:25-29, FullScreen.jsx:305-306)

- Stage: `flex: 1 1 auto; min-height: 0; display: grid; place-items: start center; padding: 24px 24px 0; overflow: hidden`. The art sits 24 below the header and the slack goes **below** the art.
- Cover `.fs-art`: `width: 100%` of the 24-pt gutters (345 pt on 393), `aspect-ratio: 1`, `max-height: 100%`, **radius 8**, **no shadow** (mobile-nowplaying overrides app.css's shadow), object-fit cover.
- Placeholder when there is no art: same box with background `rgba(fg,.08)`.
- **UNSURE:** on a short screen, max-height could make the box non-square; the web relies on object-fit cover.
- Approximate vertical budget at 393x852 (top inset 59, bottom inset 34), computed from the CSS values:

| Part | Height (pt) |
|---|---|
| Header (4 + 59 + 44) | 107 |
| Stage top padding | 24 |
| Art | 345 |
| Bottom block | ~322 |
| Spare space under the art | ~54 |

**Art loading** (`FullScreen.jsx:66-102, 207-209`):
- Hi URL = image `maxHeight 640, full:true`. Lo URL = `maxHeight 320`.
- `useSteadyArt` keeps the **previous song's** art on screen until the new one has loaded and decoded. It paints lo first, then swaps to hi when hi has loaded. The swap does not re-run the fade.
- Each new song (a new `key`) runs `fs-art-in .45s ease-out both`: from `opacity .4; scale(.985)` to `opacity 1; scale(1)` (`app.css:1012-1014`).
- `prefers-reduced-motion` disables this fade (`app.css:1015`).
- Mirrored relay sessions provide `artUrl` directly (no lo copy).

#### 3.2.4 Bottom block `.fs-bottom` (mobile-nowplaying.css:30-77)

The container is a flex column, stretched, padding `24px 24px calc(16px + env(safe-area-inset-bottom))`. Children in visual order: meta (`order:1`), seek (2), controls (3), phone row (4).

**Meta row** `.fs-meta`: flex, center, gap 12, margin `0 0 16px`. The thumbnail is hidden on phone. The text column flexes with min-width 0.

| Element | Spec |
|---|---|
| Title | `Marquee` (3.6). **24 / 700**, letter-spacing **-0.3**, line-height 1.25, `--fg`. 'Nothing playing' when empty. |
| Artist(s) | `ArtistLinks` (TrackRow.jsx:82-103): each artist name is a separate inline tappable span, separated by ", ". Tapping one closes Now Playing and opens that artist page. Falls back to a single tappable `nowPlaying.artist`. **16 / 400**, line-height 1.3, `--fg-sub`. No underline on touch. |
| Quality badge | 3.5. In this row: margin-top **6**, **12 px**. |
| Like button `.fs-like` | 44x44, margin-right **-10**. Glyph **24x24** (`HeartPath`, FullScreen.jsx:37-39, 16 viewBox). Outline `--fg` when not liked; filled `var(--seek-accent)` when liked. Shown only when `nowPlaying.itemId` exists. Behaviour in 3.9.5. |

**Seek bar** `.fs-seek`:

| Property | Value |
|---|---|
| Layout | grid of 2 columns x 2 rows, margin `-20px 0 8px`. The negative top margin pulls the 44-pt hit area up so the 16-pt spacing is measured to the track. |
| Touch target | full width, **44 high**, margin-bottom -14 |
| Track | 4 px tall, vertically centered. Played part `--fg` up to pct; the rest `rgba(fg,.3)`. No radius. |
| Thumb | **12x12** circle `--fg`, no shadow, **always visible** on phone. While pressed it scales **1.34** (about 16 pt) with `transition: transform .12s`. |
| Times | font **11**, `--fg-sub`, line-height 1, tabular numerals. Left: elapsed `m:ss`. Right: **remaining** as `-m:ss`, i.e. `-(duration - shown)` clamped at 0. |
| Gesture | `touch-action: none`, so a slightly diagonal drag never pans the page |

Scrub behaviour (`FullScreen.jsx:133-155, 316-323`):
- Touch start: freeze the shown value at the live playhead, then set it from the finger.
- `value = clamp((touchX - barLeft) / barWidth * duration, 0, duration)`, so the finger x drives the value, not the native thumb. The time label follows the scrub value live.
- Release: `player.seek(lastValue)`. Exactly one seek per drag.
- After release, the local value is held for **250 ms**, or **1500 ms** when mirroring another device, so the thumb does not snap back before the reported position catches up.
- The global long-press is suppressed on inputs.
- Range is `0..max(1,duration)`. Time format is `m:ss` with minutes unbounded (`fmt`, FullScreen.jsx:18).

**Transport** `.fs-controls`: flex, center, `justify-content: space-between`, margin `0 0 24px`, colour `--fg`.

| Button | Hit area | Glyph | States |
|---|---|---|---|
| Shuffle (first) | 44x44, margin-left **-6** | `ShuffleGlyph` (TrackRow.jsx:71-76), rendered **24x24** | off: `--fg`. on or smart: `--accent-ink`. **There is no visual difference between "on" and "smart" here** (no spark, no dot). |
| Previous | 44x44 | 16-viewBox skip-back path (FullScreen.jsx:341), rendered **32x32** | |
| Play/Pause | **64x64 circle**, background `--fg` | `PlayGlyph` / `PauseGlyph` (TrackRow.jsx:59-69), rendered **28x28**, colour `--on-fg` (#000) | no hover scale |
| Next | 44x44 | skip-forward path (FullScreen.jsx:343), **32x32** | |
| Repeat (last) | 44x44, margin-right **-6** | 16-viewBox loop path (FullScreen.jsx:344), **24x24** | off: `--fg`. all or one: `--accent-ink`. **"Repeat one" has no "1" badge on the phone Now Playing** (only the desktop footer draws one). |

Press feedback: opacity .6 while pressed (`app.css:1416`). The phone CSS selects prev/next by `[title="Previous"]` / `[title="Next"]`, so in non-English locales those two glyphs may fall back to 24 pt. **UNSURE**; the native app should use 32.

**Phone bottom row** `.fs-phone-row` (order 4): flex, center, gap 0, `--fg`.

| Element | Spec |
|---|---|
| Device picker (left, flexible) | wrapper margin-left -10. Button: flex, gap 8, height 44, padding `0 10px`, **12 / 600**. Glyph 24x24 (`DeviceIcon`, DevicePicker.jsx). The device name is hidden **unless casting**: then glyph and name are `--accent-ink`, and the name is one line with ellipsis (Marquee). Tap opens the device sheet (casting section). |
| Lyrics toggle | 44x44, `G.lyrics` = `LyricsGlyph` 24 (Player.jsx:70-77, a microphone rotated 45 degrees). Off `--fg`, on `--accent-ink`. Tap toggles the tab between Album and Lyrics. |
| Queue | 44x44, margin-right **-10**, `G.queue` 24 (FullScreen.jsx:24). Tap starts the Now Playing slide-out (250 ms) and **at the same time** opens the Queue page (z 150, which runs its own rise-in under the closing Now Playing). |

The CSS comment mentions share and visualizer buttons in this row; **they are not rendered** (`FullScreen.jsx:366-374`).

**Volume on phone: none.** `.fs-output`, which holds the desktop device+volume, and the mini player's volume are hidden. The only phone volume UI is the speaker slider inside the device sheet (`.dm-volume`), shown only while the session is on a speaker. Hardware volume buttons call `player.volumeStep()` (usePlayer.js:1320-1326).

#### 3.2.5 Lyrics tab (mobile-nowplaying.css:79-97)

| Property | Value |
|---|---|
| Page background | `--page`. The gradient is replaced. |
| Blurred cover behind (`.fs-bg`, `display:block`) | absolute, inset **-60px**, cover-fit, centered, `transform: scale(1.1)`, filter `blur(60px) brightness(.32) saturate(1.3)` |
| Blurred cover image | the art the page first loaded, normally the 320-px lo copy. `useSteadyArt` does not move `bg` to the hi copy. |
| Song change crossfade | the new layer fades in over the old one: `fs-bg-in .9s ease both`, opacity 0 to 1. The old layer is removed when that animation ends (`CrossfadeBg`, FullScreen.jsx:107-114, app.css:1011). Reduced motion turns the fade off. |
| Stage | `display:block; padding:0` |
| Scroll pane `.fs-lyrics` | full width and height, padding `16px 24px calc(48px + env(safe-area-inset-bottom))`, vertical scroll, no scrollbar |
| Edge fade mask | `linear-gradient(transparent, #000 6%, #000 92%, transparent)`: top 6% and bottom 8% fade out |
| Bottom block | **hidden** (`.fs-bottom {display:none}`): no seek bar, transport or bottom row on the Lyrics tab |
| Leaving the tab | chevron (back to Album), or swipe-down when the pane is at scrollTop 0 (closes Now Playing). The ⋯ menu remains. |

The CSS comment speaks of "a mini transport at the bottom"; **it is not rendered**. Lyrics content and behaviour are in 3.4.

#### 3.2.6 Visualizer tab: **not reachable on phone**

The tab buttons live in `.fs-tabs`, which is hidden on phone. The phone row has no visualizer button. The settings sheet opens only from a second tap on the visualizer tab. So `tab === 'viz'` can never be set on a phone (`FullScreen.jsx:273-291, 366-374`).

Phone CSS for it does exist (mobile-nowplaying.css:99-105):
- stage padding `8px 0 0`
- hint `t('Play to start the visualizer')`, 13 px `--fg-sub`, centered
- while a sheet is open, the cover shows behind it and the canvas is hidden

Full detail is in 3.7 in case product wants it on iOS. **Recommendation: omit it from the native phone app**, matching the current web.

#### 3.2.7 "⋯" track sheet (FullScreen.jsx:221-240, 302; ContextMenu.jsx)

This is a bottom sheet (shared generic sheet; values in 3.8).
- **Header:** cover from image `maxHeight 120` (56x56, radius 4), title, artist.
- Tapping a row closes the sheet (slide-out 250 ms), then runs its action.
- A row with `sub` opens a second sheet stacked on top.

| # | Row (i18n key) | Icon (FullScreen.jsx unless noted) | Action |
|---|---|---|---|
| 1 | 'Add to queue' | `G16.queue` | `player.addToQueue([track])`: inserted right after the current track, behind any earlier hand-queued tracks (usePlayer.js:899-923) |
| 2 | 'Add to playlist' then a sub-sheet | `G.plus` | sub-sheet: 'New playlist' (`G.plus`; closes Now Playing and opens the new-playlist prompt with this track), a separator if there are playlists, then each playlist name (adds the track) |
| 3 | 'Add to Liked Songs' / 'Remove from Liked Songs' | `I.heart` / `I.heartOn` (TrackRow.jsx:140+) | like toggle (3.9.5) |
| — | separator | | |
| 4 | 'Go to song radio' | `G16.radio` | `jf.instantMix(id, 100, 'radio')`, then `playQueue(items, 0)` |
| 5 | 'Go to artist' | `G.artist` | one artist: open it (closes Now Playing). More than one: a sub-sheet listing them. |
| 6 | 'Go to album' | `G.album` | open the album (closes Now Playing) |
| — | separator | | |
| 7 | 'Sync Lyrics' / 'Syncing Lyrics…' (disabled while a job runs) | `I.lyrics` | `syncLyrics()` (3.4.5) |
| 8 | 'Share' | `G16.share` | `navigator.share({title: "Title — Artist", url})` on touch; the URL is `<server>/?track=<id>`. Elsewhere copies the link and toasts 'Link copied' or 'Could not copy the link' (TrackRow.jsx:46-57). |
| 9 | Sleep timer, then a sub-sheet | `G16.moon` | see below |

**Sleep timer** (`FullScreen.jsx:44-60`, `usePlayer.js:268-282, 1094-1107`).

The row label shows the current state:

| State | Label |
|---|---|
| no timer | 'Sleep timer' |
| end of track | 'Sleep timer: end of track' |
| under 60 minutes left | 'Sleep timer: {m} min left' |
| an exact number of hours left | 'Sleep timer: {h} h left' |
| hours and minutes left | 'Sleep timer: {h} h {m} min left' |

`left = max(1, ceil((at - now)/60000))` minutes. The label is computed when the sheet renders and is not live-updated.

Sub-sheet rows, in order:
1. '{n} minutes' for 5, 10, 15, 30 and 45
2. '1 hour'
3. 'End of track'
4. if a timer is set: a separator, then 'Turn off timer'

Behaviour:
- The timer is stored on the **server**, so it is the same on all devices and fires with the phone locked. A timed stop pauses whatever is playing.
- 'End of track': when the current song ends by itself, the player stops on the **next** song, paused at 0:00, and clears the timer.
- Optimistic: the local state updates at once, and the server echo confirms it.

---

### 3.3 Queue page (phone)

Sources: `components/RightPanel.jsx:43-87, 151-262, 433-484`, `styles/mobile-nowplaying.css:166-211`, `styles/app.css:177, 515-559, 1239`.

#### 3.3.1 Page

| Property | Value |
|---|---|
| Layer | `position: fixed; inset: 0; z-index: 150`, background `--page`, flex column |
| Open | `rise-in .3s cubic-bezier(.2,.7,.2,1)`, from translateY(100%) (app.css:1465) |
| Close | chevron only, with the `.closing` slide-down `.25s ease-in` and unmount at 250 ms. **No swipe-down** (the Now Playing swipe excludes `.rightpanel`); the edge-swipe back is disabled while the page is open. |
| Opened from | the Now Playing queue button. The mini player's queue button is hidden on phone. |

#### 3.3.2 Header `.panel-header`

- Grid `44px minmax(0,1fr) 44px`, align center, padding `calc(4px + env(safe-area-inset-top)) 16px 0`, min-height 56.
- Left: chevron-down 44x44, glyph 24 (`ChevronDown`, RightPanel.jsx:28-32). Its title attr is 'Close panel'.
- Centre: two lines from the same `usePlayingFrom` as 3.2.2, centered:
  - small: 11/500, `rgba(fg,.7)`, letter-spacing .08em, uppercase
  - name: 13/700 `--fg`, ellipsis
- Desktop Queue/Lyrics tabs are hidden.

#### 3.3.3 Body `.panel-body`

- Vertical scroll, flex column, **gap 24** between sections.
- Padding `8px 16px calc(80px + env(safe-area-inset-bottom))`; the later rule at :199 overrides the 24 px at :177.

Section header `.section-head`:
- flex, space-between, min-height 32, margin-bottom **4** (forced, overriding the inline 8)
- h2 **16 / 700**
- right-side text button 13/700 `--fg`, padding `8px 0`

Sections, in order (RightPanel.jsx:232-261):
1. **'Now playing'**: the current track row. Its title is `--accent-ink`. No drag handle. Its long-press menu has no 'Remove'.
2. **'Next in queue'**: present only if there are hand-queued tracks, i.e. the leading run of `_queued` items after the current one. Header right: **'Clear queue'**, which removes every `_queued` item after the current one.
3. **'Next from: {name}'**: the rest of the context. 'Next up' when there is no context. Only the first **80** rows are rendered. (The count shown beside the heading is desktop-only.)

Empty states:
- No queue at all: centered, padding 32 0. h2 'Add to your queue' 16/700, margin-bottom 8. Below it, 'Play an album or playlist, or use “Add to queue” on any song.' in `.qrow-sub` style.
- Nothing after the current track: 'End of the queue.' in `.qrow-sub`, padding 12 0.

#### 3.3.4 Row `.qrow` (mobile-nowplaying.css:182-198)

| Part | Spec |
|---|---|
| Row | flex, center, gap **12**, min-height **64**, padding `8px 0`, transparent; pressed: `rgba(fg,.08)` |
| Art (a button) | **48x48**, radius 4. Image `maxHeight 80` of the track (or album). Placeholder `--card-hover`. **Tap: plays this track** (`skipTo(pos)`). The desktop hover play overlay is hidden. |
| Title | **16**, line-height 1.25, one line, ellipsis. Current row: `--accent-ink`. Smart-shuffle picks (`_rec`) get a leading sparkle glyph: 12x12, `--accent-ink`, margin-right 5, `vertical-align -1px` (RightPanel.jsx:71, app.css:1838). **Tap on the title opens the album page.** **UNSURE / likely bug:** the queue page stays on top (it is not closed), so the album opens hidden behind it. |
| Subtitle | `ArtistLinks`: each artist is tappable and opens the artist (same queue-stays-open caveat). Fallback is AlbumArtist. **13**, `--fg-sub`, one line. |
| ⋯ | hidden on phone |
| Drag handle (upcoming rows only) | **44x44**, margin-right **-12**, `--fg-sub`, glyph 24 (`Handle`: two horizontal bars, RightPanel.jsx:33-37), `touch-action:none`. Accessibility label 'Drag to reorder'. |

**Reorder by drag handle** (`RightPanel.jsx:170-207`):

1. Pointer down on the handle captures the pointer. No hold delay: the drag starts immediately.
2. The lifted row (`.lifted`) follows the finger with `translateY(dy)` and no transition. Its style:
   - background `--sheet`, radius 6
   - shadow `0 8px 24px rgba(0,0,0,.5)`
   - margin `0 -8px`, padding 8, z 3
3. Target slot = `pos + round(dy / rowHeight)`. rowHeight is measured, default 64. The target is clamped to `[currentIndex+1, queue.length-1]`, so only upcoming tracks move and nothing can go above the current track.
4. Rows between the origin and the target shift by **±64 pt** with `transition: transform .15s ease-out`. Moving down shifts them up (-64); moving up shifts them down (+64).
5. Release or cancel: if the target differs from the origin, call `player.moveInQueue(from, to)` (remove from `from`, insert at `to`). Then clear the drag state.

**No auto-scroll** while dragging near the edges (none in code). Updates are throttled to one per animation frame.

**Remove.** There is no swipe-to-delete. Long-press a row (450 ms still, cancelled by movement over 10 pt; haptic `vibrate(10)`; App.jsx:1395-1433) to open a bottom sheet:
- Header: art, title, artists.
- Rows have no icons. The icon column is hidden (mobile-nowplaying.css:115).

| Row | Action |
|---|---|
| 'Remove from queue' (not on the Now-playing row) | `removeFromQueue(pos)`; cannot remove the current track |
| 'Add to Liked Songs' / 'Remove from Liked Songs' | like toggle |
| 'Add to playlist' (sub-sheet of playlist names; only if playlists exist) | adds the track |
| separator | |
| 'Go to artist' (first artist) | opens the artist |
| 'Go to album' | opens the album |

Taps that close the sheet within 500 ms of it opening are ignored, so the finger lifting does not dismiss it.

#### 3.3.5 Pinned transport `.panel-transport` (shown only when something is playing)

| Property | Value |
|---|---|
| Size | flex none, height `calc(64px + env(safe-area-inset-bottom))`, padding `0 24px env(safe-area-inset-bottom)` |
| Background / border | `--page`; top border 1 px `rgba(fg,.06)` |
| Row | flex, space-between, height 64. Buttons 44x44; first margin-left -6, last margin-right -6. |
| Buttons | shuffle `ShuffleGlyph` 24 · previous 32 · **play 48x48 circle** (background `--fg`, `--on-fg` Play/Pause glyph 22) · next 32 · repeat 24. On states use `--accent-ink`; smart and repeat-one look the same as on/all. |
| Progress | absolute, top **-2**, full width, height 2. Track `rgba(fg,.2)`, fill `--fg`, width `min(100, position/duration*100)%`. Uses the **coarse** `player.position`, which per playhead.js updates only every few seconds, so it moves in steps. **UNSURE** if intended; the native app could use the live playhead. |

---

### 3.4 Lyrics

Sources: `components/RightPanel.jsx:10-18, 264-431`, `api/lyricsync.js`, `components/LyricSyncStatus.jsx`, `styles/mobile-nowplaying.css:79-97`, `styles/app.css:566-578, 768-780`. On phone, lyrics appear only in the Now Playing Lyrics tab (3.2.5).

#### 3.4.1 Data and phone line clean-up

- Fetch `jf.lyrics(nowPlayingId)`, which returns `[{text, start?}]` with `start` in seconds.
- A failed fetch is retried after 2 s, 4 s and 8 s, then the state becomes 'none'.
- The lyrics reload when a sync job for this track finishes (window event `slopify:lyricschanged`).

Phone only (`phoneLines`, RightPanel.jsx:268-285):
1. Drop empty or whitespace-only lines.
2. If any line has a `start`, gap markers are inserted:
   - `threshold = max(5 s, 2.5 x median spacing between consecutive starts)`
   - If the first line starts after the threshold, insert "♪" at start 0.
   - Between lines whose starts differ by more than the threshold, insert "♪" at `prev.start + min(5, diff/2)`.
   - Markers carry `gap: true`.

#### 3.4.2 Look

| Element | Spec |
|---|---|
| List `.lyrics` | flex column, left-aligned, **gap 22**, padding-bottom 32 |
| Line | full-width-wrapping text button: **24 / 700**, letter-spacing **-0.2**, line-height 1.3, left-aligned, opacity 1 |
| Line colours, **synced** | **upcoming:** `rgba(fg,.5)`. **Active ("now") and already sung:** `--fg`, full white. Transition `color .1s ease-out`. The base app.css rule dims sung lines; on phone that is overridden, so sung lines are white. |
| Line colours, **unsynced** | all lines `--fg` |
| Gap line "♪" | same style, letter-spacing `.1em` |
| Text selection | lines are selectable (`user-select:text`, app.css:1411) |

#### 3.4.3 Following the song

- The active line is recomputed **every 100 ms**:
  `at = positionNow() - (playing ? outputLag() : 0) - speakerDelay + 0.25`
  - `speakerDelay` is the calibrated offset of the session's speaker (`useOffset`), else 0.
  - The +0.25 s lead makes lyrics appear slightly early.
  - Active = the last line with `start <= at`; -1 before the first line.
- Auto-scroll: whenever the active line changes and the user is not in manual mode, smooth-scroll the `.fs-lyrics` pane so the active line's centre sits at the pane's vertical centre.
- Manual mode: any `touchmove` (or wheel) inside the pane stops following. A **'Sync'** pill then appears:
  - sticky, bottom `calc(16px + env(safe-area-inset-bottom))`, centered, margin-top 16
  - background `--fg`, text `--on-fg`, **16 / 700**, padding `10px 24px`, radius 500
  - enter animation `pill-in .2s ease-out`: from opacity 0, translateY(6) to the rest position
  - tap: resume following and scroll to the active line at once
- Manual mode resets when the track changes.
- **Tap a synced line:** `player.seek(line.start)` and resume following. Tapping an unsynced line does nothing.

#### 3.4.4 States (i18n keys)

| State | UI |
|---|---|
| loading | `<p>` 'Loading lyrics...' in `.placeholder-note` style (16 px, `--fg-sub`, padding 8 0) |
| no track | 'Play something to see lyrics.' |
| none, with a sync job running | the sync banner (below) |
| none, offline | 'Lyrics aren’t available offline for this song.' |
| none | 'Looks like we don’t have the lyrics for this song.' and a pill button **'Find and sync lyrics'**: margin-top 12, padding `8px 16px`, radius 999, border 1 px `rgba(fg,.3)`, `--fg`, 14/700, transparent |
| ok, unsynced, no job | above the lines: note 'These lyrics aren’t synced to the song yet.' (13 px `--fg-sub`, wraps; flex wrap with gap `4px 12px`, margin-bottom 12) and an inline pill **'Sync them'** (padding `4px 12px`, 13 px) |
| a job running for this track | banner `.lyrics-syncing` at the top: flex, gap 10, margin-bottom 14, 14 px `--fg-dim`. Contents: a spinner (14x14 circle, 2 px border `rgba(fg,.2)` with the top segment `--accent`, rotating 360 degrees every .8 s linear; static under reduced motion), then **'Syncing these lyrics'** (bold, `--fg`), then " · " and the job label. |

Job label (`jobLabel`): queued with others ahead gives 'Waiting · {n} ahead'; queued gives 'Starting'; running gives the server's `step` text or 'Starting'.

#### 3.4.5 Sync jobs

`api/lyricsync.js`:
- `syncLyrics(jf, {Id, Name})` posts a job. If the server says it already exists, toast 'Already syncing "{name}"'. On error, toast "Couldn't sync lyrics: {error}".
- All unfinished jobs are polled **every 2 s**.
- When a job finishes, it shows a 5 s toast `"{title}: {result}"`, where the result defaults to 'Done' or "Couldn't sync", and the lyrics reload.
- Jobs still running are resumed after sign-in.

`LyricSyncStatus.jsx` is a global status pill shown while any job exists:
- `position: fixed; bottom: 96px`, centered, z **99**
- max-width `min(560, 100vw-32)`, padding `10px 16px`, radius 999
- background `--bg-elevated-hi` (#2a2a2a), 13 px, shadow `0 4px 12px rgba(0,0,0,.5)`
- contents: spinner, then **'Syncing lyrics'** bold, then ` · {title} — {label}`, plus ` · {n} more` when there are several jobs
- the text is `--fg-dim`, one line, ellipsis

**Note:** z 99 is **below** Now Playing (200), so it is invisible while Now Playing is open. On the main screens it sits at bottom 96, which overlaps the mini-player card band (91 to 147 above the screen bottom). **UNSURE** if intended. The same applies to the generic `.toast` (bottom 96, or 150 while syncing; z 100; app.css:767, 781-786).

"tapSync" (`api/tapSync.js`) is **not** lyrics. It is the math for speaker-delay calibration by tapping, used only from the visualizer settings (3.7), and so unreachable on phone.

---

### 3.5 Quality badge

Sources: `components/QualityBadge.jsx`, `styles/app.css:1734-1740`.

- Shown on phone only in the Now Playing meta row, under the artist. Hidden in the mini player (`Player.jsx:305`).
- Text = `formatLabel(deliveredFormat(trackFormat, sessionDeviceKind))`:
  - Lossless: codec, plus `"{bitDepth}-bit"` only when the bit depth is over 16, plus the sample rate in kHz (an integer, or one decimal). Examples: "FLAC 44.1kHz", "FLAC 24-bit 96kHz", "ALAC 48kHz".
  - Lossy: `"{codec} {round(bitrate/1000)}kbps"`, e.g. "AAC 320kbps", or the bare codec when the bitrate is unknown.
- Delivered format:

| Session device | Result |
|---|---|
| a speaker or another client | the original file |
| this device, stream mode `file` | the original file |
| this device, profile `alac` | the file's own format with codec "ALAC" if it is lossless |
| this device, other profiles | AAC (HLS) or MP3 at 320/160/96 kbps from profile `aac-320`/`aac-160`/`aac-96`, default 320 |

- Style: block, `width: max-content`, margin-top 6, **12 px** (the base is 11), line-height 14, weight 500, letter-spacing `.02em`, one line, ellipsis.
- Colour: `--fg-dim` (#b3b3b3) when lossy, `--accent-ink` when lossless.
- Accessibility title: 'Lossless' / 'Compressed'.

---

### 3.6 Marquee (scrolling single line) and FittedTitle

`components/Marquee.jsx`, `styles/app.css:666-683`.

Used on phone for:
- the Now Playing title
- the "Playing on {name}" line
- the casting device name

Behaviour:
- Measure `dist = textWidth - boxWidth` whenever the text or box width changes.
- If `dist <= 0`: static text, clipped, no fade.
- If `dist > 0`:
  - Animate translateX from 0 to `-(dist + 24)` px. Duration `D = 4 + dist/30` seconds per direction, linear, infinite, **alternate**, i.e. it ping-pongs.
  - Keyframes: hold at 0 for 0-25%, move during 25-75%, hold at the end for 75-100%. Because of alternate, each end hold lasts 0.5·D in total and each move lasts 0.5·D.
  - Masks: a right-edge fade (opaque to transparent over the last **28 px**) is always on. A left-edge fade (transparent to opaque over **20 px**) is parked off-box at rest and slides in at 25-28% of each cycle, so the left edge fades only while the text is moving.

`FittedTitle.jsx` (font ladder 96/72/48/32 at weight 800) is used by entity headers, **not the player**. It is out of scope here.

---

### 3.7 Visualizer (spec for completeness; not reachable on the phone today)

Sources: `components/Visualizer.jsx`, `FullScreen.jsx:161-192, 250-253, 289`, `api/colors.js:61-124`, `components/Calibrate.jsx`, `api/tapSync.js`.

**Engine.** audioMotion-analyzer draws on a canvas over a transparent background:
- `minFreq 30`, `maxFreq 16000`, weighting `'D'`, no scales.
- Audio source: the local audio graph where Web Audio is available. On **iPhone it is always a silent "shadow" copy**: an MP3 192k transcode started at the session playhead, played into a context with no output, re-synced when it drifts more than 0.1 s (at most every 5 s) or more than 0.6 s.
- The context must be resumed inside a tap (`unlockShadowAudio`).

**Styles** (`EQ_STYLES`, Visualizer.jsx:55-63; key = displayed name):

| id | Name | Look |
|---|---|---|
| `line` (default) | 'Line' | line graph, width 1.9, faint reflection |
| `area` | 'Area' | line 1.5 with a 35% fill |
| `led` | 'LED bars' | LED bars with peaks |
| `bars` | 'Bars' | rounded bars with peaks |
| `mirror` | 'Mirror' | bars mirrored, with reflection |
| `radial` | 'Radial' | radial spinning bars |

**Colours.** `GRADIENTS` = `album`, `prism` (default), `classic`, `rainbow`, `orangered`, `steelblue`. Labels: 'Match album art', 'Prism', 'Classic', 'Rainbow', 'Orangered', 'Steelblue'.

'album' derives three colours from the cover with `paletteColors` (art `maxHeight 200`):
1. Bin 48x48 pixels as `vibrantColor` does. A cover that is at least 60% neutral (saturation < .15 or extreme lightness) gives the white/grey stops `rgb(255,255,255) / rgb(226,226,226) / rgb(190,190,190)`.
2. Otherwise pick up to 3 bins with saturation over .12 that differ by more than .08 in hue or more than .3 in lightness.
3. Fill any missing slots with the first colour lightened by .22 and darkened by .22.
4. Sort light to dark. Clamp saturation to [.38, .62] and raise lightness to at least .66 / .54 / .42.
5. If extraction fails, fall back to 'classic'.

**Smoothing** slider: 0 to 0.95, step 0.05, default 0.6. Label 'Smoothing'; value 'Real time' at 0, else a percentage.

**Settings and storage.** Settings live in account prefs `viz: {style, gradient, smoothing}`, mirrored to localStorage `conduit.viz`.

The settings sheet:
- header icon `G.viz`, title 'Visualizer', sub 'Style, colours and smoothing'
- rows 'Style' and 'Colours', each opening a sub-sheet with a green check at the right of the selected option
- the Smoothing slider (drawn like the seek bar: 4 px track, 12 pt thumb)
- when on a speaker: 'Timing on {name}' / 'Timing on {name} ({ms} ms)', 'Calibrate by tapping…' (or disabled 'Calibrate from the client that is playing'), and 'Forget calibration'

Calibration UI strings are in Calibrate.jsx:160-220.

Background while on this tab: the blurred cover, darker (`brightness(.22)`; app.css:1004). The phone CSS shows the gradient instead.

---

### 3.8 Bottom sheets used by the player (⋯, queue long-press, sleep timer)

Generic sheet values (`styles/app.css:1444-1460`, `styles/mobile-nowplaying.css:107-123, 213-218`, `components/ContextMenu.jsx`):

| Property | Value |
|---|---|
| Scrim | fixed full screen, z 299, `rgba(0,0,0,.6)`, `fade-in .2s`. Tap closes the sheet and does not fall through. |
| Sheet | fixed to the bottom, full width, top radius **16**, padding `12px 8px calc(24px + env(safe-area-inset-bottom))`, max-height 80vh, scrolls, background `--sheet` (#282828), shadow `0 -8px 40px rgba(0,0,0,.6)`, z 300 |
| Grab handle | 36x4, radius 2, `rgba(fg,.25)`, 6 from the top, centered |
| Header | flex, gap 12, padding `14px 12px 12px`, bottom border 1 px `rgba(fg,.1)`, margin-bottom 6. Image **56x56** radius 4. Title **16/700** `--fg`, ellipsis. Sub **13** `--fg-sub`. |
| Row | flex, gap 12, padding `14px 12px`, **16 px** `--fg`. Icon cell 16x16 `--fg-dim`. Disabled opacity .4. The submenu chevron is hidden on phone. Checked rows show a green check 16 at the right (`--accent-ink`). |
| Separator | 1 px `rgba(fg,.14)`, margin `4px 0` |
| Enter | `sheet-in .22s cubic-bezier(.2,.7,.2,1)`: from translateY(40) and opacity 0. Top-level sheets only; sub-sheets appear without animation. |
| Sub-sheet | another sheet over the first, z 301, min-height 45vh |
| Exit | `.closing`: translateY(100%) with the shadow fading, `.25s ease-in`; unmount at 250 ms |
| Drag to dismiss | follows a downward drag (only when the sheet's scrollTop <= 0, and not on sliders); closes when `dy > 100` or (`< 300 ms` and `dy > 40`); otherwise snaps back with `.2s ease-out` (App.jsx:1481-1512) |
| Other ways to close | page scroll or touchmove outside the sheet |

---

### 3.9 Playback behaviour (what the buttons do)

Sources: `player/usePlayer.js`. When another device is the active player, every action below is sent as a relay command to it instead (`activePlayerRef`). The UI shows the mirrored state.

#### 3.9.1 Play/Pause (`toggle`, usePlayer.js:1164-1231)

- When controlling another device, it sends an explicit `setPlaying: !shownPlaying`, never a blind flip.
- Locally, if the element is dead after the app comes back from the background, play reloads the track at the current playhead. A 3 s play timeout triggers the same reload.

#### 3.9.2 Previous (usePlayer.js:1136-1159)

- If the playhead is **more than 3 s** in: restart the current track at 0:00, keeping its play state.
- Otherwise go to the previous track. On the first track (index 0) this restarts it.
- Offline: the previous downloaded track, or restart.

#### 3.9.3 Next and end of track (usePlayer.js:1088-1135)

- Next = `advance(manual)`: index + 1 if there is one.
- At the end of the queue:
  - repeat 'all': restart from index 0
  - repeat 'one': replay
  - otherwise Autoplay: an `artist:` context plays more of the artist; anything else appends ~25 similar songs (`instantMix`; shuffled only under smart shuffle); if nothing is found, park on the last track at 0:00, paused
- A track ending by itself under repeat 'one' replays.
- Rapid skips: the UI moves at once, but the load waits until taps are 300 ms apart (usePlayer.js:982-990).

#### 3.9.4 Shuffle and repeat

**Shuffle** cycles `off → on → smart → off` (usePlayer.js:1382-1394, 1329-1369).
- **on:** remember the original order, then queue = `[current, ...shuffled(rest)]` with index 0.
- **off:** restore the remembered order and point the index at the current track.
- **smart:** like on, plus recommendations mixed in, one after every 3 upcoming tracks (up to 40 total; needs at least 4 tracks left). They are flagged `_rec` and drawn with a sparkle in the queue. Turning smart off returns to the original order without them.

**Repeat** cycles `off → all → one → off` (usePlayer.js:1395-1400).

Phone visuals:
- Shuffle and repeat are green when not 'off'.
- The phone does not distinguish smart from on, or one from all. Only the desktop footer draws the spark and "1" (Player.jsx:332-336, 371).
- **Recommend** at least the "1" on repeat-one natively; that is a product decision, not current web behaviour.

#### 3.9.5 Like (App.jsx:1013-1027)

1. Optimistic flip, so all hearts for that track update.
2. HTTP `setFavorite`.
3. On failure: revert and toast 'Not saved: {error}' (the error is cut to 60 characters).
4. On success: toast 'Added to Liked Songs' / 'Removed from Liked Songs'. Toasts sit under Now Playing (z 100 < 200), so they are not visible there.

The heart follows the **session** track (`nowPlaying.itemId`), so it also works when only controlling another device.

#### 3.9.6 Seek (usePlayer.js:1233-1284)

- One seek per drag release (3.2.4) or lyric tap.
- Locally: set the element time. A progressive transcode is restarted at the new point, keeping play/pause.
- A speaker gets a remote seek; if it reports not seekable, the stream is rebuilt at the point.

#### 3.9.7 Volume

- `setVolume(0-100)`. Speakers are throttled to one command per 120 ms during a drag (`useThrottledVolume`, DevicePicker.jsx:69-81).
- The phone has no local volume UI (3.2.4).

#### 3.9.8 Crossfade, gapless, normalization (usePlayer.js:357-379, 2208-2290)

**Crossfade and gapless** apply only where audio runs through Web Audio, i.e. **not on iPhone** (`ROUTES_WEB_AUDIO = !IS_IOS`, usePlayer.js:55-56). On iPhone the next song starts when the last one ends.

The web semantics for a native port:

| Setting | Rule |
|---|---|
| Crossfade | account setting, 0-12 s (choices 0/1/2/3/5/8/12; api/prefs.js:16). Overlap length = `min(setting, currentLength/3, nextLength/3)` with equal-power curves (sin up, cos down). |
| Gapless | on by default; a splice of about 25 ms |
| Album played in order | always gapless, never crossfaded (context = album, and both tracks are on it) |
| Repeat-one, sleep end-of-track, manual skips | no transition; a hard cut |

**Normalization:** on by default. Target -14 LUFS using server-measured gain (`track._gain`, in dB):
- album gain when the context is that track's album
- track gain otherwise
- linear factor `10^(dB/20)`
- on iPhone the server bakes the gain into the transcode (`norm` URL parameter)

---

### 3.10 Icon index (all inline SVG, `fill="currentColor"` unless noted)

| Icon | Where defined |
|---|---|
| Chevron down (24) | `FullScreen.jsx:266` (inline), `RightPanel.jsx:28-32 ChevronDown` |
| More ⋯ (24) | `FullScreen.jsx:22 G.dots` |
| Lyrics mic (24) | `Player.jsx:70-77 LyricsGlyph` (used as `G.lyrics`) |
| Queue (24) | `FullScreen.jsx:24 G.queue`. The 16-px version is `G16.queue` / `TrackRow.jsx I.queue`. |
| Visualizer bars (24, stroke 2) | `FullScreen.jsx:26 G.viz` |
| Shuffle | `TrackRow.jsx:71-76 ShuffleGlyph` |
| Smart spark (9, desktop footer only) | `Player.jsx:333-335` |
| Previous / Next | inline paths `FullScreen.jsx:341, 343`, `RightPanel.jsx:474, 476`, `Player.jsx:339-341, 356-358` |
| Play / Pause | `TrackRow.jsx:59-69 PlayGlyph / PauseGlyph`. The mini player uses identical inline copies (`Player.jsx:345-353`). |
| Repeat (phone) | inline path `FullScreen.jsx:344`, `RightPanel.jsx:477`. The desktop footer uses a different stroke icon with a "1" (`Player.jsx:365-372`). |
| Heart outline / filled | `FullScreen.jsx:37-39 HeartPath`; `TrackRow.jsx:119-131 Heart`; menu `I.heart / I.heartOn` |
| Cast (playing elsewhere) | `Player.jsx:137-145 CastGlyph` (stroke 2) |
| Device glyphs | `DevicePicker.jsx DeviceIcon` (casting section) |
| Drag handle | `RightPanel.jsx:33-37 Handle` |
| Smart-pick sparkle (12) | `RightPanel.jsx:71` inline |
| Menu glyphs | `FullScreen.jsx:21-36 G / G16` (plus, artist, album, moon, radio, share), `TrackRow.jsx:140+ I` (lyrics, heart, heartOn, …) |
| Check (sheet) | `ContextMenu.jsx:98` |

### 3.11 Known gaps / ambiguities to decide on

1. The Visualizer, its settings and the speaker calibration are unreachable on the phone (3.2.6).
2. Repeat-one and smart shuffle have no visual difference from repeat-all and shuffle on the phone (3.2.4, 3.3.5).
3. The Lyrics tab hides the whole transport. The CSS comment mentions a mini transport that is not implemented (3.2.5).
4. The CSS comment lists share and visualizer buttons in the bottom row, but the code renders device, lyrics and queue only (3.2.4).
5. In the queue, tapping a title or artist opens a page behind the still-open queue (3.3.4). There is no auto-scroll during drag, and no swipe-to-close.
6. The queue progress line uses the coarse position and moves in steps (3.3.5).
7. Toasts and the lyric-sync pill render under Now Playing and overlap the mini-player band (3.4.5).
8. The mini "Playing on" line resolves to 13/400 because of the cascade, while app.css intends 12/600 (3.1.2).
9. Prev/next glyph size depends on the English `title` attribute selector (3.2.4).

---

## 4. Devices, casting and remote control

Scope: everything on the PHONE layout (viewport 393x852, `@media (max-width: 760px)`, `usePhone()` in `web/src/components/TrackRow.jsx:12,27-36`) that picks an output device, shows where the music plays, controls a remote device, sets a remote volume, calibrates a speaker, and syncs the sleep timer.

All paths below are relative to `web/src/`. CSS cascade order is `styles/app.css` -> `styles/mobile-nowplaying.css` -> `styles/mobile-home-search.css` -> `styles/mobile-library.css` (`main.jsx:9-12`). When two files give the same selector, the later file wins. The values below are the ones that win.

### 4.0 Tokens used in this section (default dark theme)

These come from `styles/app.css:5-46`. `api/prefs.js:41-95` (`applyTheme`) can override them at runtime from the user's theme. Implement them as theme tokens, not literals.

| Token | Default value | Used for |
|---|---|---|
| `--fg` | `#fff` (`--fg-rgb` = `255,255,255`) | primary text, icons |
| `--fg-sub` | `#a7a7a7` | secondary lines in the sheet |
| `--fg-dim` | `#b3b3b3` | quality badge (compressed) |
| `--accent` | `#1ed760` | volume slider fill + thumb |
| `--accent-ink` | `#1ed760` | green text/icons (current device, "Playing on", casting button) |
| `--sheet` | `#282828` (light theme: the theme's `surface`) | device sheet background |
| `--chip` | `#2a2a2a` | mini player fallback tint |
| `--danger` / `--danger-bg` | `#f3727f` / `#2a1618` | error strip (transfer failure) |
| `rgba(var(--fg-rgb),.1)` | `rgba(255,255,255,0.10)` | sheet dividers |
| `rgba(var(--fg-rgb),.3)` | `rgba(255,255,255,0.30)` | grabber, slider track |

Body font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`, 400 16px, line-height 1.5 (`app.css:85-91`). On iOS, use SF Pro. Any text whose weight is not given below is 400.

Light theme: the mini player row forces dark tokens (white text). A device sheet opened from the mini player gets the theme's own ink back (`--theme-fg`, etc.). A device sheet opened from Now Playing stays dark, because `.fs` keeps the dark tokens and `--sheet: #282828` (`app.css:51-57,1250-1251`).

---

### 4.1 Data model: what is a "device"

#### 4.1.1 Device kinds

| `kind` | What it is | Where it comes from | Sheet subtitle (`model`) |
|---|---|---|---|
| `local` | This client's own output | `LOCAL_DEVICE` constant (`player/usePlayer.js:129-134`) | see 4.1.2 |
| `relay` | Another signed-in Slopify client on the same account | `roster.players` filtered `canPlay`, mapped at `usePlayer.js:634-636`. `id = "relay:<clientId>"`, `relayClientId`, `form` | `FORM_MODEL[form]`: `tv` -> "Slopify TV", `tablet` -> "Tablet", `phone` -> "Phone", `laptop` -> "Laptop", `desktop` -> "Desktop". Fallback is "Desktop" for kind desktop, "Phone" for kind phone, else "Slopify" (`usePlayer.js:46-47`) |
| `cast` | Google Cast / Chromecast | `roster.lanDevices` (`usePlayer.js:626-632`) | "Chromecast" |
| `bluos` | Bluesound | lanDevices | "Bluesound" |
| `bridge` | Slopify's own speaker bridge (ESP etc.) | lanDevices | `d.model` or "Speaker" (translated) |
| `upnp` | DLNA / Sonos-as-UPnP | lanDevices | `d.model` or "DLNA" |
| `airplay` | AirPlay | lanDevices | "AirPlay" |
| `roku` | Roku | lanDevices | `d.model` or "Roku" |
| `tv` | A TV the server can open the Slopify TV app on (no client yet) | lanDevices, `id = "tv:<host>"` (server `server/src/session.ts:208-212`) | "Slopify TV" |

Extra fields on lanDevices: `viaClient` (which client or `server:<uid>` drives it), `group` (array of ids with the speaker itself first, only for server speakers in a Slopify speaker group, `session.ts:175-179`), and `form: 'tv'` when `"<kind> <model>"` matches `/^roku |appletv|apple tv|\btv\b|television|bravia|webos|tizen|viera/i` (`usePlayer.js:128,632`).

BluOS sync groups can also carry `slaves: [{host,name}]` / `isSlave` (desktop mDNS list only).

The roster comes over the session WebSocket (`api/session.js:123-131`): `{ players, lanDevices, activeClientId }`. The server leaves this client out of `players` (`session.ts:190`). lanDevices contains the server's own speakers, plus speakers of clients on the same network that the server does not already list itself. They are de-duplicated by id (`usePlayer.js:626-631`).

#### 4.1.2 LOCAL_DEVICE naming (`usePlayer.js:40-42,129-134`)

| Runtime | `name` | `model` |
|---|---|---|
| Phone app shell (`window.slopifyShell`) | "This Phone" | "Phone playback" |
| TV app shell (`slopifyShell.deviceForm === 'tv'`) | "This TV" | "TV playback" |
| Desktop app | "This Computer" | "Local playback" |
| Plain browser | "This Web Player" | "Browser playback" |

These strings are i18n keys marked with `N_()`. The sheet translates them only for `kind === 'local'` (`DevicePicker.jsx:164`). The Swift client is the phone app, so it uses "This Phone" / "Phone playback".

This client's own identity, sent to the server and shown on OTHER clients, comes from `clientIdentity()` (`api/deviceName.js:31-38`). The phone app reports `{ name: slopifyShell.deviceName (e.g. "iPhone 16"), kind: 'phone', form: 'phone' | 'tablet' | 'tv' }`.

#### 4.1.3 The full list fed to the picker

`App.jsx:1802,1811`: `devices = [...desktopMdnsDevices, ...player.relayDevices, ...player.lanDevices]`. On the phone, `window.conduit` does not exist, so `desktopMdnsDevices` is always `[]` (`App.jsx:682-687`). The phone list is therefore relay clients in roster order, then lanDevices in server order.

#### 4.1.4 The session device (`sessionDeviceOf`, `components/Player.jsx:174-188`)

The picker's "active" device is the device the SESSION is on. It is not necessarily this client's local selection:

- Another client is the active player (`roster.activeClientId` set and not my id):
  - If that client's `nowPlaying.device` is a speaker (kind not `local`/`relay`), the session device is that speaker. It is looked up in the list, or built as `{...speaker, model: ''}`, and gets `playingOn = [speaker.id, ...speaker.members]`.
  - Otherwise it is that client's relay row (`relayClientId === activeId`). If the row is missing, it is synthesised as `{ id: 'relay:<id>', kind: 'relay', name: <roster name or 'Slopify'>, form }`.
- Otherwise it is `player.device`, this client's own pick: `LOCAL_DEVICE` or a speaker it drives.

`casting` (green state) means `sessionDevice.kind !== 'local'` (`DevicePicker.jsx:196`). This includes "another phone/laptop is playing".

---

### 4.2 Device button (entry point to the sheet)

Component `DevicePicker` (`components/DevicePicker.jsx:130-203`). The button is `.devicebtn`. Its only content is `ConnectIcon` plus a name label (`Marquee`).

**ConnectIcon** (`DevicePicker.jsx:57-62`): 16x16 viewBox, filled `currentColor`, two paths. One is a speaker box with a tweeter and woofer. The other is a bracket on the left (a laptop edge). Copy the paths verbatim.

Accessibility title: `t('Playing on {name}', { name })` (`:198`).

Tap: toggles the sheet (`open ? close() : setOpen(true)`, `:197`).

The button appears in two places on the phone:

#### 4.2.1 In the mini player (`Player.jsx:412`; CSS `mobile-nowplaying.css:149-152`)

- It is the first item at the right of the 56pt mini card, before the play button. The grid columns are `minmax(0,1fr) auto auto`, `.player-right` has order 2 and `.player-controls` has order 3 (`mobile-nowplaying.css:139,147-154`).
- Box 44x44, no padding, icon centred and drawn at 24x24.
- Colour `--fg` (#fff). When casting, `--accent-ink` (#1ed760).
- No name label: `.devicebtn-name` is `display:none` (`app.css:687`).
- Every other `.player-right` child (lyrics, queue, volume, expand) is hidden on the phone (`mobile-nowplaying.css:149`).

#### 4.2.2 In Now Playing, bottom-left of the phone row (`FullScreen.jsx:364-375`; CSS `mobile-nowplaying.css:68-77`)

- `.fs-phone-row` is a flex row and the last item of `.fs-bottom`. `.fs-bottom` has padding `24px 24px calc(16px + safe-bottom)` (`mobile-nowplaying.css:32`).
- Row order: `[device area flex:1] [Lyrics 44x44] [Queue 44x44, margin-right -10px]`.
- The device area `.fs-phone-device` uses `flex: 1 1 auto; min-width:0; margin-left:-10px`.
- Device button: height 44, padding `0 10px`, gap 8, `font-size 12px; font-weight 600`, icon 24x24 (`flex:none`). Colour `--fg`. When casting, icon and text are `--accent-ink`.
- Name label: hidden when not casting. When casting it is shown on one line, using `labelFor(sessionDevice)` (see 4.3.4). It is a **Marquee**: if the text overflows, it scrolls at 30 px/s with a 2 s hold at each end. Duration is `4 + overflowPx/30` s, the animation is `linear infinite alternate`, it moves `-(overflow+24)px`, and edges fade 20px (left, appearing once moving) and 28px (right) (`components/Marquee.jsx:8-25`, `app.css:671-682`).
- The whole `.fs-bottom` (and with it this button) is hidden on the Lyrics tab (`mobile-nowplaying.css:92`).
- The desktop-only `.fs-output` (picker + volume slider) is also rendered but `display:none` on the phone (`mobile-nowplaying.css:17`). Ignore it.

---

### 4.3 "Connect to a device" sheet (phone)

JSX `DevicePicker.jsx:205-239`; CSS `mobile-nowplaying.css:110-111,221-253`, `app.css:1447,1461-1462`, `mobile-home-search.css:48`.

#### 4.3.1 Presentation

| Property | Value |
|---|---|
| Scrim | Full screen, `rgba(0,0,0,.6)`, z 299, fades in with `opacity 0->1` over 200 ms, default easing (`app.css:1447,1209`). It does NOT fade out: it disappears when the sheet unmounts after its 250 ms slide. |
| Sheet frame | Fixed to the bottom edge, full width, z 300. Radius `16 16 0 0`. Background `--sheet` (#282828). Shadow `0 -8px 40px rgba(0,0,0,.6)`. |
| Sheet padding | top 12, sides 16, bottom `24 + safe-area-bottom` |
| Max height | `85vh` (724pt on 852). Content scrolls vertically inside the sheet; scrolling does not chain to the page (`overscroll-behavior: contain`). |
| Grabber | 36x4, radius 2, `rgba(255,255,255,.3)`, centred, 6pt from the sheet top (`::after`). Draggable, see Dismissal. |
| Enter animation | `sheet-in`: `transform: translateY(40px)` plus `opacity 0` -> `none` / `1`, **200 ms** (the duration override in `mobile-home-search.css:48` wins over 220 ms), easing `cubic-bezier(.2,.7,.2,1)` (`app.css:1451`, `mobile-nowplaying.css:111`) |
| Exit animation | `slideOut()` adds `.closing`: `transform: translateY(100%)`, and the shadow transitions to transparent. Both over **250 ms `ease-in`**. Unmount happens after `setTimeout(250)` (`Player.jsx:79-85`, `mobile-nowplaying.css:110`). |
| Now Playing Visualizer tab | While a device sheet is open over it, the canvas is hidden and the cover image is shown behind (`mobile-nowplaying.css:104-105`). This is dead on the phone; see 4.8. |

#### 4.3.2 Dismissal

- Tap the scrim. `onClick` and `onTouchEnd` call `preventDefault`/`stopPropagation`, then `close()` (`DevicePicker.jsx:205`).
- Tap the device button again (toggle).
- Pick a device row: `onSelect(d); close()` (`:225`).
- A document `mousedown` outside the picker root closes it, and so does the Escape key (`:137-149`). This has no phone equivalent beyond the scrim.
- Drag to dismiss: yes. A downward drag starting while the sheet is scrolled to the top (not on the volume slider or inputs) moves the sheet with the finger; release with dy > 100, or dy > 40 within 300 ms, closes it, otherwise it snaps back over 0.2 s ease-out (`web/src/App.jsx:1481-1514`, which targets `.devicemenu` and `.ctxmenu-fixed:not(.ctxmenu-sub)`). (Corrected by the editor: an earlier draft said there was no drag-to-dismiss.) The Now Playing swipe-down-to-close ignores touches inside `.devicemenu`, and the mini player swipe-to-skip ignores `.devicemenu`, `.dm-volume` and inputs (`App.jsx:187-189, 1439, 1457`).

#### 4.3.3 Layout, top to bottom

**A. Header** `.devicemenu-head`: padding `12 0 16`, block layout.

| Line | Text (i18n key) | Style |
|---|---|---|
| Title | "Connect to a device" | 20pt / 700, letter-spacing -0.3px, `--fg` |
| Subtitle | `remoteCount > 0`: "{n} on your network". `remoteCount === 0`: in the phone app and browser (no `window.conduit`), an empty string. Desktop only: "Searching your network..." | 13pt, `--fg-sub`, margin-top 2 |

`remoteCount` is the number of listed non-local entries, after BluOS slaves are removed. It includes other Slopify clients (`:186`).

**B. Current device** `.dm-current`: flex row, `align-items:center`, gap 16, padding `12 0 16`, 1pt bottom border `rgba(255,255,255,.1)`, margin-bottom 8. The icon colour is `--accent-ink` (green).

| Part | Content | Style |
|---|---|---|
| Icon | `DeviceIcon(kind, form, phone set)` (see 4.3.5) | 32x32, green |
| Label | "Current device" | 13pt / 700, `--fg` |
| Name | `labelFor(active)` | 16pt / 700, `--accent-ink`, one line, ellipsis (no marquee) |
| Sub | `subtitleFor(active)`, or if empty, `kindLabel(active)` | 13pt, `--fg-sub` |
| Quality | `QualityBadge` (4.3.7) | 11pt/14pt line, margin-top 4 |

The text column is a vertical stack with gap 2 and `min-width:0`.

**C. "Select another device"** `.dm-others`: shown only if at least one other entry exists. 16pt / 700, `--fg`, padding `12 0 4`.

**D. Device rows** `.deviceitem` (a `button`, one per entry in `others`, `:224-232`):

- Full width, flex, `align-items:center`, gap 16, padding `10 0`, **min-height 56**, radius 0, left-aligned text, colour `--fg`.
- Icon 24x24, `--fg` (white, never green: the current device is not repeated here).
- Name: 16pt / 400, `--fg`, one line, ellipsis.
- Sub: `subtitleFor(d)`, or if empty, `kindLabel(d)`. 13pt, `--fg-sub`.
- No pressed or highlight style is defined (`.deviceitem:hover {background: transparent}`). **UNSURE**: iOS WebKit's default tap highlight may show briefly. Natively, use no highlight or a subtle one.
- No "playing" dot on the phone (`.deviceitem-dot {display:none}`). No per-row quality badge on the phone. The desktop `.devicegroup-label` is hidden on the phone, and the phone JSX does not use groups.

**E. Note** `.dm-note`: 13pt, `--fg-sub`, line-height 1.4, padding-top 12, margin 0.

- When `window.conduit` is absent (the phone app shell AND browsers): "Speakers and TVs show up in the Slopify app. In the browser, playback stays on this device."
- Desktop only: "Chromecast and Bluesound players on this network appear here automatically once they are awake."
- **UNSURE / likely unintended**: the phone *app* also shows the "In the browser…" sentence, because the shell does not define `window.conduit` (`:187`). Confirm with the product owner before copying it.

**F. Speaker volume** (4.4). Shown only when `active.kind !== 'local'` and a numeric volume is present (`:238`).

#### 4.3.4 Row ordering and text rules (`DevicePicker.jsx:155-191`)

1. Build `visible = devices` minus BluOS slaves: drop `kind==='bluos'` entries that have `isSlave`, or whose host appears in any device's `slaves`.
2. `all = [LOCAL_DEVICE, ...visible]`. The order is: This Phone, then other Slopify clients (roster order), then speakers and TVs (server order). There is no sorting and no grouping on the phone.
3. `playing = Set(active.playingOn || [active.id])`. `others = all.filter(d => !playing.has(d.id))`. Every speaker in the playing group is removed from the list, not just the picked one.

`labelFor(d)`:

- `d.playingOn` has more than one id: join the names of those ids (looked up in the list, falling back to the raw id) with `" + "`, e.g. "Kitchen + Den".
- BluOS master with slaves: `"Master + Slave1 + …"`.
- Otherwise `nameFor(d)`: translated for local, raw name for everything else.

`subtitleFor(d)`:

- `d.group.length > 1`: "Grouped with {names}", where the names are `group.slice(1)` joined with `", "`.
- BluOS with slaves: "Grouped • {n} speakers" (n = slaves + 1).
- Otherwise `t(d.model)`, which may be empty.

`kindLabel(d)` (fallback when the subtitle is empty):

| kind | text |
|---|---|
| local | "This phone" |
| cast | "Google Cast" |
| bluos | "Bluesound" |
| bridge | `t(model)` or "Speaker" |
| airplay | "AirPlay" |
| upnp, roku | `model` |
| anything else (relay, tv) | "Slopify" |

#### 4.3.5 Device icons (all 24x24 viewBox, filled `currentColor`, defined in `DevicePicker.jsx`)

Selection logic in `DeviceIcon` (`:45-54`):

```
shape = d.form || (kind==='local' ? LOCAL_FORM : kind==='tv' ? 'tv' : null)
path  = FORM_ICONS[shape] || PHONE_ICONS[kind] || (kind in {bridge,upnp,airplay} ? PHONE_ICONS.bluos : PHONE_ICONS.cast)
```

`LOCAL_FORM` is `clientIdentity().form`, which is `'phone'` in the phone app (`:43`).

| Resolved icon | Source constant | Used for (phone) |
|---|---|---|
| Phone outline with home dot | `PHONE_ICONS.local` = `FORM_ICONS.phone` (`:25,37`) | This Phone; relay clients with form `phone` |
| Laptop (screen on a base line) | `PHONE_ICONS.relay` = `FORM_ICONS.laptop` (`:28,36`) | relay clients with form `laptop` or no form |
| Monitor on a stand | `FORM_ICONS.desktop` (`:35`) | relay clients with form `desktop` |
| Tablet with dot | `FORM_ICONS.tablet` (`:41`) | relay clients with form `tablet` |
| TV: closed screen on a short stand | `FORM_ICONS.tv` (`:40`) | kind `tv`; any device with `form:'tv'` (Roku, Apple TV, DLNA TV, Slopify TV client) |
| Open-bottom screen with a stand bar (Cast TV) | `PHONE_ICONS.cast` (`:26`) | `cast` without `form:'tv'`; also `roku` if the TV regex fails (there is no `PHONE_ICONS.roku`) |
| Speaker box (tweeter + woofer) | `PHONE_ICONS.bluos` (`:27`) | `bluos`, `bridge`, `upnp`, `airplay` |

The desktop set `ICONS` (`:11-20`) is not used on the phone sheet. It is used only by `PlayingElsewhereBar`, which is hidden on the phone.

#### 4.3.6 Tap a row: what happens (`player.setDevice`, `usePlayer.js:1452-1632`)

Sheet behaviour: `onSelect(d)` fires immediately, then the sheet slides out (250 ms). No spinner or optimistic UI exists in the sheet itself. The UI updates when roster or player state changes.

Transfer paths:

1. **Target is a relay client, or a lanDevice with `viaClient`.** On the phone this is always the case: there is no local speaker discovery, so every speaker is "via" the server or another client (`:1465-1466`).
   - Build the handoff:
     - If this phone is mirroring another client, use that session's queue (`trackIds` and `queued` flags), the index, the live playhead (`relay.playheadOf(np)`), and whether it was playing.
     - If this phone is the active player, use its own queue, index, interpolated position, `playing`, context id, and the unshuffled `original` order if shuffled.
   - Send relay command `{ action:'transfer', trackIds, queued, index, position, playing, ctx, original, deviceId }` to `relayClientId` (relay) or `viaClient` (speaker). `deviceId` is `'local'` for a relay pick (play on that client's own output) or the speaker id.
   - If this phone was the player, it stops its own output at once, sets `playing=false` and freezes the playhead. It then becomes a mirror when the roster shows the new active client. That flips the mini player to "Playing on X" and the device button green.
2. **This phone was mirroring and picks a device it drives itself** (in practice "This Phone"):
   - Set the device, `relay.claim()` (become the active player), then fetch the session's queue by id.
   - Start the current track at the live playhead (`playheadOf`), then `playing=true`.
   - On error, show `e.message` in the error strip.
3. **Plain local-to-local switch:** `prev.id === next.id` does nothing. Otherwise the target starts first, then the old device stops. The brief overlap is intentional.
   - If the target is already playing the same track, its playhead is adopted.
   - On failure, the UI reverts to the previous device and the error strip shows "Could not move playback to {name}: {error}".
   - Afterwards the volume shown becomes the new device's own level (speaker `status().volume` if it is > 0 and not muted, else the local element volume), and status polling is ignored for 2.5 s.

Receiving side (`executeCommand` 'transfer', `usePlayer.js:2608-2648`):

- The receiver claims, switches to `deviceId`, starts the chosen track from its own record first, then fills in the rest of the queue.
- On failure: "Could not take over playback: {error}".

Error strip (`Player.jsx:257-261`, `app.css:583`): `.player-error` above the mini card. Background `--danger-bg`, text `--danger`, padding `8 16`, 14pt, radius 4, margin-bottom 8. Tap it to dismiss (`clearError`).

#### 4.3.7 Quality line (`components/QualityBadge.jsx`, `app.css:1736-1739`)

- Text: `formatLabel(deliveredFormat(trackFormat, nowPlaying.device.kind))`.
  - Lossless: `"<codec>[ <bits>-bit if >16][ <kHz>kHz]"`, e.g. "FLAC 24-bit 96kHz".
  - Lossy: `"<codec> <kbps>kbps"`.
- For any device that is not local (speakers, other clients), the label describes the original file.
- For the local phone it depends on the stream mode:
  - `file` gives the original.
  - `alac` shows ALAC for lossless sources.
  - `aac-320` / `aac-160` / `aac-96` show "AAC <n>kbps" (HLS) or "MP3 <n>kbps".
  - On mobile data, a rung lower applies for 10 min after a stall (`player/linkWatch.js:10,25-37`: alac->aac-320->aac-160->aac-96).
- Style: block, `width: max-content`, 11pt / 500, line-height 14, letter-spacing .02em, one line with ellipsis.
- Colour `--fg-dim` (#b3b3b3), or `--accent-ink` when lossless. In the sheet it has margin-top 4.
- Hidden when unknown (null).
- Tooltip keys: "Lossless" / "Compressed".

`api/linkSpeed.js` (link tier for picture sizes) has no device UI.

---

### 4.4 Speaker volume slider in the sheet (`SheetVolume`, `DevicePicker.jsx:64-124`; CSS `mobile-nowplaying.css:242-253`)

**Visibility:** only when the session device is not local (speaker OR another Slopify client), `onVolume` is set, and `volume` is a number (`:238`). This is the **only volume control on the phone**. The mini player volume and the Now Playing `.fs-volume` are hidden (`mobile-nowplaying.css:17,149`).

**Layout:**

- A row pinned to the bottom of the sheet (`position: sticky; bottom: calc(-24px - safe)`). It stays visible however long the list is.
- It extends to the sheet edges (margin `8 -16 calc(-24 - safe)`). Padding `12 16 calc(24 + safe)`, background `--sheet`, 1pt top border `rgba(255,255,255,.1)`, z 1 above the rows.
- Flex row, `align-items:center`, gap 14, colour `--fg`:
  `[speaker-low icon 22x22] [slider flex:1] [speaker-high icon 22x22]`.
- Icons (16x16 viewBox, filled, inline at `:114` and `:121`):
  - Low is the Spotify speaker body only.
  - High is the body, one inner arc and an outer arc.
  - The code comments say "16pt glyphs" and "4pt bar", but the CSS gives 22pt icons and an 8pt bar. **Follow the CSS values.**

**Slider visuals:**

- Touch height 44.
- Track 8pt tall, vertically centred, square ends (radius 0).
- Filled part `--accent` (#1ed760) from 0 to value%. Remainder `rgba(255,255,255,.3)`.
- Thumb: 20x20 circle in `--accent`, no shadow, always visible. It scales to 1.25 while pressed, with a 120 ms transform transition.

**Value and range:** integer 0-100. The value shown is the drag value while dragging, else `player.volume` (`useThrottledVolume`, `:69-83`).

**Touch handling** (`useTouchSlider`, `:84-108`): a custom touch handler, so the sheet's scroll never steals the drag.

- `touchstart` with exactly one finger: cancel scrolling, then jump straight to `value = round(clamp01((touchX - barLeft) / barWidth) * 100)`. This works anywhere on the bar, not only on the thumb.
- `touchmove` with one finger: same calculation, scrolling cancelled.
- `touchend` / `touchcancel`: commit (`end`).

**Throttle:** at most one command per 120 ms, plus a trailing send and the final value.

- On each move, the shown value updates at once.
- If 120 ms or more have passed since the last send, send now.
- Otherwise store it as pending and arm one 120 ms timer that sends the latest pending value.
- On release, clear the timer, send any pending value, and stop showing the drag value.

**What a send does** (`player.setVolume`, `usePlayer.js:1287-1305`):

- Set `volumeHeld` for 2 s. During that window, incoming reports (speaker poll, mirrored echo) cannot move the slider (`usePlayer.js:2031,2842-2843`).
- Update local state.
- If another client is active, send relay command `{action:'setVolume', level}` to it. Otherwise call the speaker driver `remote.setVolume(dev, level)`. Errors are ignored.

**Value source while not dragging:**

- Within 2 s after a send: the local value.
- When mirroring another client: that client's reported `nowPlaying.volume`.
- When this phone drives a speaker: the speaker's polled volume. Changes made on the speaker's own app or knob are mirrored, except while it reads muted.

**Accessibility:** label "Speaker volume"; title "Volume {n}%".

#### 4.4.1 Hardware volume buttons in remote mode (`App.jsx:1175-1180,1295-1310`; `usePlayer.js:72-87,1319-1326`)

- While the sound plays elsewhere (`player.mirroring` or the local device is not local), the native shell turns hardware volume presses into `conduit:volumestep` events with `step` = ±1.
- If another client is active, the press goes to that client as `{action:'volumeStep', step}`.
- Otherwise the stepper rule applies:
  - Steps of 5.
  - Presses less than 300 ms after the last one are ignored.
  - Upward, a run of presses may rise at most 20 above where the run began. A run resets after 3 s of no presses.
  - Clamped to 0-100.
- When the sound is on the phone itself, the buttons control the phone natively. There is no in-app volume UI.

---

### 4.5 "Playing on X" (remote control mode)

#### 4.5.1 Label logic (`elsewhereLabel`, `Player.jsx:117-135`)

The label is `null` (meaning the sound is here) unless one of these holds:

- Another client is the active player. If that client's `nowPlaying.device` is a speaker (kind not local/relay), the label is **the speaker's name**. Otherwise it is **that client's name**, e.g. "MacBook Pro" or "iPhone 15". The active client may be the server (`server:<uid>`), which plays server speakers, so the label is the speaker name.
- This phone itself is driving a speaker. The label is the speaker's name.

As a result, every client shows the same "Playing on Kitchen". Rendered text: `t('Playing on {name}', { name: label })`.

`elsewhereForm` (`:147-155`) returns the other client's `form` when the music is on a Slopify client (not a speaker), else null. Only `PlayingElsewhereBar` uses it.

#### 4.5.2 `PlayingElsewhereBar` (`Player.jsx:157-167`; CSS `app.css:846-850,1271`)

This is the desktop's full-width green strip. It is **hidden on the phone** (`.playing-elsewhere {display:none}` inside the phone media query). Do not build it. For reference: background `--accent`, text `--on-accent` (#000), 11pt / 700, padding `3 12`, right-aligned, icon 15pt.

#### 4.5.3 Mini player in remote mode (`Player.jsx:285-304`; CSS `app.css:1272-1273`, `mobile-nowplaying.css:139-156`)

- The second text line (artist) is **replaced** by a green device line. Layout: flex, `align-items:center`, gap 6, `--accent-ink` (#1ed760), **12pt / 600** (the title stays 13pt / 600).
  - Icon: `CastGlyph`, 13x13, stroke outline (24 viewBox, stroke 2, round caps and joins). Paths: `M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6`, `M2 12a9 9 0 0 1 8 8`, `M2 16a5 5 0 0 1 4 4`, `M2 20h.01` (`Player.jsx:137-145`). The phone always uses this Cast glyph, even when the other device is a laptop or phone.
  - Text: Marquee "Playing on {name}", scrolling as in 4.2.2.
- The device button turns green (4.2.1).
- Everything else looks the same:
  - Cover art from `nowPlaying.artId`, resolved by id through this client's server.
  - Title.
  - Play/pause showing the mirrored `playing`.
  - The 2pt progress line uses the mirrored playhead, `relay.playheadOf(np)`: position plus server-clock time since the report (`api/session.js:209-216`; `usePlayer.js:2802-2803`).
  - The card tint comes from the art.
- Controls route to the active client over the relay: play/pause (`toggle` / `setPlaying`), next, previous, seek, repeat, shuffle, setVolume, volumeStep (`usePlayer.js:1130-1140,1310-1326`).
- Swipe left/right on the card (dx > 60, dy < 40, under 600 ms) sends next / previous to the active client (`App.jsx:1433-1446`).
- A tap anywhere else on the card opens Now Playing.
- The heart is hidden on the phone mini card.

#### 4.5.4 Now Playing in remote mode (`FullScreen.jsx`)

- The device button at bottom-left turns green and shows the label (4.2.2).
- The seek bar shows the mirrored playhead. After a scrub release the thumb holds the dragged value for **1500 ms** when mirroring (250 ms when local) so it does not snap back before the mirror catches up (`FullScreen.jsx:150-156`).
- All transport buttons route to the active client, as in 4.5.3.
- The queue shows the active player's published queue (`usePlayer.js:3094-3102`).
- There is no other visual difference: no extra banner, and the volume stays only in the device sheet.

#### 4.5.5 Session adoption (no device UI, affects what shows)

- When nobody is playing, the server sends the account's last session. The phone shows that track paused at its position, so the app never opens on "Nothing playing" (`applySession`, `usePlayer.js:566-610`).
- `adoptActive` (`usePlayer.js:1408-1449`), which adopts a speaker found already playing, is desktop-only (`remote` is required).

---

### 4.6 Sleep timer sync (`FullScreen.jsx:41-59,238`; `usePlayer.js:265-282,1091-1100`; `api/session.js:102,121,232`)

- The sleep timer is an item in the Now Playing "⋯" sheet. Icon `G16.moon`: a 16 viewBox stroke crescent, `M14 9.8A6 6 0 0 1 6.2 2 6 6 0 1 0 14 9.8z`, stroke 1.5 (`FullScreen.jsx:32`). Section 3 covers the ⋯ sheet's visuals.
- Item label:

| State | Label |
|---|---|
| No timer | "Sleep timer" |
| End of track | "Sleep timer: end of track" |
| Timer set, under 60 min left | "Sleep timer: {m} min left" |
| Timer set, 60 min or more left | "Sleep timer: {h} h {m} min left", or "Sleep timer: {h} h left" when m = 0 |

  Minutes left is `max(1, ceil((at - now)/60000))`. The label is recomputed on each render of Now Playing, not on its own timer.
- Submenu, in order: "5 minutes", "10 minutes", "15 minutes", "30 minutes", "45 minutes" (key "{n} minutes"), "1 hour", "End of track". If a timer is set, a separator then "Turn off timer".
- Setting a value updates the UI at once (optimistic `{at: now + m*60000}` or `{endOfTrack:true}` or null). It also sends `{type:'sleep', minutes | endOfTrack:true | off:true}` on the session socket.
- The server is the source of truth. It broadcasts `{type:'sleep', sleep}` to every client and includes it in `hello-ok`, so all devices show the same timer, and it fires even when the phone is locked or closed.
- A timed timer is fired by the server: it sends `setPlaying false` to the active player (marked "quiet stop", `usePlayer.js:2686`).
- "End of track" is handled by whichever client is playing. When the track ends naturally, it stops, moves to the next track and stays paused at 0:00.

---

### 4.7 Speaker calibration overlay (`components/Calibrate.jsx`; CSS `app.css:1077-1098,1089`)

**Phone reachability: not reachable.**

- The only entry points are the Now Playing visualizer settings menu ("Calibrate by tapping…") and the Visualizer tab. Both live in `.fs-tabs`, which is `display:none` on the phone (`mobile-nowplaying.css:17`; `FullScreen.jsx:272-289`).
- The phone bottom row has only Device, Lyrics and Queue (`FullScreen.jsx:366-374`).
- The comment at `mobile-nowplaying.css:10` mentions "visualizer" in the phone row, but the code has no such button.
- **UNSURE**: whether the native app should expose it. If it does, the spec below is what the web renders.

**Preconditions** (`FullScreen.jsx:168-191`, `Visualizer.jsx:250-253`):

- The session device is a speaker (not local/relay).
- This client drives it (not mirroring, and `player.device.id === speaker.id`), or the active client is `server:*`.
- The overlay renders only when the sound is not local.

Menu rows for this, in the viz menu:

| Row | Behaviour |
|---|---|
| "Timing on {name} ({ms} ms)", or "Timing on {name}" with no offset | Header row, not tappable |
| "Calibrate by tapping…" | When this client cannot drive the speaker, the label is "Calibrate from the client that is playing" and the row is disabled |
| "Forget calibration" | Shown only if an offset exists. Sends `offset:null` |

The offset is stored on the server per speaker (`relay.sendOffset(id, seconds)`) and shared with every client.

**Overlay layout:**

- `.cal` covers the visualizer area (`inset 0`): background `#00000066`, backdrop blur 6, padding 24, content centred, z 3.
- A pointer-down anywhere counts as a TAP, except inside the button row.
- Card: width `min(520, 100%)`, background `#181818`, radius 12, padding `28 28 24`, shadow `0 16 48 #0009`, centred text, white.
- Title "Calibrate {name}": 22pt / 700, margin-bottom 12. `{name}` falls back to "this speaker".
- Text styles:

| Style | Values |
|---|---|
| Body | 15pt, line-height 1.45, #fff, margin-bottom 12 |
| Muted | #b3b3b3, 14pt |
| Warn | #f5b942 |
| Steps list | left-aligned, indent 22, 15pt, line-height 1.5, #e6e6e6, 6pt between items |

- Step tag: 12pt / 700, letter-spacing .08em, UPPERCASE, #b3b3b3, margin-bottom 14.
- Tap pad: a 200x200 circle, margin `6 auto 16`, padding 24, 16pt / 700, line-height 1.3.
  - Fill `#ffffff1a`, 2pt border `#ffffff40`.
  - On each registered tap it re-runs `cal-hit` (280 ms ease-out). The animation goes from fill and border `--accent`, black text and scale 1.06 back to the rest state.
  - In the "ready" state the border is dashed and the text #b3b3b3.
- Progress bar: height 4, radius 2, track `#ffffff33`, side margin 24, margin-bottom 12. Fill `--accent`, width = progress, width transition 100 ms linear.
- Result number: 44pt / 800, letter-spacing -.02em, tabular digits, margin `8 0 10`. Format `"+123 ms"` (sign shown when > 0).
- Buttons: a centred row, gap 10, margin-top 8.
  - Primary: background #e6e6e6, black text, pill (radius 500), padding `10 24`, 14pt / 700. Disabled at opacity .4.
  - Ghost: transparent, white text, 1pt border `#ffffff59`.

**States** (`phase`):

| Phase | Content | Buttons |
|---|---|---|
| `intro` | Body: "Speakers play a little behind what they report, so the bars can run ahead of the sound. Two quick steps measure {name}'s delay so the visualizer lines up." <br> Steps: 1. "Slopify pauses and jumps ahead. <b>Tap the moment you hear the music.</b> (Twice.)" 2. "<b>Tap along to the beat</b> for {n} seconds." (n=12). The `<b>` parts are bold. <br> Muted: "Tap anywhere, or press Space. No microphone is used." <br> If not playing, warn: "Start playing on {name} first." | "Start" (disabled unless playing), "Cancel" (ghost) |
| `jump` | Tag "Step 1 of 2 · {n}" (round number). Pad "Tap when you hear the music". Muted line shows the message, or "Listen…" | "Cancel" |
| `ready` | Tag "Step 2 of 2". Dashed pad "Get ready…". Progress bar. Muted "Next: tap on every beat." | "Cancel" |
| `beat` | Tag "Step 2 of 2". Pad "Tap along to the beat". Progress bar. Muted "1 tap" or "{n} taps" | "Cancel" |
| `result` | Big offset. Body: "{name} plays {ms} ms behind what it reports. The visualizer now uses this." or "...ahead of what it reports...". Muted: "Lock strong · {n} taps" if quality ≥ 2.5, else "Lock okay · {n} taps" | "Looks right" (closes), "Try again" (ghost, restarts) |
| `failed` | "Couldn't lock on to the beat ({n} taps). Pick a part of the song with a clear beat and tap on every beat.", or the same without "({n} taps)" when there is no result | "Try again", "Close" (ghost) |

**Timing logic** (`Calibrate.jsx:78-144`):

- *Start / jump:*
  1. Target = reported position + 6 s. If the track has under 25 s left after that, target = max(0, reported - 30).
  2. Pause if playing, then wait 1400 + random(0-900) ms.
  3. Seek to the target and arm the tap.
  4. After 1500 ms, if still not playing, send play. Cast needs this; BluOS plays from the seek.
- *Tap in jump:* compute d = reported(now) - target.
  - Not armed, not playing, or d < 0.05 s: "Too early, wait for the music."
  - d > 4 s: "That was late. Tap the moment you hear it."
  - Otherwise flash and record d.
  - Repeat (message "Good.", re-jump after 1500 ms) until two rounds agree within 0.35 s, or three rounds are done.
  - The median becomes the coarse value.
- *Beat:* phase `ready` for 2500 ms, then `beat` for 12 s. Each tap flashes and records the reported position. Progress updates every 100 ms.
  - At the end, `solveLag(onsetFrames, taps, coarse)` runs (`api/tapSync.js`).
  - If quality < 1.6, the phase becomes `failed`.
  - Otherwise it becomes `result` and the offset is saved immediately (`onDone(offset)` sends it to the server).
- *Keys:* Space/Enter tap, Escape closes. Not relevant on iPhone.

---

### 4.8 Edge cases and states summary

| Situation | Sheet | Mini player | Now Playing device button |
|---|---|---|---|
| Playing on this phone, nothing else online | Header subtitle empty. Current = This Phone / "Phone playback" + quality. No "Select another device", no rows. Note only. No volume | Artist line; white device icon | White icon, no name |
| Playing on this phone, others online | Current = This Phone. Rows: other clients, then speakers | same | same |
| Playing on another Slopify client | Current = that client (form icon, green name, model e.g. "Laptop"). Rows include "This Phone" first. Volume slider shown (controls that client) | Green "Playing on <client name>" with Cast glyph; green icon | Green icon + green name |
| Playing on a speaker (driven by the server or any client) | Current = speaker (or "A + B" for a group, sub "Grouped with B"). Every grouped speaker is removed from the rows. Volume slider shown | Green "Playing on <speaker>"; green icon | Green icon + "<speaker>" or "A + B" (marquee) |
| Transfer fails | Sheet already closed | Red error strip above the card: "Could not move playback to {name}: {error}" or "Could not take over playback: {error}" | n/a |
| Nothing playing | Sheet still works (Current = This Phone; quality hidden) | "Nothing playing" title | Shown only if a session device exists (always true in practice) |

**UNSURE / quirks found in the code (decide before reproducing):**

1. The phone sheet is rendered inside the mini player's `.player-row`, and that row opens Now Playing on any click that is not on a button, input, link or `[role=button]` (`Player.jsx:268`). A tap on the sheet's non-button areas (header, current-device block, note) may therefore bubble up and open Now Playing behind the sheet. The scrim stops propagation, but the sheet body does not. This is probably unintended.
2. The phone app shows the browser-only note (4.3.3 E).
3. Calibration is unreachable on the phone (4.7).
4. The comments say a 4pt slider bar and 16pt icons, but the CSS uses 8pt and 22pt (4.4).

---

## 5. Library, track rows, menus, downloads/offline

All values are for the phone layout (viewport 393x852, `max-width: 760px`). CSS is loaded in this order, later files win at equal specificity: `app.css` → `mobile-nowplaying.css` → `mobile-home-search.css` → `mobile-library.css` (web/src/main.jsx:9-12). Values below are the resolved (winning) ones. "pt" = CSS px = iOS points.

### 5.0 Tokens used in this section

Dark theme values from `:root` (web/src/styles/app.css:5-46). A light theme exists (`:root[data-light="1"]`, app.css:50-66) but it is set at runtime and is out of scope here; use the token names so a light theme can swap them.

| Token | Value | Used for |
|---|---|---|
| `--bg-base` | `#121212` | Library page ground, tab bar, sheets' text ground |
| `--page` | `#121212` | Page colour, `.newpl` full-screen naming page |
| `--fg` | `#ffffff` | Primary text, icon buttons in library header |
| `--fg-dim` | `#b3b3b3` | Menu icons, folder placeholder glyph, Downloads secondary text |
| `--fg-sub` | `#a7a7a7` | Secondary text (row subtitles, ⋯ button, sort row icons) |
| `--fg-faint` | `#727272` | Placeholder text in naming page |
| `--fg-chrome` | `#a9a9a9` | Downloads Retry/Play pill border |
| `--accent` / `--accent-ink` / `--green` | `#1ed760` | Active chip, pin, now-playing title, download marks, drop line |
| `--seek-accent` | `#1db954` | Filled liked heart only |
| `--on-accent` | `#000000` | Text on green |
| `--on-fg` | `#000000` | Text on white pills |
| `--chip` | `#2a2a2a` | Chips, search field, image placeholders in sheets/skeletons |
| `--card-hover` | `#282828` | Image placeholder in rows, lifted drag row |
| `--sheet` | `#282828` | Bottom sheet background |
| `--bg-elevated` | `#1f1f1f` | `.banner` (Downloads error) |
| `--bg-elevated-hi` | `#2a2a2a` | (desktop menu bg; phone uses `--sheet`) |
| `--tint` | `#ffffff1a` (white 10%) | |
| `--tint-hi` | `#ffffff24` (white 14%) | Folder drop-target bg, Downloads bar track |
| `--danger` | `#f3727f` | Destructive menu rows, Downloads warnings |
| `--fg-rgb` | `255,255,255` | used as `rgba(var(--fg-rgb), a)` |
| `--ease` | `cubic-bezier(.3,0,0,1)` | Downloads progress bar |

Font: system stack `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`, base 16/400, line-height 1.5 (app.css:80-86). Use SF Pro. All UI text is non-selectable on phone, no long-press callouts (mobile-home-search.css:11-12; app.css:1410-1412). Press feedback: tapped rows get `background: rgba(255,255,255,.08)` while pressed (app.css:1415); icon buttons go to `opacity .6` while pressed (app.css:1417).

---

### 5.1 How the Library tab is wired (App.jsx)

Sources: web/src/App.jsx:277, 387, 395, 425, 1540-1545, 1645-1672, 1781-1797; web/src/styles/app.css:1236-1237, 1306-1307.

- The phone has 3 bottom tabs: Home, Search, Your Library (App.jsx:1783). Tapping "Your Library" sets `mobileLib = true` (App.jsx:1789). The Library page is the desktop left rail (`Sidebar.jsx`) shown full width; the main content pane is hidden (`.shell.show-lib .sidebar {display:grid}`, `.shell.show-lib .content {display:none}`, app.css:1236-1237). The rail's Home/Search nav is hidden (app.css:1307).
- Any navigation (opening a playlist/album/artist/Liked Songs from a row) sets `mobileLib = false` (App.jsx:387) but the Library tab stays lit (per-tab navigation stack, App.jsx:388-395). Going Back to the root re-shows the library (App.jsx:425). Native: a `NavigationStack` per tab; Library root = this page.
- Tapping the already-lit tab while at its root calls `document.querySelector('.shell .content').scrollTo({top:0, behavior:'smooth'})` (App.jsx:1786). On the Library root `.content` is hidden, so the library list does NOT scroll to top. **UNSURE** whether intended; native should probably scroll the list to top (Spotify does).
- Library root header: the global navbar shows, left to right: 32pt avatar, then the title "Your Library" (`t('Your Library')`) 24/700, letter-spacing -0.3 (App.jsx:1541, 1576; app.css:1203-1204). Navbar: min-height 48 + `safe-area-inset-top` padding on top, horizontal padding 16, gap 12 (app.css:1377; mobile-home-search.css:16-18). Avatar: 32x32 circle, image cover-fit, fallback = first letter of the user name uppercased, 13pt bold black on `#509bf5` (app.css:712-716, 1203). Tapping the avatar opens the account drawer (section on drawer; its "Downloads" row opens the Downloads page, §5.9).
- Page ground: `--bg-base` `#121212`, no corner radius (app.css:1239).

---

### 5.2 "Your Library" page (Sidebar.jsx on phone)

Sources: web/src/components/Sidebar.jsx (whole file, 500 lines); web/src/styles/mobile-library.css:4-77; web/src/styles/app.css:193-212, 469-473, 961-969, 1306-1313, 1437-1443; mobile-home-search.css:56; mobile-nowplaying.css:139.

#### 5.2.1 Vertical structure

Fixed (non-scrolling), top to bottom:
1. Navbar (avatar + "Your Library"), §5.1.
2. Header action buttons, floating at the navbar's right edge (5.2.2).
3. Filter chips row (5.2.3).
4. Either the sort row (5.2.4) or, while searching, the "Find in Your Library" field (5.2.5).

Then the only scrolling region: the list (5.2.6). The chips/sort/search rows never shrink (`flex:none`, mobile-home-search.css:56); the list takes the rest (`flex:1 1 auto; overflow-y:auto`, mobile-library.css:16-18).

List padding: `0 16 ` + bottom `calc(24 + 56 + 8 + 49 + safe-area-bottom)` = 137pt + bottom inset, so the last row scrolls clear of the floating mini player (56 + 8 margin) and tab bar (49) (mobile-nowplaying.css:139).

#### 5.2.2 Header buttons ("search" and "+")

Sidebar.jsx:350-364; mobile-library.css:8-13; icon paths Sidebar.jsx:11-23, `Icon` Sidebar.jsx:25-32.

- Container: `position: fixed; top: 8 + safe-area-top; right: 8; z-index 30`, flex row, gap 4. The desktop title inside `.libhead` is hidden.
- Two buttons, each 40x40 hit area, icon 24x24, colour `--fg` `#fff`, stroke width 1.7 (round caps/joins, no fill), viewBox 0 0 24 24:
  1. Search (magnifier): path `M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2` (`ICONS.search`). Toggles search mode. While search mode is on, the button is green `--accent-ink` `#1ed760` (`.icon-btn.on`). Each toggle also clears the query. Accessibility label / tooltip: `t('Find in Your Library')`.
  2. Plus: path `M12 5v14M5 12h14` (`ICONS.plus`). Opens the Create sheet (5.2.10). Label: `t('Create playlist')`.
- Pressed: opacity .6.

#### 5.2.3 Filter chips

Sidebar.jsx:232-233, 366-371, 275-276; mobile-library.css:21-24; app.css:1438-1441.

- Row: horizontal scroll (no indicator), padding 8 top / 16 sides / 8 bottom, gap 8.
- Chips: `Playlists` / `Albums` / `Artists` (keys `t('Playlists')`, `t('Albums')`, `t('Artists')`). There is NO "Downloaded" chip; offline mode filters automatically (5.8).
- Chip style: height 32 (min), horizontal padding 16, text 13/500, bg `--chip` `#2a2a2a`, text `#fff`, capsule radius (500). Selected: bg `#1ed760`, text `#000`.
- Behaviour: state `libFilter` = none | playlist | album | artist (not persisted).
  - Tap an unselected chip: select it. Once one is selected, the other chips are hidden, and a round "×" chip appears before it.
  - "×" chip: 32x32, padding 0, centred "×" glyph at 18pt, bg `#2a2a2a`. Label `t('Clear filter')`. Tap clears the filter.
  - Tap the selected chip again: clears the filter.
  - Offline: the `Artists` chip is removed; if it was selected the filter is cleared (Sidebar.jsx:276, 368).
- Selecting a chip shows a flat list (no folders, no drag), 5.2.7.

#### 5.2.4 Sort row and grid/list toggle

Sidebar.jsx:379-386; mobile-library.css:27-29; app.css:1442.

- Row: flex, space-between, min-height 40, padding 8 top / 16 sides / 8 bottom, text 13/600 `#fff`.
- Left: sort icon 16x16 (stroke, path `ICONS.sort`: `M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3`), gap 6, then the label `t('Recents')`. This is STATIC: it is a plain span, not tappable, there are no sort options. The order is always the server "library layout" order (5.2.6). (Native may render it as a non-interactive label to match.)
- Right: view toggle, 40x40 circle hit area, `margin-right: -10` (so the glyph aligns to the 16pt gutter), icon 20x20 stroke 1.9, `#fff`. Shows the `grid` icon (`M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z`) while in list view, and the `list` icon (`M4 6h16M4 12h16M4 18h16`) while in grid view. Label `t('Grid view')` / `t('List view')`.
- Grid/list state is in-memory only (React `useState(false)`, Sidebar.jsx:243): default list; it survives tab switches in the session (the Sidebar stays mounted) but resets on app reload. Not saved to server or storage.

#### 5.2.5 "Find in Your Library" (search mode)

Sidebar.jsx:239-242, 265-266, 372-378; mobile-library.css:32-37.

- Replaces the sort row (chips stay visible above it).
- Row: flex, gap 8, padding 4 top / 16 sides / 8 bottom.
- Field: height 36, radius 4, bg `#2a2a2a`, text 16 `#fff`, left padding 38 (icon inside), right padding 12, no border. Placeholder `t('Find in Your Library')` in `#a7a7a7`. Autofocus (keyboard opens). Spellcheck off.
- Magnifier icon inside the field: 20x20 stroke icon, colour `#a7a7a7`, 10pt from the field's left edge, not tappable.
- "Cancel" text button at the right: `t('Cancel')`, 14/600 `#fff`, height 36, padding 0 4. Tap: leave search mode, clear the query.
- Matching: case-insensitive substring of the item name (`name.toLowerCase().includes(q.trim().toLowerCase())`). Liked Songs matches against its localized name. A non-empty query flattens folders (5.2.7). Results update per keystroke.

#### 5.2.6 Content and order

Sidebar.jsx:100-127, 145-161, 267-274, 392-442.

Entries come from: user playlists, saved albums (album favourites), followed artists (artist favourites), plus folders defined in the server layout (`GET /api/library/layout` → `{ order: [ids], folders: [{ id, name, cover?, items: [ids] }] }`, api/slopify.js:365-373).

Order algorithm (Sidebar.jsx:103-125):
1. Folders' children are taken out of the top level and shown under their folder.
2. Remaining items in `layout.order` order.
3. Folders not mentioned in `order` go to the top.
4. Items not in the layout at all ("fresh", newly saved) go above everything known.
5. Pinned items (`prefs.libraryPinned`, an array of ids in server prefs) float to the top, keeping their relative list order (NOT pin order).
6. Liked Songs is always the very first row, above pinned items, and always shows a pin (it is not in the pinned array).

The layout is fetched on mount, on a `prefs._libraryLayout` change from another device (via session socket), and on a refresh event; it is cached locally (`jf.persisted('libraryLayout')`) for instant first paint (Sidebar.jsx:55-77).

#### 5.2.7 Flat mode vs tree mode

Sidebar.jsx:268-274.

- Flat mode when any of: a chip filter is set, the search query is non-empty, or offline. In flat mode: folders are not shown; their children appear inline at the folder's position; the list can't be dragged; the global long-press menu is used (5.2.9).
- Tree mode otherwise: folders shown; an open folder's children follow it, indented; drag to reorder is on.
- Filter: kind must equal the chip. Offline: only items with at least one downloaded song (5.8). Liked Songs shows only when no filter or the Playlists filter is set, it matches the query, and (offline) it is downloaded.

#### 5.2.8 Row layout (list view)

Sidebar.jsx:392-441; mobile-library.css:41-50; app.css:199-212, 469-473.

| Part | Value |
|---|---|
| Row | Full width inside the 16pt gutters, padding 8 top/bottom, 0 sides, horizontal stack, gap 16, centre-aligned, no separators, no background, radius 0 |
| Row height | 64 art + 16 = 80pt |
| Artwork | 64x64, corner radius 3, aspect-fill, placeholder bg `--card-hover` `#282828`. Artists: circle |
| Liked Songs art | 64x64 radius 3, linear gradient 135° `#450af5` → `#c4efd9`, white filled heart centred at 45% of the tile (path in TrackRow.jsx:107-109, `LikedCover`) |
| Folder art | if the folder has a cover: the image (64x64 radius 3); else placeholder `#282828` with a centred folder glyph 28x28 stroke 1.9 colour `--fg-dim` `#b3b3b3`; `folder` path when shut, `folderOpen` path when open (Sidebar.jsx:21-22, 410-412) |
| Text column | vertical, min-width 0 |
| Title | 16/400 `#fff`, one line, tail ellipsis |
| Subtitle | 13/400 `#a7a7a7`, one line, tail ellipsis, horizontal stack gap 4 |
| Pin glyph | 13x13 filled, `#1ed760`, before the subtitle (path Sidebar.jsx:40-44, also `I.pin` TrackRow.jsx:161). Label `t('Pinned')` |
| Downloaded mark | 12x12 green circle with black down-arrow, before the subtitle when every song is downloaded (5.7.3) |
| Folder child | extra left padding 20 (`.libitem.infolder`) |
| Press | opacity .7 + bg `rgba(255,255,255,.08)` while pressed |

Image URLs: `jf.imageUrl(id, { maxHeight: 84 })`; folder cover gets `&c=<first 10 chars of cover id>` as a cache-buster.

Subtitle text per kind (` • ` is U+2022 with spaces):

| Kind | Subtitle |
|---|---|
| Liked Songs | [pin] [download mark / partial text] `Playlist` + (if count known) ` • {n} songs` (`t('Playlist')`, `t('{n} songs', {n})`) |
| Playlist | [pin?] [dl] `Playlist` + (if ChildCount > 0) ` • {n} songs` |
| Album | [pin?] [dl] `Album • {album artist}` (`t('Album')`) |
| Artist | [pin?] `Artist` (`t('Artist')`); never a download mark |
| Folder | `Folder • {n} items` (`t('Folder')`, `t('{n} items', {n})`); n = children count |

Partial downloads offline only: instead of the mark, the text `{have} of {total} downloaded • ` (`t('{have} of {total} downloaded')`) precedes the subtitle (Sidebar.jsx:151-156). Online, partial downloads show nothing.

#### 5.2.9 Taps, long-press, drag (tree mode) and menus

Sidebar.jsx:225-230, 278-314, 387, 392-441; libraryDrag.js:1-230; App.jsx:1395-1432; app.css:961-967.

Tap:
- Liked Songs → open Liked Songs page.
- Playlist → open playlist page. Album → album page. Artist → artist page.
- Folder → toggle open/shut. Open folders are saved per device in local storage key `slopify.libOpenFolders` (JSON array of folder ids) (Sidebar.jsx:47-49, 91-96).

Long-press, tree mode (rows with drag; constants libraryDrag.js:22: `TOUCH_SLOP 8`, `LONG_MS 380`, `EDGE 56`, `MAX_SPEED 18`):
1. Finger down on a row starts a 380 ms timer. Moving more than 8pt (euclidean) before it fires = a scroll; the press is dropped.
2. At 380 ms the row "lifts": light haptic (10 ms vibrate), the row gets bg `#282828`, shadow `0 8 24 rgba(0,0,0,.45)`, z above others, scale 1.02, and follows the finger. List scrolling is blocked.
3. If the finger is released without having moved more than 8pt from the start: the drag is cancelled (row slides back) and the row's context menu opens at the finger position (`onHold`). The release's synthetic click is swallowed for 400 ms so it does not open the row.
4. If the finger moves > 8pt after lifting: it is a drag (5.2.11).
- Liked Songs is NOT a drag row and is inside the list marked `data-own-press`, which disables the global long-press. Result: in tree mode a long-press on Liked Songs does nothing on the phone. In flat mode it opens its menu. **UNSURE**: likely a bug; Spotify gives Liked Songs a menu. Recommend native gives it the menu in both modes.

Long-press, flat mode: the app-wide long-press (App.jsx:1395-1432) applies: hold still 450 ms (cancel if moved > 10pt on x or y), then the menu opens at the finger, with a 10 ms haptic, and the release's click is swallowed for 400 ms.

Library row menus (`menuItems`, Sidebar.jsx:194-224). Shown as the phone bottom sheet (5.5) with NO header block. Separators shown as `—`. Items with no icon have no icon column (5.5.4):

| Object | Items (top to bottom), condition → action |
|---|---|
| Liked Songs | `Add to queue` → fetch liked tracks, append to queue. `Play` → fetch liked tracks, play from 0 with context `liked` |
| Playlist | `Add to queue` → fetch playlist tracks, append. `Play` → play from 0 (context = playlist id). — . `Pin playlist` / `Unpin playlist` → toggle id in `prefs.libraryPinned`. `Regenerate` (only if the playlist has `AiPrompt`) → open the AI generate dialog prefilled. `Edit details` → open the playlist page and then its edit-details dialog (300 ms later). `Delete` (trash icon `I.trash`, red) → system confirm `Delete "{name}"?` → delete, toast `Deleted {name}` |
| Album | `Add to queue`. `Play`. — . `Pin album` / `Unpin album`. `Go to artist` (only if the album has an album-artist id) → artist page. `Share` → share link (5.4.6). `Remove from Your Library` → un-favourite album, toast `Removed from Your Library` |
| Artist | `Add to queue` → append an instant mix of the artist. `Play` → play the instant mix. — . `Pin artist` / `Unpin artist`. `Share`. `Unfollow` → un-favourite the artist, library refresh |
| Folder | `Rename` (icon `I.edit`) → full-screen naming page, kind rename (5.2.10). `Choose photo` (icon `I.photo`) → system image picker (jpeg/png/webp), uploads `POST /api/library/folders/{id}/cover`. `Delete` (`I.trash`, red) → confirm `Delete "{name}"?` → folder removed, its children go back to the top level at the folder's position (nothing deleted) |

i18n keys: `Add to queue`, `Play`, `Pin playlist`, `Unpin playlist`, `Pin album`, `Unpin album`, `Pin artist`, `Unpin artist`, `Regenerate`, `Edit details`, `Delete`, `Delete "{name}"?`, `Go to artist`, `Share`, `Remove from Your Library`, `Unfollow`, `Rename`, `Choose photo`.

Note: these library menus are NOT reduced when offline (unlike track and hero menus). **UNSURE** if intended; `Play` on a non-downloaded album would fail offline.

#### 5.2.10 Create flow ("+")

Sidebar.jsx:244-264, 316-326, 444-459; mobile-library.css:51-62.

1. Tap "+" (or the empty-state "Create playlist" button) → bottom sheet (5.5), no header, items:
   - `Playlist` (icon `I.playlist`, 16pt) → naming page, kind playlist.
   - `Generated playlist (AI)` (icon `I.sparkle`) → opens the AI "Generate playlist" dialog (out of scope, `GeneratePlaylist.jsx`). Present whenever the app provides it (always on phone).
   - `Folder` (icon: Sidebar `folder` stroke glyph at 16pt) → naming page, kind folder.
   Descriptions (`Build a playlist with songs` etc.) are desktop-only; not shown on phone.
2. Naming page (`.newpl`): full-screen overlay over everything (z 320), bg `--page` `#121212`. Vertical stack centred both ways, gap 24, padding `24 + safe-top` / 24 sides / `24 + safe-bottom`. No enter/exit animation.
   - Title, 24/700 `#fff`, centred, letter-spacing -0.3: `Give your playlist a name` / `Give your folder a name` / `Rename folder`.
   - Text field: full width up to 340, transparent bg, no border except a bottom hairline 1px `#727272` (becomes `#fff` when focused), text 24/700 `#fff` centred, padding 8 top 12 bottom. Placeholder (`#727272`, 700): `My playlist #1` (playlist) or `My folder` (folder/rename). Autofocus. Spellcheck off. Prefilled with the current name for rename, empty otherwise.
   - Actions row, gap 24, 8 below the field: `Cancel` text button 16/700 `#fff`, padding 12x8 → dismiss. `Create` (or `Save` for rename) capsule: bg `#fff`, text `#000` 16/700, min-height 48, padding 0 32, radius 500; disabled (opacity .3) while the trimmed name is empty.
   - Keyboard Return submits.
3. Submit: playlist → `createPlaylist(name)`, playlist list refreshed, toast `Created {name}`; error toast `Could not create playlist: {error}` (App.jsx:1050-1057). Folder → optimistic insert at the top, `POST /api/library/folders {name}`. Rename → `PATCH /api/library/folders/{id} {name}` (skipped if unchanged).

i18n keys: `Create playlist`, `Playlist`, `Generated playlist (AI)`, `Folder`, `Give your playlist a name`, `Give your folder a name`, `Rename folder`, `My playlist #1`, `My folder`, `Cancel`, `Create`, `Save`, `Created {name}`.

#### 5.2.11 Drag to reorder (tree mode only)

libraryDrag.js:22-229; Sidebar.jsx:278-314; app.css:961-967.

- Enabled only in tree mode, not while naming. Rows: every entry except Liked Songs (which has no drag handle and always stays first).
- During drag: the lifted row tracks the finger (translate + scale 1.02). The other rows slide out of the way to show where it will land: animated transform `.18s cubic-bezier(.2,0,0,1)`. Positions are measured once at lift.
- Hit test against the row under the finger (at its shifted position): upper half → land before it, lower half → after it (grid view: left/right half). Over a folder row and vertically within its middle 25%-75% band → "drop into folder" (only if the dragged item is not a folder): the folder row gets bg `rgba(255,255,255,.14)` and an inset 2pt `#1ed760` outline, and no drop line shows. Over the gap the others opened: no change (prevents flicker). Above the first row → slot 0; below the last → last slot.
- Drop line: 2pt tall, radius 1, `#1ed760`, inset 4pt from the slot's left, width slot width - 8 (min 8), vertically at the middle of the destination slot, with an 8x8 ring at its left end (2pt `#1ed760` border, fill `#121212`, centred on the line's start). Fades in/out `.12s`. Hidden when the slot equals the start slot.
- Auto-scroll: when the finger is within 56pt of the list's top or bottom edge, scroll by up to 18pt per frame, proportional to how deep into the edge zone.
- Dragging a folder: all open folders show shut for the drag (a folder can't go inside a folder; one level only).
- Cancel (no move, pointer cancelled, app loses focus): everything animates back, `.2s cubic-bezier(.2,0,0,1)` for the row, `.18s` for the others.
- Drop rules (Sidebar.jsx:281-307):
  - Into a folder → becomes that folder's FIRST child.
  - Between two children of a folder (or before its first child) and the dragged item is not a folder → inside that folder at that index.
  - Right under an open EMPTY folder (and dragged item not a folder) → into that folder.
  - Otherwise → top level, right after the item above (or after the folder that holds the item above); slot 0 → very top.
- After drop the dropped row animates from where it was released to its new place, `.2s cubic-bezier(.2,0,0,1)`.
- Save: optimistic. `PUT /api/library/layout {order, folders: {folderId: [ids]}}` with header `X-Slopify-Rev: <random rev>`. On failure: restore the previous layout and toast `Could not save Your Library: {error}`. If the server answers with a layout, show it; else re-fetch (Sidebar.jsx:78-89, 143).

#### 5.2.12 Grid view

mobile-library.css:65-71.

- Two equal columns, column and row gap 16, top padding 8, same side gutters 16.
- Each cell is a vertical stack, gap 8, no padding: artwork full cell width, square (radius 3, circle for artists; Liked Songs tile/folder tile also square); title 14/400 `#fff`, up to 2 lines then ellipsis, line-height 1.3; subtitle 13 `#a7a7a7` single line block; pin glyph inline before the subtitle with 4pt right margin, baseline offset -1.
- Same taps, menus and drag as the list (hit test uses left/right halves).

#### 5.2.13 Empty, loading and error states

Sidebar.jsx:248-251, 461-495; mobile-library.css:74-77.

Empty block style: vertical, left-aligned, gap 6, padding 24 top / 8 bottom; title 16/700 `#fff`; line 13 `#a7a7a7`, 12 below; optional button: white capsule, text `#000` 13/700, min-height 32, padding 0 16.

| Condition | Title / text / button |
|---|---|
| Offline, nothing downloaded (no Liked, no entries, no query) | `Nothing downloaded` / `Download a playlist or album while you have a connection and it shows here.` |
| Online, no entries, library finished loading, at least 1.5 s since the page mounted, liked count known, no query, filter none or Playlists | `Create your first playlist` / `It's easy, we'll help you.` / button `Create playlist` (opens the Create sheet) |
| Query with no match | `Couldn’t find “{query}”` (curly quotes) / `Try a different playlist, album or artist name.` |
| Artists filter, none, online, loaded | `No artists yet` / `Follow an artist and they show up here.` |
| Albums filter, none, online, loaded | `Save your first album` / `Add an album to Your Library and it shows up here.` |

Loading: there is NO skeleton or spinner on the library list. While loading, only Liked Songs (always present online; its count is omitted until known) and whatever cached data exists are shown. Playlists, saved albums and liked count are cached across launches (`jf.persisted`, App.jsx:553-554, 673), so a relaunch paints the last list at once.

---

### 5.3 VirtualList (track lists)

Source: web/src/components/VirtualList.jsx:1-50; used at Library.jsx:1572-1586.

- Album, playlist and Liked Songs track lists are windowed with a FIXED row height: phone 64pt; 84pt when a "find in list" filter is active and any result has a lyric snippet. (Desktop 56/76.) Overscan 8 rows, initial window 40 rows. Scroll container = the page's scroll view.
- Native: a `LazyVStack`/`List` with fixed 64pt rows is equivalent. Each row's key: `PlaylistItemId` or `{trackId}-{index}`.
- Other lists (search results, artist Popular, recommended) are not virtualized.

---

### 5.4 TrackRow (shared track row)

Sources: web/src/components/TrackRow.jsx:1-337; web/src/styles/app.css:397-436, 827-837, 884-885, 921-934, 1329-1341, 1399-1425, 1824; mobile-library.css:146-155, 180-183.

#### 5.4.1 Layout on phone

| Part | Value |
|---|---|
| Row | horizontal stack, centre-aligned, gap 12, padding 8 top/bottom 16 sides, min-height 64, radius 0, no background (also when active). Inside a padded page section (`.pad`, e.g. artist page) side padding 0 |
| Index / play button | HIDDEN on phone, except the artist page "Popular" list (5.4.3) |
| Artwork | only when the list asks for it (`showArt`): playlists, Liked Songs, search results, artist Popular, profile, recommended. 48x48, radius 3, aspect-fill, placeholder `#282828`. Album pages: no art. URL `jf.imageUrl(trackId or albumId, {maxHeight: 80})` |
| Text column | fills remaining width, min-width 0 |
| Title | 16/400 `#fff`, one line, tail ellipsis. Active (this track is the current track): `#1ed760` |
| Subtitle | 13/400 `#a7a7a7`, 2pt below the title, one line, tail ellipsis. Content: [downloaded mark] + artist names joined `, ` (fallback album artist). On phone the artist names are plain text, not links. When the list passes a custom `subtitle` (e.g. Popular: play count), that replaces the artists |
| Lyric snippet (search "find" by lyrics only) | extra line under the subtitle: small `Lyrics` tag (10/600, line-height 15, bg white 10%, text `#b3b3b3`, radius 3, padding 0 6) + the matched line, 12pt `#b3b3b3`, line-height 16, 3pt top margin, matched words `#fff` weight 500; gap 8 |
| Album column, heart, duration | HIDDEN on phone (`.trackrow-album, .trackrow-like, .trackrow-dur {display:none}`, app.css:1338). No heart on phone rows |
| ⋯ button | 40x40, always visible, `margin-right: -12` (glyph sits ~4pt from the gutter), colour `#a7a7a7`, Dots glyph 16x16 (TrackRow.jsx:131-135). Label `t('More options')` |
| Explicit / quality badges | NONE in track rows (QualityBadge is only used by the device picker and now-playing) |
| Unavailable (offline and not downloaded) | whole row opacity 0.4 (app.css:1824) |
| Highlighted (opened via a link to a specific track) | bg white 14% + 1pt outline white 21%, scrolled to centre (app.css:921; Library.jsx:583-586) |
| Pressed | bg `rgba(255,255,255,.08)` |

#### 5.4.2 Taps and gestures

TrackRow.jsx:240-259, 270-276, 314-333; App.jsx:1395-1432.

- Tap anywhere on the row (except ⋯, the art, lyric snippet): if this row is the current track → toggle play/pause; else → play the list from this row (`playQueue(listTracks, index, contextId)`). In search results rows may instead navigate (`onRowOpen`).
- Touch-down on the row: pre-warm the stream for that track (`jf.prewarm(trackId)`, HLS only). Native: start fetching/buffering on touch-down.
- Tap the artwork (when it has an album): open the album page.
- Tap the lyric snippet (when it has a time): play from that line.
- Tap ⋯: open the row menu (5.4.5).
- Long-press (hold still 450 ms, cancel on > 10pt movement): open the same menu, 10 ms haptic, swallow the release tap.
- No swipe gestures on track rows. Reordering playlist tracks uses HTML5 drag (`dnd`, Library.jsx:620-629) which does not fire on iOS touch; so on the phone web app, playlist tracks cannot be reordered. **UNSURE** whether native should add it (Spotify iOS reorders in an edit mode).

#### 5.4.3 Now-playing indicator

TrackRow.jsx:113-116, 260-268; app.css:827-832; mobile-library.css:180-183.

- On phone rows the index column is hidden, so the only now-playing cue is the green title.
- Artist page "Popular" list: index column shown, 20 wide x 24 tall, 16pt `#a7a7a7` number; for the active row the number is `#1ed760`, and while playing it is replaced by the animated bars:
  - `NowPlayingBars`: 14x14 box, 3 bars 3pt wide, 2pt gap, bottom-aligned, colour `#1ed760`, base heights 40% / 90% / 60%, each animates `scaleY .4 → 1 → .4` (origin bottom) over 0.9 s ease-in-out infinite, delays 0 / .25 / .5 s. Label `t('Now playing')`.
  - No hover play glyph on phone.

#### 5.4.4 Downloaded mark in rows

TrackRow.jsx:176-179, 283-284; app.css:1822. When the song is downloaded on this device: a 12x12 mark before the subtitle text, 5pt right margin, baseline offset -1: filled circle `#1ed760` r8 (viewBox 16), with a black down-arrow stroke 1.6 round (`M8 4v6m0 0L5.5 7.5M8 10l2.5-2.5`). Label `t('Downloaded')`.

#### 5.4.5 Track row menu (all items, in order)

TrackRow.jsx:210-236, 332-333. Rendered as the phone bottom sheet (5.5) WITH a header: image = track art (`maxHeight 120`), title = track name, sub = artist names joined `, ` (fallback album artist).

| # | Item (i18n key) | Icon (TrackRow.jsx `I`) | Shown when | Action |
|---|---|---|---|---|
| 1 | `Add to queue` | `queue` | list provides it (all Library lists do) | append the track to the queue |
| 2 | `Add to playlist` ▸ | `plus` | always | submenu: `New playlist` (icon `plus`) → name prompt (5.4.7); then a separator (if any playlists); then one row per user playlist (no icon) → add, toast `Added to {name}` / `Could not add: {error}` |
| 3 | `Remove from this playlist` | `trash` | on a user playlist's page (not Liked, not mixes) | remove the row |
| 4 | `Add to Liked Songs` / `Remove from Liked Songs` | `heart` / `heartOn` (filled `#1db954`) | always | toggle like. Optimistic; toast `Added to Liked Songs` / `Removed from Liked Songs`; on error revert + `Not saved: {error}` (App.jsx:1013-1028) |
| 5 | `Exclude from your taste profile` / `Include in your taste profile` | `ban` | list provides it | toggle dislike (`UserData.Likes === false` = excluded); toast `Excluded from your taste profile` / `Included in your taste profile` |
| — | separator | | | |
| 6 | `Go to song radio` | `radio` | list provides it | start a mix from this track |
| 7 | `Go to artist` | `artist` | track has ≥1 artist with an id | one artist: open it. Several: submenu with each artist name |
| 8 | `Go to album` | `album` | track has an album id | open album |
| 9 | `Sync Lyrics` / `Syncing Lyrics…` (disabled while a job runs) | `lyrics` | always (when signed in) | start a lyrics sync job |
| 10 | `Share` | `share` | always | 5.4.6 |
| — | separator | | only with Download | |
| 11 | `Download` ▸ | `down` | list provides it (Library lists do) | submenu of file formats: `Original (highest quality)`, `FLAC`, `WAV (16-bit)`, `MP3 320 kbps`, `AAC 256 kbps`, `OGG Vorbis 320 kbps` → saves a FILE (not offline download); toast `Downloading...` / `Converting to WAV...`, error `Download failed: {error}` (api/download.js:12-19, 59-82; App.jsx:1082-1086). **UNSURE** what native should do (share sheet / Files export) |

Offline variant (TrackRow.jsx:181-188, 236): only `Go to artist`, `Go to album`, and `Add to queue` (only if this song is downloaded) remain; separators are removed when leading, trailing or doubled.

Icon SVG definitions: all 16x16, viewBox 0 0 16 16, `fill: currentColor`, in `export const I` at TrackRow.jsx:140-162 (keys: plus, queue, ban, radio, artist, album, down, trash, heart, heartOn, lyrics, share, follow, edit, gear, sparkle, playlist, photo, play, check, pin). Other files import it as `MI`. `heartOn` is filled `var(--seek-accent, #1db954)`; `check` is filled `#1ed760`. Export these paths verbatim as SF-Symbol-like template images.

#### 5.4.6 Share

TrackRow.jsx:38-57. Builds `{server main address}/?{kind}={id}` (kind = track | album | artist). On touch devices with a share API → system share sheet with title `"{title} — {by}"` (or just title) and the URL; dismissing it is silent. Otherwise copies the URL and toasts `Link copied`; failure `Could not copy the link`. Playlists are not shareable.

#### 5.4.7 "New playlist" from a track

App.jsx:1059-1069, 1768-1778; app.css:853-860.
- A centred modal over a 60% black scrim (tap scrim = cancel): card bg `#2a2a2a`, radius 8, padding 24, width min(420, screen - 32), vertical gap 16, shadow `0 16 24 rgba(0,0,0,.3)`.
- Title `New playlist` 20pt; text field prefilled with the track's album name (fallback `My Playlist`), all text selected on focus, padding 12x14, radius 4, border 1pt `#555` (focus `#fff`), bg `#1f1f1f`, 15pt; buttons right-aligned gap 8: `Cancel` (outlined capsule: 1pt `#7a7a7a` border, 14/700, padding 8x16, min-height 32) and `Create` (white capsule, black 700 text, padding 10x24, disabled .4 when empty).
- Submit: create the playlist containing the track; toast `Added to {name}`.

---

### 5.5 ContextMenu on phone = bottom sheet

Sources: web/src/components/ContextMenu.jsx:1-153; app.css:438-466, 1105, 1445-1466; mobile-nowplaying.css:108-123, 214-218; mobile-home-search.css:41, 44-49; RightPanel.jsx:47-51; Player.jsx:79-85.

#### 5.5.1 Structure

- A full-screen scrim + one sheet, both rendered over everything (portal on `body`).
- Scrim: black 60% (`rgba(0,0,0,.6)`), z 299, fades in 0.2 s (opacity 0 → 1). Tap on scrim: closes the sheet and the tap does NOT reach what is under it.
- Sheet: pinned to the bottom, full width, z 300. Top corners radius 16, bottom 0. Bg `--sheet` `#282828`. Shadow `0 -8 40 rgba(0,0,0,.6)`. Padding: 12 top, 8 sides, `24 + safe-area-bottom` bottom. Max height 80% of screen height, content scrolls inside.
- Grabber: decorative bar 36x4, radius 2, white 25%, centred, 6pt from the sheet top. The top-level sheet IS draggable: a downward drag starting while the sheet is scrolled to the top (not on the volume slider or inputs) moves the sheet with the finger; release with dy > 100, or dy > 40 within 300 ms, closes it, otherwise it snaps back over 0.2 s ease-out (`web/src/App.jsx:1481-1514`, which targets `.devicemenu` and `.ctxmenu-fixed:not(.ctxmenu-sub)`). Sub-sheets (`.ctxmenu-sub`) are not.
- The sheet is invisible for its first layout pass (measured, then shown); immaterial natively.

#### 5.5.2 Header (when provided)

ContextMenu.jsx:62-68; app.css:1453-1459; mobile-home-search.css:41.
- Row: gap 12, padding 14 top / 12 sides / 12 bottom, hairline divider below 1pt white 10%, 6pt margin below.
- Image 56x56 radius 4 (circle when `round`, i.e. artists), bg `#2a2a2a`; or an icon slot 56x56 centred `#fff` (used for Liked Songs = the LikedCover tile 56x56 radius 4, sort sheets, settings sheets).
- Title 16/700 `#fff` single line ellipsis; subtitle 13 `#a7a7a7` single line ellipsis, 2pt gap.
- Who passes a header: track rows, queue rows, detail-page ⋯ menus, Liked Songs sort sheet, settings sheets. Library-list menus and the "+" create sheet: no header.

#### 5.5.3 Items

ContextMenu.jsx:69-102; app.css:446-458, 1450; mobile-nowplaying.css:115-117.

| Element | Value |
|---|---|
| Item row | full width, horizontal stack, gap 12, padding 14 top/bottom 12 sides, text 16/400 `#fff`, single line ellipsis, radius 2 |
| Icon slot | 16x16, colour `#b3b3b3`. If NO item in the sheet has an icon, the icon slot is removed for every row |
| Danger item | text and icon `#f3727f` |
| Disabled | opacity .4, not tappable |
| Checked | green check (path `M13.985 2.383 5.127 12.754 1.388 8.375l-1.14 1.048 4.879 5.617L15.184 3.36l-1.199-.977z`, 16x16) at the far right, `#1ed760` |
| Submenu indicator | chevron is HIDDEN on phone |
| Separator | 1pt line white 14% (`rgba(255,255,255,.14)`), 4pt vertical margin |
| Heading-only item (`{label}` without action) | 12/700 `#b3b3b3`, padding 8 12 4 |
| Slider item | label row 16 + value 13 `#a7a7a7`, track 4pt white 30% with white fill, thumb 12 white (used by player sheets, not here) |
| Pressed | bg `rgba(255,255,255,.08)` |

Tap an item: the sheet closes first, then the action runs.

#### 5.5.4 Submenus

ContextMenu.jsx:40-50, 88-91, 104-109; app.css:1461.
- Tapping an item that has a submenu opens a SECOND sheet over the first (same styling, z 301, min-height 45% of screen height, no header, no slide-in animation). The first sheet stays underneath (visible above the second if it is taller).
- There is no Back control. Tapping a different parent item (where visible) switches the submenu; tapping the scrim closes both; tapping a submenu item closes everything and runs the action. **UNSURE**: native could implement this as a pushed page inside the sheet with a back chevron.

#### 5.5.5 Animations

- Open: sheet slides up from +40pt and fades in, 0.2 s, `cubic-bezier(.2,.7,.2,1)` (app.css:1451-1452 with duration from mobile-home-search.css:48). Scrim fades in 0.2 s.
- Close: for track rows, library menus, detail-page menus the sheet just disappears (no exit animation; ContextMenu never adds the closing class). Queue rows only: slide down to `translateY(100%)` in 0.25 s `ease-in`, then unmount (RightPanel.jsx:51; Player.jsx:79-85; mobile-nowplaying.css:109). Native: use one consistent dismiss (slide down 0.25 s ease-in) for all.

#### 5.5.6 Closing triggers

ContextMenu.jsx:120-142. Tap/press outside the sheet; the user scrolling/dragging outside the sheet (touch-move outside); window resize (e.g. rotation); Escape; a downward drag on the top-level sheet (see 5.5.1, `App.jsx:1481-1514`). Scrolling inside the sheet does not close it. Programmatic scrolls do not close it. Queue rows ignore closes in the first 500 ms after opening.

---

### 5.6 Other menus per object type (detail pages and queue)

#### 5.6.1 Detail page ⋯ sheet (album, playlist, Liked Songs, artist)

Library.jsx:1276-1305, 1350-1353, 1999-2005. Opened by the ⋯ in the page's action row. Header: image = item art (`maxHeight 120`; Liked Songs: LikedCover tile in the icon slot), round for artists, title = name, sub = `Artist` / `Playlist` (also Liked) / album's lead artist name (fallback `Album`).

Items in order with conditions ("dl" = offline download available: native iOS can always save; not for mixes, artists, or empty lists):

| # | Item | Icon | Album | Playlist (own) | Liked Songs | Artist | Mix | Action |
|---|---|---|---|---|---|---|---|---|
| 1 | `Add to queue` | queue | ✓ | ✓ | ✓ | ✓ | ✓ | append all tracks |
| 2 | `Follow` / `Unfollow` | follow | | | | ✓ | | toggle follow |
| 3 | `Go to radio` | radio | ✓ | ✓ | | ✓ | ✓ | start a mix from it |
| 4 | `Add to playlist` ▸ | plus | ✓ | ✓ | ✓ | ✓ | ✓ | (only if it has tracks) sub: `New playlist` (seeds with first track) + other playlists (not itself) → one request with all ids, toast `Added to {name}` |
| 5 | `Go to artist` | artist | ✓ (lead artist) | | | | | open artist |
| 6 | `Save to Your Library` / `Remove from Your Library` | heart / heartOn | ✓ | | | | | toggle album favourite |
| 7 | `Share` | share | ✓ | | | ✓ | | share link |
| 8 | `Download for offline` or `Remove download` / `Remove download ({done}/{total})` (while downloading) | down / trash | dl | dl | dl | | | 5.7.2 |
| 9 | `Update download ({have}/{total})` | down | dl, partly held, not busy | same | same | | | download the missing songs |
| 10 | `Download as zip` | down | | ✓ (has tracks) | | | | server zip of tagged AAC files; desktop file download. **UNSURE** native equivalent (share/export) |
| — | separator | | | ✓ | | | | |
| 11 | `Regenerate` | sparkle | | ✓ if AI playlist | | | | AI regenerate dialog |
| 12 | `Edit details` | edit | | ✓ | | | | edit-details dialog |
| 13 | `Delete` (red) | trash | | ✓ | | | | confirm `Delete "{name}"?` → delete, toast `Deleted {name}` |

Offline variant: only items flagged offline remain: `Add to queue`, `Go to artist`, and the download items (8, 9); separators tidied.

#### 5.6.2 Queue row sheet

RightPanel.jsx:43-83, 217-224. On phone, queue rows have no ⋯; the sheet opens on long-press. Header: art, title, artists. No icons (so no icon column):
1. `Remove from queue` (not on the "Now playing" row) → remove at that position.
2. `Add to Liked Songs` / `Remove from Liked Songs`.
3. `Add to playlist` ▸ (only if the user has playlists; no "New playlist" here) → each playlist.
4. separator
5. `Go to artist` (first artist with an id) → open artist.
6. `Go to album` (if album id).

---

### 5.7 Offline downloads ("Download for offline")

Sources: web/src/api/offline.js:1-152; web/src/offline/store.js:1-244; web/src/offline/local.js:1-29; web/src/offline/net.js:1-61; Library.jsx:1256-1275, 1330-1349, 2007-2026; Sidebar.jsx:145-156; TrackRow.jsx:176-179; App.jsx:1320-1340; app.css:1813-1828.

Note: two different "downloads" exist. (a) OFFLINE downloads of whole playlists/albums/Liked Songs onto the device (this section). (b) The "Downloads" PAGE, which lists server-side album acquisition requests (5.9). And (c) per-track file export via the track menu's `Download ▸` (5.4.5 #11).

#### 5.7.1 Model

- Collections: `{ id, name, kind: 'playlist'|'album'|'liked', cover, trackIds[], added }`. Liked Songs uses id `__liked__` (`LIKED_ID`, Library.jsx:29). Songs stored once even if in several collections; removing a collection deletes only songs no other collection (of any account on the device) holds (store.js:47-64, 99-128).
- Per-account library (keyed by user id); song/cover files shared by id.
- Track record: `{ title, artist, album, albumId, durationMs, q (quality), norm, file, bytes, cover }`. Downloaded = has `file`.
- Quality: if the streaming quality setting is "original" (Lossless) and the file is FLAC/MP3/AAC/ALAC/PCM/WAV/AIFF → original file; otherwise AAC at the user's profile quality via `/api/stream/{id}/whole/{q}` with loudness normalization baked in (album gain for albums, track gain otherwise; none if normalization is off). Saving again at another quality re-downloads (api/offline.js:47-95; store.js:37-44).
- Covers: album covers at 320px (`/api/image/{albumId}?size=320`), playlist own cover at `maxHeight 320`. Lyrics `/api/lyrics/{id}` are fetched and cached too.
- Downloads run 2 in parallel per collection, collections one after another; each song tried 3 times with 1.5 s / 3 s / 4.5 s back-off (store.js:21, 148-195).
- On app start and whenever the server becomes reachable: resume interrupted downloads, backfill missing covers, and upload offline plays (`POST /api/plays {trackId, at, client:'offline'}` in time order) (api/offline.js:118-152; App.jsx:1320-1333).
- A running download keeps the app alive in the background (web uses a silent audio stand-in, `primeKeepAlive`). Native: use a background URLSession.
- Size estimate: AAC 40 kB/s, lossless 120 kB/s of duration. Before saving: if free quota < need → error toast `Not enough room: needs about {need} GB, {free} GB free` (5 s).

#### 5.7.2 The download button (detail page action row)

Library.jsx:1257-1275, 1330-1349; DownloadGlyph Library.jsx:2007-2026; mobile-library.css:110-112; app.css:1816-1821.

Shown on album, playlist (incl. AI playlists) and Liked Songs pages when the list has tracks; not on artists or mixes. On phone it sits in the left group of the action row: [album heart] [download] [⋯] … [shuffle] [play] (DOM order with `order`/`margin-left:auto`, mobile-library.css:110-117).

- Hit area 40x40; glyph drawn at 24x24 (viewBox 24; the SVG says 28 but phone CSS forces 24).
- Colour (`currentColor`): `#a7a7a7` when nothing is held; `#1ed760` once the collection is held (any part, including while downloading).

| State | When | Glyph | Tap |
|---|---|---|---|
| `none` | not held | outline circle r 10.5, stroke 1.5; down arrow `M12 7v8m0 0-3-3m3 3 3-3` stroke 1.5 round | download (with size confirm if > 1 GB) |
| `busy` | this collection is downloading | outline circle at 30% opacity + progress arc `#1ed760` stroke 1.5, starting at 12 o'clock clockwise, length = max(3%, done/total) of the circumference; arrow as above | nothing |
| `part` | held, not all songs present, idle | filled circle r 12 in current colour (green) + black arrow with baseline `M12 6v9m0 0-3.5-3.5M12 15l3.5-3.5M7.5 18h9` stroke 1.8 round (`#000`) | download the rest |
| `done` | held, all songs present | same as `part` | remove (confirm) |

- Count label under the button (busy or part): `{have}/{total}`, 11pt, line-height 1, tabular digits, `#a7a7a7`, centred horizontally under the button, 2pt overlap upward, does not affect layout.
- Accessibility label: `Downloading {have} of {total}` / `Downloaded` / `Downloaded {have} of {total}` / `Download for offline`. Tooltip on done: `Remove download`.
- Download tap:
  - If not held and estimate > 1 GB: system confirm `{n} songs, about {gb} GB. Download for offline?` (gb 1 decimal); Cancel aborts.
  - Toasts (4 s): offline → `You’re offline. It downloads when you’re back online.` (queued, starts when online); held → `Downloading the rest`; else `Downloading {n} songs. Keep Slopify open until it finishes.`
  - Errors → toast with the message (5 s).
- Remove: system confirm `Remove the downloaded songs of "{name}" from this device?` → delete; toast `Download removed`.
- Completion toast (5 s, App.jsx:1336-1338): `{name} is ready offline ({n} songs)` / `{name} is ready offline (1 song)`; with failures `{name}: {done} of {total} songs downloaded, {failed} failed (Update download to retry)`.

#### 5.7.3 Marks elsewhere

- Track rows: `DownloadedMark` before the artist line (5.4.4).
- Library rows: `DownloadedMark` before the subtitle when `have >= total`; offline + partial: `{have} of {total} downloaded • ` text (5.2.8).
- Playback: a downloaded song always plays from the device copy, online or not (offline/local.js).

---

### 5.8 Offline mode

Sources: web/src/offline/net.js:1-61; App.jsx:193-207, 1545; Sidebar.jsx:148-156, 267-276, 461-466; TrackRow.jsx:203-206, 236; Library.jsx:522, 1111-1121, 1353, 1549, 1590; player/usePlayer.js:828-840, 1106-1155; app.css:1824-1828.

Detection: offline when the OS reports no network, or a request fails to connect / is answered by the service worker's cached copy. Going offline is CONFIRMED by a `/healthz` probe (4 s timeout) failing before the app flips. While offline, `/healthz` is probed every 15 s; online when it returns 200 + JSON `{ok:true}` without the offline header (captive portals that answer 200 HTML do not count). Any live API response also ends offline mode. Native: NWPathMonitor + the same health probe and confirmation.

What changes while offline:

| Area | Behaviour |
|---|---|
| Global pill | `Offline · downloaded music only`; fixed, centred horizontally, 8pt above the mini player's top edge (re-measured every 1 s; 16pt from bottom if no player), z 60, bg `#3a3a3a`, text `#fff` 12/600, padding 5x12, capsule, shadow `0 2 8 rgba(0,0,0,.4)`, not tappable |
| Your Library | flat list of only collections with ≥1 downloaded song; Liked Songs only if downloaded; no folders, no drag; `Artists` chip removed; partial collections show `{have} of {total} downloaded • `; empty → `Nothing downloaded` state |
| Track rows | not-downloaded rows at opacity 0.4; menu reduced (5.4.5). Tapping one: playback refuses with player error `Offline: only downloaded songs play`. Tapping a downloaded one plays the list filtered to downloaded songs only, always on this device (remote speakers unreachable) |
| Next / previous | skip over not-downloaded songs |
| Detail ⋯ menus | reduced to offline-safe items (5.6.1) |
| Library long-press menus | NOT reduced (see note 5.2.9) |
| Recommended section on playlists | hidden |
| Search | searches downloaded songs only (title/artist/album, every typed word must match, accents folded, max 50), songs only, no albums/artists/playlists |
| Artist never opened online | full page: title `Not available offline` (20pt `#fff`), text `Open this artist once with a connection, and they show up here offline too.` (`#a7a7a7`, max width 320, line-height 1.4), centred, padding 120 top / 32 sides |
| List that failed to load | `Not available offline. Open it once with a connection, or download it.`; discography: `Not available offline.`; genre: `Not available offline` |
| Saving for offline while offline | remembered, downloads once back online (toast above) |
| Plays | recorded locally, uploaded when online |

---

### 5.9 Downloads page (server album requests)

Sources: web/src/components/Downloads.jsx:1-176; Library.jsx:744; App.jsx:957-960, 1620; app.css:499-500, 1776-1812; mobile-library/home-search `.pill` rules.

Entry: account drawer → `Downloads`. A pushed detail page (back chevron, top bar title `Downloads`, page slides in). It lists albums the user requested (artist page Request buttons, generated playlists' missing songs) and their acquisition state.

Layout (phone):
- Page padding 16 sides, top `56 + safe-top` (under the floating back bar), bottom clears player + tab bar.
- Heading `Downloads` (h1 `.greeting`). No phone style matches `.downloads .greeting`, so it is the default h1: ~32pt bold with default margins. **UNSURE**: pick 24-32/700 to match other page titles.
- Head row: wraps, space-between, gap 12, margin 4 top 8 bottom:
  - Chips `Yours` / `Everyone` (scope `mine` / `all`): phone pill style, height 32, padding 0 16, 14/500, bg `#2a2a2a` text `#fff`, capsule; selected bg `#1ed760` text `#000`. Gap 8.
  - Summary: counts per non-empty state, 14pt `#b3b3b3`, gap 14, wraps: `{n} downloading` (green), `{n} adding to library`, `{n} stuck` (red `#f3727f`), `{n} waiting in line`, `{n} failed` (red), `{n} done`.
- Watcher line (if data has `watcher`): 13pt `#b3b3b3`, margin -4 top 14 bottom: `Soulseek downloader: {status}` where status joins with ` • `: `checking the wanted list now` or `last checked {when}` + `next check {when}`, and `{n} albums wanted, {per} searched per check` / `1 album wanted` / `{n} albums wanted`.
- Error banner (fetch failed): text = error message with any leading `NNN: ` removed; padding 12x16, radius 8, bg `#1f1f1f`, text `#b3b3b3` 14pt, margin 16x24.
- Loading (no cached data yet): `Loading…` in the empty style.
- Empty: block margin 32 top/bottom, `#b3b3b3`; bold line 18pt `#fff` 6 below: mine → `Nothing requested yet` / `Request an album from an artist page, or make a generated playlist: songs it suggests that you do not have yet show up here while they download.`; everyone → `The queue is empty` / `Nobody is downloading anything right now.`
- Sections in this order, each only if non-empty: `Downloading`, `Adding to library`, `Stuck`, `Waiting in line`, `Failed`, `Done`. Section margin 24 top 8 bottom; heading 20/700 `#fff` + count 14/400 `#b3b3b3` baseline-aligned, gap 8. `Done` and `Failed` show at most 30 rows. `Stuck` has a hint 13pt `#b3b3b3`: `No new song for {time} or more. Soulseek keeps looking; if nothing turns up it moves to Failed with the reason. Retry also tries torrents.`

Row (phone): grid 2 columns `48pt | rest`, gap 12, padding 8, radius 6; status block spans the full width on a second line.
- Art 48x48 radius 4 aspect-fill, placeholder `#2a2a2a`.
- Text: title 16/500 `#fff` one line ellipsis; meta `{artist} • {type} • {year}` 14 `#b3b3b3`; optional note 13 `#b3b3b3`. If the album is in the library (`libraryAlbumId`) the text block is tappable → open the album.
- Progress bar (downloading, stuck, adding, done): height 4, radius 2, track `rgba(255,255,255,.14)`, fill `#1ed760` (done: `#b3b3b3`, stuck: `#f3727f`), width = done/total (adding/done 100%; downloading min 3%), animated width 0.6 s `cubic-bezier(.3,0,0,1)`. Gap 6 above the status line.
- Status line: flex space-between, gap 10, 13pt `#b3b3b3`, min-height 28. Text by state:
  - downloading via torrent: `Torrent • {detail}`; else `{done} of {total} songs` (`{done} of 1 song`) + ` • started {when}`.
  - stuck (red): search-outcome text (below) or reason or `No progress for {time}`, then ` • {done} of {total} songs`.
  - queued: search-outcome text: `Searching Soulseek for it now…`; `Searched Soulseek {when}: nobody is sharing it`; `Searched Soulseek {when}: {n} results, none a complete match for this release` (1-result variant); `Found on Soulseek {when}, but nobody sharing it would send it (offline or their queue is full)`; `Found on Soulseek {when}, the download is starting`; plus ` • next try {when}` / ` • checking now`. Not yet searched: `Waiting for the downloader to pick it up` (+ ` • requested {when}`) or `Not searched yet • first search at the next check, {when}` (long variant with `({n} albums wait, {per} are searched per check, so it can take a few)`).
  - failed (red): reason or `Failed` + ` • {ago}`.
  - adding: `Downloaded • adding to your library…`.
  - done: `{n} songs added` / `1 song added` + ` • {ago}`; if not found in library (red) `Downloaded, but not found in your library`.
- Buttons at the right of the status line: done + in library → `Play` (plays the album); failed or stuck → `Retry` (`Retrying…` disabled while running) → `{title} is back in line` toast, or `Could not retry: {error}`. Style: transparent, 1pt `#a9a9a9` border, capsule, padding 5x14, 13/700 `#fff`; disabled opacity .5.
- Time words: `just now` (< 60 s), `{n} min ago`, `{n} h ago`, `1 day ago`, `{n} days ago`; durations `{n} min` / `{n} h`; future `any moment now` (≤ 5 s), `in {n} s` (< 90 s), `in {time}`.
- Data: `jf.downloads(scope)` polled every 5 s while the app is visible (a slow answer is not stacked), last answer cached per scope and shown instantly. Changing scope discards in-flight answers for the old scope.

---

### 5.10 Likes store (heart state everywhere)

Source: web/src/api/likes.js:1-41; App.jsx:1013-1028. One in-memory map `trackId → likedAt ms`, loaded from the relay (`GET /likes`), updated by the user's own toggles and by server `like` broadcasts from any device. Every heart and the `Add/Remove Liked Songs` menu label read only this store (never the item's `UserData.IsFavorite`, which can be stale). Liked Songs order = newest `likedAt` first; `likedCount` = map size. Native: a single observable store keyed by track id.

---

### 5.11 i18n keys used in this section (English text is the key)

Library: `Your Library`, `Find in Your Library`, `Create playlist`, `Clear filter`, `Playlists`, `Albums`, `Artists`, `Recents`, `Grid view`, `List view`, `Cancel`, `Liked Songs`, `Playlist`, `Album`, `Artist`, `Folder`, `Pinned`, `{n} songs`, `{n} items`, `{have} of {total} downloaded`, `Nothing downloaded`, `Download a playlist or album while you have a connection and it shows here.`, `Create your first playlist`, `It's easy, we'll help you.`, `Couldn’t find “{query}”`, `Try a different playlist, album or artist name.`, `No artists yet`, `Follow an artist and they show up here.`, `Save your first album`, `Add an album to Your Library and it shows up here.`, `Could not save Your Library: {error}`, plus the menu and create keys in 5.2.9 / 5.2.10.

Track rows and menus: `More options`, `Downloaded`, `Now playing`, `Lyrics`, `Play from this line`, `Open album`, `Add to queue`, `Add to playlist`, `New playlist`, `Remove from this playlist`, `Add to Liked Songs`, `Remove from Liked Songs`, `Save to Liked Songs`, `Exclude from your taste profile`, `Include in your taste profile`, `Go to song radio`, `Go to artist`, `Go to album`, `Sync Lyrics`, `Syncing Lyrics…`, `Share`, `Download`, `Original (highest quality)`, `WAV (16-bit)`, `Link copied`, `Could not copy the link`, `Remove from queue`, `Go to radio`, `Follow`, `Unfollow`, `Save to Your Library`, `Remove from Your Library`, `Download for offline`, `Remove download`, `Remove download ({done}/{total})`, `Update download ({have}/{total})`, `Download as zip`, `Regenerate`, `Edit details`, `Delete`, `Delete "{name}"?`, `My Playlist`.

Toasts: `Added to {name}`, `Created {name}`, `Deleted {name}`, `Could not add: {error}`, `Could not create playlist: {error}`, `Could not delete: {error}`, `Added to Liked Songs`, `Removed from Liked Songs`, `Not saved: {error}`, `Added to Your Library`, `Removed from Your Library`, `Excluded from your taste profile`, `Included in your taste profile`, `Downloading...`, `Converting to WAV...`, `Download failed: {error}`.

Offline: `Offline · downloaded music only`, `Offline: only downloaded songs play`, `Not available offline`, `Open this artist once with a connection, and they show up here offline too.`, `Not available offline. Open it once with a connection, or download it.`, `{n} songs, about {gb} GB. Download for offline?`, `You’re offline. It downloads when you’re back online.`, `Downloading the rest`, `Downloading {n} songs. Keep Slopify open until it finishes.`, `Remove the downloaded songs of "{name}" from this device?`, `Download removed`, `Downloading {have} of {total}`, `Downloaded {have} of {total}`, `{name} is ready offline ({n} songs)`, `{name} is ready offline (1 song)`, `{name}: {done} of {total} songs downloaded, {failed} failed (Update download to retry)`, `Not enough room: needs about {need} GB, {free} GB free`.

Downloads page: all strings quoted in 5.9 (sections `Downloading`, `Adding to library`, `Stuck`, `Waiting in line`, `Failed`, `Done`; chips `Yours`, `Everyone`; `Play`, `Retry`, `Retrying…`, `Loading…`, etc.).

### 5.12 Icon index

| Icon | Where defined |
|---|---|
| Library header/sort/folder line icons (`home, search, library, plus, sort, grid, list, folder, folderOpen`), 24 viewBox stroke 1.9 (1.7 in header) | Sidebar.jsx:11-32 (`ICONS`, `Icon`) |
| Pin (green thumbtack) | Sidebar.jsx:40-44 (`Pin`); also `I.pin` TrackRow.jsx:161 |
| Menu glyphs 16x16 filled (`I` / `MI`) | TrackRow.jsx:140-162 |
| Dots (⋯) 16x16 | TrackRow.jsx:131-135 (`Dots`) |
| Heart outline/filled | TrackRow.jsx:118-129 (`Heart`) |
| Liked Songs tile | TrackRow.jsx:104-112 (`LikedCover`) + gradient app.css:469-473 |
| Now-playing bars | TrackRow.jsx:113-116 + app.css:827-832 |
| Play / Pause / Shuffle glyphs | TrackRow.jsx:59-76 |
| DownloadedMark 12x12 | TrackRow.jsx:177-179 |
| DownloadGlyph (4 states) | Library.jsx:2007-2026 |
| Submenu chevron (hidden on phone) | ContextMenu.jsx:4-8 |
| Menu check | ContextMenu.jsx:98 |
| Bottom-tab Library glyph (outline / filled) | App.jsx:178-180 (`TabLib`) |

---

## 6. Home, Search and detail pages

Scope: the phone layout (viewport 393x852, CSS `@media (max-width: 760px)`, JS `usePhone()` = `matchMedia('(max-width: 760px)')`, `web/src/components/TrackRow.jsx:12-35`). Every value below is what wins in the cascade on the phone. Stylesheets load in this order (`web/src/main.jsx:9-12`): `app.css`, then `mobile-nowplaying.css`, then `mobile-home-search.css`, then `mobile-library.css`. When two files set the same property, the later file wins unless the earlier rule is more specific. I resolved those conflicts by hand, and the source of each final value is cited.

Paths below are relative to `web/src/`. `t('X')` means i18n key `X` (the English text is the key; translations live in `locales/*.json`).

### 6.0 Shared tokens, primitives and conventions

#### 6.0.1 Colour tokens (dark theme default, `styles/app.css:5-46`)

| Token | Value | Used for |
|---|---|---|
| `--bg-base` | `#121212` | page/panel background, stuck bars |
| `--page` | `#121212` (`--page-rgb` 18,18,18) | page ground, gradient ends |
| `--card` | `#181818` | |
| `--card-hover` | `#282828` | image placeholder background |
| `--chip` | `#2a2a2a` | pills, shortcut tiles, art placeholders, skeletons |
| `--field` | `#1f1f1f` | modal inputs |
| `--sheet` | `#282828` | bottom sheets |
| `--bg-elevated-hi` | `#2a2a2a` | modal background |
| `--fg` | `#fff` (`--fg-rgb` 255,255,255) | primary text |
| `--fg-dim` | `#b3b3b3` | card subtitles outside Home |
| `--fg-sub` | `#a7a7a7` | secondary text on phone, icon buttons |
| `--fg-faint` | `#727272` | |
| `--accent` / `--accent-ink` / `--green` | `#1ed760` | play buttons, active pill, active row title |
| `--accent-hover` | `#3be477` | |
| `--accent-press` | `#1abc54` | |
| `--seek-accent` | `#1db954` | filled heart; colour of any `.iconbtn.on` glyph (`app.css:970`) |
| `--on-accent` / `--on-fg` | `#000` | text on green / white |
| `--tint` | `#ffffff1a` | |
| `--tint-hi` | `#ffffff24` | |
| `--tint-press` | `#ffffff36` | busy Request pill |
| `--danger` | `#f3727f` | destructive rows, error text |
| `--danger-bg` | `#2a1618` | error banner background |
| `--r-art` | 4px | |
| `--ease` | `cubic-bezier(.3, 0, 0, 1)` | |

A light theme exists (`:root[data-light="1"]`). It forces every `.hero` and `.tile` back to the dark tokens (`app.css:51-58`), with `.hero --fg-sub: #d0d0d0` (`app.css:59`) and no wash behind `.actions` (`app.css:63`). The Theme/Settings spec covers it.

Font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`, base 400 16px/1.5 (`app.css:84-90`). In SwiftUI this is the system font (SF Pro).

#### 6.0.2 Content scroller

- Every page is one vertical scroller, `.content`: `overflow-y: auto`, `overscroll-behavior-y: contain` (`app.css:176`, `app.css:1413`).
- Bottom padding clears the mini player and tab bar: `calc(24px + 56px + 8px + 49px + env(safe-area-inset-bottom))`, i.e. **137pt + bottom safe area** (`mobile-nowplaying.css:139`).
- Scrollbars are hidden everywhere (`app.css:1418-1419`).
- Whenever the detail item id, the see-all page or the tab changes, the scroller jumps to the top: `scrollTo({top:0})` (`components/Library.jsx:333-335`).
- `--hero` defaults to `#3d3c3c` on `.content` (`app.css:283`). Detail pages set it inline (see 6.3.1).

#### 6.0.3 Touch feedback (`app.css:1407-1424`)

- No tap highlight, no callouts, no text selection outside inputs (also `mobile-home-search.css:12-13`).
- Pressed state (`:active`):
  - track rows and shortcut tiles: background `rgba(255,255,255,.08)`
  - card art (`.card:active .card-art img`), browse tiles and shortcut art: `filter: brightness(.8)`
  - icon buttons: `opacity .6`
- Hover tints are disabled on touch.

#### 6.0.4 Long-press

There is no `onContextMenu` on Home cards, shortcut tiles, mix tiles, browse tiles or search rows (`SearchRow`), so **a long-press does nothing on them**. On track rows (`TrackRow`) a still press of 450 ms opens the row's context sheet and fires a 10 ms vibration (`App.jsx:1395-1420`; the row menu itself is covered in the track-row/context-menu section).

#### 6.0.5 Pills (chips)

Final phone style (`mobile-home-search.css:76-77` over `app.css:230-235`, `app.css:1278-1279`):

- Height: min 32pt. Horizontal padding 16. Fully round (radius 9999).
- Text: 14pt, weight 500.
- Off: background `#2a2a2a`, text `#fff`.
- On: background `#1ed760`, text `#000`.
- Pills in a row sit 8pt apart (`app.css:229`).
- Exceptions: the Library tab chips are 13pt, and the Generate-playlist idea pills are 13pt (`app.css:1748`).

#### 6.0.6 Section heading (`.shelf-head`)

- Flex row, baseline aligned, space-between.
- h2 is weight 700.
- Sizes and margins depend on the page:

| Where | h2 size / tracking / line-height | Margin |
|---|---|---|
| Home | 24pt / -0.3 / 1.2 | 0 0 12 (`mobile-home-search.css:91-92`) |
| Search page | 18pt / -0.2 | 20 0 12; the first section has 8 on top (`mobile-home-search.css:134-136`) |
| Artist page | 20pt (`mobile-library.css:176`) | 24 0 12; the first section has 8 on top (`mobile-library.css:178`, `206`) |
| Genre/Radar/other detail pages | 24pt / -0.3 (`mobile-library.css:207`) | 24 0 12 (`mobile-library.css:206`); the first section on a browse/radar page has 4 on top (`mobile-home-search.css:39`) |

The "Show all" button is hidden on Home (`mobile-home-search.css:93`). Detail pages (outside Home) never render one.

#### 6.0.7 Card (album/artist tile)

Base rules: `app.css:251-276`, phone rules `app.css:1288-1293`, Home rules `mobile-home-search.css:97-109`.

- Container: vertical stack, padding 0, gap 0, no background.
- Art: square, width = column width.
  - Home and see-all: corner radius 2 (`mobile-home-search.css:98`). Round cards (`.card.round`, artists) are circles.
  - Elsewhere the radius is also 2: `mobile-home-search.css:98` is unscoped, so it wins over `app.css:1289` (radius 1).
  - No shadow on phone.
- Placeholder (no image): `#282828` fill.
- Play button (`.card-play`): hidden on phone (`app.css:1293`, `mobile-home-search.css:109`). **Cards never play on tap. A tap always opens the item.**
- Title:
  - Home and see-all: 14pt / weight 700 / line-height 1.3, margin-top 8, **1 line** with ellipsis, left aligned (`mobile-home-search.css:102`).
  - Other pages: 14pt / weight 700, margin-top 4, line-height 1.4, 2 lines (`app.css:1291`, `275`).
- Subtitle:
  - Home and see-all: 13pt, `#a7a7a7`, line-height 1.3, margin-top 2, up to 2 lines (`mobile-home-search.css:103`).
  - Other pages: 13pt, `#b3b3b3` (`--fg-dim`), 2 lines (`app.css:276`, `1292`).
- Round cards outside Home and see-all centre the title and subtitle (`mobile-library.css:209-210`). On Home and see-all they stay left aligned, because the scoped rule there is more specific.
- Fade-in (Home only, `FadeImg`):
  - Behaviour: `Home.jsx:17-23`.
  - CSS: `img.fade { opacity:0; transition: opacity .15s ease-out }` and `.loaded { opacity:1 }` (`mobile-home-search.css:107-108`).
  - Effect: the art area is empty (shows the page behind) until the image decodes, then fades in over 150 ms with ease-out.
  - Cards outside Home use a plain `<img>` with no fade.
- Unavailable release (`.card.missing`, `app.css:980-985`, `mobile-library.css:205`):
  - Art filter `grayscale(.6) brightness(.55)`; title `#b3b3b3`.
  - A **Request pill** is centred over the art: background `#fff`, text `#000`, 12pt/700, padding 6x12, radius 500, shadow `0 8 16 rgba(0,0,0,.4)`.
  - Busy pill: background `#ffffff36`, text `#fff`.
  - Labels:

| State (server or local) | Label | Busy/disabled |
|---|---|---|
| none | `Request` | no |
| `queued` / `exists` | `Requested` | yes |
| `downloading` | `Downloading…` | yes |
| `failed` | `Retry` | no |
| local POST error | `Failed` | no |

    Source: `Library.jsx:405-418`. While any request is pending, the page re-fetches every 5 s (discography) or 4 s (Everywhere search). It skips the refresh while the app is hidden and stops after 30 min (`Library.jsx:419-450`).

#### 6.0.8 Horizontal shelf (`.shelf`)

- Layout: one row of fixed-width columns, gap 16, horizontal scroll, no snapping, scrollbar hidden.
- Home: columns 150pt. The row bleeds edge to edge (margin 0 -16, padding 0 16, scroll-padding-left 16), with a 1px trailing spacer so the last card keeps a 16pt right inset (`mobile-home-search.css:94-96`).
- Other pages (artist, genre): columns **158pt**, padding 0 0 6, no bleed. The row starts and clips at the 16pt page inset (`app.css:1287`).

#### 6.0.9 Grid (`.pad .grid`)

2 columns, row gap 16, column gap 12 (`mobile-library.css:204`). At 393pt the column width is (393-32-12)/2 = 174.5pt.

#### 6.0.10 Placeholder note and error banner

- `.placeholder-note`: 13pt `#a7a7a7`, padding 16, margin 8 0 (`mobile-library.css:156`, `app.css:511`).
- `.banner.error`: padding 12x16, radius 8, background `#2a1618`, text `#f3727f`, 14pt, margin 16 24 (`app.css:499-500`). It shows the raw error message at the top of the page and clears when the page, tab or see-all changes (`Library.jsx:327`).

#### 6.0.11 Skeletons

- Rows: 8 rows, each min-height 64.
  - Optional 48x48 radius-4 art block (playlists and mixes only).
  - Two lines: 55% width x 12pt and 35% x 10pt, radius 6, fill `#2a2a2a`, gap 8.
  - Animation: opacity 1 → .45 → 1, 1.4 s ease-in-out, infinite.
  - Sources: `app.css:502-510`, `mobile-home-search.css:49`, `Library.jsx:1557-1561`.
- Title (when the item has no name yet): block 60% x 22pt, radius 6, `#2a2a2a`, margin 12 0 8, same shimmer (`mobile-home-search.css:50`).

#### 6.0.12 Icons (all inline SVG; `fill="currentColor"` unless noted)

| Icon | Defined at | viewBox / size |
|---|---|---|
| PlayGlyph | `TrackRow.jsx:59-63` | 16, default 20 |
| PauseGlyph | `TrackRow.jsx:64-68` | 16 |
| ShuffleGlyph | `TrackRow.jsx:71-76` | 16 |
| Heart (outline and filled) | `TrackRow.jsx:119-129` | 16; filled colour `#1db954` |
| LikedCover heart | `TrackRow.jsx:104-112` | 16, `#fff` |
| Dots (more) | `Library.jsx:165-167` | 16 viewBox drawn at 24 |
| CloseGlyph (x) | `Library.jsx:80-82` | 16 |
| Clock | `Library.jsx:161-163` | desktop only |
| Verified badge | `Library.jsx:1179-1181` | 24 viewBox |
| Music note (mixmark, release placeholder) | `Library.jsx:1216`, `1452` | |
| Magnifier (Liked find) | `Library.jsx:1141` | |
| Magnifier (search field) | CSS data-URI, `app.css:1297` | 24 viewBox, black |
| Back chevron | `App.jsx:1551` | 24 viewBox, 20, drawn at 18 |
| DownloadGlyph | `Library.jsx:2009-2026` | 24 |

#### 6.0.13 Liked Songs cover (`LikedCover`)

- Square with a `linear-gradient(135deg, #450af5, #c4efd9)` background and a centred white filled heart sized at `--heart`% of the box (default 45%).
- Sources: `TrackRow.jsx:104-112`, `app.css:469-472`.

#### 6.0.14 Detail-page navigation chrome (phone)

Shown whenever a detail page or see-all page is open (`App.jsx:1540-1556`, `app.css:1224-1233`, `mobile-home-search.css:31-36`, `mobile-library.css:302-305`).

- The app header (avatar row) is removed: `.app.mobile-detail .navbar {display:none}`.
- **Top bar** (`.mobile-topbar`):
  - Fixed to the top of the screen, full width, z 40.
  - Height `56 + safe-area-top`; content row starts below the safe area.
  - 3 columns: 48 | 1fr | 48. Does not take touches except on the back button.
- **Back button**:
  - 32x32 circle, 16pt from the left edge, vertically centred in the 56pt row. Glyph 18x18 `#fff`.
  - On artist pages only (when a `.hero.artist` exists): background `rgba(0,0,0,.5)` with `backdrop-filter: blur(8px)`.
  - On every other page: transparent (bare chevron).
  - Background transition `.15s`.
  - Tap: `goBack()` (history pop; navigation section).
  - Label / aria: `t('Go back')`.
- **Scroll-linked fade** (`App.jsx:1374-1393`). On scroll of `.content`:
  - `span = max(120, heroHeight - 60)`, or 160 when the page has no `.hero`.
  - `topbar = clamp((scrollTop - 40) / span, 0, 1)`.
  - Bar background = `color-mix(in srgb, <page --hero> 55%, #121212)` at opacity `topbar`.
  - Centre title = the item name (see-all: `t('Albums')` / `t('Artists')` / `t('Your top artists')`), 16pt/700 `#fff`, one line with ellipsis, at opacity `clamp(topbar*2 - 1, 0, 1)`. It only starts appearing past half the fade.
  - The value is reset to 0 on page change.
- **Liked Songs page**: the bar's background and title are forced to opacity 0 and only the chevron shows (`mobile-library.css:143`).
- **Push transition**:
  - `.app.mobile-detail .content` plays `page-in`: `transform: translateX(100%) → none`, 200 ms, `cubic-bezier(.2,.7,.2,1)`. Transform only, no opacity (`mobile-home-search.css:46-47`; this keyframe redefines the one at `app.css:1232-1233`, which loses because it loads earlier).
  - It plays when entering detail mode from a root tab.
  - **UNSURE:** the `Library` component is not keyed per page, so React reuses the same `.content` node when going from one detail page to another (album → artist), and the animation probably does not replay on those pushes.
- **Desktop-only loading screen**: the black "three dots" loading pane is never shown on phone. The phone paints the page immediately with skeletons (`Library.jsx:1122-1130`).

#### 6.0.15 Persisted / stale-while-revalidate data

- Home lists, browse tiles and recently opened album/artist/playlist pages are painted from a local copy first (`jf.persisted(...)`, `localStorage`), then refreshed.
- A `slopify:fresh` event (service worker got a newer `/api/home`, `/api/top-songs` or `/api/tracks/top`) triggers a reload of Home (`Home.jsx:152-157`).
- A native client should mirror this: show cached data instantly, refresh in the background, no spinner.

---

### 6.1 Home

Sources: `components/Home.jsx` (whole file), `styles/mobile-home-search.css:58-110`, `styles/app.css:790-824`, `1275-1293`.

#### 6.1.1 What exists, and what does not

- **Release Radar exists.** It is **not** a playlist of tracks. It is a list of **releases** (albums, EPs and singles):
  - dated within the **last 90 days** and not in the future;
  - by the user's "radar artists": up to 60 artists, scored as followed (+100), liked albums (+10 each), liked tracks (+3 each), plays in the last 180 days (+1 each);
  - excluding Various/Unknown Artists;
  - gathered from Lidarr discographies on the server, newest first (`server/src/discover.ts:162-177`, `285-347`).
  - Releases already in the library open and play. The rest link to the artist page, and on the Radar page they carry a Request pill.
- **Daily Mixes exist** (up to 6). Each one is the server's `instantMix` seeded from one of the user's most played artists, kept for the user's local day (`Home.jsx:113-121`, `api/slopify.js:432-439`).
- **"Your Top Songs {year}"** exists: one tile per year that has plays.
- **There is NO Weekly Jams, NO Daily Jams, NO Discover Weekly, NO "On Repeat", NO generated weekly/daily playlists.** The code comment says so explicitly: "Made For You is the Daily Mixes and nothing else: no weekly or daily playlists" (`Home.jsx:117-120`). A grep for `Weekly|Jams|Discover` in the client finds nothing relevant.
- The time-of-day **greeting** (`t('Good morning')` before 12:00, `t('Good afternoon')` before 18:00, `t('Good evening')` otherwise, local time, `Home.jsx:34-39`) is rendered but **hidden on phone** (`.home .greeting {display:none}`, `mobile-home-search.css:79`). **Do not show it.**

#### 6.1.2 Header (phone Home tab)

- **Layout**: the app header collapses to height 0 on the Home tab (`.app.mobile.tab-home grid-template-rows: 0 1fr`, `mobile-home-search.css:64-69`). The `mobile-title` text is hidden.
- **Avatar**: a 32x32 circle floats absolutely at `top: 8 + safe-area-top`, `left: 16`, z 60, above the chip row. No shadow (`mobile-home-search.css:19`, `68`; size `app.css:1203`). Tapping it opens the account drawer (shell section).
- **Background tint**: the `.content` background is `linear-gradient(180deg, #2a2a2a 0, #121212 250px)` over `#121212`, with `background-attachment: local`. It **scrolls with the content**: a soft grey wash over the first 250pt (`mobile-home-search.css:70`).
- **Chip row** (`.contentbar`):
  - `position: sticky; top: 0; z 9`.
  - Padding: `top 8 + safe-area-top, right 16, bottom 8, left 56`. The 56 leaves room for the floating avatar (16 + 32 + 8).
  - Background: transparent at rest. Once the scroller's `scrollTop > 8` it becomes `#121212` (class `stuck`), with `transition: background .2s` (`mobile-home-search.css:71-72`, `Home.jsx:208-216`).
  - The pills scroll horizontally if they overflow (they never do with 3).
- **Chips**: `t('All')`, `t('Music')`, `t('Artists')`, style per 6.0.5. Default `All`.
  - On phone they **filter Home in place** and never navigate (`Home.jsx:195-207`).
  - Tapping a chip sets it on. Tapping the active chip again does nothing (no toggle back to All).
  - `Music` hides the artist shelves ("Jump back in", "Your top artists").
  - `Artists` hides the shortcut grid, "Made For You", "Your Top Songs", "Recently played" and "Release Radar".
- **Body padding**: 16 top, 16 left/right, 24 bottom, plus the global bottom inset from 6.0.2 (`mobile-home-search.css:78`).

#### 6.1.3 Section order and conditions

| # | Section | Condition (phone) | Data source |
|---|---|---|---|
| 1 | Shortcut grid (no title) | filter != Artists | Liked Songs + recent albums + playlists + library albums, max 8 |
| 2 | `t('Made For You')` | filter != Artists. **Always rendered, even with 0 tiles** (an empty shelf under the heading) | `mixSeeds` |
| 3 | `t('Your Top Songs')` | filter != Artists && years > 0 | `GET /api/top-songs?tzo=` |
| 4 | `t('Recently played')` | filter != Artists && recent > 0 | `/api/home` `recentAlbums`, first 16 |
| 5 | `t('Jump back in')` | filter != Music && recentArtists > 0 | derived from top tracks (below) |
| 6 | `t('Release Radar')` | filter != Artists && radar > 0 | `GET /api/radar` (timeout 120 s), first 16 |
| 7 | `t('Your top artists')` | filter != Music && topArtists > 0 | derived from top tracks, first 16 |

Spacing between sections: each section has bottom margin 24 (`.homeshelf {margin: 0 0 24px}`); the shortcut grid also has bottom margin 24.

Data loading (`Home.jsx:122-151`):

- All sources are fetched in parallel on mount and on `fresh` events.
- Every list starts from its persisted copy (`home.recent`, `home.radar`, `home.topArtists`, `home.recentArtists`, `home.topYears`).
- Failures are silent: the section keeps its old data or stays hidden.
- **Top tracks** come from `jf.topTracks({limit:200})` (`/api/home` `topTracks`).
  - `rankTopArtists`: for every track and every artist in `ArtistItems`, add `1 + PlayCount`. Sort descending (`Home.jsx:7-13`).
  - `recentArtists`: for each artist, the max `UserData.LastPlayedDate` over its tracks. Sort newest first, take 16.
- **mixSeeds**: the first 6 of `topArtists`. If `topArtists` is empty, the first 6 of the library `artists` list instead (`Home.jsx:190`).
- **No section shows a loading or empty state.** Sections appear when their data arrives. There are no skeletons on Home.

#### 6.1.4 Shortcut grid

Sources: `Home.jsx:66-83`, `180-187`, `225-235`; `mobile-home-search.css:81-86`; `app.css:798-812`.

- **Layout**: grid of 2 equal columns, gap 8, up to 8 tiles (4 rows). At 393pt each tile is (361-8)/2 = 176.5pt wide.
- **Tile**:
  - Height 56, radius 4, background `#2a2a2a`, overflow clipped, horizontal stack with gap 0.
  - Art: 56x56 on the left edge, corner radius 4 on the left side only (4 0 0 4), aspect-fill. Placeholder `#282828`.
  - Title: 13pt / weight 700 / line-height 1.25, white. Padding: left 10, right 8. Up to **2 lines**, ellipsis. Vertically centred.
  - No play button on phone (`.shortcut .shortcut-play {display:none}`).
- **Title text**: `tileTitle(name)` strips these suffixes from the label only (`Home.jsx:25-32`):
  1. `/\s*[([](?:feat|ft|with|featuring|radio edit|remaster|remastered|deluxe|version|edit|mix|live|bonus)[^)\]]*[)\]]/gi`, removed anywhere;
  2. `/\s+[-–]\s+(?:\d{4}\s+)?(?:remaster|remastered|radio edit|single version|deluxe|live|edit|version|mix).*$/i`, removed at the end.
  3. If nothing is left, the original name is used.
- **Fill order** (`Home.jsx:181-187`):
  1. Liked Songs (always first). Uses LikedCover at 45%; label `t('Liked Songs')`.
  2. Albums from Recently played, in order, until there are 8 tiles.
  3. Library playlists, in list order.
  4. Library albums not already present.
- **Images**: `imageUrl(id, {maxHeight:128})`, faded in per 6.0.7.
- **Tap**: Liked → Liked Songs page; album → album page; playlist → playlist page. **Nothing plays.**
- **Press**: background `rgba(255,255,255,.08)`, art `brightness(.8)`.

#### 6.1.5 Shelves (shared)

- Heading per 6.0.6 (Home).
- **The heading text is tappable** and opens the section's "see all" target when one exists. Only the "Show all" button is hidden. Targets:

| Section | Heading tap |
|---|---|
| Recently played | see-all Albums |
| Jump back in | see-all Artists |
| Release Radar | Radar page |
| Your top artists | see-all Top artists |
| Made For You | nothing |
| Your Top Songs | nothing |

- Rows per 6.0.8 (Home): 150pt columns, gap 16.

#### 6.1.6 Mix tiles: "Made For You" and "Your Top Songs"

Sources: `Home.jsx:41-64`, `237-253`; `app.css:816-824`; `mobile-home-search.css:110`.

- **Card**: as in 6.0.7 with a square **150x150** art. Title = the label, 14/700, 1 line. Subtitle 13pt grey.
- **Art**:
  - Photo aspect-filled with `object-position: top` (the top of the image is kept).
  - Without a photo: `linear-gradient(160deg, color-mix(in srgb, <mix> 55%, #000), <mix>)`.
- **Colour band**:
  - Absolute at the bottom of the art, full width, background = the mix colour (raw hex, not darkened).
  - Text `#fff`, 14pt/700, letter-spacing -0.2. Padding 6 vertical, 10 horizontal. Bottom corners radius 2.
  - Text = the label (the same text as the card title below).
  - Height is set by the text: about 14 x 1.5 line-height + 12 ≈ 33pt. **UNSURE** of the exact line-height (inherits 1.5).
  - The band shows immediately; only the photo fades in.
- **Colours**: `MIX_COLORS = ['#e8115b', '#1e3264', '#8d67ab', '#e13300', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07']`. Index `i % 8`, with i = position in its own shelf. Both shelves start at `#e8115b`.

| Shelf | Label | Subtitle | Image | Tap |
|---|---|---|---|---|
| Made For You (up to 6) | `t('Daily Mix {n}', {n: i+1})` | `t('{name} and more', {name: seedArtist})` | seed artist image, `maxHeight 320` | Daily Mix page (6.3.6) with colour `MIX_COLORS[i]` |
| Your Top Songs (one per year, server order) | `t('Your Top Songs {year}', {year})` | current year: `t('Your most played songs of {year} so far', {year})`; past years: `t('The songs you played most in {year}', {year})` (`Home.jsx:45`) | album art of the year's top track (`y.top.AlbumId`), or no image | Top Songs page (6.3.6) with colour `MIX_COLORS[i]` |

The year objects are `{year, songs, plays, top}` (`api/slopify.js:334-337`).

#### 6.1.7 Recently played

- Album cards, square art, `maxHeight 320`, up to 16.
- Subtitle: `AlbumArtist`, else `t('Album')`.
- Tap → album page (`Home.jsx:255-262`).

#### 6.1.8 Jump back in

- **Round** artist cards (circle art). Subtitle `t('Artist')`. Left aligned on Home.
- Tap → artist page (`Home.jsx:264-271`).

#### 6.1.9 Release Radar shelf

Source: `Home.jsx:273-284`.

- Up to 16 release cards, square art.
- Title = release title. Subtitle = `"{artistName} • {t(rtype) or t('Album')}"`; `rtype` is `Album`, `EP` or `Single`, used as i18n keys.
- In library (`inLibrary` = library album id): art `imageUrl(inLibrary, 320)`; tap → that album page.
- Not in library: art = `r.image` (an external URL); tap → **the artist's page**, where it can be requested. No Request pill on Home.

#### 6.1.10 Your top artists

- Round artist cards, first 16 of the ranking. Subtitle `t('Artist')`.
- Tap → artist page.

---

### 6.2 Search tab

Sources: `components/Library.jsx:66-103`, `200-229`, `270-308`, `515-525`, `1647-1981`; `api/search.js`; `styles/mobile-home-search.css:112-193`; `styles/app.css:1295-1304`, `1426-1430`, `947-953`.

#### 6.2.1 States

The search page is in **focus mode** when either is true (`Library.jsx:1736`):

- the field has been tapped (`searchFocus`, cleared only by Cancel or by leaving the tab, `Library.jsx:204-208`); or
- the query is non-empty.

Blurring the field (keyboard dismiss) does **not** leave focus mode.

| State | What shows |
|---|---|
| Browse (not focused, empty query) | header row "Search" + field + "Start browsing" tiles + "Browse all" genre tiles |
| Focused, empty query | field + Cancel; "Recent searches" list if any (otherwise empty below the field) |
| Typing / results | field + Cancel + type chips (once results exist) + flat result list |
| No results | field + Cancel + chips + centred "Couldn't find" message |

#### 6.2.2 Header row

- **Not focused**: the normal tab header. Height `48 + safe-area-top`, padding 16 left and right, gap 12. It holds the 32pt avatar and the title `t('Search')`, 24pt/700, letter-spacing -0.3 (`app.css:1200-1204`, `1376-1377`; `mobile-home-search.css:16-19`).
- **Focused**: the header row collapses to height 0 and is hidden (`mobile-home-search.css:114-116`). The field moves up to the top of the screen. **Animation:** none is defined for the collapse, so it is instant (**UNSURE** whether the iOS client should animate it).

#### 6.2.3 Search bar block (`.contentbar`)

Sources: `mobile-home-search.css:122-133`, `app.css:1296-1300`, `Library.jsx:1759-1772`.

- **Block**:
  - Sticky at the top of the scroller (top 0, z 9), background `#121212`.
  - Padding: 4 top, 16 left/right, 8 bottom. In focus mode the top padding is `8 + safe-area-top`.
  - Wraps onto rows: row gap 8, column gap 12.
- **Field**:
  - Height 44, radius 4, background `#fff`, text `#000`, 16pt/500, no border.
  - Padding: 0 right 16, left 48.
  - Black magnifier, 24x24, at x = 12, vertically centred.
  - Placeholder `t('What do you want to listen to?')`, colour `#121212` at opacity .85, weight 500.
  - Spellcheck off. No auto-focus on phone.
  - Full width when not focused. When focused it shrinks to share the row with Cancel.
- **Cancel**:
  - Text button `t('Cancel')`, 16pt/400 white, left padding 4, height 44.
  - Shown only in focus mode, with an entry animation from opacity 0 and translateX(8) to the resting state over 200 ms ease-out.
  - Tap: clear the query, leave focus mode, dismiss the keyboard.
- **Type chips** (`.searchtypes`):
  - Rendered inside the sticky block as its own full-width row, only once a result object exists (or in `Everywhere` mode with a query).
  - One line that scrolls horizontally. It bleeds to the screen edges (margin 0 -16, padding 0 16), gap 8. Pill style per 6.0.5.
  - Chips: `t('All')`, `t('Songs')`, `t('Artists')`, `t('Albums')`, `t('Playlists')`, `t('Everywhere')`. Default `All`. The choice is kept across queries for the session.
  - Tap: select the chip and scroll it into view (smooth, nearest).
- **Keyboard**: Arrow/Enter/Escape handling exists for hardware keyboards (`Library.jsx:1675-1685`). It is optional for iOS.

#### 6.2.4 Typing behaviour

Sources: `Library.jsx:515-525`, `api/search.js:25-44`.

- Every keystroke restarts a **60 ms** debounce, then calls `GET` search (`jf.search(q, 10)`). Offline it uses `searchOffline(q)` over downloaded songs instead.
- A newer query aborts the older request, and a reply for an older query is ignored.
- Results are **not cleared while typing**: the previous list stays until the new one arrives. An empty or whitespace-only query clears the results.
- An error shows the error banner. Aborts are ignored.
- The **top result** is picked on the client, in this order:
  1. the first artist whose name starts with the normalised query (NFKC + lowercase);
  2. else the first album that starts with it;
  3. else the first track that starts with it;
  4. else the first artist, then the first album, then the first track.

#### 6.2.5 Browse state (not focused, empty query)

`Start browsing` section (phone only, `Library.jsx:1740-1757`, `1800-1805`). Four fixed tiles, in this order:

| Tile | Colour | Cover | Tap |
|---|---|---|---|
| `t('Made For You')` | `#1e3264` | first persisted top artist (`home.topArtists[0]`), else first library artist | switches to the **Home tab** |
| `t('New Releases')` | `#e13300` | `home.added[0]`, else `albums[0]`. **Note:** Home never writes `home.added`, so in practice this is the first library album | see-all **Albums** page (6.3.10) |
| `t('Charts')` | `#8d67ab` | album of the most played track (`browse.chartsTop`), else `home.recent[0]`, else `albums[1]` | Charts page (6.3.8) |
| `t('Liked Songs')` | `#5038a0` | LikedCover with heart 50% instead of a photo | Liked Songs page |

`Browse all` section (`Library.jsx:1806-1814`, `1730-1734`):

- One genre tile per tile from `GET /api/browse` (cached in `localStorage` key `slopify.browse`, then refreshed; timeout 8 s).
- The server returns at most 24 tiles: genres with at least 10 tracks, largest first, `Other` last. Each tile is `{id:'genre:<name>', name, count, coverId, cover, covers, kind:'genre'}`. The cover is the genre's most played album (`server/src/library.ts:355-372`).
- **The server sends no colour.** The tile colour is `TILE_COLORS[i % 16]`: `['#e13300', '#1e3264', '#8d67ab', '#e8115b', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07', '#477d95', '#503750', '#27856a', '#d84000', '#e1118c', '#a56752', '#4b7d9b', '#e61e32']` (`Library.jsx:270`).
- Tap → genre page (6.3.8).
- If the tiles have not loaded (and nothing is cached), only the heading shows.

Tile grid and tile (`mobile-home-search.css:139-143`, `app.css:947-951`):

- **Grid**: 2 columns, gap 12 both ways. At 393pt each tile is 174.5 x 100.
- **Tile box**: height 100, radius 4, padding 12, background = tile colour, overflow clipped, text `#fff`.
- **Title**: top-left, 15pt/700, line-height 1.2, letter-spacing -0.3, max width 58% of the tile, wraps.
- **Cover**:
  - Size: square, 56% of the tile width (about 97.7pt), aspect-fill, radius 4.
  - Position: right edge offset -18% of the tile width, bottom edge offset -18% of the tile height. It overflows and is clipped.
  - Rotation: 25° clockwise.
  - Shadow: `0 8 24 rgba(0,0,0,.5)`.
  - The image request is `imageUrl(coverId, {maxHeight:200})`.
- **Liked tile cover**: the same box and position (`.tile .tile-liked`, `app.css:474`), drawn as the LikedCover gradient with a 50% heart.
- **Press**: `brightness(.8)`.
- **Section spacing**: the search page body has padding 4 16 24. Section headings are 18pt per 6.0.6.

#### 6.2.6 Recent searches (focused, empty query)

Sources: `Library.jsx:220-223`, `271-279`, `1707-1722`, `1776-1786`; `mobile-home-search.css:145-154`.

- **What is stored**: the things the user opened or played from a search, never the typed text: `{q, kind: 'Artist'|'Album'|'Song'|'Playlist', id, art, name, sub}`.
  - Stored in account prefs `recentSearches`, which sync to every device. Max 10, newest first. Re-adding an item moves it to the top.
  - `art` = `AlbumId` for songs, otherwise the item's id.
- **Section**: heading `t('Recent searches')`, then rows, then the clear pill. Shown only when there is at least one entry.
- **Row** (`SearchRow`):
  - Horizontal stack: min-height 64, vertical padding 8, gap 12.
  - Art: 48x48, radius 4 (circle for artists), background `#2a2a2a`, aspect-fill, `imageUrl(art||id, {maxHeight:96})`.
  - Name: 16pt `#fff`, line-height 1.3, 1 line with ellipsis.
  - Subtitle: 13pt `#a7a7a7`, 1 line. Text = the stored `sub`, else the kind label (`t('Artist')` / `t('Album')` / `t('Song')` / `t('Playlist')`).
  - Remove button: 44x44, right margin -12 (the glyph aligns with the 16pt inset), CloseGlyph 16 in `#a7a7a7`. Tap removes the entry. Label / aria: `t('Remove')`.
- **Row tap** (`openRecent`):
  - Song → its album page (via `art`, or by fetching the track).
  - Artist → artist page. Playlist → playlist page. Album → album page.
  - The entry moves to the top of the list.
- **Clear pill** `t('Clear recent searches')`:
  - Centred, top margin 16. Transparent background, 1px `#727272` border, text `#fff` 14pt/700, padding 0 16, min-height 32, fully round.
  - Tap: empties the list.

#### 6.2.7 Result list (phone, types All/Songs/Artists/Albums/Playlists)

Sources: `Library.jsx:1687-1706`, `1882-1894`; `mobile-home-search.css:170-193`.

- **No headings and no Top-result card.** One flat list.
- **Row order** (`phoneRows`). Filter each list by the chosen type: `All` shows every type, otherwise only the chosen one. Then build, skipping duplicates by `kind:id`:
  1. the top result, if its type is shown;
  2. the first 4 songs;
  3. the first 2 artists;
  4. the first 2 albums;
  5. the first 1 playlist;
  6. all remaining songs, then artists, then albums, then playlists.
- **Song rows** are TrackRows inside `.searchlist`:
  - min-height 64, vertical padding 8, horizontal padding 0, gap 12.
  - Art 48x48 radius 4, background `#2a2a2a` (track image `imageUrl(track.Id, 80)`).
  - Title 16pt white, 1 line, line-height 1.3.
  - Second line 13pt `#a7a7a7`: **"Song • " + artist names**, or just "Song" when there are no artists. The "Song • " prefix is a CSS literal in English (`mobile-home-search.css:180-181`), **not translated**.
  - More button (⋯): 44x44, right margin -12, `#a7a7a7`, opens the row's context sheet.
  - No number, heart or duration.
  - The active (now playing) track's title is `#1ed760`.
- **Lyric matches**: a song row may carry a lyric match (`_snippet`). Under the subtitle it then shows a `t('Lyrics')` tag (10pt/600, line-height 15, background `#ffffff1a`, text `#b3b3b3`, radius 3, padding 0 6) and the matched line. Text 12pt `#b3b3b3` with matched words in `#fff` weight 500; it wraps on phone (`mobile-home-search.css:182`, `app.css:922-925`). Tapping the snippet plays the song from that lyric time.
- **Other rows** (artist, album, playlist) are SearchRows (style as 6.2.6, without the remove button). Image `imageUrl(item.Id, 96)`; circle for artists. Subtitle:

| Kind | Subtitle |
|---|---|
| Artist | `t('Artist')` |
| Album | `t('Album') • {ProductionYear} • {AlbumArtist}` (empty parts dropped) |
| Playlist | `t('Playlist')` |
| Song (when used) | `t('Song') • {artists}` |

  Source: `Library.jsx:1653-1656`.
- **Tap behaviour**:
  - **Song row tap opens the song's album page; it does not play** (`onRowOpen`, `Library.jsx:1671`; TrackRow tap rule `TrackRow.jsx:261`).
  - Exception: if the song is the one currently playing, the tap toggles play/pause.
  - Art tap → album page.
  - Artist / album / playlist row tap → that page.
  - Every open records a recent search.
  - **There is no direct "play" affordance in phone search results.**
  - Long-press a song row → context sheet. Long-press other rows → nothing.
- **No results** (the list has 0 rows; `mobile-home-search.css:156-159`, `Library.jsx:1969-1974`):
  - Centred column, top padding 96, side padding 24, gap 8.
  - Bold 16pt white: `t('Couldn’t find “{query}”', {query})`.
  - Then 13pt grey: `t('Try searching again using a different spelling or keyword.')`.
- **Loading**: there is no spinner; the previous results stay on screen.

#### 6.2.8 "Everywhere" (catalogue beyond the library)

Sources: `Library.jsx:292-308`, `1836-1880`; `mobile-home-search.css:161-168`.

- **Request**: 300 ms debounce, then `GET /api/gsearch?q=` with a 35 s timeout. The server asks Lidarr/Deezer and flags what the library has.
- **States**:
  - Waiting: placeholder note `t('Searching everywhere…')`, centred, vertical padding 24.
  - Failure (including timeout): `t('Couldn’t search everywhere right now.')`.
  - No albums: the "search-empty" block with `t('Couldn’t find “{query}” anywhere', {query})` and `t('Try a different spelling, or the artist and album together.')`.
- **Results**:
  - Heading `t('Everywhere')`, with the hint `t('{have} of {total} in your library')` at 13pt grey beside it. Heading margin 12 0 4.
  - Rows are SearchRows: image = library art if owned, else the external `a.image`; name = title; subtitle `"{t(rtype)} • {year} • {artist}"`.
  - Missing releases: art `grayscale(.4) brightness(.7)`, name `#a7a7a7`.
  - Each row has a trailing action:
    - In library: a play button, which **renders invisible on phone**. `.card-play` keeps `opacity:0; position:absolute` because no phone rule targets it inside `.srow`. **UNSURE/bug:** the native client should probably omit it to match.
    - Missing: a Request pill, inline (not absolutely positioned), 12pt, padding 6x12, left margin 4, labels per 6.0.7.
  - Row tap: in library → album page; missing with no state yet → request it; otherwise nothing.

---

### 6.3 Detail pages

The detail view is chosen by `detail.kind` (`Library.jsx:605-1620`). Kinds covered here: `Album`, `Artist`, `Playlist` (including Liked Songs `Id === '__liked__'`, Daily Mix `_mix`, Top Songs `_mix`), `Radar`, `Browse` (genre or Charts), and the see-all grids. Profile, Settings, History and Downloads are covered elsewhere.

#### 6.3.1 Page colour (`--hero`) — exact algorithm

Sources: `Library.jsx:105-149`, `336-345`, `611-617`; `api/colors.js:1-59`.

1. **Cover sample** (`vibrantColor(url)`, `colors.js:21-59`). The URL is `imageUrl(item.Id, {maxHeight:120})`. It is requested for every detail item except Liked Songs and Profile, cached per URL, and stored per item id (`null` if it fails).
   1. Draw the image into a **40x40** canvas and read the RGBA pixels.
   2. For each pixel, compute HSL. **Skip it if L < .08 or L > .92.**
   3. Bin the pixel by the top 4 bits of each channel: `key = (r>>4)<<8 | (g>>4)<<4 | (b>>4)`. Each bin accumulates count n, the sums of r, g and b, the sum of S and the sum of L.
   4. Score each bin: `n * (.15 + meanS) * (meanL in (.2,.75) ? 1 : .35)`.
   5. The best bin's mean RGB (rounded) is the result. If there is no bin, the result is `null`.
2. **Instant fallback** (`blurhashAverage`, `Library.jsx:111-117`). Take `item.ImageBlurHashes.Primary[item.ImageTags.Primary]`. Base-83 decode characters 2..5, giving an integer v, then `rgb = [v>>16 & 255, v>>8 & 255, v & 255]`. The alphabet is `0-9A-Za-z#$%*+,-.:;=?@[]^_{|}~` (exact order in source). This paints at once; the sampled colour replaces it when ready, with no transition.
3. **Phone tint** (`heroTint(rgb, true)`, `Library.jsx:119-133`):
   1. Convert the RGB to HSL (h, s, l in 0..1).
   2. `s' = min(.65, s > .04 ? max(s, .3) : s)`.
   3. `L' = min(.38, max(.24, l))`.
   4. Round each to an integer: `H = round(h*360)`, `S = round(s'*100)`%, `L = round(L'*100)`%.
   5. `--hero = color-mix(in srgb, hsl(H S% L%) 55%, #121212)`. This is a per-channel blend in gamma-encoded sRGB: `0.55*c + 0.45*18`.
4. **Fixed colours** (mixes, Radar, genre tiles, Liked Songs) go through the same clamp (`phoneHero(hex)`).
5. **Precedence** (`Library.jsx:617`):
   1. `item._color` (mix / top songs) → `phoneHero(_color)`;
   2. else the sampled or blurhash tint, for non-artists;
   3. else Liked Songs → `phoneHero('#5038a0')`;
   4. else an artist with a tint → the tint;
   5. else the default `#3d3c3c` (not clamped).

   Radar uses `phoneHero('#8d67ab')`. Genre and Charts pages use `phoneHero(tile.color || '#3d3c3c')`. **Genre tiles have no `color` field, so every genre page is grey even though its tile was coloured. Charts is purple.**

Pre-computed phone hero colours for the fixed palette (my Python reimplementation of the formula above):

| Input | Clamped HSL | Final `--hero` |
|---|---|---|
| `#e8115b` | hsl(339 65% 38%) | `#601b33` |
| `#1e3264` | hsl(223 54% 25%) | `#18233e` |
| `#8d67ab` | hsl(274 30% 38%) | `#402d4d` |
| `#e13300` | hsl(14 65% 38%) | `#602b1b` |
| `#148a08` | hsl(114 65% 29%) | `#1c4b16` |
| `#0d73ec` | hsl(213 65% 38%) | `#1b3a60` |
| `#7d4b32` | hsl(20 43% 34%) | `#4c3123` |
| `#ba5d07` | hsl(29 65% 38%) | `#603c1b` |
| `#5038a0` (Liked) | hsl(254 48% 38%) | `#302457` |
| `#3d3c3c` (default) | hsl(0 1% 24%) | `#2a2929` |

`paletteColors()` in `colors.js:61-124` is used only by the Visualizer, not by pages.

#### 6.3.2 Hero header (album / playlist / Liked / mix)

Sources: `Library.jsx:1153-1247`; `mobile-library.css:79-107`; `app.css:1315-1321`.

- **Container**:
  - Vertical stack, left aligned, gap 0.
  - Padding: top `56 + safe-area-top` (under the floating top bar), sides 16, bottom 4.
  - Background, top to bottom: `--hero`, overlaid with a gradient from `rgba(18,18,18,0)` at 0% to `rgba(18,18,18,.3)` at 100% (`mobile-library.css:84`).
  - It scrolls with the page. There is **no parallax and no image scaling** on scroll; the only scroll effect is the top-bar fade (6.0.14).
- **Cover**:
  - Centred horizontally, 250x250 (capped at `screenWidth - 64`; at 393 that is 250). Radius 4, shadow `0 8 36 rgba(0,0,0,.55)`, bottom margin 16. Aspect-fill.
  - On screens 380pt or narrower it is 220x220 (`mobile-library.css:307-311`).
  - Album / playlist covers load progressively: `imageUrl(id, 320)` first, then swap to `imageUrl(id, {maxHeight:464, full:true})`.
  - Liked Songs uses LikedCover at **180x180** (6.3.5). Mixes use the composite cover (6.3.6).
- **Kind label** ("Album", "Playlist", ...): hidden on phone (`.hero .kind {display:none}`).
- **Title**:
  - **24pt / weight 700 / letter-spacing -0.3 / line-height 1.2**, margin 0 0 6, `#fff`.
  - Wraps with no line limit; long words break anywhere.
  - `FittedTitle` (`components/FittedTitle.jsx:1-37`, a 96 → 72 → 48 → 32 step-down to fit 2 lines) still runs, but the phone CSS forces `font-size: 24px !important` (`mobile-library.css:93`), so **FittedTitle has no visible effect on phone. Use a fixed 24pt.**
  - While the item has no name yet: the skeleton title bar (6.0.11).
- **Meta block** (`p.hero-meta.phone`): a vertical stack, left aligned, gap 6, 13pt `#a7a7a7`.
  1. **Owner line** (`.hero-owner`): horizontal, gap 6, text `#fff` 13pt/700. Avatar 20x20 circle.
     - Album: lead album artist avatar (`imageUrl(artistId, 48)`, hidden if it fails to load) + artist name as a button → artist page; further album artists follow as ", Name" buttons.
     - Playlist and Liked Songs: the user's avatar. If it fails: a 20pt circle `#535353` with the white initial, 11pt/700. Then `me.Name` (or `t('You')`) as a button → profile.
     - Mix / Top Songs: a 20pt circle filled with the raw mix colour holding a white 12pt music-note glyph, then bold `t('Made for you')`.
  2. **Stats line** (`.hero-stats`), 13pt `#a7a7a7`:

| Page | Text |
|---|---|
| Album | `"{t(releaseType)} • {ProductionYear}"` (e.g. "Album • 2013") |
| Liked Songs | `t('Playlist • 1 song')` / `t('Playlist • {n} songs', {n})` |
| Mix / Top Songs | `"{_sub} • {fmtTotalShort}"` (e.g. "Daft Punk and more • 2h 31min") |
| Playlist | `"{t('Playlist')} • {fmtTotalShort}"`, or `"{t('Playlist')} • {t('{n} songs')}"` when the total duration is 0 |

- **Formats** (`Library.jsx:150-160`):
  - `fmtTotalShort(ticks)`: seconds = round(ticks / 1e7). With hours: `t('{h}h {m}min')`; otherwise `t('{m}min {sec}sec')`.
  - The long form `fmtTotal` (`t('{h} hr {m} min')` / `t('{m} min {sec} sec')`) is desktop only.
- **releaseType** (`Library.jsx:181-191`). n = `ChildCount ?? SongCount ?? track count`; mins = `RunTimeTicks / 6e8`. Checked in order:
  1. AlbumArtist contains "various artists" → `Compilation`;
  2. name ends with "EP" or "- EP" → `EP`;
  3. name ends with "- Single" or "(single)" → `Single`;
  4. 1 ≤ n ≤ 3 and (no duration or under 30 min) → `Single`;
  5. 1 ≤ n ≤ 6 and (no duration or under 30 min) → `EP`;
  6. otherwise `Album`.
- **Editable playlists** (user playlists, not Liked Songs or mixes):
  - The cover is a button. Tap → Edit details dialog (6.3.11). Label `t('Choose photo')`.
  - The "Choose photo" overlay on the cover only shows on hover, so it is never visible on phone.
  - The title is also a button → Edit details. Label `t('Edit details')`.

#### 6.3.3 Colour band and action row

Sources: `Library.jsx:1249-1364`; `mobile-library.css:86-89`, `109-130`; `app.css:291-311`, `361-376`.

- **Band**:
  - Behind the action row, a box starts at the top of the action row and extends **230pt below** it, behind the first rows.
  - Fill: `linear-gradient(180deg, color-mix(in srgb, --hero 70%, #121212) 0%, #121212 100%)`. Artist pages use 80% instead of 70%.
  - The track list and page body above it are transparent, so the colour fades out behind the first rows. Seen with the hero, this reads as one continuous gradient.
- **Action row**:
  - Horizontal, wraps, items vertically centred, gap 4.
  - Padding: 8 top/bottom, 16 sides. Min-height 64.
  - **Left group**, in source order: Heart (albums only), Follow (artists only), Download (when allowed), More (⋯).
  - **Right group**: Shuffle, then Play. Shuffle is pushed right (`margin-left:auto`, order 8); Play has order 9, margin-left 4, margin-right -4.
- **Icon buttons** (`.iconbtn`):
  - 40x40 hit box, glyph 24x24, colour `#a7a7a7`.
  - On (shuffle on, album saved, download held): the glyph is `#1db954`. No dot below.
  - Press: opacity .6.
- **Play** (`.bigplay`):
  - 48x48 circle, fill `#1ed760`, glyph 22x22 black.
  - Shows Pause when this page is the playing context and audio is playing.
  - Press: background `#1abc54`. A hover scale of 1.04 exists in CSS but is irrelevant on touch.
  - Tap:
    - If this page is the current context (`player.contextId === ctxOf(item)`): play/pause toggle.
    - Otherwise: play the page's tracks from index 0 with this context.
    - Nothing happens if there are no tracks.
  - Labels: `t('Play')` / `t('Pause')`.
- **Shuffle**:
  - Toggles the player's global shuffle (`off` ↔ `on`). It does not start playback.
  - Labels: `t('Enable shuffle')` / `t('Disable shuffle')`.
  - Shown on every page kind on phone, including artists.
- **Heart** (albums only): "Save to Your Library". Outline heart when off; filled `#1db954` when on.
  - Tap: `onFollowAlbum(item, !saved)` (marks the album as a Jellyfin favourite).
  - Labels: `t('Save to Your Library')` / `t('Remove from Your Library')`.
- **Follow** (artists only): an outlined pill.
  - Min-height 32, padding 0 16, 13pt/700 white, border 1px `#727272`; when following, the border is white. Fully round.
  - Text: `t('Follow')` / `t('Following')`.
  - Tap: optimistic toggle of the Jellyfin favourite on the artist. Reverts and shows the error banner on failure.
- **Download for offline**. Shown when offline saving is supported, the page is not an artist or mix, and it has tracks. Glyph states (`DownloadGlyph`, drawn at 24pt):

| State | Glyph | Tap |
|---|---|---|
| none | outline circle (r 10.5, stroke 1.5) + down arrow, `#a7a7a7` | download |
| busy | faint circle (opacity .3) + `#1ed760` progress ring clockwise from 12 o'clock (dash = circumference x max(.03, progress)) + arrow | nothing |
| part | filled circle `#1db954` + black arrow and base line | download the rest |
| done | same as part | remove |

  - A count "have/total" sits under the button (11pt `#a7a7a7`, tabular figures, centred, out of the layout flow) while busy or partly held.
  - Download asks for confirmation when the size estimate is over 1 GB: `t('{n} songs, about {gb} GB. Download for offline?')`. Then it shows one toast:
    - offline: `t('You’re offline. It downloads when you’re back online.')`;
    - topping up: `t('Downloading the rest')`;
    - new: `t('Downloading {n} songs. Keep Slopify open until it finishes.')`.
  - Remove asks `t('Remove the downloaded songs of "{name}" from this device?')`, then shows the toast `t('Download removed')`.
  - Accessibility labels: `t('Downloading {have} of {total}')`, `t('Downloaded')`, `t('Downloaded {have} of {total}')`, `t('Download for offline')`.
- **More (⋯)**: opens a bottom sheet (context menu; generic sheet style in `app.css:1443-1458`).
  - Sheet header: 56x56 image (round for artists; LikedCover for Liked Songs), title = item name, subtitle `t('Artist')` / `t('Playlist')` / lead artist name (albums).
  - Items (`Library.jsx:1276-1304`); "Y" means shown:

| Item | Album | Playlist | Liked | Mix | Artist |
|---|---|---|---|---|---|
| `t('Add to queue')` | Y | Y | Y | Y | Y |
| `t('Follow')`/`t('Unfollow')` | | | | | Y |
| `t('Go to radio')` (instant mix, 100, mode radio) | Y | Y | | Y (**UNSURE:** with a `mix:` id this probably fails) | Y |
| `t('Add to playlist')` ▸ `t('New playlist')` + every other playlist (one POST with all ids, toast `t('Added to {name}')`) | Y | Y | Y | Y | Y |
| `t('Go to artist')` | Y | | | | |
| `t('Save to Your Library')`/`t('Remove from Your Library')` | Y | | | | |
| `t('Share')` | Y | | | | Y |
| Download: `t('Download for offline')` or `t('Remove download')` / `t('Remove download ({done}/{total})')`, plus `t('Update download ({have}/{total})')` when partly held | Y | Y | Y | | |
| `t('Download as zip')` | | Y | | | |
| separator | | Y | | | |
| `t('Regenerate')` (only if the playlist has `AiPrompt`) → Generate dialog in regenerate mode | | Y | | | |
| `t('Edit details')` → 6.3.11 | | Y | | | |
| `t('Delete')` (red; confirm `t('Delete "{name}"?')`) | | Y | | | |

  - When offline, only "Add to queue", "Go to artist" and the download items remain (`heroOffline`, `Library.jsx:2002-2005`).
- **"Find in playlist / album" field**: not shown on phone (`.within {display:none}`, `mobile-home-search.css:29`). Only Liked Songs has a find field (6.3.5).

#### 6.3.4 Track list (album / playlist / mixes)

Sources: `Library.jsx:1534-1616`; `mobile-library.css:145-165`; `app.css:1334-1342`.

- **Virtualised list**. Fixed row height **64** (84 when filtered rows carry lyric snippets, which only happens on Liked find). Keys use `PlaylistItemId` when present.
- **No column header** on phone (`.trackhead` hidden).
- **Row**:
  - Horizontal; padding 8 vertical, 16 horizontal; gap 12; min-height 64.
  - Art 48x48 radius 3, **playlists, Liked Songs and mixes only**. Albums show no art and no number.
  - Title 16pt `#fff`, 1 line with ellipsis.
  - Artists 13pt `#a7a7a7` as plain text (not links on phone). A green downloaded mark comes first when the song is kept offline.
  - More (⋯): 40x40 with right margin -12, `#a7a7a7`.
  - Hidden on phone: number, album column, heart, duration.
  - Active track: title `#1ed760`. Unavailable offline: the whole row at opacity .4.
- **Taps**:
  - Row → play the list from that index, with the page as context. On the current track → toggle play/pause.
  - Art → the song's album page.
  - ⋯ or long-press → the track's context sheet.
  - In user playlists the sheet also has `t('Remove from this playlist')`.
  - Drag-to-reorder uses HTML5 drag events, which iOS Safari touch does not fire. **UNSURE:** reordering is probably unavailable on phone in the web app.
- **Highlighted row**: when a song deep link opens its album, that row is scrolled to the centre (smooth).
- **Empty and error notes** (when there are no tracks and loading has finished):

| Case | Text |
|---|---|
| load failed, offline | `t('Not available offline. Open it once with a connection, or download it.')` |
| load failed | `t('Couldn’t load this — try again.')` |
| Liked Songs | `t('Songs you like will appear here. Save songs by tapping the heart icon.')` |
| playlist | `t('This playlist is empty.')` |
| album | `t('This album is empty.')` |
| other | `t('Nothing here yet.')` |

- **Loading**: 8 skeleton rows (6.0.11). Pages open instantly with whatever is cached.
- **Recommended** (user playlists only; not Liked Songs or mixes, not while loading, not while filtering, not offline). Sources: `Library.jsx:367-397`, `1590-1615`; `mobile-library.css:158-165`; `app.css:1117-1126`.
  - Section top margin 24, top padding 16, no rule.
  - Header (padding 0 16 8): h2 `t('Recommended')` 24pt/700 tracking -0.3; p `t('Based on what’s in this playlist')` 13pt grey.
  - While loading: `t('Finding songs…')`.
  - Rows: TrackRow with art and no number. Right padding 0, followed by an **Add** pill: transparent, 1px `#b3b3b3` border, white 13pt/700, min-height 32, padding 0 16, fully round, right margin 16. Text `t('Add')`.
  - Tap Add: the row disappears at once and the song is added to the playlist.
  - Then the text button `t('Refresh')`, 13pt white, weight 700, padding 14 16. Tap → a new seed (generation + 1) and a refetch.
  - Data: `GET /api/playlists/{id}/recommended?limit=10&seed={gen}` (disliked tracks dropped). An empty playlist uses the top 40 played tracks instead.
  - The section is hidden if the result is empty.

#### 6.3.5 Liked Songs page

Sources: `Library.jsx:1137-1151`, `1567-1570`; `mobile-library.css:132-143`; `App.jsx:970+`.

- **Container**: `.content.liked-page`; hero colour `#302457` (6.3.1).
- **Find bar**, pinned at the very top:
  - Sticky at top 0, z 6. Horizontal, gap 8, background `--hero` (`#302457`).
  - Padding: top `10 + safe-area-top`, right 16, bottom 8, left **56** (room for the back chevron).
  - Field: flexible width, height 36, padding 0 10, radius 4, background `rgba(255,255,255,.14)`, gap 8.
    - Magnifier 16pt white.
    - Input 14pt/500 white. Placeholder `t('Find in Liked Songs')` at `rgba(255,255,255,.75)`.
    - A × clear button (20pt white) appears when there is text. Label / aria `t('Clear')`.
  - Sort chip `t('Sort')`: height 36, padding 0 16, 13pt/700 white, background `rgba(255,255,255,.14)`, fully round.
    - Tap → bottom sheet with header (playlist icon, `t('Sort by')`, subtitle = current option).
    - Options `t('Recently added')` (default; newest liked first), `t('Title')`, `t('Artist')`, `t('Album')`, each with a green check on the active one.
    - Sorting is a case-insensitive locale compare on Name / first artist / Album, phone only.
- **Top bar**: on this page its background and title stay at opacity 0; only the back chevron shows.
- **Hero**: top padding 16 (not 56, because the find bar sits above). Cover = LikedCover **180x180**, radius 4, centred. Title `t('Liked Songs')`. Owner line with the user. Stats `Playlist • n songs`.
- **Actions**: Download, ⋯ | Shuffle, Play.
- **Find** (`Library.jsx:527-548`):
  - 80 ms debounce, then a scoped search over the liked rows (all query words must match name / artists / album).
  - Engine hits keep their ranking, then plain substring matches follow.
  - No match: `t('No matches for “{query}” in here.')`.
  - Recommended is not shown while filtering.
- **Data**: the liked ids, newest first. Rows are cached, so a reopen paints instantly (`App.jsx:966-1000`).

#### 6.3.6 Daily Mix / Your Top Songs page (`item._mix`)

Sources: `Library.jsx:230-249`, `1159-1164`, `1216`; `mobile-library.css:102-106`.

- **Opening**: the page opens instantly with `loading` and skeleton rows, then fills in.
  - Daily Mix: `GET /api/tracks/{seedArtistId}/mix?limit=50&tzo=` (dislikes dropped).
  - Top Songs: `GET /api/top-songs/{year}?tzo=`.
  - On failure: `loadFailed` note (6.3.4) plus the error banner.
- **Item**:
  - Daily Mix: `{Id:'mix:<seedId>', Name: t('Daily Mix {n}'), _art: imageUrl(seed, {464, full}), _color: MIX_COLORS[i], _sub: t('{name} and more')}`.
  - Top Songs: `{Id:'top:<year>', Name: t('Your Top Songs {year}'), _art: album of the top track or null, _sub: topSongsSub(year)}`.
- **Page colour**: `phoneHero(_color)` (6.3.1 table).
- **Cover**: the Home tile composite.
  - 208x208, radius 4, clipped, shadow `0 8 24 rgba(0,0,0,.5)`, centred.
  - Photo 208x208, aspect-fill, top aligned.
  - Bottom band in the **raw** mix colour, white 16pt/700, letter-spacing -0.2, padding 10x14, no radius. Text = `item.Name`.
  - **UNSURE:** with `_art` null (a Top Songs year without a top track) the image is broken or empty; the native client should show the band over the mix colour.
- **Meta**: mixmark owner line + `t('Made for you')`; stats `"{_sub} • {duration}"`.
- **Actions**: ⋯ | Shuffle, Play. No download, heart or follow.
- **Rows**: with art; no Recommended section; not editable.

#### 6.3.7 Artist page

Sources: `Library.jsx:1153-1247` (hero), `1385-1532` (body), `346-366`, `472-512`; `App.jsx:867-899` (data); `mobile-library.css:167-210`; `app.css:1322-1326`.

**Data loading** (paint from cache first):

- Tracks: the search index, `GET` scoped `artistIds="<id>"` limit 150. Fallback: Jellyfin tracks, limit 200.
- The artist item (`itemById`).
- `artistAlbums` (own albums, plus `appearsOn`).
- Popular order: `GET /api/artists/{id}/popular` (Deezer top tracks matched to the library). Matched tracks come first in that order; the rest follow.
- Discography: `GET /api/discography/{id}` (30 s timeout).
- Similar artists: `GET /api/similar/{id}`.

**Hero**:

- Height at least 300, no padding, content bottom-aligned.
- **Banner photo**: `bannerUrl(item)`.
  - Source: the backdrop image if present (width 640 on a phone or slow link, 1280 otherwise); else the primary image at 640.
  - Drawn full-bleed: aspect-fill, positioned at **horizontal centre, 25% from the top**.
  - Overlay gradient top to bottom: transparent at 30%, `rgba(0,0,0,.35)` at 70%, `color-mix(--hero 80%, #121212)` at 100%. The photo melts into the action-row band with no seam.
  - Without a banner: a flat `--hero` background, and the round thumbnail is hidden on phone.
- **Text block** (padding 0 16 8):
  1. Verified badge: `#4cb3ff` glyph 18x18, gap 8, then `t('Verified Artist')` 12pt/700 white. Bottom margin 4. **Always shown.**
  2. Name: **48pt / weight 700 / letter-spacing 0 / line-height 1.05**, margin 0 0 4, white, wraps. It is 34pt on screens 380pt or narrower (`mobile-library.css:174`, `310`).
  3. Meta: `t('{n} songs in your library', {n})`, 13pt white, no shadow.
- **Back button**: the dark blurred disc (6.0.14).

**Actions**: Follow pill, ⋯ | Shuffle, Play. Play plays the page's tracks in popular order.

**Body sections, in order**:

1. **`t('Popular')`**:
   - First 5 tracks, or 10 when expanded.
   - Each row: number column (16pt `#a7a7a7`, width 20; it turns `#1ed760` when active, and shows animated now-playing bars when active and playing), 48pt art, title only.
   - Subtitle: `t('1 play')` / `t('{n} plays', {n: localised})` when PlayCount > 0, else the album name.
   - Row tap plays the artist's list from that index.
   - When there are more than 5 tracks, a pill follows: `t('See more')` / `t('Show less')`. Border 1px `#727272`, fully round, 13pt/700 white, min-height 32, padding 0 16, top margin 8.
2. **`t('Popular releases')`** (phone default view):
   - The 5 newest releases (library albums merged with the discography; sorted by year, then date string, descending).
   - Row: horizontal, gap 12, vertical padding 6. Art 76x76 radius 4 (placeholder `#2a2a2a` with a 28pt `#727272` music note). Name 16pt white, 1 line. Subtitle `"{year} • {t(type)}"` 13pt grey, 3pt below.
   - Missing releases: art `grayscale(.4) brightness(.75)`, and a Request pill on the right (inline, 13pt, padding 6x14).
   - Tap an owned release → album page. Missing rows are not tappable; only their pill is.
   - States: loading with no rows → `t('Loading…')`. Failure → `t('Couldn’t load the full discography.')` + a `t('Retry')` link (`t('Not available offline.')` when offline).
   - When any releases exist, an outlined pill follows: `t('See discography')`, top margin 12, bottom margin 4, 13pt/700, border `#727272`, min-height 32, padding 0 16.
3. **`t('Discography')`** (after tapping See discography; it replaces section 2 until the artist changes):
   - Heading hint: `t('{have} of {total} in your library')` or `t('Loading…')`.
   - Filter row: one horizontally scrolling line that bleeds to the screen edges (margin 0 -16 12, padding 0 16), gap 8.
     - Group 1: `t('Everything')` / `t('In your library')` / `t('Not in library')`.
     - Group 2 (only when more than 2 options): `t('All')` plus whichever of `t('Albums')`, `t('Singles')`, `t('EPs')`, `t('Compilations')` exist. A 1px `rgba(255,255,255,.2)` left divider with 12pt padding and 4pt margin separates the groups.
   - Grid of 2 cards (6.0.9). Owned: card with subtitle `"{year} • {type}"`. Missing: dimmed `.card.missing` with a centred Request pill (6.0.7); without an image it shows a music-note placeholder (32% of the box, `#727272` on `#2a2a2a`).
   - The section keeps its tallest height so filtering never shifts the scroll position.
4. **`t('Appears On')`**: shelf of 158pt album cards (other artists' albums). Tap → album.
5. **`t('Fans also like')`**: shelf of round 158pt artist cards, centred text, subtitle `t('Artist')`. Tap → artist page.
6. **`t('About')`**: only when `item.Overview` exists; the text in the placeholder-note style (13pt grey, padding 16).

**Offline, never-opened artist**: a centred column (padding 120 32) with `t('Not available offline')` (20pt white) and `t('Open this artist once with a connection, and they show up here offline too.')` (grey, max width 320, line-height 1.4) (`Library.jsx:1113-1120`, `app.css:1825-1827`).

#### 6.3.8 Genre page and Charts (`kind 'Browse'`)

Sources: `Library.jsx:257-269`, `672-742`; `mobile-home-search.css:37-39`.

- **Opening**: opens instantly with loading.
  - Genre: in parallel, `GET /api/genres/{name}` (hub: `trackCount`, `albumCount`, `topArtists[{id,name}]`, `albums[{id,name,artist,year}]`, `recent[...]`) and genre tracks (the first 30 are kept).
  - Charts (`filter 'plays > 0'`): the top 100 played tracks, first 50 kept. No hub.
- **Page colour**: Charts `#402d4d`. Genre pages `#2a2929` (6.3.1).
- **Hero**:
  - No cover.
  - Padding: top `56 + safe-area-top`, sides 16, bottom 8. No minimum height.
  - Kind label `t('Genre')`, hidden.
  - Title: the genre name or `t('Charts')`, 24pt/700.
  - Meta (13pt `rgba(255,255,255,.7)`):

| Case | Text |
|---|---|
| hub loaded | `t('{songs} songs • {albums} albums')` (localised numbers) |
| tracks, no hub | `t('{n} most played')` |
| loading | `t('Loading…')` |
| failed | `t('Not available offline')` or `t('Couldn’t load this — try again')` |
| nothing | `t('Nothing in this genre yet')` |

- **Actions**: Shuffle and Play, both on the right. Shuffle here has no on-state styling.
  - Play: fetch `GET /api/genres/{name}/mix` (Charts uses its own tracks) and play from 0.
  - Shuffle: set shuffle on, then play the same mix from a random index.
- **Sections**:
  1. `t('Top artists')`: shelf of round cards.
  2. `t('Albums')`: grid of up to 18. Subtitle `"{artist} • {year}"`. For Charts, built from the tracks' albums.
  3. `t('New additions')`: shelf of up to 12.
  4. `t('Popular')`: track rows with art. Tap plays from that row.

#### 6.3.9 Release Radar page (`kind 'Radar'`)

Sources: `Library.jsx:250-256`, `631-670`.

- **Opening**: `GET /api/radar` (timeout 120 s).
- **Page colour**: `#402d4d`.
- **Hero**: like the genre page, no cover.
  - Kind `t('Made for you')`, hidden.
  - Title `t('Release Radar')`.
  - Meta: `t('Checking the last 90 days for the artists you like…')` while loading; then `t('{n} new releases from the artists you like • last 90 days', {n})`.
- **Actions**: none. An empty slim row (min-height 8, no padding).
- **Body**:
  - Empty: `t('Nothing new from your artists in the last 90 days.')`.
  - Otherwise a 2-column grid, newest first.
    - Owned: card subtitled `"{artistName} • {date}"`. Tap → album.
    - Missing: dimmed card with a centred Request pill. Subtitle = artist name (a link to the artist) + `" • {t(rtype)} • {date}"`.
- **Release fields**: `album_id, title, date (YYYY-MM-DD), year, rtype, image, artistId, artistName, inLibrary, localName, requestStatus`.

#### 6.3.10 See-all pages (Albums, Artists, Your top artists)

Sources: `Library.jsx:1622-1645`, `169-179`; `mobile-home-search.css:21-27`, `102-103`.

- **Navigation**: a pushed detail page (top bar title `t('Albums')`, `t('Artists')` or `t('Your top artists')`; back chevron).
- **Chip row**: sticky (top 0, z 9, background `#121212`).
  - Padding: top `56 + safe-area-top` (below the top bar), 16 sides, 8 bottom.
  - Chips `t('All')`, `t('Music')`, `t('Artists')`. `Music` is on for Albums, `Artists` is on for Artists. **None is on for Top artists.**
  - Taps: `All` → Home tab; `Music` → Albums see-all; `Artists` → Artists see-all.
- **Heading**: inline `h2`, 24pt, bold (browser default weight), margin 0 0 16. Text `t('Your top artists')` / `t('Artists')` / `t('Albums')`.
- **Grid**: 2 columns (6.0.9). Card titles use the Home style (14/700, 1 line, left aligned).
  - Albums: library albums in server `/api/albums` order (**UNSURE** of the sort). Subtitle = AlbumArtist.
  - Artists: library artists. Round cards, subtitle `t('Artist')`.
  - Top artists: Home's full ranking (6.1.3), reloaded on `fresh`.
- **Taps**: album → album page; artist → artist page.

#### 6.3.11 Edit details dialog (user playlist)

Sources: `Library.jsx:1366-1383`, `460-470`; `app.css:331-338`, `853-860`.

- **Opened by**: tapping the playlist cover or title, the ⋯ `t('Edit details')` item, or the `conduit:editdetails` event (used by "Edit details" from Your Library).
- **Backdrop**: full screen, `rgba(0,0,0,.6)`, dialog centred. A touch on the backdrop closes it without saving.
- **Dialog**: background `#2a2a2a`, radius 8, padding 24, width `min(524, screenWidth-32)` (361 at 393), gap 16, shadow `0 16 24 rgba(0,0,0,.3)`.
  1. h3 `t('Edit details')`, 20pt.
  2. Body: one column at this width, gap 16.
     - Cover picker: 180x180, radius 4, background `#282828`, shadow `0 0 40 rgba(0,0,0,.55)`, left aligned.
       - Image: `imageUrl(id, {360, full})`, or the chosen file's preview.
       - Tap → photo picker (`image/*`).
       - Its "Choose photo" overlay shows only on hover, so it is invisible on phone.
     - Name input: padding 12x14, radius 4, border 1px `#555`, background `#1f1f1f`, white 15pt, placeholder `t('Add a name')`, auto-focus.
  3. Actions, right aligned: `t('Save')`. White background, black text, 700, radius 500, padding 10x24. Opacity .4 and disabled when the trimmed name is empty.
- **Save**: `onEditPlaylist(item, {name: trimmed, imageFile})`.
- **Delete** (⋯ → `t('Delete')`): a native confirm `t('Delete "{name}"?')`, then `onDeletePlaylist(item)`.

---

### 6.4 Generated playlist (AI) dialog

Sources: `components/GeneratePlaylist.jsx:1-111`; `App.jsx:1747-1766`; `styles/app.css:1743-1773`, `853-860`, `371-376`.

- **Reachable on phone**:
  - Your Library "+" sheet → `t('Generated playlist (AI)')` (the description line is hidden on phone, `Sidebar.jsx:260-263`).
  - A generated playlist's ⋯ → `t('Regenerate')`.
- **Shell**: the same modal as 6.3.11, but width `min(520, screenWidth-32)`.
  - The backdrop closes it only when idle.
  - Title `t('Generated playlist')` or `t('Regenerate playlist')`, 20pt.
- **Availability**: on open, the client calls `jf.aiStatus()`.
  - If it reports not ok: show `status.reason` (unreachable: `t('Could not reach the server.')`; no reason: `t('Generated playlists are not available on this server.')`), with Cancel only.
  - Generate stays disabled until the status has loaded.
- **Note** (14pt `#a7a7a7`, line-height 1.45, top margin -6), hidden while busy:
  - New: `t('Describe what you want. The brain finds 25 songs in your library that sound like it: 20 you have not played yet, 5 you know.')`
  - Regenerate: `t('Change the request or keep it. The songs in this playlist are replaced; a name or cover you gave it stays.')`
- **Textarea**:
  - 3 rows, min-height 84, padding 12x14, radius 4, border 1px `#555` (white when focused), background `#1f1f1f`, white **16pt** on phone, vertically resizable, max 1000 characters.
  - Placeholder `t('e.g. rainy day indie, a bit melancholy')`. Auto-focus, cursor at the end. Pre-filled with the old prompt when regenerating. Disabled while busy.
  - Return submits; Shift+Return inserts a newline.
- **Idea pills** (only while idle with an empty prompt): wrap, gap 8, 13pt, base pill style. Tap fills the prompt. Ideas:
  - `t('Late night drive, R&B and slow rap')`
  - `t('Upbeat songs for the gym')`
  - `t('Like my most played lately, but songs I have not heard much')`
  - `t('Chill Sunday morning, acoustic and soft')`
  - `t('2010s pop throwbacks')`
- **Buttons** (right aligned, gap 8):
  - Secondary `t('Cancel')`, or `t('Hide')` while busy. Outlined: 1px `#7a7a7a`, radius 9999, padding 8x16, 14pt/700 white, min-height 32.
  - Primary `t('Generate')` or `t('Regenerate')`: white with black text, radius 500, padding 10x24, 700. Disabled (opacity .4) when the prompt is empty, busy, or the status is unknown.
- **Progress** (busy; vertical stack, gap 10). The server job is polled with `waitJob`; the UI re-renders every 500 ms for the countdown.
  1. Optional title, 16pt/700.
  2. Optional vibe text, 13pt grey, line-height 1.45.
  3. Bar: height 4, radius 2, track `rgba(255,255,255,.2)`. Fill `#1ed760` at width `max(3, pct)%`, animating `width .6s ease`.
  4. Time-left line, 13pt grey (`timeLeft`). The server's `leftMs` minus the time since that update arrived:
     - under 5 s → `t('Almost done')`;
     - otherwise round up to 5 s, then `t('About {s} s left')`, `t('About {m} min {s} s left')` or `t('About {m} min left')`;
     - when there is no info yet → the step text (starts as `t('Starting')`).
  5. Stage list (gap 8, 14pt). Each stage has a 16pt icon and a label:

| Stage state | Icon | Label style |
|---|---|---|
| done | green check (`#1ed760`) | `#a7a7a7` |
| active | 16pt spinner: 2px ring `rgba(255,255,255,.25)`, top segment `#1ed760`, rotating 360° every 0.8 s linear | white, 600 |
| pending | 6pt dot `#535353` | `#727272` |

     Details follow the label in 400-weight grey: for the "find" stage when done, `t('{n} songs, {fresh} you have not played')`; for the active stage, its detail text.
- **Errors**: `#f3727f` 14pt text. The dialog stays open and can be retried.
- **Hide**: closes the dialog while the job keeps running.
- **Done** (`App.jsx:1749-1766`). The playlist list is refreshed, then:
  - New playlist, dialog still open → it closes and the new playlist page opens.
  - New playlist, after Hide → toast `t('{name} is ready in Your Library.')`, plus "more" text if extra songs are downloading: `t('1 more song is downloading and will be added.')` / `t('{n} more songs are downloading and will be added.')`.
  - Regenerated → the playlist is reopened if it is on screen or the dialog was open, plus toast `t('{name} regenerated')` (with "more" text if any).
  - Failure after Hide → toast `t('Could not generate the playlist: {error}')`.

### 6.5 Spotify import (reachable on phone)

Sources: `components/SpotifyImport.jsx:1-89`; `Library.jsx:820-821`; `app.css:1753-1759`, `976`, `994`.

- **Location**: on phone it lives inside **Settings** under the heading `t('Import from Spotify')`, so it is reachable; the page itself is covered in the Settings section. Element details:
- **Hint**: `.settings-hint`, bottom margin 12. Four sentences:
  1. `t('Brings your Spotify listening history, Liked Songs, saved albums and playlists in, matched to songs in this library.')`
  2. A rich string with a link to `https://www.spotify.com/account/privacy/` and bold parts: `t('Request the data at <a>spotify.com › Account › Privacy</a>: tick <b>Account data</b> (liked songs, playlists, the last year of plays) and, for every play since you joined, <b>Extended streaming history</b>.')`
  3. A rich string with `<code>`: `t('Spotify emails a <code>my_spotify_data.zip</code> for each. Upload one or both, as zips or the JSON files inside.')`
  4. `t('Running it again with a newer export only adds what is new. Liked and playlist songs the library does not have are requested for download and filled in as they arrive.')`
- **Button** (in `.settings-actions`: a row, gap 12, top margin 14): primary `t('Choose files')`, or `t('Importing…')` and disabled while busy.
  - White fill, black text, radius 500, padding 10x24, 700, height 40.
  - Opens a multi-select file picker for `.zip`/`.json`.
  - While busy, a status text sits beside it: `t('Uploading {name}')` / `t('Uploading {name} ({i} of {n})')` with ": NN%", then the server job's step text.
- **Error**: `#f3727f` 14pt, top margin 12.
- **Result**: a list, 14pt grey with bold numbers in white, gap 4, left padding 18. Lines:
  - plays: `t('<b>{added}</b> plays added ({matched} of {total} matched)')`
  - liked: `t('<b>{added}</b> liked songs added ({matched} of {total} matched)')`
  - albums (if any): `t('<b>{added}</b> saved albums added ({matched} of {total} matched)')`
  - playlists: `t('<b>{created}</b> playlists created ({matched} of {songs} songs matched)')`, or the "…{skipped} skipped because a playlist with that name exists" variant
  - songs: `t('{matched} of {total} different songs are in this library')`
  - queued or missing lines (keys at `SpotifyImport.jsx:71-77`)
  - A collapsible `t('Most played songs not in the library ({n})')` list ("Artist – Title · n plays"), max height 280, scrollable.

---

### 6.6 Open questions / risks for the native port

1. **Search song rows open the album instead of playing** (6.2.7). On phone there is no direct play affordance in results. The code does this on purpose; confirm before "fixing".
2. **Genre pages are grey** (`#2a2929`) because `/api/browse` tiles carry no colour, while the tile itself uses `TILE_COLORS`. Reproduce as is, or pass the tile colour through (a product decision).
3. **"Made For You" always renders**, even with zero mixes (an empty shelf under the heading).
4. **Everywhere in-library rows** have an invisible play button (6.2.8).
5. **Mix page with no art** (Top Songs year without a top track) renders an empty image (6.3.6).
6. **Push animation** probably only runs on the first push from a root tab (6.0.14).
7. **Playlist drag-reorder** is effectively unavailable on iOS touch in the web app.
8. **"Song • " prefix** in search rows is hard-coded English in CSS.
9. **Hero colour is a two-step paint**: blurhash average first, then the sampled vibrant colour. There is no transition between them.

---

## 7. Settings, profile, stats, admin, themes

Scope: every settings-type screen reachable on the phone layout (viewport 393x852, phone = width <= 760 px). All paths are relative to `web/src/` unless they start with `server/`. "pt" = CSS px = iOS points. i18n: the English text passed to `t()` IS the key (see `i18n.js:1-9`); `{name}` placeholders are filled at runtime. Strings quoted below in `'...'` are those keys verbatim.

Conventions used below:
- Colours are given as a token name plus its value under the default "Spotify" theme. The value for every other theme is in the theme table in 7.9.
- `safeTop` / `safeBottom` = `env(safe-area-inset-top/bottom)`.
- Default font everywhere: system font (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`), 16 px, weight 400, line-height 1.5 (`styles/app.css:81-87`). Use SF Pro.
- Touch: no tap highlight and no text selection on UI chrome. Text fields are still selectable (`styles/app.css:1408-1412`).

---

### 7.1 Entry points and navigation

| From | Control | Opens | Source |
|---|---|---|---|
| Phone account drawer (tap the 32 pt avatar at top-left of a root tab) | header row: avatar 56 pt + name 20/700 + `'View profile'` 13 pt `--fg-sub` | Profile (7.4) | `App.jsx:1613-1616`, CSS `styles/app.css:1205-1222` |
| Drawer | row `'Listening history'` (icon: clock-arrow, path `M12 8v4l3 2M21 12a9 9 0 1 1-3-6.7M21 3v5h-5`) | History (7.5) | `App.jsx:1619` |
| Drawer | row `'Downloads'` | out of scope (Downloads page) | `App.jsx:1620` |
| Drawer | row `'Settings'` (gear stroke icon, long path at `App.jsx:1621`) | Settings (7.2) | `App.jsx:1621` |
| Drawer | last row `'Log out'` (icon path `M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9`), pushed to the bottom of the drawer (`margin-top:auto`) | sign out (7.8) | `App.jsx:1636`, `styles/app.css:1214` |
| Profile page `⋯` sheet | `'Settings'` | Settings | `components/Library.jsx:1060` |
| History hero | `'Edit profile'` green text button | **Settings** (not Profile) | `components/History.jsx:358` |
| History "not connected" gate | `'Open settings'` | Settings | `components/History.jsx:388` |

Drawer rows: 16 pt text, padding 14/20, gap 16 between icon and text, no radius. Drawer width `min(82vw, 340pt)`, bg `--page` (#121212), slides in from the left over 0.25 s `cubic-bezier(.2,.7,.2,1)`. Scrim `rgba(0,0,0,.55)` fades in over 0.25 s. A tap on the scrim closes it. A left swipe (dx < -50 and |dx| > 1.5·|dy|) also closes it (`App.jsx:1600-1611`, `styles/app.css:1206-1209`).

How the pages open (`App.jsx:617-620, 938-964`). Each one is a pushed "detail" page:
- Settings: `detail = { item: { Id:'settings', Name: t('Settings') }, kind:'Settings' }`.
- Profile: `detail = { item: { Id:'profile', Name: me.Name || t('You') }, kind:'Profile', loading:true }`, then the data is fetched (7.4.4).
- History: `detail = { item: { Id:'history', Name: t('Listening history') }, kind:'History' }`.

A pushed page slides in from the right. The base rule (`styles/app.css:1232-1233`) is 0.22 s, `translateX(24px)` → 0 with opacity .4 → 1. `styles/mobile-home-search.css:46-47` overrides it to **0.2 s, translateX(100%) → 0, no opacity change**, with easing `cubic-bezier(.2,.7,.2,1)`. The override wins because it loads later, so use: **full-width push, 200 ms, ease-out** (a standard UINavigationController push is fine).

**Top bar on pushed pages** (`App.jsx:1546-1554`, `styles/app.css:1226-1230`, `styles/mobile-home-search.css:31-35`):
- Fixed at the top. Height `56 + safeTop`, padding-top `safeTop`. 3-column grid: 48 / 1fr / 48.
- Back button: 32x32 circle, 16 pt from the left. Glyph is an 18 pt chevron (24 viewBox, path `M15.957 2.793a1 1 0 0 1 0 1.414L8.164 12l7.793 7.793a1 1 0 1 1-1.414 1.414L5.336 12l9.207-9.207a1 1 0 0 1 1.414 0z`), colour `--fg`.
- On Settings, Profile and History the button has no disc: `background: transparent`, because the dark 50% disc only appears on artist pages.
- Title: 16/700 `--fg`, centred, one line with ellipsis.
- Scroll behaviour: `progress = clamp((scrollTop - 40) / span, 0, 1)`. `span = max(120, heroHeight - 60)` if the page has a `.hero`, else 160 (`App.jsx:1381-1389`).
  - The bar background is `color-mix(--hero 55%, --page)` at opacity = progress.
  - The title opacity is `clamp(progress*2 - 1, 0, 1)`.
  - The back disc turns transparent at progress = 1.
- **Settings overrides this**: the bar background is always opaque `--bg-base` and the title (`'Settings'`) is always visible (`styles/mobile-library.css:214-216`).
- On the Scrobbling sub-page the top bar is hidden and the page draws its own bar (7.2.3).
- Light theme: `:root[data-light="1"] .app:not(:has(.hero)) .mobile-topbar::before { background: var(--page) }` (`styles/app.css:61`), so on Settings and History the bar is the paper colour. On Profile (which has a `.hero`) the bar keeps the **dark** tokens (`styles/app.css:51-58`).

---

### 7.2 Settings page (phone)

Source: `components/Library.jsx:748-878` (phone branch, `kind === 'Settings' && phone`). CSS: `styles/mobile-library.css:212-247`.
The generic `kind === 'Settings'` branch at `components/Library.jsx:880-1027` is the **desktop** layout (native `<select>`s, theme preset pills, colour cards). It is not shown on the phone. It is only referenced below where it carries a hint string or behaviour the phone lacks.

#### 7.2.1 Page container and row anatomy

| Element | Spec | Source |
|---|---|---|
| Page (`.content.settings-phone > .pad.settings`) | Scrolls vertically. Padding: top `56 + safeTop` (sits under the fixed top bar), left/right 16, bottom 32. Full width (no max-width). Background `--bg-base` #121212. | `styles/mobile-library.css:218`, `styles/app.css:1196` (`.app` bg) |
| Section heading `h2` | 16 pt / 700, `--fg` #fff, margin 24 top / 4 bottom, no side margin | `styles/mobile-library.css:223` |
| Row `.setrow` | Full-width button. Horizontal stack, items centred vertically, gap 12. **min-height 56**, padding 8 top/bottom, 0 sides. Left-aligned, colour `--fg`. No background, divider, or press state (no `:active` style; **UNSURE** whether to add the iOS default highlight. The web has none). | `styles/mobile-library.css:224` |
| Disabled row | opacity 0.4 | `styles/mobile-library.css:225` |
| Row text block `.setrow-text` | flex 1, vertical stack, gap 2 | `:226` |
| Row title `b` | **16 pt / 400** (not bold), `--fg` | `:227` |
| Row subtitle `small` | 13 pt `--fg-sub` #a7a7a7, single line, ellipsis | `:228` |
| Chevron `.setrow-chev` | 16x16, `--fg-sub`. SVG viewBox 0 0 16 16, path `M6 3.5 10.5 8 6 12.5 5 11.5 8.5 8 5 4.5z`, fill currentColor. Defined inline as `Chev` at `components/Library.jsx:755`. | `styles/mobile-library.css:229` |
| Caption `.settings-caption` | 13 pt `--fg-sub`, line-height 1.45, margin 4 top / 16 bottom | `:239` |

Rows that only toggle (Normalize, Gapless) have **no chevron and no switch control**. The subtitle text shows the current state and a tap flips it.

#### 7.2.2 Row order (top to bottom), with tap behaviour

| # | Section `h2` | Row title (key) | Subtitle (key) | Tap | Source line |
|---|---|---|---|---|---|
| 0 | (none) | Profile row: avatar + `me.Name` | `'View profile'` | Push Profile (7.4) | `Library.jsx:785-792` |
| 1 | `'Playback'` | `'Streaming quality on phones'` | label of the current `phoneQuality` (see 7.2.4) | Open sheet `phoneQuality` | `:794-798` |
| 2 | | `'Streaming quality elsewhere'` | label of the current `quality` | Open sheet `quality` | `:799-802` |
| 3 | | `'Normalize volume'` | `normalize === false` → `'Off'`, else `'On: every song at the same loudness'` | Toggle: `onUpdatePrefs({ normalize: prefs.normalize === false })` (false→true, anything else→false). No chevron. | `:803-805` |
| 4 | | `'Crossfade'` | `t('{value}. Not on iPhone yet', { value: crossfadeLabel(prefs.crossfade) })`, e.g. "Off. Not on iPhone yet" | Open sheet `crossfade` | `:806-809` |
| 5 | | `'Gapless playback'` | `gapless === false` → `'Off. Not on iPhone yet'`, else `'On. Not on iPhone yet'` | Toggle `gapless`. No chevron. | `:810-812` |
| 6 | `'Scrobbling'` | `'Scrobbling'` | token set: user set → `t('On, as {user}')`, no user → `'On, as your account'`; no token → `'Off'` | Push the Scrobbling sub-page (7.2.3) | `:814-818` |
| 7 | `'Import from Spotify'` | (inline block, not a row) | | See 7.6 | `:820-821` |
| 8 | `'Language'` | `'Language'` | native name of the picked language (from `LANGUAGES`), or `'Automatic'` | Open sheet `language` | `:823-827` |
| 9 | `'Appearance'` | `'Theme'` | matching preset name (translated), or `'Custom'` when the 4 colours match no preset | Open sheet `theme` | `:829-833` |
| 10-13 | | Colour rows: `'Accent'`, `'Background'`, `'Surface'`, `'Text'` | hints: `'Play button, likes, the active track'`, `'The page behind everything'`, `'Cards, menus, the queue panel'`, `'Titles and icons'`. The tapped row shows its hex instead (see below). | Opens the system colour picker. Each change saves at once. | `:834-840` |
| 14 | | `'Reset to default'` (no subtitle, no chevron) | | `onUpdatePrefs({ theme: DEFAULT_THEME })`. **Disabled (opacity .4) while the theme already equals the default.** | `:841-843` |
| 15 | | caption `'Saved to your account and applied to every Slopify you have open.'` | | | `:844` |
| 16 | (admin only) | AdminSettings sections: `'Library'`, `'Tasks'`, `'Speakers'`, `'Accounts'` | | See 7.7. Shown only if `me.Policy.IsAdministrator` (server role `admin`). | `:845` |
| 17 | `'Server'` (only inside the React-Native shell, `SHELL_SERVERS`) | `'Server address'` | `baseUrl` without `http(s)://` | Shell posts `{type:'servers'}` to open its server picker. **Native: open your own server/address screen.** | `:847-853`, `Library.jsx:26-27` |
| 18 | `'Help'` | `'Logs'` | `'See what the app logged, report a problem'` | Opens the Logs dialog (7.6.2) | `:855-860` |
| 19 | (no heading) | About block | | See 7.6.3 | `:861` |

There is **no Log out row in Settings**. Log out lives in the account drawer (7.1, 7.8). There is no in-app control to change your own display name or password: the name is set by an admin or at sign-up, and a password is only set after an admin reset (forced-change screen, out of scope).

**Profile row (row 0)** (`styles/mobile-library.css:230-234`):
- Padding 12 top / 16 bottom, instead of the 8/8 of other rows.
- Title `me.Name` is **16/700** (bold here only). Subtitle `'View profile'`.
- Avatar: 56x56 circle with bg `#535353`.
  - Behind the image: the user's first initial uppercased, 22/700 `#fff`, centred.
  - On top: the image `GET /api/users/{userId}/avatar[?v=bust]`, aspect-fill.
  - If the image fails to load it is hidden, so the initial shows through (`Library.jsx:786-789`).
  - The `key={avatarV}` forces a reload after an upload.

**Colour rows (10-13)** (`Library.jsx:834-840`, `styles/mobile-library.css:235-238`):
- Layout: a 32x32 colour swatch circle at the left, then the text block, then the chevron.
- The swatch is filled with the current value and has a 1 pt border `rgba(fg, .25)`.
- Tapping the row sets `hexOpen = key`. From then on that row's subtitle shows the hex (e.g. `#1ed760`) in `--fg` with a monospace font (`ui-monospace, SFMono-Regular, Menlo`), and the system colour picker opens.
- Only one row is "open" at a time. The state resets when you leave the page.
- Every `onChange` from the picker immediately calls `onUpdatePrefs({ theme: { ...theme, [key]: value } })` (lowercase `#rrggbb`).
- Native: use `ColorPicker` / `UIColorPickerViewController` with `supportsAlpha = false`. **Throttle or debounce the network save** (the web PATCHes on every picker change event; **UNSURE** how often iOS WebKit fires it during a drag).

#### 7.2.3 Scrobbling sub-page

Source: `components/Library.jsx:756-781`. CSS: `styles/mobile-library.css:217-222, 239-245`. This is an in-page state (`settingsSub = 'scrobbling'`), not a new navigation entry. The system back gesture and the app back button act on the app history, so **UNSURE** whether the web's swipe-back returns to Settings or goes past it. Native: push it as a real child view.

The global top bar is hidden (`styles/mobile-library.css:217`). The page draws its own bar instead:

| Element | Spec |
|---|---|
| `.settings-nav` | Sticky at top 0, z 5. Height `56 + safeTop`, padding-top `safeTop`, bg `--bg-base`. Grid 48 / 1fr / 48. |
| Back button | 48x48 hit area, glyph 22x22 (same 24-viewBox chevron path as the top bar), `--fg`. Tap sets `settingsSub = null`. aria-label `'Back'`. |
| Title | `'Scrobbling'`, 16/700, centred |
| Content | Padding: top 8, sides 16, bottom 32 (`styles/mobile-library.css:219`) |

Form, top to bottom:
1. Caption: `'Every song you play for at least half its length is sent to ListenBrainz as a listen. Get the token from listenbrainz.org, under Settings.'`
2. Field: label `'ListenBrainz username'`, styled 13/700 `--fg` with 8 below. Input: placeholder `'username'`, autocapitalize none, spellcheck off.
3. Field: label `'ListenBrainz user token'`. Input: **secure** (password) field, placeholder `xxxxxxxx-xxxx-…`, spellcheck off.
   - Both inputs (`.settings-input`): full width, height 48, 16 pt text, bg `--chip` #2a2a2a, radius 4, no border (`styles/mobile-library.css:242`). Field block margin-bottom 16 (`:240-241`). Padding inherits desktop `10px 12px` (`styles/app.css:955`); focus border `--fg-dim`.
4. Save button `.settings-save`:
   - Centred pill: radius 500, min-height 48, padding 0 40, 16/700, bg `--accent` #1ed760, text `--on-accent` #000, margin 8 top / 16 bottom.
   - **Disabled (opacity .3) until the draft differs from the saved values.**
   - Label `'Save'`. It becomes `'Saved'` for 2.5 s after a successful save.
5. Status caption:
   - token set + user: `t('Scrobbling as {user}.')`
   - token set, no user: `'Scrobbling as your account.'`
   - no token: `'Scrobbling is off until a token is saved.'`
6. Only when a token is saved: `'Disconnect'`. A text button, centred, 14/700 `--fg`, padding 12/16. Tap → `onUpdatePrefs({ listenbrainz: { user:'', token:'' } })` and clear the draft.

Submit: `onUpdatePrefs({ listenbrainz: { user: user.trim(), token: token.trim() } })`, then clear the draft and flash `'Saved'`.

The draft lives only in memory (`lbDraft`, `Library.jsx:462-465`). The token is **never written to device storage**: `_persist('prefs')` strips `listenbrainz.token` (`api/slopify.js:87-91`). Native: keep the token in memory or Keychain only. Read it from `GET /api/prefs`.

#### 7.2.4 Option sheets (`settingsMenu`)

Source: `components/Library.jsx:863-875` (ContextMenu with a `header`). Sheet chrome: `components/ContextMenu.jsx`, CSS `styles/app.css:1444-1458`, `styles/mobile-nowplaying.css:113-123`, `styles/mobile-home-search.css:48`.

**Sheet chrome (phone):**
- Bottom sheet, full width, top corners radius 16. Background `--sheet` #282828. Shadow `0 -8px 40px rgba(0,0,0,.6)`.
- Padding 12 top, 8 sides, bottom `24 + safeBottom`. The later rule in `mobile-nowplaying.css:123` overrides the `28 +` from `app.css`.
- `max-height: 80vh` (681 pt on 852), scrolls internally.
- Grabber: 36x4, radius 2, `rgba(fg, .25)`, centred, 6 pt from the top edge.
- Scrim: full screen, `rgba(0,0,0,.6)`, fades in over 0.2 s. A tap on the scrim closes the sheet and the tap does not fall through.
- Entry animation: translateY 40 → 0 with opacity 0 → 1, 0.2 s, `cubic-bezier(.2,.7,.2,1)`.
- These settings sheets close **instantly** (they do not use `slideOut`). The 250 ms slide-down exit only applies to sheets that call `slideOut` (`components/Player.jsx:62-85`). **UNSURE** whether to animate natively; a standard sheet dismiss is fine.
- The sheet also closes on: picking an item, a touchmove or scroll outside it, Escape, window resize (`ContextMenu.jsx:120-142`).

**Sheet header** (`styles/app.css:1452-1458`):
- Horizontal row, gap 12, padding 14 top / 12 sides / 12 bottom, bottom border 1 pt `rgba(fg, .1)`, 6 pt margin below.
- Left: a 56x56 box with a **16x16 glyph** centred in it, colour `--fg`.
- Text: title 16/700 `--fg`, subtitle 13 `--fg-sub`. Each is one line with ellipsis, so the long subtitles below get truncated on a 393 pt screen.

**Item rows:**
- Horizontal, gap 12, padding 14/12, 16 pt `--fg`. Pressed: bg `rgba(fg, .08)`.
- Left icon slot is 16x16. It holds the selection check, or nothing (the slot keeps its width as long as any row has an icon).
- The **check glyph `MI.check`** (`components/TrackRow.jsx:160`): 16 viewBox, path `M15.53 2.47a.75.75 0 0 1 0 1.06L6 13.06 .47 7.53a.75.75 0 0 1 1.06-1.06L6 10.94l8.47-8.47a.75.75 0 0 1 1.06 0z`, **fill hard-coded `#1ed760`**. It does not follow the theme accent.
- Tapping an item closes the sheet, then saves.

| Sheet `kind` | Header icon | Header title | Header subtitle | Items (label → saved value) | Selected = |
|---|---|---|---|---|---|
| `phoneQuality` | `MI.play` | `'Streaming quality on phones'` | `'Applies from the next track on every phone signed in as you.'` | 4 QUALITIES (table below) → `phoneQuality: id` | `prefs.phoneQuality \|\| 'high'` |
| `quality` | `MI.play` | `'Streaming quality elsewhere'` | `'Desktop and tablet. Applies from the next track. Speakers always get the original file.'` | 4 QUALITIES → `quality: id` | `prefs.quality \|\| 'original'` |
| `crossfade` | `MI.play` | `'Crossfade'` | `'Songs that end by themselves fade into the next. Albums played in order stay gapless.'` | `Off`, `1 second`, `2 seconds`, `3 seconds`, `5 seconds`, `8 seconds`, `12 seconds` → `crossfade: 0/1/2/3/5/8/12` (number) | `Number(prefs.crossfade) \|\| 0` |
| `language` | `MI.gear` | `'Language'` | `'Saved to your account. Automatic follows the server, then this device.'` | `'Automatic'` (value `''`), then the 22 LANGUAGES (labels are native names, not translated) → `language: code` | localStorage `slopify.lang.user` (`''` = Automatic) |
| `theme` | `MI.photo` | `'Theme'` | `'Applied to every Slopify you have open, instantly.'` | 6 presets (7.9), label translated. Icon: the check if this is the current preset, else a **16x16 dot filled with that preset's accent** (`.theme-dot`, `styles/mobile-library.css:246`) → `theme: {accent,bg,surface,fg}` | the preset that `themeEquals` the current theme; with a custom theme none is checked |

Header glyphs (`components/TrackRow.jsx:155-159`), all 16 viewBox, `fill=currentColor`:
- `MI.play`: `M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z`
- `MI.photo`: `M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zm1.5 0v6.3l2.6-2.6 3 3 2.1-2.1 3.3 3.3V3.5h-11zM5.5 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z`
- `MI.gear`: two paths (ring + toothed outline), verbatim at `components/TrackRow.jsx:155`.

**QUALITIES** (`api/prefs.js:8-13`):

| id | Label key | Hint key (desktop only) | bitrate |
|---|---|---|---|
| `original` | `'Lossless (original file)'` | `'FLAC / whatever was ripped. Bit-perfect; phones stream it as Apple Lossless.'` | (original) |
| `high` | `'Very high (320 kbps)'` | `'MP3 transcode. Good for a phone on data.'` | 320000 |
| `normal` | `'Normal (160 kbps)'` | (none) | 160000 |
| `low` | `'Low (96 kbps)'` | (none) | 96000 |

**LANGUAGES** (`i18n.js:11-34`), code → label: en English, es Español, fr Français, de Deutsch, it Italiano, pt-BR Português (Brasil), nl Nederlands, pl Polski, ru Русский, uk Українська, tr Türkçe, sv Svenska, da Dansk, nb Norsk bokmål, fi Suomi, cs Čeština, ja 日本語, ko 한국어, zh-CN 简体中文, zh-TW 繁體中文, id Bahasa Indonesia, vi Tiếng Việt.

**crossfadeLabel** (`api/prefs.js:17`): 0 → `'Off'`, 1 → `'1 second'`, n → `t('{n} seconds')`.

#### 7.2.5 Settings table (every setting)

Saving (`App.jsx:603-612`). `onUpdatePrefs(patch)`:
1. If `patch.language` is a string, call `setUserLanguage` (7.2.6).
2. Merge into in-memory prefs, run `applyTheme` and `applyPlayback`, and cache the prefs (minus the LB token) in localStorage `slopify.cache.<userId>.prefs`.
3. Broadcast **only the patch** to the account's other live clients over the relay socket (`relay.sendPrefs(patch)`).
4. `PATCH /api/prefs` with the patch (2 retries). The server shallow-merges it into a per-user JSON blob, max 64 KB (`server/src/social.ts:261-271`).
5. On failure, show the toast `t('Could not save settings: {error}')`.

Load (`App.jsx:565-576`): paint from the cached copy first, then `GET /api/prefs`. Fill defaults with `theme = { ...DEFAULT_THEME, ...p.theme }` and `quality = p.quality || 'original'`.

Incoming patches from other clients (`App.jsx:707-714`): merge, with `theme` re-defaulted, then re-apply. All changes are live; no client reloads except for a language change.

| Setting (label key) | Control (phone) | Options | Default | Storage | Effect |
|---|---|---|---|---|---|
| `'Streaming quality on phones'` | row → sheet | `original` / `high` / `normal` / `low` | `'high'` (320 kbps MP3) | account pref `phoneQuality` | The stream format on any client whose viewport is <= 760 px. Takes effect from the next track. **Native iOS app: always use this one.** (`App.jsx:316, 318-324`) |
| `'Streaming quality elsewhere'` | row → sheet | same | `'original'` | account pref `quality` | Desktop and tablet stream format. Speakers always get the original. |
| (implicit) | none | | phone = true | `jf.losslessHls = isMobile` | Phones fetch `original` as Apple Lossless HLS (`App.jsx:320`) |
| `'Normalize volume'` | toggle row | on / off | on (`normalize !== false`) | account pref `normalize` (bool) | Loudness-normalise to -14 LUFS. An album played in order keeps its own balance. Not applied on speakers or to lossless on iPhone (desktop hint, `Library.jsx:919`). |
| `'Crossfade'` | row → sheet | 0, 1, 2, 3, 5, 8, 12 s | 0 (Off) | account pref `crossfade` (number, clamped 0-12) | Songs that end on their own fade into the next. Albums played in order stay gapless. Web: "Not on iPhone yet" (computers and Android only). **Native may implement it; if so, drop the "Not on iPhone yet" suffix (UNSURE, product call).** |
| `'Gapless playback'` | toggle row | on / off | on (`gapless !== false`) | account pref `gapless` (bool) | Next song starts the moment one ends. Same iPhone caveat. |
| `'Scrobbling'` | row → sub-page form | user (text), token (secret) | `{user:'', token:''}` (off) | account pref `listenbrainz: {user, token}`. Token is never cached on the device. | Plays of at least half the length go to ListenBrainz (done server-side or relay-side, **UNSURE** where). History stats need it (7.5). |
| `'Language'` | row → sheet | `''` (Automatic) + 22 codes | `''` | account pref `language` **and** device localStorage `slopify.lang.user` | UI language. See 7.2.6. |
| `'Theme'` | row → sheet | 6 presets | Spotify | account pref `theme: {accent,bg,surface,fg}` | `applyTheme`, 7.9 |
| `'Accent'` / `'Background'` / `'Surface'` / `'Text'` | colour rows | any `#rrggbb` | `#1ed760` / `#121212` / `#1f1f1f` / `#ffffff` | same `theme` object (whole object written each time) | 7.9 |
| `'Reset to default'` | action row | | | writes `theme: DEFAULT_THEME` | |
| Visualizer (not on the Settings page) | Now Playing viz tab `⋯` sheet | style / colours / smoothing | `{style:'line', gradient:'prism', smoothing:0.6}` | account pref `viz` + localStorage copy `conduit.viz` | 7.10 |
| History range (not on the Settings page) | chips on the History page | today, week, 4w, 6m, year, all | `'4w'` | device localStorage `conduit.histRange2` | 7.5 |

Other account-pref keys exist (`likedAt`, `libraryPinned`, `libraryOrder`, `_libraryLayout`, `recentSearches`, `dislikes`). They belong to other sections and have no Settings UI.

#### 7.2.6 Language specifics

Source: `i18n.js:36-118`, `App.jsx:303-312, 607-608, 1215-1228`.

Resolution order: the person's pick (`slopify.lang.user`), then the server's `LANGUAGE` (from `GET /api/i18n` → `{language}`, cached in `slopify.lang.server`), then the device languages, then `'en'`. `match()` maps variants to the supported codes:
- `zh-Hant`/`TW`/`HK`/`MO` → `zh-TW`, other `zh*` → `zh-CN`
- `no`/`nn`/`nb*` → `nb`
- otherwise match on the base code, e.g. `pt-PT` → `pt-BR`

When the pick is made on **this** device: save it, then `window.location.reload()` after 800 ms, so the new dictionary loads. Native should switch strings live, no reload needed.

When the pick arrives from **another** device (via prefs): stored for the next launch. It is applied right away only when nothing is playing and the app is visible. Otherwise it is retried every 30 s and on `visibilitychange`.

The row subtitle shows the native label of the stored pick, or `'Automatic'`. It does not show the effective language.

Missing translations fall back to English. Dictionaries are `web/src/locales/<code>.json`, keyed by the English string.

---

### 7.3 Settings: loading, empty, and error states

- The page has no loading state. Prefs come from the cache or the defaults immediately.
- Avatar missing: initial letter on #535353.
- Save failure: toast `'Could not save settings: {error}'`. The UI keeps the optimistic value; there is no rollback (`App.jsx:611`).
- Admin blocks: see 7.7 (error line `'Could not reach the server: {error}'`).

---

### 7.4 Profile page (phone)

Source: `components/Library.jsx:1029-1109`. Data: `App.jsx:938-955`. CSS: `styles/mobile-library.css:249-268`, `styles/app.css:877-881, 1316-1325`.

#### 7.4.1 Hero
- Container `.content` sets `--hero: #4a4a4a` (`Library.jsx:1032`).
- Hero layout: vertical stack, items **centred**, gap 12. Padding top `56 + safeTop`, sides 16, bottom 24.
- Background: `linear-gradient(180deg, rgba(--page-rgb, 0) 0%, --bg-base 100%)` over a flat `#4a4a4a`. This is a grey band that fades into the page.
  - Light theme: `.hero` keeps the dark tokens (`styles/app.css:51-58`), so the gradient ends in `#121212` and the hero text is white even on Paper. **UNSURE** whether that dark-to-paper seam is intended; reproduce it as coded.
- Avatar (`label.hero-cover.profile-avatar.editable`): **128x128 circle**, bg `--sheet` #282828, shadow `0 8px 24px rgba(0,0,0,.5)`, 12 pt below.
  - Image: `/api/users/{id}/avatar`.
  - If it fails to load: the image is hidden and the initial is shown, 56/800 `--fg`, centred.
  - **Tapping the avatar opens the photo picker** (it is a file `<input accept="image/*">`). The "Choose photo" overlay text is hidden on the phone.
  - **UNSURE / likely bug:** the phone rule `.hero .hero-cover img { width:250px; height:250px }` (`styles/app.css:1317`) out-specifies `.profile-avatar img { width:100% }`. The web therefore renders a 250 pt image centred and clipped inside the 128 pt circle, which looks zoomed about 2x. Recommend a plain aspect-fill 128 circle.
- Text block, centred:
  - `.kind` "Profile" is hidden on the phone.
  - Name: h1, **24 pt / 800**, letter-spacing -0.3, line-height 1.05, margin 0 0 4, max 2 lines (`FittedTitle`'s 96/72/48/32 ladder is overridden to 24 by `font-size: 24px !important`, `styles/app.css:1319`).
  - Meta: 13 pt `--fg-sub` (`#d0d0d0` inside a hero on a light theme), centred: `'1 public playlist'` or `t('{n} public playlists')`. The count is the length of the user's `playlists` list.

#### 7.4.2 Actions row
- `.actions.profile-actions`: centred row, gap 8, padding 0 16 8, no colour band (`::before` hidden).
- `'Edit'` pill (`btn-secondary`):
  - min-height 32, padding 0 16, 13/700, 1 pt border `#727272`, radius 9999, text `--fg`.
  - It is a file input, so a tap **opens the photo picker directly** (`Library.jsx:1047-1051`).
- `⋯` button (`iconbtn more`): 32x32, `--fg-dim`. Glyph "Dots" is 24x24, viewBox 16, path `M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM16 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z` (`Library.jsx:165-167`). Tap opens a bottom sheet:
  - Header icon: `.sheet-initial`, a 56 circle `#535353` with the initial 22/700 `#fff`. Title: name. Subtitle: `'Profile'`.
  - Items: `'Change photo'` (icon `MI.photo`) triggers the hidden file input; `'Settings'` (icon `MI.gear`) pushes Settings.

Avatar upload (`App.jsx:613-616`, `api/slopify.js:199-202`):
- `POST /api/users/me/avatar`, raw file body, `Content-Type` = the file's MIME type. There is no crop UI.
- Success: bump the cache-bust `?v=<now>` on every avatar URL and toast `'Profile picture updated'`.
- Failure: toast `t('Could not upload: {error}')`.
- The server keeps one 512 px rendition (`api/slopify.js:192-198`).

#### 7.4.3 Body (`.pad`: padding 8 16 24)
Sections appear in this order, and each one only if it has data:

1. **`'Top artists this month'`**
   - Shelf header: h2 24/700, letter-spacing -0.3, margin 16 top (first section) / 12 bottom.
   - Sub-line `'Only visible to you'`: 13 pt `--fg-sub`, margin -8 0 8.
   - Horizontal scroller of **round** artist cards. Column width 120, gap 12. Card title 14 pt (`styles/mobile-library.css:265-267`), centred for round cards. Subtitle `'Artist'`. Image `imageUrl(artistId, maxHeight 320)`. The card-play button is hidden on the phone (`styles/mobile-home-search.css:109`).
   - Tap: open the artist. (Play is reachable only via the hidden button, so not on the phone.)
2. **`'Top tracks this month'`**
   - Same sub-line.
   - A track list (standard phone TrackRow: 64 pt min height, 48 art radius 4, padding 8/16, title 16, subtitle 13 `--fg-sub`; see the track-row section). **Shows the first 5 only.**
   - If there are more than 5, a `'See all'` / `'See less'` pill toggles the full list (max 10): `btn-secondary seeall`, min-height 32, padding 0 16, 13/700, border `#727272`, margin-top 8, left-aligned.
   - Row tap plays that list from the tapped row (shared `rowProps`, context `'profile'`).
3. **`'Public Playlists'`**
   - Horizontal shelf of square cards, 120 wide. Subtitle `t('By {name}')`. Tap opens the playlist.

Loading: while `detail.loading`, the line `'Loading…'` (13 pt `--fg-sub`, padding 16) shows below the sections. The hero and Edit button render immediately.
Error: a red banner (`.banner.error`: bg `--danger-bg` #2a1618, text `--danger` #f3727f, radius 8, padding 12/16, 14 pt).
Empty: with no listening data only the hero, the actions and Public Playlists (if any) remain.

#### 7.4.4 Data
- `topTracks({limit:60})` takes `topTracks` from the home payload (`api/slopify.js:331`).
- Top artists = artists of those tracks, each scored `sum(1 + playCount)`, top 16.
- Tracks shown = the first 10.
- "This month" is the label only; the window is whatever the home payload computes (**UNSURE**, server-side).

---

### 7.5 Listening history / stats (History.jsx), phone

Source: `components/History.jsx` (the whole file). CSS: `styles/app.css:1479-1645` (base, stats.fm look), phone overrides in `styles/mobile-library.css:270-300`, safe-area rule `styles/app.css:1378`.
Top bar title: `'Listening history'`, fading in with scroll (`span = 160`, since there is no `.hero`).

#### 7.5.1 Page tokens
- Page `.content.sf`: bg `--page` (**fixed #121212 on every dark theme**, even Midnight; Paper uses `#f4f1ea`). Text `--fg`, base 14 pt / weight 500.
- Headings are 700 with line-height 1.25: h1 24 (phone), h2 24, h3 20, h4 18. Paragraphs and spans are `--fg-sub`, weight 500; `p` margin 8 0.
- Accent in this page: **`--green`**, which is **#1ed760 on every dark theme** and `--accent-ink` on light. It does not follow a custom accent on dark themes. The range chips are the exception: they use `--accent`.
- Container: padding 0 16, no max-width (`styles/mobile-library.css:283`).

#### 7.5.2 Hero (`.sf-hero`, `History.jsx:341-364`)
- Padding-top `56 + safeTop` (`styles/app.css:1378` wins over `mobile-library.css:271`).
- Background `linear-gradient(180deg, --card 0%, --card calc(100% - 80px), --page 100%)`; `--card` is #191919 with the Spotify theme (7.9).
- Profile block (`.sf-profile`): vertical stack, centred, gap 16, padding 24 0 24.
- Avatar: **128 circle** (inline 192 overridden with `!important`), bg `--chip`, no ring border on the phone.
  - Image `/api/users/{id}/avatar`.
  - If it fails to load: the initial, 56/800 `--fg`.
- Name: h1 24/800, centred.
- Handle: `@` + lowercased name, 16 pt `--fg-sub`, centred.
- Only when `connected`: a row, margin-top 8, horizontally centred items. The items are separated by a 4x4 **square** `--fg-sub` dot with 8 pt margins (`.sf-dot`):
  - `t('{n} streams', {n: total})`
  - optional `t('{n} from Spotify')`
  - `'Edit profile'`: a text button in `--green` 700 that opens **Settings**

#### 7.5.3 Range picker (phone = chips, `History.jsx:369-373`)
- Horizontal scroller with hidden scrollbar. It bleeds to the screen edges: margin 0 -16, padding 0 16. Gap 8.
- Chip: min-height 32, padding 0 16, 13/500, bg `--chip` #2a2a2a, text `--fg`, radius 500.
- Selected chip: bg `--accent`, text `--on-accent`.
- Labels (keys) and descriptions (`History.jsx:15-22`):

| key | chip label | description suffix |
|---|---|---|
| `today` | `'today'` | `'from today'` |
| `week` | `'this week'` | `'from this week'` |
| `4w` (default) | `'4 weeks'` | `'from the past 4 weeks'` |
| `6m` | `'6 months'` | `'from the past 6 months'` |
| `year` | the current year number, e.g. "2026" (not translated) | `'from this year'` |
| `all` | `'lifetime'` | (none: the description uses the bare variant) |

- The selection persists in localStorage `conduit.histRange2`.
- Each range is fetched once and cached in memory for the life of the page.

#### 7.5.4 Stat cards (`History.jsx:377-394`)
- 2-column grid, gap 12.
- Each card is text only, with no background:
  - value: h3 **18 pt** bold, `--fg`, one line, capitalised
  - inline delta badge after the value
  - label: 14 pt `--fg-sub`, max 2 lines
- 7 cards, in order. The label keys are: `'streams'`, `'minutes streamed'`, `'hours streamed'` (= round(minutes/60)), `'days streamed'`, `'different tracks'`, `'different artists'`, `'different albums'`.
- Numbers use the locale's grouping (`toLocaleString(language)`).
- Delta badge (`History.jsx:169-174`, CSS `styles/app.css:1618-1621`):
  - `pct = round((now - before) / before * 100)`, or 100 if `before = 0` and `now > 0`. Hidden if there is no previous value or both are 0.
  - Shows `+N%` in `--green`, `-N%` in `#f87171`, or `0%` in `--fg-sub`.
  - Style: 12/700, bg `--card`, radius 6, padding 1/6, 8 pt left margin, vertically centred.
  - The comparison is against the previous window of the same length (`st.prev`).
- **Loading:** 6 skeleton cards. Each has a 36-tall row holding a pill 50% wide × 28 tall, then a 16-tall pill 70% wide. Pills are `--card` with radius 9999 and pulse 2 s (opacity 1 → .5 → 1, `cubic-bezier(.4,0,.6,1)`).
- **Not connected** (no ListenBrainz):
  - 3 fake cards showing `?`, blurred 4 pt.
  - Over them, centred: `'Connect ListenBrainz under Settings › Scrobbling to see your streaming history'` (`--fg-faint`).
  - Below that, the `'Open settings'` pill: bg `--fg`, text `--on-fg`, radius 500, min-height 32, padding 0 16, 13/700, margin-top 8.
  - **Every section below is hidden** in this state.
- **Error:** `t('Could not load history: {error}')` in `--fg-faint`.

#### 7.5.5 Sections (only when `connected`), in order
Section header (`.sf-section-head`):
- Sticky at top 0, z 30, bg `--page`, padding 28 0 12.
- Title h2 24/700, one line.
- Description `--fg-sub` 14, one line with ellipsis, full width on the phone.
- The toolbar (grid / prev / next buttons) is **hidden on the phone**.
- **UNSURE:** the sticky headers pin at y = 0, under the fixed 56 + safeTop top bar, which turns opaque once scrolled. Natively, pin them below the nav bar.

Descriptions take the form `t('Your top X {range}', {range: t(suffix)})`, or the bare `'Your top X'` for lifetime.

1. **`'Top genres'`**. Desc `'Your top genres {range}'` / `'Your top genres'`.
   - Horizontal scroller of chips, gap 8, padding-bottom 12.
   - Chip: radius 9999, bg `--card`, padding 8/16, weight 500, `--fg`, text **lowercased**. Not tappable.
   - Empty: `'Not enough data to complete this list'` centred, `--fg-faint`, padding 16.
2. **`'Top tracks'`**. Carousel: native horizontal scroll, bleeds to the edges (margin 0 -16, padding 0 16), gap 16, item width 160, row height 276.
   - Card: square cover 160, **no corner radius**, bg `--card` placeholder.
   - Title h4 18/700, 2 lines max, margin-top 8, format `"{i+1}. {name}"`.
   - Meta line, 2 lines max: `t('{n} minutes')` • `'1 stream'`/`t('{n} streams')` • artist name. The artist name is a link if `artistId` is set.
   - Tap the cover or title: open the album (no-op if it is not in the library). Tap the artist: open the artist.
   - Pressed: scale .95 over 0.3 s ease-in-out.
3. **`'Top artists'`**. Item height 262.
   - Card: 160 **circle** image. If there is no `artistId`, the initial is shown, 48 pt `--fg-sub`.
   - Below: centred h4 `"{i}. name"` and the line `minutes • streams`. Tap opens the artist.
4. **`'Top albums'`**. Item height 255.
   - Square 160 cover, h4 2 lines, meta one line. Tap opens the album.
5. **`'Streams and minutes streamed per day'`**. Desc `'Your listening over time {range}'`.
   - Two average cards in a 2-column grid, gap 12, margin-bottom 16. Each card: bg `--card`, radius 12, padding 14/16; value h3 20 `--green`; label 13 `--fg`.
     - `'average streams per day'` = round(streams / days with any stream)
     - `'average minutes per day'` = round(minutes / days with any stream)
   - Then 2 charts stacked (1 column, gap 16): `'Daily'` and `'Cumulative'` (running sums).
   - Chart card: bg `--card`, radius 12, padding 12 12 8. Title h4 18 with 0 4 4 padding.
   - SVG viewBox 640x220, scaled to the card width. Plot padding: left 44, right 12, top 12, bottom 28.
     - Horizontal grid lines at "nice" ticks (`ticksFor`: 0 to max in about 3 steps of 1/2/2.5/5/10 × 10^k), stroke `rgba(fg, .06)`.
     - Y labels right-aligned at x = 36. X labels: about 8 across (every `ceil(n/8)`-th, plus the last); the first is start-aligned, the last end-aligned, at y = 212. Ticks are 11 user units in `--fg-faint`, so they render **tiny** (about 5.8 pt) on a 393 pt screen. **UNSURE:** natively, use real 11 pt labels.
     - Lines: stroke 2, round joins and caps. Streams in `--green`; minutes in `--green` at .45 opacity.
     - Buckets: `perDay` rows. Kept per day if there are 60 days or fewer; by ISO week (Monday start, label = the week's Monday as "MMM d") if 200 or fewer; else by month (label "MMM yy").
     - Scrub: on pointer move, a dashed crosshair (`rgba(fg, .35)`, 3-3 dash) and 4-radius dots for each series. The tooltip box (bg `--page`, 1 pt border `rgba(fg, .08)`, radius 8, padding 6/10, 12 pt, at top 40, centred on x) shows the label bold, `'1 stream'`/`t('{n} streams')`, and `'1 minute streamed'`/`t('{n} minutes streamed')`.
     - The web uses mouse events only, so on touch it shows only on synthetic mouse moves (**UNSURE**). Natively, add a drag-to-scrub gesture.
   - Legend, centred, gap 16, 12 pt: an 8 pt green dot with `'streams'`, and an 8 pt green dot at .45 opacity with `'minutes streamed'`.
6. **`'Listening clocks'`**. Desc `'Your listening habits throughout the day {range}'`.
   - Two clocks stacked vertically, gap 8, each followed by its caption `'streams'` / `'minutes streamed'`.
   - SVG viewBox 320x320, width 100% up to 360, centred.
   - 24 wedges of equal angle (15° each), starting at 12 o'clock and going clockwise. Hour 0 is at the top.
     - Each wedge's radius is `value / max × 150` (centre 160,160). Fill `--green`, stroke `--page` 2 wide.
     - Spokes: 24 lines, stroke `rgba(fg, .12)`, 1 wide, out to r = 150.
   - Hour labels `0`, `6`, `12`, `18` at (160,14), (310,164), (160,314), (10,164), 12 units, `--fg-faint`.
   - Native tooltip per wedge: `"HH:00 - HH:00: N streams"`, or `"Xh Ym"` for the minutes clock.
   - The second clock uses `byHourSeconds` if present, else `byHour`.
7. **`'Recent streams'`**. Desc `'Your recently played tracks'`.
   - **Loading:** 4 skeleton rows: a 48 pt square (radius 8), a text pill 15rem wide, and a right-aligned pill 4rem wide.
   - **Empty:** a "music off" icon (48 pt, `--fg-faint`, path at `History.jsx:51`) with `"Looks like you don't have any recent streams"`.
   - Rows are grouped by calendar day ("MMMM d, yyyy" in the locale). The day label `.sf-day` is sticky at **top 0** on the phone, bg `--page`, padding 8 0.
   - Row:
     - 48x48 cover (no radius)
     - gap 12
     - title h4 one line (18 pt, from `.sf h4`; **UNSURE**, it reads large next to a 48 cover, but it is as coded)
     - second line: `artist • album • "Spotify"` (if `src === 'spotify'`), `--fg-sub`, one line
     - right-aligned relative time, no wrap, 8 pt left margin
     - then a 1 pt divider in `--card`, margin 8 0
     - Tap opens the album.
   - Relative times (`History.jsx:25-39`):
     - < 45 s `'a few seconds ago'`; < 90 s `'a minute ago'`; < 45 min `t('{n} minutes ago')`
     - < 90 min `'an hour ago'`; < 22 h `t('{n} hours ago')`; < 36 h `'a day ago'`; < 26 d `t('{n} days ago')`
     - < 45 d `'a month ago'`; < 324 d `t('{n} months ago')`; < 547 d `'a year ago'`; then `'1 year ago'` / `t('{n} years ago')`
   - The first 8 rows show. If there are more, a `'show all'` link appears (uppercase, 700, `--fg-faint`, margin 12 0).
   - After "show all": infinite scroll. When the end sentinel comes within 2000 pt, fetch the next page with `before = lastTs`.
     - While fetching: a 24 pt spinner (3 pt `--card` ring with a `--green` top arc, 0.8 s linear rotation).
     - When the server returns no more rows: `'No streams to load!'`.

#### 7.5.6 API
`GET /api/history?tzo=<Date.getTimezoneOffset()>&range=<key>`, timeout 60 s (`api/search.js:73`). Response fields used:
- `connected` (bool), `total`, `sources.spotify`
- `streams`, `minutes`, `daysStreamed`, `uniqueTracks`, `uniqueArtists`, `uniqueAlbums`
- `prev{streams, minutes, daysStreamed, uniqueTracks, uniqueArtists, uniqueAlbums}`
- `topGenres[{id, name}]`
- `topTracks[{id, name, albumId, artist, artistId, seconds, count}]`
- `topArtists[{name, artistId, seconds, count}]`
- `topAlbums[{name, albumId, seconds, count}]`
- `perDay[{day:'YYYY-MM-DD', count, minutes}]`
- `byHour[24]`, `byHourSeconds[24]?`
- `error` (on failure)

Recent streams: `GET /api/history?tzo=..&recent=1[&before=<ts>]` → `{ listens: [{ts (unix s), track, artist, album, albumId, id, src}] }`.

---

### 7.6 Inline blocks on the Settings page

#### 7.6.1 Import from Spotify (`components/SpotifyImport.jsx`, CSS `styles/app.css:975-994, 1751-1759`)
Sits under the h2 `'Import from Spotify'`. Block padding-bottom 8.

- Explainer `.settings-hint`: 14 pt `--fg-dim` (#b8b8b8 with Spotify), margin-bottom 12. One paragraph built from 4 keys, with inline rich tags (`<b>` bold, `<code>` monospace, `<a>` link to `https://www.spotify.com/account/privacy/`; links are `--fg` and underlined):
  1. `'Brings your Spotify listening history, Liked Songs, saved albums and playlists in, matched to songs in this library.'`
  2. `'Request the data at <a>spotify.com › Account › Privacy</a>: tick <b>Account data</b> (liked songs, playlists, the last year of plays) and, for every play since you joined, <b>Extended streaming history</b>.'`
  3. `'Spotify emails a <code>my_spotify_data.zip</code> for each. Upload one or both, as zips or the JSON files inside.'`
  4. `'Running it again with a newer export only adds what is new. Liked and playlist songs the library does not have are requested for download and filled in as they arrive.'`
- Button row (`.settings-actions`): horizontal, gap 12, margin-top 14, wraps on the phone. Buttons are 40 tall.
  - `'Choose files'` (`.primary`): bg `--fg` #fff, text `--on-fg` #000, radius 500, padding 10/24, 700. Disabled at opacity .4.
  - It opens a multi-select document picker accepting `.zip`, `.json`, `application/zip`, `application/json`.
  - While running the label is `'Importing…'` (disabled), with a status text beside it (hint style, no margin).
- Flow (`SpotifyImport.jsx:27-46`):
  1. For each file, upload with progress (`jf.uploadSpotifyFile`). Status: `t('Uploading {name} ({i} of {n})')` or `t('Uploading {name}')`, then `": NN%"`.
  2. `POST /api/import/spotify {fileIds}` returns a job.
  3. Poll it with `waitJob`; the status shows `job.step` (server text).
  4. When done, fire `slopify:librarychanged`.
- Error: a red line (`#f3727f`, 14 pt, margin-top 12) with the message, leading `"NNN: "` stripped.
- Result block (`.spimport-result`, 14 pt `--fg-sub`, margin-top 14; `<b>` in `--fg`). A bulleted list with 18 pt left indent and 4 gap:
  - `'<b>{added}</b> plays added ({matched} of {total} matched)'`
  - `'<b>{added}</b> liked songs added ({matched} of {total} matched)'`
  - only if `albums.total > 0`: `'<b>{added}</b> saved albums added ({matched} of {total} matched)'`
  - playlists: `'<b>{created}</b> playlists created ({matched} of {songs} songs matched)'`, or, if any were skipped, `'..., {skipped} skipped because a playlist with that name exists'`
  - `'{matched} of {total} different songs are in this library'`
  - queued downloads (if `queued.songs` or `queued.albums` > 0):
    - with `result.downloads`: `'<b>{songs}</b> missing liked and playlist songs [and <b>{albums}</b> saved albums] are being requested. Each one goes into Liked Songs, its playlist or saved albums as it downloads (see Downloads).'`
    - without: `'{songs} liked and playlist songs [and {albums} saved albums] are not in the library. They are filled in if they are added later.'` (two separate keys each, see `SpotifyImport.jsx:73-79`)
  - A disclosure `'Most played songs not in the library ({n})'`, with `n` shown as e.g. "100+" at 100 or more. Expands to a numbered list (22 indent, max-height 280, scrolls) of `"Artist – Title"` plus `<small> · {n} plays</small>`.

#### 7.6.2 Logs dialog (`components/Logs.jsx`, CSS `styles/app.css:853-868`)
A centred modal, not a sheet.
- Backdrop: fixed full screen, `rgba(0,0,0,.6)`, z 130. Tapping outside the card closes it.
- Card: bg `--bg-elevated-hi` (#313131), radius 8, padding 24, width `min(640, 100vw - 32)` (= 361 pt), max-height `100dvh - 32` (scrolls), vertical stack with gap 12, shadow `0 16px 24px rgba(0,0,0,.3)`.

Contents, top to bottom:
1. Header row (space-between): h3 `'Logs'` (20 pt) and a `'Copy'` button (`btn-secondary`).
   - The button is disabled when there are no lines.
   - Tap copies every line, newline-joined, to the clipboard. The label is `'Copied'` for 2 s.
2. Log view: a monospace block, 12/1.5 `ui-monospace`. Height min 120, max 40vh, scrolls, and starts scrolled to the bottom. bg `--page`, radius 4, padding 10/12, pre-wrap, colour `--fg-dim`.
   - Lines come from `clientLogLines()`, the in-memory client log (`api/clientLog.js`). Native: your own app log ring buffer.
   - Empty: `'Nothing logged on this device yet.'`
3. h3 `'Report a problem'`.
4. Text area: 4 rows, max 4000 characters, placeholder `'What happened, and what were you doing?'`. Padding 12/14, radius 4, 1 pt border `#555`, bg `--field`, 15 pt; focus border `--fg`.
5. Hint: `"Sends what you write, the log above and this device's type to your Slopify server."`
6. Status line: `'Sent. Thanks.'` in `--accent-ink`, or the error text in `#f15e6c`. Typing clears it.
7. Actions (right-aligned, gap 8):
   - `'Close'` (`btn-secondary`)
   - submit `'Send report'` (`.primary`: bg `--fg`, text `--on-fg`, radius 500, padding 10/24, 700; disabled at .4 while the text is empty or sending). The label is `'Sending…'` while sending.

Send: `POST /api/reports` with:
```json
{ "message": "...", "logs": "<last 300 lines>",
  "info": { "device": "...", "installed": true, "online": true, "link": "4g",
            "screen": [393, 852], "window": [393, 852], "desktop": null, "shell": null, "language": "en" } }
```
On error the text is `err.message`, or `'Could not send'`.
`btn-secondary` everywhere: 1 pt border `#7a7a7a`, radius 9999, padding 8/16, 14/700 `--fg`, min-height 32 (`styles/app.css:371-375`).

#### 7.6.3 About (`components/About.jsx`)
Phone variant: no heading, sits directly after the Logs row.
- Paragraph 1, hint style (14 pt `--fg-dim`, margin-top 6), built from:
  - `t('{app} is free software under the <a>GNU AGPL v3</a>.', { app: "Slopify" + (version ? " " + version : "") })`. The `<a>` part links to `https://www.gnu.org/licenses/agpl-3.0.html`.
  - a space, then link `'Source code'` → `info.source`, or `https://github.com/lukasbaxter/slopify` by default
  - `" · "`, then link `'What leaves your server'` → `<source>/blob/main/docs/PRIVACY.md`
- Paragraph 2: `'Not affiliated with Spotify.'`
- Links: `--fg`, underlined, open externally.
- `info` = `GET /api/server` (cached 10 min) → `{ version, source }`.

---

### 7.7 Admin settings (admins only), phone

Source: `components/AdminSettings.jsx:176-363` (with `phone` prop). CSS: `styles/app.css:1647-1732`; `.settings-phone` overrides at `:1715-1732`.
Rendered between Appearance and Server/Help. Four `.settings-section` blocks (margin 28 0). Each `h2` uses the phone heading style, 16/700.

**Shared pieces:**
- **`run(failed, fn, done)`** (`:231-237`): one action at a time, enforced by a `busy` lock. While anything runs, every admin button is disabled. On success, toast `done`; on failure, toast `"<failed>: <error>"`.
- **List rows (`.admin-list li`):** bg `--bg-highlight` #1f1f1f, radius 6, padding 10/12 (phone), 14 pt. Items laid out horizontally, wrapping, gap 12. Secondary spans are `--fg-dim`. Rows are 8 apart.
- **Stats (`.admin-stats`, phone):** a single column, 2 apart, 14 pt. Each stat is a label span (12 pt `--fg-dim`) above a value `b`.

#### 7.7.1 Library (`:246-265`)
Polls `GET /api/admin/status` every 5 s while the app is visible. On error: `t('Could not reach the server: {error}')`.

| Label | Value |
|---|---|
| `'Tracks'` / `'Albums'` / `'Artists'` | numbers |
| `'Lyrics'` | `t('{synced} synced · {plain} plain · {instrumental} instrumental · {missing} missing')` |
| `'Artist pictures'` | `t('{n} of {total}')` |
| `'Last scan'` | while scanning: `t('running ({files} files, {added} new)')`. Otherwise: `ago(finished)` + ` · ` + `t('{files} files, {added} added, {changed} changed, {removed} removed')`, plus ` · error` if any. Never scanned: `'never'`. |
| `'Fetching'` | `'running'`, or `t('idle · {n} lyrics to try')` |

`ago()` returns: `'never'`, `'just now'` (< 60 s), `t('{n} min ago')`, `t('{n} h ago')`, `t('{n} d ago')`.

Buttons:
- `'Scan library now'` (`.primary`, white pill). Label `'Scanning…'` and disabled while scanning. Calls `POST /api/admin/scan`, toast `'Scan started'`, error prefix `'Could not scan'`.
- `'Fetch lyrics & artwork now'` (`btn-secondary`). Label `'Fetching…'`. Calls `POST /api/admin/enrich`, toast `'Fetching lyrics and artwork'`, error prefix `'Could not fetch'`.

Hint: `'Recurring work runs from the Tasks list below; these buttons are the same two chores, started by hand.'`

#### 7.7.2 Tasks (`:267-289`, components `TaskSchedule :137-174`, `TaskMenu :89-135`, `TaskSetting :45-85`)
`GET /api/admin/tasks` every 5 s (`{tasks:[...]}`). A sequence counter drops stale poll answers after a local edit.

Task object fields: `id`, `name`, `description`, `running{step, progress 0..1|null}`, `info`, `last{ok, started, summary, error}`, `schedule{mode, hours?, at?, day?}`, `canWatch`, `settings[]`.

**Phone row** (grid, gap 8 vertical / 10 horizontal):
```
[ico] [name ................] [⋯]
[schedule controls (wrap) .......]
[meta (up to 4 lines) ...........]
[Run now]
```
- **Icon**: 30 circle, bg `rgba(fg, .08)`, glyph 15 pt `--fg-dim`. Stroke icons per id (`:28-37`): `scan` magnifier, `enrich` picture, `heads` bolt, `discovery` compass, `backlog` layers, `flac` waveform-up, `brain` sparkles, `lyricsync` speech bubble. Paths are verbatim in the source. Unknown ids use `scan`.
- **Running state**: icon circle bg `--accent`, glyph `--on-accent`; name and meta in `--accent-ink`.
  - A 2 pt progress bar sits along the row's bottom edge, `--accent`, scaleX(progress) with a 0.6 s ease. The minimum shown is 2%.
  - Unknown progress: a 30%-wide sliver sliding from -30% to 100% over 1.4 s, ease-in-out, looping. With reduce-motion: a full-width bar at .5 opacity.
- **Name** (`b`), wraps.
- **Meta** text:
  - running: `step` + ` · NN%`
  - else `info`
  - else `last`: `'failed · '` if not ok, then `ago(started)`, then ` · summary`, then ` · error`
  - else `'never run'`
- **Schedule**: select `mode` with options `'Every…'` (interval), `'Daily at…'`, `'Weekly…'`, `'On file change'` (only if `canWatch`), `'Off'`.
  - Picking a mode saves at once with defaults: interval `{hours:6}`, daily `{at:'04:00'}`, weekly `{day:0, at:'04:00'}`.
  - Interval adds an hours select: `'15 min'` 0.25, `'30 min'` .5, `'hour'` 1, `'2 h'`, `'3 h'`, `'6 h'`, `'12 h'`, `'24 h'`. An unknown current value is shown as `t('{n} h')`.
  - Weekly adds a day select: `'Sunday'` (0) … `'Saturday'` (6).
  - Daily and weekly add a time field (HH:mm), saved on blur or Enter only.
  - Control style: bg `rgba(fg, .08)`, no border, radius 4, padding 5/6, 12 pt, dark colour scheme.
  - Save: `PUT /api/admin/tasks/{id}/schedule {schedule}`. Optimistic; reconciled with the returned task. On error, toast `t('Could not change the schedule: {error}')` and reload the list.
- **Run now** (`btn-secondary`). Label `'Running…'`, disabled while running or busy. Calls `POST /api/admin/tasks/{id}/run`, toast `t('{name} started')`, error prefix `t('Could not run {name}')`.
- **⋯ menu**: a 28 circle with a 16 pt three-dot glyph (`:110`), `--fg-dim`. Open state: `--fg` on `rgba(fg, .1)`. It opens an inline **popover** (not a sheet):
  - Position: absolute, right-aligned, 6 below. Width `min(360, 100vw - 32)`. bg `--bg-elevated-hi`, radius 4, padding 12, gap 10, shadow.
  - Closes on an outside tap or Escape.
  - Contents: the description (13 pt `--fg-dim`); then each setting; or `'Nothing to adjust for this one.'`.
  - Setting types (`TaskSetting`), each with a label `b` and an optional help `small` (12 pt `--fg-dim`):
    - `toggle`: a switch 34x20, radius 10. Off track `rgba(fg, .25)`, on track `--accent`, knob 14 white, 0.15 s. Saves on change.
    - `text`: full-width input. Saves on blur/Enter if changed (trimmed).
    - `select`: options `{value, label}`. Saves on change.
    - `number` (default type): input 64 wide with min/max and an optional `unit` em text. Saves on blur/Enter.
  - Saving any setting: `PUT /api/admin/tasks/{id}/settings {values:{key:value}}`. Optimistic. Error toast `t('Could not save that setting: {error}')`.
  - **`lyricsync` only**: on open, `GET /api/admin/lyricsync` and show `t('{timed} timed · {verified} verified · {corrected} corrected · {unsure} unsure · {failed} failed · {pending} to check')`.
    - Then `'Undo all changes…'`, which swaps to a confirm line `'Put every timed and corrected song back the way it was?'` with buttons `'Put back'` and `'Keep'`.
    - Put back: `POST /api/admin/lyricsync/undo` → toast `t("Put back {n} songs' lyrics")`. Error: `t('Could not undo: {error}')`.

#### 7.7.3 Speakers (`:291-321`)
Shown when `status.speakers` exists.
- Each row: name `b`, then a span. The span starts with the kind: `Chromecast`, `BluOS`, `AirPlay · {model}`, or `model || kind`. Then ` · host`, then ` · playing` (`'playing'`) if playing.
- AirPlay rows get a `'Pair'` button:
  1. `POST /api/admin/speakers/{id}/pair` with `{}`.
  2. Prompt `t('Enter the PIN shown on {name}')`. If none is entered, error `'No PIN entered'`.
  3. POST again with `{pin}`.
  4. Toast `t('Paired with {name}')`. Error prefix `t('Could not pair with {name}')`.
- If the device advertises `pw=true` (`raop.txt.pw` or `airplay.txt.pw`), it also gets `'Password'`: prompt `t('Password for {name}')`, POST `{password}`, toast `'Saved'`.
- Empty list: `"No speakers found on the server's network yet. They are looked for continuously."`
- Native: replace `window.prompt` with an alert that has a text field.

#### 7.7.4 Accounts (`:323-360`)
`GET /api/users` once → `{users:[{id, name, role, last_seen}]}`.

Each row:
- Name `b`. For yourself: `t('{name} (you)')`.
- Span: `'Admin'` or `'User'`, then ` · ` + `t('last seen {when}')`.
- For other users only, an actions group (right-aligned on desktop, wraps on the phone; buttons 6/12 padding, 13 pt):
  - `'Make user'` / `'Make admin'`: `POST /api/users/{id}/role {role}`, then reload. Toast `t('{name} is a user now')` / `t('{name} is an admin now')`. Error `'Could not change role'`.
  - `'Reset password'`: confirm `t("Reset {name}'s password? They will be signed out everywhere and get a temporary password to sign in with.")`, then `POST /api/users/{id}/password {}` → `{password}`. An inline block appears under the row:
    - a read-only monospace field about 20 characters wide holding the password
    - `'Copy'`: clipboard; toast `'Copied'`, or `'Select the password and copy it'` if copying fails
    - `'Done'`: hides the block
    - small text `t('Give this to {name}. They will choose a new password when they sign in.')`
    - Error `'Could not reset the password'`.
  - `'Remove'`: confirm `t("Remove {name}'s account? Their likes, playlists and history go with it.")`, then `DELETE /api/users/{id}`. Toast `t('{name} removed')`. Error `'Could not remove'`.

Below the list:
- `'New invite link'` (`.primary`): `POST /api/invites {}` → `{code}`. It then shows a read-only full-width field with `<base>/?invite=<code>` (base = `linkBase()` inside the shell, else the server `baseUrl`) and a `'Copy'` button (toast `'Invite link copied'`). Error `'Could not make invite'`.
- Hint (phone): `'An invite link lets someone make their own account; it works once and expires in 7 days.'` (Desktop appends `'Admins can scan the library, fetch lyrics and manage accounts.'`.)

---

### 7.8 Sign out
`App.jsx:756-772`. Drawer row `'Log out'`:
1. Fire-and-forget `POST /api/auth/logout`.
2. Clear the stored session (`clearSession`, `api/slopify.js:616`).
3. Wipe the in-memory library, detail, likes and other account state.
4. Show the Login screen.

There is no confirmation. Any 401, or the socket rejecting the token, triggers the same sign-out (`slopify:unauthorized`). The per-user cache in localStorage (`slopify.cache.<userId>.*`) is **not** deleted, but it is keyed by user (**UNSURE** whether native should purge it; recommended).

---

### 7.9 Theme system (`api/prefs.js`, `styles/app.css:5-66`)

A theme is 4 colours, `{ accent, bg, surface, fg }` (lowercase `#rrggbb`). Everything else is derived by `applyTheme(theme)` (`api/prefs.js:42-96`):
1. Sanitise: any key that is not a 6-digit hex falls back to the default for that key.
2. `light = isLight(bg)`, where isLight = `(r*299 + g*587 + b*114) / 1000 > 140`.
3. `fgDim = mix(fg, bg, light ? .28 : .30)`. Here `mix(a, b, t)` is a per-channel linear blend, rounded and clamped.
4. `accent-ink`: start from `accent`. On light themes only, while `contrast(ink, mix(bg, fg, .2)) < 4.5` (WCAG contrast), repeat `ink = mix(ink, #000, .1)`, at most 12 times.
5. `inkOn(x)` = `#000000` or `#ffffff`, whichever has the higher WCAG contrast against x.
6. Write CSS variables on `:root`, set `color-scheme` to `light` or `dark`, and set `data-light="1"` on light themes.

Variable formulas (`api/prefs.js:57-94`):

| Variable | Formula |
|---|---|
| `--accent` | accent |
| `--accent-rgb` | accent as "r,g,b" |
| `--accent-ink` | step 4 |
| `--accent-on-dark` | light ? mix(accent, #fff, .45) : accent |
| `--accent-hover` | mix(accent, light ? #000 : #fff, .12) |
| `--accent-press` | mix(accent, #000, .12) |
| `--seek-accent` | accent |
| `--on-accent` | inkOn(accent) |
| `--on-fg` | inkOn(fg) |
| `--bg-base` | bg |
| `--bg-highlight`, `--bg-elevated` | surface |
| `--bg-elevated-hi` | mix(surface, fg, .08) |
| `--card` | mix(bg, surface, .5) |
| `--card-hover` | mix(surface, fg, .06) |
| `--tint` / `--tint-hi` / `--tint-press` | light ? #0000001a / #00000024 / #00000036 : #ffffff1a / #ffffff24 / #ffffff36 |
| `--fg`, `--theme-fg` | fg |
| `--fg-rgb`, `--theme-fg-rgb` | fg as "r,g,b" |
| `--fg-dim`, `--fg-chrome`, `--theme-fg-dim` | fgDim |
| `--theme-on-fg` | inkOn(fg) |
| `--fg-sub` | light ? fgDim : #a7a7a7 |
| `--fg-faint` | light ? fgDim : #727272 |
| `--black` | light ? mix(bg, fg, .05) : #000 |
| `--page` | light ? bg : #121212 |
| `--page-rgb` | light ? bg as rgb : 18,18,18 |
| `--chip` | light ? mix(surface, fg, .08) : #2a2a2a |
| `--field` | light ? mix(surface, fg, .05) : #1f1f1f |
| `--sheet` | light ? surface : #282828 |
| `--green` | light ? accent-ink : #1ed760 |
| `--danger` | light ? #b3261e : #f3727f |
| `--danger-bg` | light ? #fbe4e2 : #2a1618 |

Static tokens (not themed): `--r-panel: 8px`, `--r-art: 4px`, `--r-row: 6px`, `--gap: 8px`, `--ease: cubic-bezier(.3,0,0,1)` (`styles/app.css:40-45`). The static `:root` defaults before JS runs (`styles/app.css:5-46`) differ slightly from the computed Spotify values: `--accent-hover #3be477`, `--accent-press #1abc54`, `--seek-accent #1db954`, `--fg-dim #b3b3b3`, `--card #181818`, `--card-hover #282828`, `--bg-elevated-hi #2a2a2a`. **Once `applyTheme` has run (always, at startup), the computed values below are what shows.**

**Presets** (`api/prefs.js:22-29`). Names are keys, except "Spotify", which is not translated:

| Preset | accent | bg | surface | fg |
|---|---|---|---|---|
| `Spotify` (= DEFAULT_THEME) | #1ed760 | #121212 | #1f1f1f | #ffffff |
| `'Midnight'` | #4c8dff | #0b1020 | #151d33 | #ffffff |
| `'Ember'` | #ff7a3d | #151010 | #241a18 | #fff5ee |
| `'Orchid'` | #c77dff | #120f18 | #1e1826 | #ffffff |
| `'Mono'` | #ffffff | #000000 | #161616 | #ffffff |
| `'Paper'` (the only light preset) | #1a7f4b | #f4f1ea | #ffffff | #141414 |

**Every computed variable per preset** (generated by running `applyTheme` from `api/prefs.js`):

| Variable | Spotify | Midnight | Ember | Orchid | Mono | Paper |
|---|---|---|---|---|---|---|
| `--accent` | `#1ed760` | `#4c8dff` | `#ff7a3d` | `#c77dff` | `#ffffff` | `#1a7f4b` |
| `--accent-rgb` | `30,215,96` | `76,141,255` | `255,122,61` | `199,125,255` | `255,255,255` | `26,127,75` |
| `--accent-ink` | `#1ed760` | `#4c8dff` | `#ff7a3d` | `#c77dff` | `#ffffff` | `#135d37` |
| `--accent-on-dark` | `#1ed760` | `#4c8dff` | `#ff7a3d` | `#c77dff` | `#ffffff` | `#81b99c` |
| `--accent-hover` | `#39dc73` | `#619bff` | `#ff8a54` | `#ce8dff` | `#ffffff` | `#177042` |
| `--accent-press` | `#1abd54` | `#437ce0` | `#e06b36` | `#af6ee0` | `#e0e0e0` | `#177042` |
| `--seek-accent` | `#1ed760` | `#4c8dff` | `#ff7a3d` | `#c77dff` | `#ffffff` | `#1a7f4b` |
| `--on-accent` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` | `#ffffff` |
| `--on-fg` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` | `#ffffff` |
| `--bg-base` | `#121212` | `#0b1020` | `#151010` | `#120f18` | `#000000` | `#f4f1ea` |
| `--bg-highlight` | `#1f1f1f` | `#151d33` | `#241a18` | `#1e1826` | `#161616` | `#ffffff` |
| `--bg-elevated` | `#1f1f1f` | `#151d33` | `#241a18` | `#1e1826` | `#161616` | `#ffffff` |
| `--bg-elevated-hi` | `#313131` | `#282f43` | `#362c29` | `#302a37` | `#292929` | `#ececec` |
| `--card` | `#191919` | `#10172a` | `#1d1514` | `#18141f` | `#0b0b0b` | `#faf8f5` |
| `--card-hover` | `#2c2c2c` | `#232b3f` | `#312725` | `#2c2633` | `#242424` | `#f1f1f1` |
| `--tint` | `#ffffff1a` | `#ffffff1a` | `#ffffff1a` | `#ffffff1a` | `#ffffff1a` | `#0000001a` |
| `--tint-hi` | `#ffffff24` | `#ffffff24` | `#ffffff24` | `#ffffff24` | `#ffffff24` | `#00000024` |
| `--tint-press` | `#ffffff36` | `#ffffff36` | `#ffffff36` | `#ffffff36` | `#ffffff36` | `#00000036` |
| `--fg` | `#ffffff` | `#ffffff` | `#fff5ee` | `#ffffff` | `#ffffff` | `#141414` |
| `--fg-dim` | `#b8b8b8` | `#b6b7bc` | `#b9b0ab` | `#b8b7ba` | `#b3b3b3` | `#535250` |
| `--fg-chrome` | `#b8b8b8` | `#b6b7bc` | `#b9b0ab` | `#b8b7ba` | `#b3b3b3` | `#535250` |
| `--fg-rgb` | `255,255,255` | `255,255,255` | `255,245,238` | `255,255,255` | `255,255,255` | `20,20,20` |
| `--theme-fg` | `#ffffff` | `#ffffff` | `#fff5ee` | `#ffffff` | `#ffffff` | `#141414` |
| `--theme-fg-rgb` | `255,255,255` | `255,255,255` | `255,245,238` | `255,255,255` | `255,255,255` | `20,20,20` |
| `--theme-fg-dim` | `#b8b8b8` | `#b6b7bc` | `#b9b0ab` | `#b8b7ba` | `#b3b3b3` | `#535250` |
| `--theme-on-fg` | `#000000` | `#000000` | `#000000` | `#000000` | `#000000` | `#ffffff` |
| `--fg-sub` | `#a7a7a7` | `#a7a7a7` | `#a7a7a7` | `#a7a7a7` | `#a7a7a7` | `#535250` |
| `--fg-faint` | `#727272` | `#727272` | `#727272` | `#727272` | `#727272` | `#535250` |
| `--black` | `#000` | `#000` | `#000` | `#000` | `#000` | `#e9e6df` |
| `--page` | `#121212` | `#121212` | `#121212` | `#121212` | `#121212` | `#f4f1ea` |
| `--page-rgb` | `18,18,18` | `18,18,18` | `18,18,18` | `18,18,18` | `18,18,18` | `244,241,234` |
| `--chip` | `#2a2a2a` | `#2a2a2a` | `#2a2a2a` | `#2a2a2a` | `#2a2a2a` | `#ececec` |
| `--field` | `#1f1f1f` | `#1f1f1f` | `#1f1f1f` | `#1f1f1f` | `#1f1f1f` | `#f3f3f3` |
| `--sheet` | `#282828` | `#282828` | `#282828` | `#282828` | `#282828` | `#ffffff` |
| `--green` | `#1ed760` | `#1ed760` | `#1ed760` | `#1ed760` | `#1ed760` | `#135d37` |
| `--danger` | `#f3727f` | `#f3727f` | `#f3727f` | `#f3727f` | `#f3727f` | `#b3261e` |
| `--danger-bg` | `#2a1618` | `#2a1618` | `#2a1618` | `#2a1618` | `#2a1618` | `#fbe4e2` |
| color-scheme | dark | dark | dark | dark | dark | light |
| `data-light` | (empty) | (empty) | (empty) | (empty) | (empty) | `1` |

Observations the Swift team must keep:
- **On dark themes, `--page`, `--chip`, `--field`, `--sheet`, `--fg-sub`, `--fg-faint` and `--green` are fixed Spotify greys or green, whatever the theme colours.** For example, on Midnight the main panel `--bg-base` is navy #0b1020 but the History page `--page` and bottom sheets `--sheet` stay #121212 / #282828.
- **Light-theme "dark islands"**: with `data-light="1"`, these keep the dark token set: `.hero` (art headers, including the Profile hero), `.fs` (Now Playing), `.tile`, `.cal-card`, the top bar on pages that have a hero, `.rightpanel.with-bg`, and `.navarrow`.
  - The dark set: `--fg` #fff, `--fg-dim` #b3b3b3, `--fg-sub` #a7a7a7 (**#d0d0d0 inside `.hero`**), `--fg-faint` #727272, `--accent-ink` = `--accent-on-dark`, `--on-fg` #000, `--bg-base` #121212, `--bg-highlight`/`--bg-elevated` #1f1f1f, `--bg-elevated-hi` #2a2a2a, `--card` #181818, `--card-hover` #282828, the white tints, `--page` #121212, `--chip` #2a2a2a, `--field` #1f1f1f, `--sheet` #282828, `--danger` #f3727f (`styles/app.css:51-59`).
- `themeEquals` compares the 4 keys case-insensitively, after filling defaults (`api/prefs.js:98-101`). It drives the "Custom" label, the check in the theme sheet, and the disabled state of Reset.
- A theme change is applied live on every open client of the account, via the relay patch (7.2.5). There is no reload.
- The selection check glyph is hard-coded #1ed760, and so is the `.ctxmenu-fixed .ctx-check` (`--accent-ink`, used by the visualizer sheet).

---

### 7.10 Visualizer settings (not in Settings; Now Playing viz tab)

Source: `components/Visualizer.jsx:55-72`, `components/FullScreen.jsx:160-190, 283-289`.
- Opened by tapping the visualizer tab button while it is already the active tab. On the phone this is a bottom sheet.
- Sheet header: icon `G.viz`, title `'Visualizer'`, subtitle `'Style, colours and smoothing'`.
- The phone sheet hides the empty icon column. The check is right-aligned, in `--accent-ink`, using the glyph at `components/ContextMenu.jsx:98`: 16 viewBox, path `M13.985 2.383 5.127 12.754 1.388 8.375l-1.14 1.048 4.879 5.617L15.184 3.36l-1.199-.977z`.
- Closes with the 250 ms slide-down (`slideOut`).

Items:
1. `'Style'`: opens a submenu, which is a second sheet with min-height 45vh. Options are EQ_STYLES: `line` `'Line'` (default), `area` `'Area'`, `led` `'LED bars'`, `bars` `'Bars'`, `mirror` `'Mirror'`, `radial` `'Radial'`. Each has audioMotion options (`Visualizer.jsx:55-63`), out of scope for this section.
2. `'Colours'`: submenu with `album` `'Match album art'`, `prism` `'Prism'` (default), `classic` `'Classic'`, `rainbow` `'Rainbow'`, `orangered` `'Orangered'`, `steelblue` `'Steelblue'`.
3. Separator.
4. `'Smoothing'` slider: 0 to 0.95, step 0.05, default 0.6.
   - Value text: `'Real time'` at 0, else `NN%`.
   - Track 4 tall: filled `--fg`, rest `rgba(fg, .3)`. Thumb 12, `--fg`. Row padding 12 12 16; head 16 pt; value 13 `--fg-sub`.
5. Only if the session is on a speaker:
   - Separator.
   - Label `t('Timing on {name} ({ms} ms)')` (ms signed, e.g. `+120`) or `t('Timing on {name}')`.
   - `'Calibrate by tapping…'`, or the disabled `'Calibrate from the client that is playing'`.
   - `'Forget calibration'`, if an offset exists.

Storage: account pref `viz: {style, gradient, smoothing}` (the whole object is written each time), plus the first-paint copy in localStorage `conduit.viz`. Default `DEFAULT_VIZ = {style:'line', gradient:'prism', smoothing:0.6}`.

---

### 7.11 i18n keys used by these screens (index)

Settings: `Settings`, `Back`, `View profile`, `Playback`, `Streaming quality on phones`, `Streaming quality elsewhere`, `Normalize volume`, `Off`, `On: every song at the same loudness`, `Crossfade`, `{value}. Not on iPhone yet`, `Gapless playback`, `Off. Not on iPhone yet`, `On. Not on iPhone yet`, `Scrobbling`, `On, as {user}`, `On, as your account`, `Import from Spotify`, `Language`, `Automatic`, `Appearance`, `Theme`, `Custom`, `Accent`, `Background`, `Surface`, `Text`, `Play button, likes, the active track`, `The page behind everything`, `Cards, menus, the queue panel`, `Titles and icons`, `Reset to default`, `Saved to your account and applied to every Slopify you have open.`, `Server`, `Server address`, `Help`, `Logs`, `See what the app logged, report a problem`, `1 second`, `{n} seconds`, the 4 quality labels, the 5 sheet subtitles (7.2.4), and the preset names `Midnight`, `Ember`, `Orchid`, `Mono`, `Paper`.

Scrobbling sub-page: `Every song you play for at least half its length is sent to ListenBrainz as a listen. Get the token from listenbrainz.org, under Settings.`, `ListenBrainz username`, `username`, `ListenBrainz user token`, `Save`, `Saved`, `Scrobbling as {user}.`, `Scrobbling as your account.`, `Scrobbling is off until a token is saved.`, `Disconnect`.

Toasts: `Could not save settings: {error}`, `Profile picture updated`, `Could not upload: {error}`.

Profile: `Profile`, `Choose photo`, `1 public playlist`, `{n} public playlists`, `Edit`, `More options`, `Change photo`, `Top artists this month`, `Top tracks this month`, `Only visible to you`, `Artist`, `See all`, `See less`, `Public Playlists`, `By {name}`, `Loading…`, `You`.

History, Logs, About, Spotify import and Admin: the keys are listed inline in 7.5-7.7.

---

## 8. Language / i18n

Source: `web/src/i18n.js`, `web/src/locales/*.json`, `tools/i18n.mjs`, `server/src/i18n.test.ts`.

### 8.1 How strings are keyed

- **The English text is the key.** `t('Add to queue')` looks up `"Add to queue"` in the locale JSON and falls back to the English itself when a translation is missing, so a missing string never shows a key (`i18n.js:66-70`).
- Locale files are flat JSON objects `{ "<English>": "<translation>" }`, one per language, keys sorted. There is no `en.json` (English is the source).
- Placeholders are `{name}` style and are filled by simple replacement: `t('Added to {name}', { name })`. A placeholder with no value stays as the literal `{name}`. A test guarantees every translation has exactly the same placeholders as its English (`server/src/i18n.test.ts`).
- No plural engine. Plurals are separate keys chosen in code, for example `1 track` vs `{n} tracks`, `1 song added` vs `{n} songs added`, `{name} is ready offline (1 song)` vs `({n} songs)`. Port the same `n === 1 ? ... : ...` choices; do not switch to `.stringsdict` keys, or the shared JSON stops matching.
- A few strings carry inline bold markup `<b>…</b>` (for example `<b>Tap along to the beat</b> for {n} seconds.`, Spotify-import results). They are rendered by splitting on `<b>(.*?)</b>` and bolding the odd parts (`web/src/components/Calibrate.jsx:6`). Native: parse the same way into an `AttributedString`.
- Strings in module-level constants are marked with `N_('...')` (identity) and translated at render time with `t(value)` (example: tab labels, `App.jsx:1783`).
- Typographic punctuation is part of the key: `…` vs `...`, `’` vs `'`, `·`, `—`, `•`. Copy keys byte-exact (for example `Logging in…` uses U+2026, `Starting Slopify...` uses three dots).
- Count: 849 strings; all 21 locales are complete today (`node tools/i18n.mjs` prints per-locale counts; `--keys` dumps every key as JSON, `--missing <code>` lists gaps).
- Numbers and dates use the platform locale with the app's language code: `toLocaleString(language())` for counts and `toLocaleDateString(language(), …)` in History/Admin (`web/src/components/History.jsx:23-40, 185, 418`). Native: `Locale(identifier: code)` formatters.

### 8.2 Languages

`LANGUAGES` in `i18n.js:11-34`, in this order (the order of the Settings picker after `Automatic`):

| Code | Name shown | Code | Name shown |
|---|---|---|---|
| en | English | sv | Svenska |
| es | Español | da | Dansk |
| fr | Français | nb | Norsk bokmål |
| de | Deutsch | fi | Suomi |
| it | Italiano | cs | Čeština |
| pt-BR | Português (Brasil) | ja | 日本語 |
| nl | Nederlands | ko | 한국어 |
| pl | Polski | zh-CN | 简体中文 |
| ru | Русский | zh-TW | 繁體中文 |
| uk | Українська | id | Bahasa Indonesia |
| tr | Türkçe | vi | Tiếng Việt |

Language names are shown in their own language and are not translated.

### 8.3 Which language is used

`resolve()` (`i18n.js:57-59`): the person's pick, else the server's default, else the device's preferred languages, else `en`.
- Person's pick: Settings > Language (section 7), saved to the account prefs as `language` (`''` = Automatic) and cached on the device (`localStorage slopify.lang.user`). It follows the account to every device.
- Server default: `GET /api/i18n` returns `{ language: 'auto' | code }` (readable before sign-in), cached as `slopify.lang.server`. Checked after start; if it changes what is shown and the person has no pick, the app reloads into it.
- Matching (`match()`, `i18n.js:47-55`): case-insensitive, `_` = `-`; any `zh` with `tw|hk|mo|hant` -> `zh-TW`, other `zh` -> `zh-CN`; `no`, `nn*`, `nb*` -> `nb`; otherwise by base language (`pt`, `pt-PT` -> `pt-BR`; `de-AT` -> `de`); unknown -> none.
- Changing the language: the web app reloads the page 800 ms after the pick (so the pick is saved first). A pick arriving from another device applies right away if nothing is playing here and the app is in front, else at the next quiet moment (`App.jsx:300-312`, `1215-1227`). Native: swap the string table live and re-render; no restart needed. **UNSURE** whether the owner wants the "wait until quiet" rule kept for remote picks; a live swap interrupts nothing natively, so probably not needed.

### 8.4 Reusing the JSON natively

- Bundle `web/src/locales/*.json` as-is (copy at build time so the web files stay the single source) and implement `t(_ english: String, _ vars: [String: String] = [:]) -> String` with the same fallback and `{key}` replacement. Do not convert to `.strings`/`.xcstrings` keys.
- The native app will need a few strings the web app does not have (system permission prompts, the server-address screen, which today is English-only in `mobile/App.js`). Add them to the same JSON files as English-keyed entries, and they will be picked up by `tools/i18n.mjs` only if the scanner is extended to Swift sources (**UNSURE**: today it scans `web/src` only, `tools/i18n.mjs:12-16`).
- Text direction: no RTL languages are shipped.


---

## 9. Icons

### 9.1 Icon set

There is no icon font or icon package (`web/package.json` has none). Every glyph is an **inline SVG path in the JSX**, almost all copied from Spotify's own glyphs (16x16 viewBox for small glyphs, 24x24 for the phone's line glyphs). All use `fill="currentColor"` (or `stroke="currentColor"` for the line icons) so they take the text colour, except: `heartOn` fills with `--seek-accent` `#1db954`; `check` fills `#1ed760`. Export each path to an SF-Symbol-style template image (PDF/SVG asset, "Preserve Vector Data", render as template) and keep the viewBox so sizes match.

Two exceptions are SVGs embedded in CSS as data URIs: the magnifier inside the white search field (`web/src/styles/app.css:1297`, same path as the off Search tab glyph) and the music-note placeholder on cards without art (`web/src/styles/mobile-library.css:196`).

### 9.2 Where they are defined

| File:line | Name(s) | viewBox | Used for |
|---|---|---|---|
| `web/src/App.jsx:137` | login mark | 24 | 40 pt logo on sign-in |
| `web/src/App.jsx:172-180` | `TabHome`, `TabSearch`, `TabLib` (on = filled, off = outline) | 24 | Tab bar |
| `web/src/App.jsx:183-185`, `1618-1636` | `MenuIco` paths: profile, history, downloads, settings (gear), update, log out | 24, stroke 1.8 | Account drawer rows |
| `web/src/App.jsx:1551` | back chevron | 24 | Detail top bar back button (drawn at 18 pt) |
| `web/src/App.jsx:1560, 1579, 1582` | dots, back/forward arrows | 16 | Desktop only |
| `web/src/components/TrackRow.jsx:59-72` | `PlayGlyph`, `PauseGlyph`, `ShuffleGlyph` | 16 | Play/pause/shuffle buttons everywhere |
| `web/src/components/TrackRow.jsx:104-135` | `LikedCover` (heart on gradient), `NowPlayingBars` (animated bars), `Heart` (outline / filled) | 16 | Liked Songs cover, playing row, like buttons |
| `web/src/components/TrackRow.jsx:140-162` | `I` (imported elsewhere as `MI`): `plus, queue, ban, radio, artist, album, down, trash, heart, heartOn, lyrics, share, follow, edit, gear, sparkle, playlist, photo, play, check, pin` | 16 | Context-menu item icons, settings sheets |
| `web/src/components/TrackRow.jsx:177-182` | `DownloadedMark` | 16 | Green arrow before a downloaded song's artist line |
| `web/src/components/Library.jsx:80-84, 161-170` | `CloseGlyph`, `Clock`, `Dots` | 16 | Recent-search remove, duration header, more buttons |
| `web/src/components/Library.jsx:755, 762` | settings chevron, settings sub-page back | 16 / 24 | Phone settings rows |
| `web/src/components/Library.jsx:2009-2025` | `DownloadGlyph` (states: idle, busy with progress ring, part, done) | 24 | Download button on album/playlist pages |
| `web/src/components/Library.jsx:1141, 1179, 1216, 1356, 1452` | inline one-offs (see section 6) | 16/24 | Profile/hero/owner/action glyphs |
| `web/src/components/Sidebar.jsx:11-23, 25-49` | `ICONS`: `home, search, library, plus, sort, grid, list, folder, folderOpen` (stroke paths) + `Icon` wrapper | 24 | Library tab header, sort row, grid/list toggle, folders |
| `web/src/components/Player.jsx:70-77` | `LyricsGlyph` | 24 | Lyrics button |
| `web/src/components/Player.jsx:137-140` | `CastGlyph` | 24 | "Playing on" line |
| `web/src/components/Player.jsx:333-438` | transport, device, queue, volume glyphs (mini player and desktop bar) | 16/24 | Mini player |
| `web/src/components/FullScreen.jsx:21-36` | `G` (24 pt: `dots, share, queue, lyrics, viz, plus, artist, album`) and `G16` (`moon, queue, radio, share`) | 24 / 16 | Now playing bottom row and its menu |
| `web/src/components/FullScreen.jsx:266-351` | chevron down, Album/Lyrics/Visualizer mode glyphs, previous, next, repeat (incl. repeat-one), shuffle | 16/24 | Now playing |
| `web/src/components/RightPanel.jsx:22-34, 71-77, 474-477` | sync-banner glyphs, queue row handle/remove, transport | 16/24 | Queue and lyrics |
| `web/src/components/DevicePicker.jsx:11-44` | `ICONS` (`local, cast, bluos, relay`), `PHONE_ICONS` (same keys, phone sheet versions), `FORM_ICONS` (`desktop, laptop, phone, tv, tablet`) and `DeviceIcon` (`45-67`) | 24 | Device sheet rows and the device button |
| `web/src/components/DevicePicker.jsx:114, 121` | volume low / high | 16 | Volume slider ends in the device sheet |
| `web/src/components/ContextMenu.jsx:5, 98` | submenu chevron, check mark | 16 | Menus |
| `web/src/components/History.jsx:45-51, 157` | `grid, prev, next, more, check, updown, musicOff`, clock face (viewBox 320) | 24/20 | Listening history page |
| `web/src/components/AdminSettings.jsx:29-36, 110` | task glyphs `scan, enrich, heads, discovery, backlog, flac, brain, lyricsync` | 24 | Admin settings |
| `web/src/components/GeneratePlaylist.jsx:41` | done check | 16 | AI playlist progress |

Sizes on the phone are set per use in CSS (24 for tab bar, now-playing row and drawer; 16 to 22 elsewhere); each section lists the size where the icon appears.

### 9.3 App icon, launch screens, logos

- App icon and favicon artwork: `web/public/favicon.svg` (green `#1ED760` padlock-shaped body with three dark `#121212` sound-wave arcs), `web/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`. Generated by `tools/logo-export.py` (also produces the launch images in `web/public/splash/<w>x<h>.png`). `ios/Slopify/Resources/Assets.xcassets` already exists in the iOS project.
- Launch screen: the splash PNGs are per device size; natively, use a black launch screen with the centred logo (**UNSURE** of the splash layout: open `web/public/splash/1179x2556.png` to match it).

### 9.4 Reference screenshots

Phone screenshots of the web app exist at `docs/images/screen-phone-library.png`, `screen-phone-lyrics.png`, `screen-phone-playing.png`, `screen-phone-playlist.png`. They may predate recent CSS changes (**UNSURE** of their age); when they disagree with this document, the CSS values here win. For pixel comparison, run the web app in the Playwright `phone` project (393x852, touch) and screenshot each screen; `tools/ios-sim` has a headless iOS simulator harness for the web app.

---

## 10. Open questions and risks

The web phone layout has quirks and probable bugs. "Identical" is the brief, but each item below needs a yes/no from the owner before it is copied or fixed. Detail is in the section cited.

### 10.1 Product questions

1. **Release Radar exists.** Home has a `Release Radar` shelf and a Release Radar page: a list of albums, EPs and singles from the last 90 days by the user's top artists, not a playlist of tracks (6.1.1, 6.1.9, 6.3.9; `web/src/components/Home.jsx:273-284`, `server/src/discover.ts:332`). The brief said there is no Release Radar. Confirm whether the native app keeps it. There is no Weekly Jams, Daily Jams or Discover Weekly (`Home.jsx:113-120`).
2. **Visualizer and speaker calibration can't be reached on the phone** (3.2.6, 3.7, 4.7). Leave them out, or add an entry point?
3. **Crossfade and gapless say "Not on iPhone yet"** in Settings (7.2.2). Native AVPlayer can do both. Implement them and drop the label?
4. **Search song rows open the album** rather than playing (6.2.7). On purpose in the code.
5. **Track menu "Download" / "Download as zip"** are file exports, separate from offline saving (5.4.5). No native equivalent is decided.
6. **Calibration, theme colour pickers, Spotify import and admin settings** are big, rarely used screens (7.6, 7.7, 4.7). They could ship after the core player.
7. **Per-tab stacks.** The web app has one global history whose entries remember their tab (2.5). A native `NavigationStack` per tab behaves differently.

### 10.2 Probable web bugs (copy or fix?)

- Long-press on Liked Songs in Your Library opens nothing in the normal view (5.2.9).
- Library row menus are not reduced when offline (5.2.9).
- Playlist track reorder uses HTML5 drag, which never fires on iOS touch, so it is unusable on the phone today (5.4.2, 6.6).
- A tap on non-button areas of the device sheet can open now playing behind it (4.8).
- The device sheet shows the browser-only note inside the phone app (4.8).
- Repeat-one looks the same as repeat-all, and smart shuffle the same as shuffle, on the phone (3.11).
- In the queue, tapping a title or artist opens a page behind the still-open queue (3.11).
- Toasts (`bottom: 96`) and the lyrics-sync pill overlap the floating mini player, and are hidden under now playing (2.9, 3.11).
- The profile avatar renders about 2x zoomed inside its 128 pt circle (7.4).
- History chart labels render at about 5.8 pt, and the chart scrub only works with a mouse (7.5).
- Genre pages are grey even when their tile is coloured (6.6).
- "Made For You" renders as an empty shelf when there are no mixes (6.6).
- The `Song • ` prefix in search rows is hard-coded English in the CSS (6.6).
- Tapping the lit Library tab does not scroll the library list to the top (5.1).
- Menus vanish with no exit animation, except queue-row menus, which slide down over 0.25 s (5.5.5). One consistent native dismiss is recommended.

### 10.3 Technical risks (largest first)

1. **Player engine and remote control** (3.9, 4). Gapless playback, crossfade, normalization and lossless-over-HLS on the phone (2.13). Also session handoff between devices over the relay socket, speakers (Sonos/DLNA/AirPlay/Roku/Bluesound) driven by the server, lock-screen controls while remote, and hardware volume buttons stepping a remote device (2.8, 4.4.1). Most of the behaviour lives in `web/src/player/usePlayer.js` (3,127 lines) and `web/src/api/session.js`. Budget it as its own project.
2. **Offline downloads** (5.7, 5.8). These need storage, resume, quality picking, the offline-mode UI changes, and offline play counts sent later.
3. **Album-colour theming** (6.3.1, 3.2.1). Hero, top-bar, mini-player and now-playing colours come from a sampled-colour algorithm with lightness clamps. Port it exactly (`web/src/api/colors.js`, `Library.jsx heroTint/phoneHero`, `Player.jsx clampLightness`), or every page will look slightly off.
4. **Synced lyrics** (3.4). This covers line clean-up, the 0.25 s lead, tap-to-seek and sync-job states.
5. **Library drag-to-reorder with folders** (5.2.11). It has custom thresholds and auto-scroll.
6. **Themes** (7.9). Six presets plus custom colours are derived into about 37 tokens. Some places stay fixed Spotify grey/green or dark "islands" on light themes, so they must be copied, not simplified.
7. **Instant paint from cache** everywhere (2.13, 6.0.15). Pages seen before must never show empty, including offline.
8. **Gesture conflicts** (2.8). Swipe-to-skip on the mini player, swipe-down on now playing and sheets, the left-edge back swipe, 450 ms long-press and 380 ms library hold must coexist with scroll views. SwiftUI needs care to match the thresholds.
