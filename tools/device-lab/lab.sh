#!/usr/bin/env bash
# Slopify device lab: browsers, Android phone, Android TV, all headless on a
# Linux box. Run from the Mac (it syncs this working tree to the lab host and
# runs itself there over ssh) or on the lab host itself (LAB_LOCAL=1).
# See README.md in this folder.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/lab.env" ] && . "$HERE/lab.env"
LAB_HOST="${LAB_HOST:-}"
LAB_PASSWORD="${LAB_PASSWORD:-lab password 123}"   # the fixture server's admin; set by `serve`
DEV_PORT="${DEV_PORT:-8190}"                       # the server the emulators use
LANE_PORT="${LANE_PORT:-8180}"                     # browser lanes: 8180..8183
REPO_URL="${REPO_URL:-https://github.com/lukasbaxter/slopify.git}"
GH_REPO="${GH_REPO:-lukasbaxter/slopify}"

usage() {
  echo "lab.sh <command> [args]          (from the Mac: syncs the tree first, then runs on LAB_HOST)"
  echo "  setup                          install everything under the lab dir (idempotent, no sudo)"
  echo "  sync                           (Mac) rsync this working tree to the lab host's clone"
  echo "  build                          npm ci when the lockfile changed, npm run build"
  echo "  browsers [lanes] [--gates]     e2e suite, lanes in parallel: chromium firefox webkit phone"
  echo "                                 (--gates: firefox/webkit also run the chromium-only specs)"
  echo "  serve | serve-stop             fixture server for the emulators on 127.0.0.1:DEV_PORT (8190)"
  echo "  android-up <phone|tv30|gtv>... boot emulators headless;  android-down [names|all]"
  echo "  status                         emulators, servers, load"
  echo "  apk-app | apk-tv               build the lab copies of the release APK / tv/slopify-tv.apk"
  echo "  phone-test                     Chrome on the phone: play, media session, screen off, PWA"
  echo "  app-test                       the Android app (latest release; APP_APK=<file> for another) on the phone"
  echo "  apk-src                        build the Android app from this tree, pointed at the lab server"
  echo "  tv-test [tv30|gtv]...          the TV app on the TV emulators (default: those running)"
  echo "  all                            everything above, then the emulators down"
  echo "  shot <phone|tv30|gtv> [file]   screenshot"
  echo "  logs                           where the logs and results are"
}

# ---------------------------------------------------------------- the Mac side
remote() {
  [ -n "$LAB_HOST" ] || { echo "LAB_HOST is not set: copy lab.env.example to lab.env (or run on the lab host with LAB_LOCAL=1)" >&2; exit 2; }
  local q=""; for a in "$@"; do q+=" $(printf %q "$a")"; done
  # RELEASE_URL: the server the release APK was built with (the repository's
  # SLOPIFY_URL Actions variable), needed to repoint it; gh knows it here.
  local rel="${RELEASE_URL:-}"
  if [ -z "$rel" ] && [[ " $* " == *" app-test "* || " $* " == *" apk-app "* || " $* " == *" all "* ]] && command -v gh >/dev/null; then
    rel="$(gh variable get SLOPIFY_URL -R "$GH_REPO" 2>/dev/null || true)"
  fi
  ssh -o BatchMode=yes "$LAB_HOST" "LAB_LOCAL=1 RELEASE_URL=$(printf %q "$rel") APP_APK=$(printf %q "${APP_APK:-}") bash \"\${LAB_DIR:-\$HOME/apps/slopify-lab}/slopify/tools/device-lab/lab.sh\"$q"
}
sync_tree() {
  [ -n "$LAB_HOST" ] || { echo "LAB_HOST is not set (lab.env)" >&2; exit 2; }
  local root; root="$(cd "$HERE/../.." && pwd)"
  local dir; dir="$(ssh -o BatchMode=yes "$LAB_HOST" 'echo "${LAB_DIR:-$HOME/apps/slopify-lab}"')"
  ssh -o BatchMode=yes "$LAB_HOST" "mkdir -p '$dir/slopify'"
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude test-results --exclude playwright-report \
    --exclude /data --exclude 'tools/device-lab/results' --exclude 'tools/device-lab/lab.env' \
    --exclude dist --exclude 'mobile/ios' --exclude 'desktop/release' \
    "$root/" "$LAB_HOST:$dir/slopify/"
  echo "synced $root -> $LAB_HOST:$dir/slopify"
}

