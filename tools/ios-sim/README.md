# Headless iOS Simulator harness

Checks Slopify's iOS behaviour against real iOS WebKit: Mobile Safari and
the home-screen web app, `<audio>`, `navigator.mediaSession` and the
lock-screen / Control Center Now Playing. Nothing appears on the Mac's
screen. Simulator.app is never started: `simctl boot` runs the device
headless, and every input and output goes through simctl, a unix socket or
private frameworks.

Needs: Xcode with an iOS simulator runtime (tested with iOS 27.0, Xcode at
`/Applications/Xcode.app`; `DEVELOPER_DIR` is set for you), ffmpeg, Node 20
and python3. No Homebrew packages are needed.

## What each piece does

| Need | How | File |
|---|---|---|
| Boot headless, open a URL | `simctl create/boot/openurl` | `ios-sim.sh` |
| Run JS in the page, read state | Web Inspector protocol over the simulator's `webinspectord_sim.socket` (stdlib Python, no proxy) | `wir.py` |
| Real taps, side and home buttons | Indigo HID messages via CoreSimulator + SimulatorKit, the same path Simulator.app uses | `simhid.m` |
| System Now Playing state | `MRMediaRemoteGetNowPlayingInfo` inside the simulator | `mrctl.m` |
| Lock-screen commands (play, pause, next, prev, seek) | `MRMediaRemoteSendCommand` inside the simulator, which reaches the MediaSession action handlers exactly as a lock-screen tap does | `mrctl.m` |
| WebKit / mediaremoted logs | `simctl spawn log stream`, distilled by `nowplaying` | `ios-sim.sh` |
| Screenshots, including the lock screen | `simctl io screenshot` after `simhid lock` + `home` | `ios-sim.sh` |

`mrctl` gets MediaRemote's read and command entitlements by embedding them
in a `__TEXT,__entitlements` section, which is where simulator processes
read entitlements from. Signing them with `codesign --entitlements` does
not work: launchd refuses to spawn the binary ("Security policy issue").

## Commands

