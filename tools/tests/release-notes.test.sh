#!/usr/bin/env bash
# tools/release-notes.sh against fake asset listings, in a throwaway repo.
# Run: bash tools/tests/release-notes.test.sh
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/release-notes.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
g init -q && g commit -q --allow-empty -m 'First' && g tag v0.1.161
g commit -q --allow-empty -m 'Second' && g tag v0.1.162
fails=0
check() { # name, notes, expected line fragment
  if grep -qF -- "$3" <<<"$2"; then echo "ok   $1"; else echo "FAIL $1: no '$3' in:"; grep -E '^\| (Windows|Mac|Android)' <<<"$2" | sed 's/^/       /'; fails=$((fails + 1)); fi
}
dl=https://github.com/lukasbaxter/slopify/releases/download/v0.1.162

# Names as electron-builder writes them by default (spaces): the files GitHub
# serves as Slopify.Setup.0.1.162.exe and Slopify.0.1.162.exe.
notes=$(ASSETS=$'Slopify Setup 0.1.162.exe\nSlopify 0.1.162.exe\nSlopify-0.1.162-arm64.dmg\nSlopify-0.1.162-arm64-mac.zip\nSlopify-0.1.162.apk' bash "$script" v0.1.162)
check 'spaced installer name links the dotted file' "$notes" "[Slopify.Setup.0.1.162.exe]($dl/Slopify.Setup.0.1.162.exe) (installer)"
check 'spaced portable name links the dotted file' "$notes" "[Slopify.0.1.162.exe]($dl/Slopify.0.1.162.exe) (portable)"

# Names as the release lists them after upload.
notes=$(ASSETS=$'Slopify.Setup.0.1.162.exe\nSlopify.0.1.162.exe\nSlopify-0.1.162-arm64.dmg\nSlopify-0.1.162.apk' bash "$script" v0.1.162)
check 'dotted installer name' "$notes" "[Slopify.Setup.0.1.162.exe]($dl/Slopify.Setup.0.1.162.exe) (installer)"
check 'android linked' "$notes" "[Slopify-0.1.162.apk]($dl/Slopify-0.1.162.apk)"

# A file really missing still says so.
notes=$(ASSETS=$'Slopify-0.1.162-arm64.dmg' bash "$script" v0.1.162)
check 'missing windows build' "$notes" '| Windows | Windows 10 / 11 | not in this release (installer), no portable build (portable) |'
check 'missing android build' "$notes" '| Android | Phones and tablets | not in this release |'
check 'commit listed' "$notes" '- Second'

[ "$fails" -eq 0 ] || { echo "$fails failed"; exit 1; }