if [ "${LAB_LOCAL:-}" != 1 ]; then
  cmd="${1:-help}"
  case "$cmd" in
    sync) sync_tree ;;
    help|-h|--help) usage ;;
    setup|android-up|android-down|status|shot|serve-stop|logs) remote "$@" ;;
    *) sync_tree >/dev/null; remote "$@" ;;
  esac
  exit
fi

# ----------------------------------------------------------- the lab host side
LAB="${LAB_DIR:-$HOME/apps/slopify-lab}"
REPO="$LAB/slopify"
SDK="$LAB/android-sdk"
BT="$SDK/build-tools/36.1.0"
ADB="$SDK/platform-tools/adb"
LOGS="$LAB/logs"
RESULTS="$LAB/results"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" ANDROID_AVD_HOME="$LAB/avd" ANDROID_USER_HOME="$LAB/android-home" ANDROID_EMULATOR_HOME="$LAB/android-home"
export PLAYWRIGHT_BROWSERS_PATH="$LAB/ms-playwright" PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
export PATH="$LAB/node/bin:$LAB/ffmpeg/bin:$SDK/platform-tools:$PATH"
export ADB
unset DISPLAY WAYLAND_DISPLAY   # nothing may open a window on the desktop
NICE=(nice -n 10)
mkdir -p "$LOGS" "$RESULTS"

NODE_VER=22.23.4
NODE_SHA=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
CLT_ZIP=commandlinetools-linux-14742923_latest.zip
IMG_PHONE="system-images;android-36;google_apis_playstore;x86_64"
IMG_TV30="system-images;android-30;android-tv;x86"
IMG_GTV="system-images;android-36;google-tv;x86_64"

# name -> avd, console port, image, device profile, ram, cores
avd_of()  { case "$1" in phone) echo slab-phone ;; tv30) echo slab-tv30 ;; gtv) echo slab-gtv ;; *) echo "unknown device $1 (phone | tv30 | gtv)" >&2; exit 2 ;; esac; }
port_of() { case "$1" in phone) echo 5560 ;; tv30) echo 5562 ;; gtv) echo 5564 ;; esac; }
img_of()  { case "$1" in phone) echo "$IMG_PHONE" ;; tv30) echo "$IMG_TV30" ;; gtv) echo "$IMG_GTV" ;; esac; }
prof_of() { case "$1" in phone) echo pixel_8 ;; *) echo tv_1080p ;; esac; }
ram_of()  { case "$1" in phone) echo 4096 ;; *) echo 2048 ;; esac; }
serial_of() { echo "emulator-$(port_of "$1")"; }

adb_up() { "$ADB" start-server >/dev/null 2>&1 </dev/null || true; }


