#!/usr/bin/env bash
# Release notes for a tag: one bullet per commit since the previous tag
# (merges and test-only commits left out), the apps and where to get them,
# then the compare link.
# Usage: tools/release-notes.sh v0.1.112 [owner/repo]
# ASSETS (newline-separated file names) limits the download links to the
# files the release really has; unset, every file is linked.
set -euo pipefail
tag="$1"; repo="${2:-lukasbaxter/slopify}"; v="${tag#v}"
prev=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
range="${prev:+$prev..}$tag"
git log --no-merges --format='%s' "$range" | grep -v -E '^(e2e|test|tests|ci|lint)[:(]' | sed 's/^/- /' || true

dl="https://github.com/$repo/releases/download/$tag"
# A link to the file when the release has it, else the fallback text.
file() { if [ -z "${ASSETS+x}" ] || grep -qxF "$1" <<<"$ASSETS"; then echo "[$1]($dl/$1)"; else echo "$2"; fi; }
cat <<EOF

## Apps

| App | Runs on | Get it |
| --- | --- | --- |
| Web app | Any browser (computer, phone, tablet) | Your server's address |
| Mac | macOS, Apple silicon | $(file "Slopify-$v-arm64.dmg" "not in this release") |
| Windows | Windows 10 / 11 | $(file "Slopify.Setup.$v.exe" "not in this release") (installer), $(file "Slopify.$v.exe" "no portable build") (portable) |
| Linux | Desktop Linux | Build from \`desktop/\` (AppImage / deb; not attached to releases yet) |
| Android | Phones and tablets | $(file "Slopify-$v.apk" "not in this release") |
| iPhone / iPad | iOS | The Home Screen web app, or $(file "Slopify-$v.ipa" "the SideStore app (not in this release)") through [SideStore](https://github.com/$repo/blob/main/docs/iphone.md) |
| TV | Android TV / Google TV | Build from \`tv/\` and sideload (not attached to releases yet) |
| Home Assistant | Home Assistant | The integration, through HACS ([setup](https://github.com/$repo/blob/main/docs/home-assistant.md)) |
| Speakers | Chromecast, BluOS, DIY \`slopify-speaker/1\` | No app: the server finds and plays to them |
EOF
echo
if [ -n "$prev" ]; then echo "**Full Changelog**: https://github.com/$repo/compare/$prev...$tag"; fi
