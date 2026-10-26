#!/bin/bash
# Headless iOS Simulator harness for checking Slopify's iOS behaviour (Mobile
# Safari / home-screen web app, <audio>, MediaSession, lock-screen Now
# Playing) with real iOS WebKit. Nothing is shown on the Mac: Simulator.app is
# never started. See README.md in this folder.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
STATE="$HERE/.state"; mkdir -p "$STATE"
BUILD="$HERE/.build"; mkdir -p "$BUILD"
DEVICE_TYPE="${IOS_SIM_DEVICE_TYPE:-iPhone 17}"
RUNTIME="${IOS_SIM_RUNTIME:-}"
NAME="slopify-ios-harness"

udid() { [ -s "$STATE/udid" ] || { echo "no harness simulator: run '$0 up' first" >&2; exit 1; }; cat "$STATE/udid"; }
simctl() { xcrun simctl "$@"; }
# wir.py talks to the booted device's own inspector socket.
wir() { WIR_SOCKET="${WIR_SOCKET:-$(xcrun simctl getenv "$(udid)" RWI_LISTEN_SOCKET)}" python3 "$HERE/wir.py" "$@"; }

build_tools() {
  if [ ! -x "$BUILD/mrctl" ] || [ "$HERE/mrctl.m" -nt "$BUILD/mrctl" ] || [ "$HERE/mrctl.entitlements" -nt "$BUILD/mrctl" ]; then
    # Simulator processes read entitlements from the __TEXT,__entitlements
    # section (codesign --entitlements is refused by the host for com.apple.* keys).
    xcrun --sdk iphonesimulator clang -fobjc-arc -Wno-arc-performSelector-leaks -arch arm64 -mios-simulator-version-min=17.0 \
      -framework Foundation -Wl,-sectcreate,__TEXT,__entitlements,"$HERE/mrctl.entitlements" "$HERE/mrctl.m" -o "$BUILD/mrctl"
    codesign -s - -f "$BUILD/mrctl" 2>/dev/null
  fi
  if [ ! -x "$BUILD/simhid" ] || [ "$HERE/simhid.m" -nt "$BUILD/simhid" ]; then
    xcrun clang -fobjc-arc -framework Foundation -framework AppKit "$HERE/simhid.m" -o "$BUILD/simhid"
  fi
  if [ ! -x "$BUILD/interrupt" ] || [ "$HERE/interrupt.m" -nt "$BUILD/interrupt" ]; then
    xcrun --sdk iphonesimulator clang -fobjc-arc -arch arm64 -mios-simulator-version-min=17.0 \
      -framework Foundation -framework AVFAudio "$HERE/interrupt.m" -o "$BUILD/interrupt"
    codesign -s - -f "$BUILD/interrupt" 2>/dev/null
  fi
}

testpage_assets() {
  local d="$HERE/testpage"
  # -75 dB: the simulator plays through the Mac's speakers. Still a real
  # audio track, so WebKit treats it as audible media for Now Playing.
  [ -f "$d/tone.mp3" ] || ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=30" -af volume=-75dB -ac 2 -ar 44100 -b:a 128k "$d/tone.mp3"
  [ -f "$d/art.png" ] || ffmpeg -v error -y -f lavfi -i "color=c=0xcc3366:s=512x512" -frames:v 1 "$d/art.png"
}