# ------------------------------------------------------------------- setup
setup() {
  mkdir -p "$LAB" && cd "$LAB"
  if [ ! -x node/bin/node ]; then
    echo "== Node $NODE_VER"
    curl -sSfLO "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.xz"
    echo "$NODE_SHA  node-v$NODE_VER-linux-x64.tar.xz" | sha256sum -c --quiet
    tar xf "node-v$NODE_VER-linux-x64.tar.xz" && ln -sfn "node-v$NODE_VER-linux-x64" node && rm "node-v$NODE_VER-linux-x64.tar.xz"
  fi
  [ -d "$REPO/.git" ] || { echo "== clone"; git clone -q "$REPO_URL" "$REPO"; }
  if [ ! -x ffmpeg/bin/ffmpeg ]; then
    echo "== ffmpeg (static build; the server and some specs need it)"
    mkdir -p ffmpeg && curl -sSfL https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz | tar xJ -C ffmpeg --strip-components=1
  fi
  build
  echo "== Playwright browsers"
  (cd "$REPO" && "${NICE[@]}" npx playwright install chromium firefox webkit 2>&1 | grep -vE "^\s*$|║|╔|╚" | tail -3) || true
  # WebKit wants four libraries this desktop does not have; no sudo, so take
  # them from the distro's .debs and put them next to WebKit's own.
  if ! ls "$LAB"/ms-playwright/webkit-*/minibrowser-wpe/sys/lib/libmanette-0.2.so.0 >/dev/null 2>&1; then
    echo "== WebKit's missing system libraries"
    rm -rf "$LAB/syslibs" && mkdir -p "$LAB/syslibs/debs" && (cd "$LAB/syslibs/debs" && apt-get download libharfbuzz-icu0 libmanette-0.2-0 libenchant-2-2 libhyphen0 >/dev/null)
    for d in "$LAB"/syslibs/debs/*.deb; do dpkg-deb -x "$d" "$LAB/syslibs/root"; done
    for d in "$LAB"/ms-playwright/webkit-*/minibrowser-*/sys/lib; do cp -a "$LAB"/syslibs/root/usr/lib/x86_64-linux-gnu/*.so* "$d/"; done
  fi
  if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    echo "== Android command-line tools"
    mkdir -p "$SDK/cmdline-tools" && curl -sSfLo /tmp/slab-clt.zip "https://dl.google.com/android/repository/$CLT_ZIP"
    unzip -q /tmp/slab-clt.zip -d "$SDK/cmdline-tools" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest" && rm /tmp/slab-clt.zip
  fi
  echo "== Android SDK packages (several GB the first time)"
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
  "${NICE[@]}" "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platform-tools" "emulator" "build-tools;36.1.0" "$IMG_PHONE" "$IMG_TV30" "$IMG_GTV" 2>&1 | tr '\r' '\n' | grep -vE "^\[|^\s*$|Loading|Fetch|Computing|Unzipping|Downloading" | tail -3 || true
  mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$LAB/tools" "$LAB/apks"
  for n in phone tv30 gtv; do
    if [ ! -d "$ANDROID_AVD_HOME/$(avd_of $n).avd" ]; then
      echo "== AVD $(avd_of $n)"
      echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -f -n "$(avd_of $n)" -k "$(img_of $n)" -d "$(prof_of $n)" >/dev/null
      sed -i "s/^hw.ramSize=.*/hw.ramSize=$(ram_of $n)/" "$ANDROID_AVD_HOME/$(avd_of $n).avd/config.ini"
    fi
  done
  if [ ! -f "$LAB/tools/apktool.jar" ]; then
    echo "== apktool"
    curl -sSfL -o "$LAB/tools/apktool.jar" "$(curl -sSfL https://api.github.com/repos/iBotPeaches/Apktool/releases/latest | python3 -c 'import sys,json;print([a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith(".jar")][0])')"
  fi
  [ -f "$LAB/lab-debug.keystore" ] || keytool -genkeypair -keystore "$LAB/lab-debug.keystore" -storepass android -keypass android -alias lab -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Slopify device lab" >/dev/null 2>&1
  echo "setup done: $LAB"
}

build() {
  cd "$REPO"
  local stamp="$LAB/.npm-lock.sha" h; h="$(sha256sum package-lock.json | cut -c1-64)"
  if [ ! -d node_modules ] || [ "$(cat "$stamp" 2>/dev/null)" != "$h" ]; then
    echo "== npm ci"; "${NICE[@]}" npm ci --no-audit --no-fund >"$LOGS/npm-ci.log" 2>&1 && echo "$h" >"$stamp"
  fi
  echo "== build"; "${NICE[@]}" npm run build >"$LOGS/build.log" 2>&1 || { tail -20 "$LOGS/build.log"; exit 1; }
}

