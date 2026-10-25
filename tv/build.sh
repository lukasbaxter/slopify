#!/bin/bash
# Build on .85 inside the Android SDK container. Output: tv/slopify-tv.apk
set -e
cd "$(dirname "$0")"
rsync -a --delete --exclude .gradle --exclude build --exclude 'app/build' --exclude '*.apk' ./ server:/home/lukas/build/slopify-tv/
ssh server 'docker run --rm -v android-sdk:/opt/android-sdk -v gradle-cache:/root/.gradle -v android-keys:/root/.android -v /home/lukas/build/slopify-tv:/project -w /project thyrlian/android-sdk:latest bash -lc "gradle --no-daemon -q assembleRelease 2>&1 | tail -40; ls -la app/build/outputs/apk/release/"'
rsync -a server:/home/lukas/build/slopify-tv/app/build/outputs/apk/release/app-release.apk ./slopify-tv.apk
ls -la slopify-tv.apk
