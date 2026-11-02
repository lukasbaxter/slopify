# Headless device lab (browsers, Android phone, Android TV)

Runs Slopify against Chromium, Firefox and WebKit, real Chrome on an
Android phone, the Android app and the TV app, all on a Linux box with
nothing on its screens: browsers run headless, emulators with `-no-window
-no-audio`. Everything lives under one folder on that box (default
`~/apps/slopify-lab`), needs no sudo and tests only against fixture servers
it starts itself from `fixtures/music`, bound to 127.0.0.1.

`lab.sh` runs on the Mac: it rsyncs this working tree (uncommitted changes
included, `node_modules`, `.git` and every `dist/` left out) over the lab's
clone, then runs itself there over ssh. On the lab box itself, run it with
`LAB_LOCAL=1`.

Needs: on the Mac, ssh to the lab box and `gh` (for the release's server
address, see "The Android app"). On the lab box: Linux x86_64, KVM usable by
the user, Java 17+ on PATH, python3, curl, git, `apt-get download` +
`dpkg-deb` (for WebKit's libraries). About 25 GB of disk.

## Setup

```sh
cp tools/device-lab/lab.env.example tools/device-lab/lab.env   # set LAB_HOST (gitignored)
tools/device-lab/lab.sh setup
```

`setup` is idempotent. It installs, under the lab folder:

| What | Where |
|---|---|
| Node 22 (official tarball, sha256 checked) | `node/` |
| The repo clone (then `npm ci`, `npm run build`) | `slopify/` |
| Playwright Chromium, Firefox, WebKit | `ms-playwright/` |
| WebKit's missing system libraries: `libharfbuzz-icu0 libmanette-0.2-0 libenchant-2-2 libhyphen0`, from the distro's .debs, copied next to WebKit's own | `syslibs/` |
| ffmpeg (static build; the server and some specs need it) | `ffmpeg/` |
| Android cmdline-tools, platform-tools, emulator, build-tools 36.1 | `android-sdk/` |
| Phone: `android-36;google_apis_playstore;x86_64` (Chrome, Play) | AVD `slab-phone` |
| Fire TV stand-in: `android-30;android-tv;x86` (Android 11; its Google services are switched off at boot) | AVD `slab-tv30` |
| Google TV: `android-36;google-tv;x86_64` | AVD `slab-gtv` |
| apktool, a lab signing key | `tools/`, `lab-debug.keystore` |

adb and the emulator also write `~/.android/` and
`~/.emulator_console_auth_token` whatever the environment says.

## Commands

```
lab.sh setup                       install everything (idempotent)
lab.sh sync                        (Mac) rsync the working tree to the lab clone
lab.sh build                       npm ci when the lockfile changed, npm run build
lab.sh browsers [lanes] [--gates]  the e2e suite, one lane per browser, in parallel:
                                   chromium firefox webkit phone (default: all four)
lab.sh serve | serve-stop          fixture server for the emulators, 127.0.0.1:8190, fresh data,
                                   admin / "lab password 123"
lab.sh android-up phone tv30 gtv   boot emulators (console ports 5560 / 5562 / 5564)
lab.sh android-down [names|all]
lab.sh status                      emulators, server, load, free memory
lab.sh phone-test                  Chrome on the phone
lab.sh app-test                    the Android app (latest release) on the phone
lab.sh tv-test [tv30|gtv]...       the TV app (default: the TVs that are up)
lab.sh apk-app | apk-tv            only build the lab copies of the APKs
lab.sh shot <phone|tv30|gtv> [f]   screenshot
lab.sh all                         browsers, then phone + tv30, then gtv; emulators down at the end
lab.sh logs                        where logs and results are
```

Each device test restarts the fixture server (fresh accounts, the build
just made: the server reads `web/dist` once, at start). `KEEP_SERVER=1`
keeps a running one.

Heavy work runs under `nice -n 10`. The four browser lanes plus two
emulators keep about 10 cores busy.

## Browsers

`playwright.lab.config.ts` is one lane: the specs in `e2e/` in one
browser, against a server of its own (`LAB_LANE`, `LAB_PORT` from 8180,
`LAB_DATA`). `lab.sh browsers` starts the four lanes side by side and
prints each lane's failures with the assertion. The repo's own
`playwright.config.ts` is not touched.

- Specs gated on `project.name !== 'chromium'` (two-device and
  "one run is enough" tests) skip in the firefox and webkit lanes. With
  `--gates` those lanes are named `chromium`, so the gated specs run in
  Firefox and WebKit too. Many of them assert Chrome specifics (device
  names like "Chrome on Linux", Chrome's HTTP/2 stall, Chrome-only test
  hooks), so treat `--gates` failures as leads, not verdicts.
- `offline.spec.ts` starts its own servers on fixed ports and launches
  WebKit and Chromium itself: it runs in the chromium lane only.
- Firefox has no `isMobile`; the phone lane is Chromium.
- Reports: `slopify/tools/device-lab/results/<lane>.log|.json`, traces
  and failure screenshots in `results/<lane>/`.

## Android: how it is driven

| Need | How | File |
|---|---|---|
| Lab server on the device | `adb reverse tcp:8190` so it is `http://localhost:8190` there: a secure context, like https (service worker, PWA). `http://10.0.2.2:8190` also reaches it but is not secure. | `lab.sh` |
| Chrome's page | `am set-debug-app` + `/data/local/tmp/chrome-command-line` (no first-run screens), `adb forward` to `chrome_devtools_remote`, Playwright `connectOverCDP` | `phone-chrome.mjs` |
| An app's WebView | its `webview_devtools_remote_<pid>` socket and a small CDP client (Playwright cannot attach to a WebView: "Browser context management is not supported") | `android.mjs` `cdpPage` |
| Taps | CDP `Input.dispatchTouchEvent` (trusted touches); system UI by `uiautomator dump` + `input tap` | `android.mjs` |
| Keys | `input keyevent` (power 26, volume, d-pad, media keys), `input text` | |
| System media state | `dumpsys media_session` (sessions, state, metadata), `dumpsys notification --noredact`, `cmd media_session dispatch play/pause/next` | `android.mjs` |
| Audio focus, process state | `logcat` (`MediaFocusControl`, `AS.HardeningEnforcer`), `dumpsys activity processes` | `app-test.mjs` |
| Music volume | `cmd media_session volume --stream 3 --get` | |

Playwright's `_android.launchBrowser()` hangs on this Chrome; the
command-line file route replaces it. With the soft keyboard up, Playwright's
`click` hits the wrong element (the visual viewport scrolls), so taps are
CDP touches after a `blur()`.

## The Android app

Release APKs carry no server address: they ask for one on first launch.
`apk-app` (the same as `apk-src`) builds the app from this tree with
`EXPO_PUBLIC_SLOPIFY_URL=http://localhost:8190`, which a self-built app opens
straight away. It is signed with the debug key, so it cannot update a release
install; `app-test` uninstalls first. The WebView has DevTools on.

## The TV app

`apk-tv` does the same to `tv/slopify-tv.apk`: the baked `SERVER_URL`
(BuildConfig and its inlined copies) becomes `http://localhost:8190`, cleartext
is allowed, and one call is added at the top of `onCreate`,
`WebView.setWebContentsDebuggingEnabled(true)` (the release does not turn
DevTools on, and `android:debuggable` does not either). Never install the
unpatched APK in the lab: it opens the server it was built for.

`tv-test` signs in with the remote (d-pad to the field, `input text`, Enter),
checks the TV in `/api/session` and in a headless "laptop" client's device
menu, has the laptop hand it the music, then the remote's right and
play/pause, Home, and the seeded sign-in (`--es token --es userId`).

## What works and what does not

- The API 30 TV image is the only Android 11 TV image in the SDK, and it
  ships Google Play services; `android-up tv30` switches them off
  (`pm disable-user`), which is as close to Fire OS 8 as an emulator gets.
  Its WebView is 90 and cannot be updated without Play.
- Chrome on the phone image is 133 and stays there: updating needs a Google
  account in Play. The same goes for installing the PWA as a WebAPK: Play
  answers `WebAPK service unknown_account` and Chrome logs
  `Failed to install WebAPK`. Manifest, service worker and Chrome's own
  installability check work.
- No sound: `-no-audio` gives the emulator no audio device; media still
  plays and its clock runs, Android still grants and refuses audio focus.
- `dumpsys media_session` shows Chrome's session; the apps' WebViews publish
  none (WebView has no Media Session API).

## Example: the app stops at a song change in the background (10-31)

The app played an album, Home was pressed. One song later the next one sat
at 0:00 for good, the page still saying it played. logcat showed why:
Chromium's WebView gives up audio focus when a song ends and asks again for
the next one, and Android 16 refuses focus to a background app without a
foreground service:

```
abandonAudioFocus() ... callingPack=com.lukasbaxter.slopify
W AS.HardeningEnforcer: AudioHardening focus request for req 1 ignored for com.lukasbaxter.slopify
page: bg el playing 8adf76 t=0.0 / bg el pause 8adf76 t=0.0 / bg reconcile: element paused, app said playing
```

Chrome on the same phone played on through four song changes with the
screen off: it holds a media foreground service.
