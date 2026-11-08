#!/bin/bash
# The phone app (mobile/) comes back after iOS ended its page's process in
# the background: the page must be showing again within 15 s, by itself.
# Exit 0 = it came back, 1 = still black (no page).
#
# Needs: `ios-sim.sh up`, a server the app can reach, and the app built for
# the simulator with that address and signed in once, e.g.
#   cd mobile && npx expo prebuild -p ios && (cd ios && pod install)
#   EXPO_PUBLIC_SLOPIFY_URL=http://127.0.0.1:8090 xcodebuild -workspace ios/Slopify.xcworkspace \
#     -scheme Slopify -configuration Release -sdk iphonesimulator \
#     -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build-sim CODE_SIGNING_ALLOWED=NO
#   APP=…/Release-iphonesimulator/Slopify.app tools/ios-sim/app-process-killed.sh
# Before the fix (10-08, no onContentProcessDidTerminate): still black 30 s later.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
H="$HERE/ios-sim.sh"
U="$("$H" udid)"
APP="${APP:-$REPO/mobile/ios/build-sim/Build/Products/Release-iphonesimulator/Slopify.app}"
BID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
wc() { ps -eo pid,command | grep -E 'com\.apple\.WebKit\.WebContent' | grep -v grep | awk '{print $1}' | sort -n; }
page() { "$H" js --app-substr process-Slopify 'document.getElementById("root") ? document.getElementById("root").children.length : 0' 2>/dev/null; }

xcrun simctl install "$U" "$APP"
xcrun simctl terminate "$U" "$BID" >/dev/null 2>&1; sleep 1
before="$(wc)"
xcrun simctl launch "$U" "$BID" >/dev/null; sleep 8
mine="$(comm -13 <(echo "$before") <(wc) | tr '\n' ' ')"
[ "$(page)" = 1 ] || { echo "the app did not show its page after launch (signed in? server up?)"; exit 2; }
echo "app content process(es): $mine"
"$H" home >/dev/null; sleep 3
# What iOS does to a backgrounded app's web content under memory pressure.
kill -9 $mine
sleep 3
xcrun simctl launch "$U" "$BID" >/dev/null
for i in $(seq 1 15); do
  sleep 1
  if [ "$(page)" = 1 ]; then echo "page back ${i} s after the app came back"; exit 0; fi
done
"$H" shot "$HERE/.state/app-process-killed.png" >/dev/null 2>&1
echo "FAIL: no page 15 s after the app came back (screenshot: $HERE/.state/app-process-killed.png)"; exit 1
