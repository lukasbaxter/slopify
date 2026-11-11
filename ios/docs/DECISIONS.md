# Decisions (answers to UI.md §10; these override UI.md where they differ)

Product
1. Release Radar stays (shelf on Home + page). It was re-added on purpose 2026-11-09.
   Never add Weekly/Daily Jams or other generated Made For You playlists.
2. Visualizer and speaker calibration: left out (not reachable on the phone today).
3. Crossfade and gapless: implemented natively; drop the "Not on iPhone yet" label.
4. Search song rows open the album, as the web does.
5. Track menu "Download" / "Download as zip" file exports: left out for now. "Download for
   offline" (offline saving) is in.
6. Later phase (not in the first build): theme colour pickers (preset themes are in),
   Spotify import, admin settings, Logs dialog. Leave the rows out until built; do not show
   dead rows.
7. Navigation: native per-tab NavigationStack (one stack per tab, standard iOS push/pop and
   edge swipe). Tapping the lit tab pops to root / scrolls to top. Now playing and Queue are
   full-screen covers above the tabs.

Web bugs: fix, do not copy
- Long-press on Liked Songs in Your Library opens its menu.
- Menus reduce correctly offline.
- Playlist track reorder works with touch (native drag handles / onMove).
- Taps on the device sheet never reach the page behind it.
- No browser-only note in the device sheet.
- Repeat-one shows the "1" badge; smart shuffle shows its distinct icon.
- Tapping a title/artist in the queue closes the queue and now playing, then opens the page.
- Toasts and the lyric-sync pill sit above the mini player, and above now playing when it is open.
- Profile avatar fills its circle (no zoom).
- History chart labels at a readable size; scrub works by touch.
- Genre pages take their tile colour.
- Made For You shelf hidden when there are no mixes.
- "Song •" prefix in search rows is localised.
- Tapping the lit Library tab scrolls the library list to the top.
- One consistent native sheet dismiss animation.