start_logs() {
  # Everything media-related, raw, to one file. `nowplaying` distils it.
  stop_logs
  local pred='process == "mediaremoted" OR process == "MediaRemoteUI" OR subsystem == "com.apple.amp.mediaremote" OR subsystem == "com.apple.amp.mediacontrols" OR (subsystem == "com.apple.WebKit" AND category == "Media")'
  nohup xcrun simctl spawn "$(udid)" log stream --level debug --style compact --predicate "$pred" >> "$STATE/media.log" 2>&1 &
  echo $! > "$STATE/log.pid"
  # Keep one Web Inspector client connected: webinspectord_sim quits when its
  # last client leaves, and the next `js` then races its restart.
  WIR_SOCKET="$(xcrun simctl getenv "$(udid)" RWI_LISTEN_SOCKET)" nohup python3 "$HERE/wir.py" hold > /dev/null 2>&1 &
  echo $! > "$STATE/hold.pid"
}
stop_logs() {
  for f in log.pid hold.pid; do [ -s "$STATE/$f" ] && kill "$(cat "$STATE/$f")" 2>/dev/null || true; rm -f "$STATE/$f"; done
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  up)
    # Create a throwaway device, boot it headless, build the helpers, start logging.
    if [ -s "$STATE/udid" ] && simctl list devices | grep -q "$(cat "$STATE/udid")"; then
      echo "reusing $(cat "$STATE/udid")"
    else
      if [ -z "$RUNTIME" ]; then RUNTIME=$(simctl list runtimes -j | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x["platform"]=="iOS" and x["isAvailable"]]; print(r[-1]["identifier"])'); fi
      simctl create "$NAME" "$DEVICE_TYPE" "$RUNTIME" > "$STATE/udid"
      echo "created $(cat "$STATE/udid") ($DEVICE_TYPE, $RUNTIME)"
    fi
    simctl boot "$(udid)" 2>/dev/null || true
    simctl bootstatus "$(udid)" >/dev/null
    build_tools; testpage_assets
    : > "$STATE/media.log"; start_logs
    echo "booted headless: $(udid)"
    ;;
  down)
    # Stop logging, shut down and delete the throwaway device, stop helpers.
    stop_logs
    for f in testpage.pid; do [ -s "$STATE/$f" ] && kill "$(cat "$STATE/$f")" 2>/dev/null || true; rm -f "$STATE/$f"; done
    if [ -s "$STATE/udid" ]; then simctl shutdown "$(udid)" 2>/dev/null || true; simctl delete "$(udid)" 2>/dev/null || true; rm -f "$STATE/udid"; fi
    echo "simulator shut down and deleted"
    ;;
  testpage)
    # Serve the minimal MediaSession test page on 127.0.0.1:${1:-8091}.
    testpage_assets
    port="${1:-8091}"
    nohup python3 -m http.server "$port" --bind 127.0.0.1 --directory "$HERE/testpage" > "$STATE/testpage.log" 2>&1 &
    echo $! > "$STATE/testpage.pid"; sleep 0.5; echo "test page: http://127.0.0.1:$port/"
    ;;
  serve)
    # Build Slopify and run it on the e2e fixture library, bound to 127.0.0.1
    # (reachable from the simulator). Foreground; Ctrl-C to stop.
    port="${1:-8090}"
    cd "$REPO"
    [ -d node_modules ] || npm ci --no-audit --no-fund
    [ -d fixtures/music ] || node fixtures/generate.mjs
    # The simulator plays through the Mac's speakers: serve an inaudible copy
    # of the fixtures unless MUSIC_DIR names another library. Each track is
    # re-encoded at -75 dB (not volume 0: identical silent files are merged
    # by the server as duplicates) and padded to PAD_SECONDS (default 40), so
    # a wrong lock-screen state is not cut short by a 4-8 s track end.
    if [ -z "${MUSIC_DIR:-}" ]; then
      MUSIC_DIR="$STATE/music-quiet-${PAD_SECONDS:-40}"
      if [ ! -d "$MUSIC_DIR" ]; then
        cp -R fixtures/music "$MUSIC_DIR.tmp"
        find "$MUSIC_DIR.tmp" -name '*.mp3' -print0 | while IFS= read -r -d '' f; do
          ffmpeg -v error -y -i "$f" -map_metadata 0 -af "volume=-75dB,apad=whole_dur=${PAD_SECONDS:-40}" -c:a libmp3lame -b:a 128k "$f.0.mp3" < /dev/null && mv "$f.0.mp3" "$f"
        done
        mv "$MUSIC_DIR.tmp" "$MUSIC_DIR"
      fi
    fi
    [ "${SKIP_BUILD:-0}" = 1 ] || npm run build
    # The server lists web/dist once at start: restart it after a web build
    # (KEEP_DATA=1 keeps the accounts and logins of the last run).
    data="${DATA_DIR:-$STATE/slopify-data}"; [ "${KEEP_DATA:-0}" = 1 ] || rm -rf "$data"
    exec env NODE_ENV=test SAVE_TO_LIBRARY=0 SPEAKERS=0 MUSIC_DIR="${MUSIC_DIR:-fixtures/music}" DATA_DIR="$data" HOST=127.0.0.1 PORT="$port" \
      LOG_LEVEL=warn LOGIN_RATE_MAX=1000 RATE_MAX=100000 node server/dist/index.js
    ;;
  open)
    # Safari's first launch on a fresh device can drop the URL (blank tab):
    # wait until a page shows it, opening again if needed.
    simctl openurl "$(udid)" "$1"
    for i in $(seq 1 30); do
      sleep 1
      if wir pages 2>/dev/null | grep -q "\"url\": \"${1%/}"; then echo "opened $1"; exit 0; fi
      if [ "$i" = 10 ] || [ "$i" = 20 ]; then simctl openurl "$(udid)" "$1"; fi
    done
    echo "warning: no inspectable page shows $1 yet" >&2 ;;
  pages)  wir pages "$@" ;;
  js)     wir js "$@" ;;
  console) wir console "$@" ;;
  np)     simctl spawn "$(udid)" "$BUILD/mrctl" info "$@" ;;      # system Now Playing as JSON
  remote) simctl spawn "$(udid)" "$BUILD/mrctl" "$@" ;;
  interrupt) build_tools; simctl spawn "$(udid)" "$BUILD/interrupt" "$@" ;;  # another app takes the audio: [secs] [--no-notify]           # play|pause|toggle|next|prev|seek N|...
  lock|home|side) "$BUILD/simhid" "$(udid)" "$cmd" ;;
  tap)    "$BUILD/simhid" "$(udid)" tap "$1" "$2" ;;
  swipe)  "$BUILD/simhid" "$(udid)" swipe "$1" "$2" "$3" "$4" ;;
  webapp)
    # Bring the home-screen web app to the front: `simctl launch
    # com.apple.webapp` reopens a web clip that has been opened before (on a
    # fresh one it shows a blank page). Otherwise: home screen, page 2 (where
    # Add to Home Screen puts it on a fresh device), tap the icon.
    simctl launch "$(udid)" com.apple.webapp >/dev/null 2>&1; sleep 3
    if ! wir pages 2>/dev/null | grep -q SafariViewService; then
      simctl terminate "$(udid)" com.apple.webapp >/dev/null 2>&1
      "$BUILD/simhid" "$(udid)" home >/dev/null; sleep 1.5
      "$BUILD/simhid" "$(udid)" swipe 360 500 60 500 >/dev/null; sleep 1.5
      "$BUILD/simhid" "$(udid)" tap "${1:-339}" "${2:-230}" >/dev/null; sleep 4
    fi
    wir pages | grep -q SafariViewService && echo "web app running" || echo "web app not found: check '$0 shot'" ;;
  shot)   simctl io "$(udid)" screenshot "${1:-$STATE/shot-$(date +%H%M%S).png}" 2>&1 | grep -v '^Detected\|^Note' ;;
  lockshot)
    # Side button (locks, screen off), then home (wakes to the lock screen,
    # still locked), let the Now Playing card settle, screenshot.
    "$BUILD/simhid" "$(udid)" lock >/dev/null; sleep 1; "$BUILD/simhid" "$(udid)" home >/dev/null; sleep "${LOCK_SETTLE:-3}"
    simctl io "$(udid)" screenshot "${1:-$STATE/lock-$(date +%H%M%S).png}" 2>&1 | grep -v '^Detected\|^Note'
    ;;
  unlock)
    # Passcode-less sim: home button then the swipe-up is a home press again.
    "$BUILD/simhid" "$(udid)" home >/dev/null; sleep 1; "$BUILD/simhid" "$(udid)" home >/dev/null ;;
  nowplaying)
    # Distil the captured log to the lines that matter (same grep as on the phone).
    since="${1:-}"
    grep -a -E 'PlaybackState changed|updateNowPlayingInfo|HTMLMediaElement::(play|pause|prepareForLoad|selectMediaResource)\(|rejecting promise|Setting nowPlayingInfo artwork|update transport controls|Image load failed|Received command|MediaSession::(setMetadata|setPlaybackState)|PlatformMediaSession::.*didReceiveRemoteControlCommand|setNowPlayingPlayer' "$STATE/media.log" \
      | { if [ -n "$since" ]; then awk -v s="$since" '$2 >= s'; else cat; fi; } \
      | sed -E 's/\{length = [0-9]+, bytes = [^}]*\}//g; s/(PlaybackState changed from [A-Za-z]+ to [A-Za-z]+) for .*(com\.apple\.[A-Za-z.]+) \(.*/\1 [\2]/; s/MRDMediaRemoteClient .*command = ([A-Za-z]+).*/command = \1/' \
      | python3 -c 'import re,sys