# ----------------------------------------------------------------- browsers
browsers() {
  local lanes=() gates=0
  for a in "$@"; do case "$a" in --gates) gates=1 ;; *) lanes+=("$a") ;; esac; done
  [ ${#lanes[@]} -gt 0 ] || lanes=(chromium firefox webkit phone)
  build
  cd "$REPO"; mkdir -p tools/device-lab/results
  local p=$LANE_PORT pids=() tag
  for lane in "${lanes[@]}"; do
    tag=$lane; [ $gates = 1 ] && [ "$lane" != phone ] && tag="$lane-gates"
    echo "== lane $tag on port $p"
    LAB_LANE=$lane LAB_PORT=$p LAB_DATA="/tmp/slopify-lab-$tag" LAB_OPEN_GATES=$gates "${NICE[@]}" \
      npx playwright test -c tools/device-lab/playwright.lab.config.ts >"tools/device-lab/results/$tag.log" 2>&1 &
    pids+=($!); p=$((p + 1))
  done
  for pid in "${pids[@]}"; do wait "$pid" || true; done
  for lane in "${lanes[@]}"; do
    tag=$lane; [ $gates = 1 ] && [ "$lane" != phone ] && tag="$lane-gates"
    node -e '
      const r = require(process.argv[1]); const out = [];
      const walk = (s) => { for (const x of s.specs || []) for (const t of x.tests) { const res = t.results[t.results.length - 1] || {}; if (t.status === "unexpected" || t.status === "flaky") out.push(`  ${t.status === "flaky" ? "FLAKY" : "FAIL "} ${x.file}:${x.line} ${x.title}\n        ${(res.error?.message || "").split("\n").filter(Boolean).slice(0, 3).join(" | ").replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300)}`); } for (const c of s.suites || []) walk(c); };
      for (const s of r.suites) walk(s);
      const st = r.stats; console.log(`${process.argv[2].padEnd(15)} passed ${st.expected}  failed ${st.unexpected}  flaky ${st.flaky}  skipped ${st.skipped}  (${Math.round(st.duration / 1000)} s)`); if (out.length) console.log(out.join("\n"));
    ' "$REPO/tools/device-lab/results/$tag.json" "$tag" 2>/dev/null || echo "$tag: no report (see tools/device-lab/results/$tag.log)"
  done
  echo "reports: $REPO/tools/device-lab/results/<lane>.log|.json, traces and screenshots in results/<lane>/"
}

# ---------------------------------------------------------- fixture server
serve() {
  serve_stop >/dev/null 2>&1 || true
  build
  cd "$REPO"; rm -rf /tmp/slopify-lab-dev
  # 127.0.0.1 only: the emulators reach it through `adb reverse` (localhost on
  # the device), so nothing on the LAN sees the lab server.
  NODE_ENV=test SAVE_TO_LIBRARY=0 SPEAKERS=0 MUSIC_DIR=fixtures/music DATA_DIR=/tmp/slopify-lab-dev HOST=127.0.0.1 PORT=$DEV_PORT \
    LOG_LEVEL=info LOGIN_RATE_MAX=1000 RATE_MAX=100000 setsid nohup "${NICE[@]}" node server/dist/index.js >"$LOGS/devserver.log" 2>&1 </dev/null &
  echo $! >"$LAB/devserver.pid"
  for _ in $(seq 1 60); do curl -sf "127.0.0.1:$DEV_PORT/healthz" >/dev/null && break; sleep 0.5; done
  kill -0 "$(cat "$LAB/devserver.pid")" 2>/dev/null || { echo "fixture server did not start:"; tail -3 "$LOGS/devserver.log"; exit 1; }
  local tok
  tok="$(curl -sf -XPOST "127.0.0.1:$DEV_PORT/api/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
  curl -sf -XPOST "127.0.0.1:$DEV_PORT/api/auth/password" -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "{\"password\":\"$LAB_PASSWORD\"}" >/dev/null
  echo "fixture server on 127.0.0.1:$DEV_PORT (admin / $LAB_PASSWORD), log $LOGS/devserver.log"
}
serve_stop() {
  # Whatever node listens on DEV_PORT on loopback (ours; started by serve).
  local pids; pids="$( { cat "$LAB/devserver.pid" 2>/dev/null; ss -ltnpH "sport = :$DEV_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2; } | sort -u)"
  for p in $pids; do grep -q 'server/dist/index.js' "/proc/$p/cmdline" 2>/dev/null && kill "$p" && echo "fixture server stopped ($p)"; done
  rm -f "$LAB/devserver.pid"
  for _ in $(seq 1 20); do curl -sf "127.0.0.1:$DEV_PORT/healthz" >/dev/null || break; sleep 0.25; done
  return 0
}
# Each device test starts from a fresh server (fresh data, the build just
# made: the server reads web/dist once, at start).
ensure_server() { if [ "${KEEP_SERVER:-}" = 1 ] && curl -sf "127.0.0.1:$DEV_PORT/healthz" >/dev/null; then return; fi; serve; }