```
tools/ios-sim/ios-sim.sh up                 create + boot a throwaway "iPhone 17", build helpers, start log capture
tools/ios-sim/ios-sim.sh testpage [port]    serve the minimal MediaSession test page (default 127.0.0.1:8091)
tools/ios-sim/ios-sim.sh serve [port]       build Slopify, run it at 127.0.0.1:8090 (foreground) on an inaudible
                                            copy of the fixture library (see "Sound" below). Env: SKIP_BUILD=1,
                                            KEEP_DATA=1 (keep accounts/logins), MUSIC_DIR=, PAD_SECONDS= (40).
                                            The server lists web/dist once at start: restart it after a web build.
tools/ios-sim/ios-sim.sh open <url>         open in Mobile Safari
tools/ios-sim/ios-sim.sh pages              list inspectable pages (Safari tabs, web apps, service workers)
tools/ios-sim/ios-sim.sh js '<expr>'        evaluate in the newest page; flags: --await, --gesture,
                                            --url-substr S, --title-substr S, --app-substr S, --sw
tools/ios-sim/ios-sim.sh console [secs]     stream console messages
tools/ios-sim/ios-sim.sh tap <x> <y>        real touch at screen points (iPhone 17 is 402x874)
tools/ios-sim/ios-sim.sh swipe x1 y1 x2 y2  real drag
tools/ios-sim/ios-sim.sh webapp-install     add the page open in Safari to the home screen, by taps
tools/ios-sim/ios-sim.sh webapp             bring the home-screen web app to the front (simctl launch com.apple.webapp)
tools/ios-sim/ios-sim.sh lock | home | side hardware buttons
tools/ios-sim/ios-sim.sh unlock             two home presses (the sim has no passcode)
tools/ios-sim/ios-sim.sh np [art.out]       system Now Playing as JSON (title, artist, album, duration,
                                            elapsed, rate, isPlaying, client app)
tools/ios-sim/ios-sim.sh remote <cmd>       play | pause | toggle | stop | next | prev | skipfwd | skipback | seek <s>
tools/ios-sim/ios-sim.sh interrupt [secs] [--no-notify]
                                            another process takes the audio (non-mixable playback session,
                                            silence), then releases it notifying others (see the limits below)
tools/ios-sim/ios-sim.sh syslog <min> '<predicate>'
                                            the simulator's whole log, filtered
tools/ios-sim/ios-sim.sh shot [file.png]    screenshot
tools/ios-sim/ios-sim.sh lockshot [file]    lock, wake to the lock screen, screenshot
tools/ios-sim/ios-sim.sh nowplaying [HH:MM:SS]
                                            the media log distilled: PlaybackState flips, HTMLMediaElement
                                            play/pause/prepareForLoad/selectMediaResource, updateNowPlayingInfo,
                                            received remote commands, lock-screen button layout
tools/ios-sim/ios-sim.sh ids [--app-substr S]
                                            WebKit's log ids of Slopify's active, spare and stand-in elements
tools/ios-sim/ios-sim.sh logfile            path of the raw media log
tools/ios-sim/np-audit.py LOG --music ID,ID --standin ID [--since T --until T --app com.apple.webapp]
                                            every stretch where Now Playing said Paused while the music played,
                                            with the call that started it; exit 1 if any (>= 0.25 s)
node tools/ios-sim/desk.mjs URL USER PASSWORD DIR
                                            a second client (headless Chromium, muted, nothing on screen),
                                            driven by DIR/cmd ("play <album>", "toggle", "quit"); DIR/state
                                            holds its { playing, mirroring, title }: a session playing elsewhere
tools/ios-sim/artwork-gaps.py LOG [--since T --until T]
                                            how long Now Playing's artwork was empty after each track change
tools/ios-sim/ios-sim.sh down               stop logging, shut down and delete the simulator
```

`--gesture` runs the expression as a user gesture (Web Inspector's
`emulateUserGesture`), so `play()` passes the autoplay gate. For real
gesture semantics, use `tap` on the button instead.

## Typical session

```sh
T=tools/ios-sim/ios-sim.sh
$T up
$T serve &                      # or: SKIP_BUILD=1 $T serve &
curl -s -XPOST 127.0.0.1:8090/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}'      # then set a password via /api/auth/password (see e2e/helpers.ts)
$T open http://127.0.0.1:8090/
$T js 'const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}))};
       const i=document.querySelectorAll(".login input"); set(i[0],"admin"); set(i[1],"<password>");
       document.querySelector(".login .primary").click()'
$T tap 100 218                  # an album shortcut on Home
$T tap 364 499                  # the album's green play button
$T np                           # what the lock screen shows
$T lockshot /tmp/lock.png
$T remote next; $T np
$T js '(window.__slopifyMediaLog||[]).slice(-20)'   # the app's own media log
$T nowplaying 01:07:49          # system side of the same moments
$T down
```

Find tap coordinates from a screenshot: screenshots are 1206x2622 pixels,
so divide by 3 for points.

## Sound

The simulator plays through the Mac's speakers. `serve` therefore serves a
copy of the fixtures with every track at -75 dB (inaudible; not volume 0,
since the server merges identical silent files as duplicates) and padded to
40 s, so a wrong lock-screen state is not cut short by a 4-8 s track end.
The test page's tone is at -75 dB too.

## Home-screen web app (standalone)

`webapp-install` does the steps below (check the screenshot it leaves); after
that `webapp` brings the app to the front. By hand, with taps (there is no
API for adding it):

1. In Safari: tap the page menu button left of the address field
   (`tap 116 816` on iPhone 17), wait 2 s, tap Share (`tap 168 351`).
   The share sheet sometimes needs a second try.