for l in sys.stdin:
    if "update transport controls" in l:
        ids = re.findall(r"(left|center|right): MRUTransportControlItem identifier: ([^|]*?) \|", l)
        l = l.split("MRUMPCMetadataDataSource")[0] + "lock-screen buttons: " + "  ".join(f"{k}={v.strip()}" for k, v in ids) + "\n"
    sys.stdout.write(l[:400].rstrip() + "\n")' | uniq
    ;;
  webapp-install)
    # Add the page open in Safari to the home screen as a web app, by taps
    # (iPhone 17 coordinates; Safari's share sheet sometimes needs a retry,
    # so check the screenshot this leaves). Then tap the icon it lands on.
    # A focused field (a login form) has the keyboard over the toolbar: blur it.
    wir js 'document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1' >/dev/null 2>&1; sleep 1
    "$BUILD/simhid" "$(udid)" tap 116 816 >/dev/null; sleep 2     # page menu
    "$BUILD/simhid" "$(udid)" tap 168 351 >/dev/null; sleep 3     # Share
    "$BUILD/simhid" "$(udid)" tap 328 780 >/dev/null; sleep 2     # View More
    "$BUILD/simhid" "$(udid)" tap 150 637 >/dev/null; sleep 7     # Add to Home Screen (the sheet is slow to fill)
    "$BUILD/simhid" "$(udid)" tap 352 100 >/dev/null; sleep 3     # Add
    simctl io "$(udid)" screenshot "$STATE/webapp-install.png" >/dev/null 2>&1
    echo "screenshot: $STATE/webapp-install.png (the new icon should be on it)"
    ;;
  ids)
    # WebKit's log id of Slopify's elements (active, spare, stand-in:
    # window.__slopifyAudio; the stand-in's face: window.__conduitFace), for np-audit.py: each element's volume is set to
    # (nearly) its own value and the setVolume line it logs is read back.
    # Ids last for the page's lifetime. Pass --app-substr ... to pick the page.
    for role in active spare standIn face; do
      n=$(( $(wc -l < "$STATE/media.log") ))
      wir js "$@" "(() => { const e = '$role' === 'face' ? window.__conduitFace : __slopifyAudio().$role; if (!e) return 'none'; e.volume = e.volume === 1 ? 0.999 : 1; return 'ok'; })()" >/dev/null
      sleep 2.5
      id=$(tail -n +"$n" "$STATE/media.log" | grep -o -E 'HTMLMediaElement::setVolume\([0-9A-F]+\)' | head -1 | grep -o -E '[0-9A-F]{8,}')
      echo "$role ${id:-?}"
    done ;;
  logfile) echo "$STATE/media.log" ;;
  syslog)  # the simulator's whole log: syslog <minutes> '<predicate>'
    simctl spawn "$(udid)" log show --last "${1:-2}m" --style compact --predicate "${2:-TRUEPREDICATE}" 2>/dev/null ;;
  udid)   udid ;;
  *)
    sed -n '/^## Commands/,/^## /p' "$HERE/README.md" 2>/dev/null || echo "see README.md"
    ;;
esac
