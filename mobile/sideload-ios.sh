#!/bin/sh
# Build the phone app and install it on a plugged-in (or paired, same Wi-Fi)
# iPhone, signed with a free Apple ID: no Apple Developer Program needed.
# A free signature lasts 7 days; run this again to renew it (your sign-in
# and settings in the app survive a reinstall).
#
# Once, before the first run:
#   1. Xcode > Settings > Accounts > + > Apple ID: sign in (a "Personal Team"
#      appears).
#   2. On the iPhone: Settings > Privacy & Security > Developer Mode > On
#      (it restarts).
# After the first install, on the iPhone: Settings > General > VPN & Device
# Management > your Apple ID > Trust.
#
#   ./sideload-ios.sh                 # first paired iPhone, your personal team
#   TEAM=ABCDE12345 ./sideload-ios.sh # a specific team
#   BUNDLE_ID=com.you.slopify ./sideload-ios.sh   # if the id is taken
#   EXPO_PUBLIC_SLOPIFY_URL=https://music.example.com/ ./sideload-ios.sh
set -eu
cd "$(dirname "$0")"
# Xcode itself, when the command line points at the bare Command Line Tools.
case "${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null)}" in *CommandLineTools*|'') export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer;; esac
export LANG="${LANG:-en_US.UTF-8}"

DEVICE="${DEVICE:-$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && /paired/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')}"
[ -n "$DEVICE" ] || { echo "No paired iPhone found: plug it in, unlock it and tap Trust."; exit 1; }

# The personal team Xcode made when you added your Apple ID.
TEAM="${TEAM:-$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | sed -n 's/.*teamID = \([A-Z0-9]*\);.*/\1/p' | head -1)}"
[ -n "$TEAM" ] || { echo "No team found: add your Apple ID in Xcode > Settings > Accounts first."; exit 1; }

[ -d node_modules ] || npm ci
if [ ! -d ios ]; then CI=1 npx expo prebuild -p ios --no-install; fi
[ -d ios/Pods ] || (cd ios && pod install)

echo "Building for $DEVICE with team $TEAM..."
xcodebuild -workspace ios/Slopify.xcworkspace -scheme Slopify -configuration Release \
  -destination "id=$DEVICE" -derivedDataPath ios/build -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  ${BUNDLE_ID:+PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID"} -quiet

xcrun devicectl device install app --device "$DEVICE" ios/build/Build/Products/Release-iphoneos/Slopify.app
echo "Installed. The signature lasts 7 days: run this again before $(date -v+7d '+%a %b %d')."