# ---------------------------------------------------------------- emulators
android_up() {
  adb_up
  [ $# -gt 0 ] || set -- phone
  for n in "$@"; do
    local s; s="$(serial_of "$n")"
    if "$ADB" -s "$s" get-state >/dev/null 2>&1; then echo "$n already up ($s)"; continue; fi
    local cores=2; [ "$n" = phone ] && cores=4
    # -no-window: nothing on the desktop. -no-audio: no sound from the
    # speakers (media still plays and its clock runs).
    setsid nohup "${NICE[@]}" "$SDK/emulator/emulator" -avd "$(avd_of "$n")" -port "$(port_of "$n")" -cores $cores \
      -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot-save >"$LOGS/emu-$n.log" 2>&1 </dev/null &
  done
  for n in "$@"; do
    local s; s="$(serial_of "$n")"
    timeout 60 "$ADB" -s "$s" wait-for-device </dev/null
    local b=""; for _ in $(seq 1 120); do b="$("$ADB" -s "$s" shell getprop sys.boot_completed 2>/dev/null </dev/null | tr -d '\r')"; [ "$b" = 1 ] && break; sleep 2; done
    [ "$b" = 1 ] || { echo "$n did not finish booting, see $LOGS/emu-$n.log"; exit 1; }
    "$ADB" -s "$s" shell settings put system screen_off_timeout 1800000 </dev/null >/dev/null
    if [ "$n" = tv30 ]; then
      # The Fire TV stand-in: Fire OS 8 is Android 11 without Google Play
      # services. This image ships them, so they are switched off.
      for p in com.google.android.gms com.android.vending com.google.android.gsf; do "$ADB" -s "$s" shell pm disable-user --user 0 $p </dev/null >/dev/null 2>&1 || true; done
    fi
    echo "$n up ($s, Android $("$ADB" -s "$s" shell getprop ro.build.version.release </dev/null | tr -d '\r'))"
  done
}
android_down() {
  adb_up
  [ $# -gt 0 ] && [ "$1" != all ] || set -- phone tv30 gtv
  for n in "$@"; do
    local s; s="$(serial_of "$n")"
    if "$ADB" -s "$s" get-state >/dev/null 2>&1; then "$ADB" -s "$s" emu kill >/dev/null 2>&1 </dev/null || true; echo "$n down"; fi
  done
  sleep 3
  pgrep -f "emulator.*-avd slab-" >/dev/null && { sleep 5; pkill -f "qemu-system.*-avd slab-" 2>/dev/null || true; }
  return 0
}
running() { adb_up; for n in phone tv30 gtv; do "$ADB" -s "$(serial_of $n)" get-state >/dev/null 2>&1 </dev/null && echo "$n"; done; return 0; }
status() {
  echo "emulators: $(running | xargs echo)"
  curl -sf "127.0.0.1:$DEV_PORT/healthz" >/dev/null && echo "fixture server: 127.0.0.1:$DEV_PORT" || echo "fixture server: down"
  echo "load: $(cut -d' ' -f1-3 /proc/loadavg), free: $(free -g | awk '/Mem/{print $7}') GB"
}

# ------------------------------------------------------------------- APKs
sign() { # in out
  "$BT/zipalign" -f -P 16 4 "$1" "$1.al" && "$BT/apksigner" sign --ks "$LAB/lab-debug.keystore" --ks-pass pass:android --out "$2" "$1.al" 2>&1 | grep -v WARNING || true
  rm -f "$1.al" "$2.idsig"
}
apk_app() {
  cd "$LAB/apks"
  # The latest release's APK (public GitHub API, no login).
  local url name
  url="$(curl -sSfL "https://api.github.com/repos/$GH_REPO/releases/latest" | python3 -c 'import sys,json;print([a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith(".apk")][0])')"
  name="$(basename "$url")"
  [ -f "$name" ] || { echo "== download $name"; curl -sSfLo "$name" "$url"; }
  [ -n "${RELEASE_URL:-}" ] || { echo "RELEASE_URL unset: the server $name was built with (gh variable get SLOPIFY_URL; lab.sh on the Mac passes it)" >&2; exit 2; }
  local out="${name%.apk}-lab-$DEV_PORT.apk"
  # 1) the server in the Hermes bundle, in place; 2) cleartext http allowed
  #    (the release forbids it, and the lab server is http://localhost).
  python3 -I "$HERE/patch-apk.py" "$name" u.apk "$RELEASE_URL" "http://localhost:$DEV_PORT"
  rm -rf dec && java -jar "$LAB/tools/apktool.jar" d -s -f -o dec u.apk >/dev/null 2>&1
  grep -q 'usesCleartextTraffic="true"' dec/AndroidManifest.xml || sed -i 's/ android:usesCleartextTraffic="false"//; s/<application /<application android:usesCleartextTraffic="true" /' dec/AndroidManifest.xml
  rm -f "$out"
  java -jar "$LAB/tools/apktool.jar" b -o b.apk dec >"$LOGS/apktool-app.log" 2>&1 || { tail -5 "$LOGS/apktool-app.log" >&2; return 1; }
  sign b.apk "$out"; rm -rf u.apk b.apk dec
  echo "$LAB/apks/$out"
}
apk_tv() {
  cd "$LAB/apks"
  local out="slopify-tv-lab-$DEV_PORT.apk"
  rm -rf tvdec && java -jar "$LAB/tools/apktool.jar" d -f -o tvdec "$REPO/tv/slopify-tv.apk" >/dev/null 2>&1
  # BuildConfig.SERVER_URL (and its inlined copies): whatever the build baked in.
  local baked; baked="$(sed -n 's/.*SERVER_URL:Ljava\/lang\/String; = "\(.*\)"/\1/p' tvdec/smali/com/lukasbaxter/slopify/tv/BuildConfig.smali)"
  if [ -n "$baked" ]; then grep -rl --fixed-strings "\"$baked\"" tvdec/smali | xargs sed -i "s#\"$baked\"#\"http://localhost:$DEV_PORT\"#g"; fi
  # WebView DevTools for the harness (the release does not enable them).
  sed -i '/^\.method protected onCreate(Landroid\/os\/Bundle;)V/,/^    \.locals/{/^    \.locals/a\
\
    const/4 v0, 0x1\
\
    invoke-static {v0}, Landroid/webkit/WebView;->setWebContentsDebuggingEnabled(Z)V
}' tvdec/smali/com/lukasbaxter/slopify/tv/MainActivity.smali
  grep -q 'usesCleartextTraffic' tvdec/AndroidManifest.xml || sed -i 's/<application /<application android:usesCleartextTraffic="true" /' tvdec/AndroidManifest.xml
  # A failed rebuild must not leave the last run's APK to be installed as if it were this one.
  rm -f "$out"
  java -jar "$LAB/tools/apktool.jar" b -o b.apk tvdec >"$LOGS/apktool-tv.log" 2>&1 || { tail -5 "$LOGS/apktool-tv.log" >&2; return 1; }
  sign b.apk "$out"; rm -rf b.apk tvdec
  echo "baked server ${baked:-none} -> http://localhost:$DEV_PORT" >&2
  echo "$LAB/apks/$out"
}

# ------------------------------------------------------------- device tests
need_up() { "$ADB" -s "$(serial_of "$1")" get-state >/dev/null 2>&1 </dev/null || android_up "$1"; }
phone_test() {
  ensure_server; need_up phone
  local out="$RESULTS/phone-$(date +%m%d-%H%M)"
  cd "$REPO" && node tools/device-lab/phone-chrome.mjs "$(serial_of phone)" "$DEV_PORT" "$LAB_PASSWORD" "$out"
}
# The phone app built from this tree (mobile/), its server the lab's own:
# what a change to the app's native side needs before it is released.
apk_src() {
  local jdk="${LAB_JDK:-$HOME/apps/jdk17}"
  [ -x "$jdk/bin/java" ] && export JAVA_HOME="$jdk" PATH="$jdk/bin:$PATH"
  cd "$REPO/mobile"
  nice -n 10 npm ci --no-audit --no-fund >"$LOGS/apk-src-npm.log" 2>&1
  CI=1 EXPO_PUBLIC_SLOPIFY_URL="http://localhost:$DEV_PORT" nice -n 10 npx expo prebuild --platform android --no-install --clean >"$LOGS/apk-src-prebuild.log" 2>&1
  (cd android && EXPO_PUBLIC_SLOPIFY_URL="http://localhost:$DEV_PORT" nice -n 10 ./gradlew assembleRelease --no-daemon >"$LOGS/apk-src-gradle.log" 2>&1) || { tail -30 "$LOGS/apk-src-gradle.log" >&2; return 1; }
  local out="$LAB/apks/slopify-src-lab-$DEV_PORT.apk"
  cp android/app/build/outputs/apk/release/app-release.apk "$out"
  echo "$out"
}
app_test() {
  ensure_server; need_up phone
  local apk; apk="${APP_APK:-$(apk_app | tail -1)}"
  local out="$RESULTS/app-$(date +%m%d-%H%M)"
  cd "$REPO" && node tools/device-lab/app-test.mjs "$(serial_of phone)" "$DEV_PORT" "$LAB_PASSWORD" "$out" "$apk"
}
tv_test() {
  ensure_server
  [ $# -gt 0 ] || set -- $(running | grep -v phone || true)
  [ $# -gt 0 ] || set -- tv30
  local apk; apk="$(apk_tv | tail -1)"
  local out="$RESULTS/tv-$(date +%m%d-%H%M)" rc=0
  for n in "$@"; do
    need_up "$n"
    (cd "$REPO" && node tools/device-lab/tv-test.mjs "$(serial_of "$n")" "$DEV_PORT" "$LAB_PASSWORD" "$out" "$apk" "$n") || rc=1
  done
  return $rc
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  setup) setup ;;
  build) build ;;
  browsers) browsers "$@" ;;
  serve) serve ;;
  serve-stop) serve_stop ;;
  android-up) android_up "$@" ;;
  android-down) android_down "$@" ;;
  status) status ;;
  apk-app) apk_app ;;
  apk-tv) apk_tv ;;
  apk-src) apk_src ;;
  phone-test) phone_test ;;
  app-test) app_test ;;
  tv-test) tv_test "$@" ;;
  shot) adb_up; "$ADB" -s "$(serial_of "${1:-phone}")" exec-out screencap -p >"${2:-$RESULTS/shot-${1:-phone}.png}"; echo "${2:-$RESULTS/shot-${1:-phone}.png}" ;;
  logs) echo "logs: $LOGS"; echo "device results: $RESULTS"; echo "browser lanes: $REPO/tools/device-lab/results"; ls -t "$RESULTS" | head ;;
  all)
    rc=0
    browsers || rc=1
    android_up phone tv30
    phone_test || rc=1
    app_test || rc=1
    tv_test tv30 || rc=1
    android_down phone tv30
    android_up gtv; tv_test gtv || rc=1; android_down gtv
    serve_stop || true
    exit $rc ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
