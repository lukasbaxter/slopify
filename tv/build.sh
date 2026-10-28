#!/bin/bash
# Build the TV app inside the Android SDK container on a Docker host.
#   BUILD_HOST=myhost SLOPIFY_URL=https://music.example.com ./build.sh
# BUILD_HOST: an ssh host with Docker (unset: this machine). SLOPIFY_URL: the
# server the app opens (unset: it asks on the TV). Output: tv/slopify-tv.apk
set -e
cd "$(dirname "$0")"
dir="${BUILD_DIR:-build/slopify-tv}"
on() { if [ -n "$BUILD_HOST" ]; then ssh "$BUILD_HOST" "$1"; else bash -c "$1"; fi; }
if [ -n "$BUILD_HOST" ]; then
  ssh "$BUILD_HOST" "mkdir -p $dir"
  rsync -a --delete --exclude .gradle --exclude build --exclude 'app/build' --exclude '*.apk' ./ "$BUILD_HOST:$dir/"
  src="$dir"
else
  src="$PWD"
fi
on "cd $src && docker run --rm -v android-sdk:/opt/android-sdk -v gradle-cache:/root/.gradle -v android-keys:/root/.android -v \$PWD:/project -w /project thyrlian/android-sdk:latest bash -lc 'gradle --no-daemon -q assembleRelease ${SLOPIFY_URL:+-PslopifyUrl=$SLOPIFY_URL} 2>&1 | tail -40; ls -la app/build/outputs/apk/release/'"
if [ -n "$BUILD_HOST" ]; then rsync -a "$BUILD_HOST:$dir/app/build/outputs/apk/release/app-release.apk" ./slopify-tv.apk; else cp app/build/outputs/apk/release/app-release.apk ./slopify-tv.apk; fi
ls -la slopify-tv.apk