2. Tap "View More" (`tap 328 780`), then "Add to Home Screen" (`tap 150 637`).
   "Open as Web App" is on by default. Tap Add (`tap 352 100`).
3. Tap the new icon on the home screen. The web app runs in
   `com.apple.SafariViewService` (Now Playing reports `parentApp:
   com.apple.webapp`) with its own storage, so log in again. Target it with
   `--app-substr SafariViewService`; `navigator.standalone` is `true` there.

The icon survives until `down` deletes the device.

## What works and what does not

- Works: page control (JS, real taps), system Now Playing state as JSON,
  every lock-screen remote command, raw and distilled logs, lock-screen
  screenshots with the title, artist and progress bar, standalone web app.
- Lock-screen screenshots in the simulator do NOT render the artwork or
  the transport glyphs: MediaRemoteUI logs `Image load failed ... Catalog
  returned nil image` and draws an empty grey square and an empty button
  row. What the buttons are comes from the log instead (`nowplaying` prints
  `lock-screen buttons: left=backward center=pause right=forward`), and the
  artwork's arrival from `Setting nowPlayingInfo artwork (id: N) ... bytes`
  and `np` (`ArtworkDataWidth/Height`, `ArtworkMIMEType`). `np art.out`
  saves the bytes only when MediaRemote hands them out, which it did not
  on iOS 27.0.
- `safaridriver` (macOS 27) with `platformName: iOS, safari:useSimulator:
  true` always answers "Could not find any session hosts". Setting the
  likely Remote Automation defaults keys in the simulator did not change
  that, and the Settings switch cannot be reached headless. The Web
  Inspector route replaces it.
- WebKit writes `title = "title"` in its own `updateNowPlayingInfo` lines
  (redacted). The real title, artist and album are in the MediaRemote lines
  and in `np`.
- No audio interruptions: another app's audio (Safari, or `interrupt`, a
  process holding a non-mixable playback session) does not interrupt the
  web app in the simulator; WebKit logs no interruption and the elements
  keep playing. What WebKit does on a real interruption is in its source
  (`PlatformMediaSession::beginInterruption` pauses every element and calls
  the page's Media Session 'pause' handler through
  `MediaSession::suspendPlayback`; `endInterruption` with may-resume calls
  'play'), so tests emulate it: pause the element from JS (not through the
  app) and send `remote pause` / `remote play`.
- MediaRemote keeps the lock screen's clock anchor unless told a position
  more than about a second away ("Setting identical nowPlayingInfo,
  skipping update" in the WebKit.GPU log); `np` shows the anchor
  (`ElapsedTime` at `Timestamp`), so lock-screen time = ElapsedTime +
  rate x (now - Timestamp).
- No real audio route: the simulator plays to the Mac's default output if
  one exists. Interruptions, AirPods and CarPlay are not simulated.
- Slopify's elements: `window.__slopifyAudio()` returns the active, spare
  and stand-in `<audio>` elements; `ids` maps them to WebKit's log ids.
- `ios-sim.sh` points `wir.py` at the booted device's own inspector socket
  (`simctl getenv RWI_LISTEN_SOCKET`) and keeps one inspector client
  connected (`wir.py hold`): webinspectord_sim quits when its last client
  leaves, and the next call would race its restart and see no pages.

## Example: the lock screen said paused while the music played (10-26)

Locked web app, music paused, lock-screen "next": the music started, and 2 s
later Now Playing went to Paused for the rest of the song. The harness
showed why: WebKit picks the Now Playing element by most recent user
interaction, not by playback (`HTMLMediaElement::selectBestMediaSession`), and
the stand-in's stop ran inside the lock-screen command's gesture
(`prepareForLoad(...) gesture = 1`, 2 s later), so the stopped stand-in
became the newest candidate. `np-audit.py` counted 4 of 4 rounds before the
fix (keepalive.js mutes the stand-in as it stops: a muted element is no
candidate) and 0 of 6 after.

