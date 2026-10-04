#!/bin/sh
# An unsigned Slopify.ipa for SideStore / AltStore, which sign it on the
# phone with the person's own Apple ID, plus the source (feed) SideStore
# reads to offer updates. CI runs this on every v* tag (release.yml); it
# also works locally with Xcode installed.
#   ./build-ipa.sh [version]     -> dist/Slopify-<version>.ipa, dist/sidestore-source.json
set -eu
cd "$(dirname "$0")"
VERSION="${1:-$(node -p "require('../package.json').version")}"
# Xcode itself, when the command line points at the bare Command Line Tools.
case "${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null)}" in *CommandLineTools*|'') export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer;; esac
export LANG="${LANG:-en_US.UTF-8}"

[ -d node_modules ] || npm ci
[ -d ios ] || CI=1 npx expo prebuild -p ios --no-install
[ -d ios/Pods ] || (cd ios && pod install)

xcodebuild -workspace ios/Slopify.xcworkspace -scheme Slopify -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO -quiet

rm -rf dist && mkdir -p dist/Payload
cp -R ios/build/Build/Products/Release-iphoneos/Slopify.app dist/Payload/
PL=dist/Payload/Slopify.app/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" -c "Set :CFBundleVersion $VERSION" "$PL"
(cd dist && zip -qry "Slopify-$VERSION.ipa" Payload && rm -rf Payload)

node sidestore-source.mjs "$VERSION" "dist/Slopify-$VERSION.ipa" "$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' ios/build/Build/Products/Release-iphoneos/Slopify.app/Info.plist)" > dist/sidestore-source.json
ls -la dist
