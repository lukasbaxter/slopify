#!/bin/sh
# Copies the web's locale files into the app's raw resources, so web/src/locales stays the
# single source of truth (UI.md 8.4). Android resource names allow only [a-z0-9_]:
# pt-BR.json becomes res/raw/locale_pt_br.json. Run after any web string change:
#   android/tools/sync-locales.sh
# A new language also needs its line in design/i18n/Localizer.kt (`languages`, `RAW`).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../web/src/locales"
dst="$here/../app/src/main/res/raw"
mkdir -p "$dst"
rm -f "$dst"/locale_*.json
n=0
for f in "$src"/*.json; do
  base=$(basename "$f" .json | tr 'A-Z-' 'a-z_')
  cp "$f" "$dst/locale_$base.json"
  n=$((n + 1))
done
echo "copied $n locale files to $dst"
