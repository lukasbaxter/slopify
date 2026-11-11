# Slopify for iPhone (native)

A real SwiftUI app, no web view. Same screens as the web app's phone layout,
plus things a PWA can't do well: gapless and crossfade, lock screen and
AirPods controls, offline downloads that keep going in the background.

Status: **beta**. Every phone screen is in, 361 unit tests pass, and it's
being tested on an iPhone 16 now. Not on the App Store.

| | |
|---|---|
| Needs | iOS 18+, Xcode, [xcodegen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) |
| Build + test | `make test` (simulator) |
| On your phone | put `DEVELOPMENT_TEAM = <your team id>` in `Local.xcconfig`, then `make install` (picks the paired iPhone) |
| Live sync | the same session as every other Slopify app |

The Xcode project is generated from `project.yml` and isn't committed.
`Local.xcconfig` is git-ignored and made on the first `make`.

## Layout

| Folder | What |
|---|---|
| `Slopify/Core` | server API, sign-in, home/away address, live session, likes, offline store |
| `Slopify/Player` | AVFoundation playback, gapless, crossfade, Now Playing / lock screen |
| `Slopify/Design` | colours, type, icons, translations, shared rows, menus and sheets |
| `Slopify/Features` | the screens: Home, Search, Library, album/artist, now playing, account |
| `docs/` | API contract, UI spec, decisions, conventions |
