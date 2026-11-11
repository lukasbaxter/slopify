#!/bin/sh
# Copies the web's locale files into the app bundle sources, so web/src/locales stays the
# single source of truth (UI.md 8.4). Run after any web string change:
#   ios/tools/sync-locales.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../web/src/locales"
dst="$here/../Slopify/Resources/Locales"
mkdir -p "$dst"
rm -f "$dst"/*.json
cp "$src"/*.json "$dst"/
echo "copied $(ls "$dst"/*.json | wc -l | tr -d ' ') locale files to $dst"
