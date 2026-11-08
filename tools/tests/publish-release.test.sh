#!/usr/bin/env bash
# tools/publish-release.sh against a fake `gh` that keeps the release in a
# folder: a first run where the Android build failed, then the re-run that
# adds the APK. The notes must end up linking it.
# Run: bash tools/tests/publish-release.test.sh
set -euo pipefail
tools="$(cd "$(dirname "$0")/.." && pwd)"
publish="${PUBLISH:-$tools/publish-release.sh}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/rel" "$tmp/repo"
export REL="$tmp/rel"
cat >"$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
# release view|create|upload|edit, just enough for publish-release.sh.
set -euo pipefail
[ "$1" = release ] || exit 2
cmd="$2"; shift 2
case "$cmd" in
  view)
    [ -f "$REL/exists" ] || exit 1
    if [[ " $* " == *" --json assets "* ]]; then cat "$REL/assets" 2>/dev/null || true; fi ;;
  create)
    touch "$REL/exists"
    while [ $# -gt 0 ]; do [ "$1" = --notes ] && printf '%s\n' "$2" >"$REL/notes"; shift; done ;;
  upload)
    name=$(basename "$2"); name=${name// /.}   # GitHub's renaming
    grep -qxF "$name" "$REL/assets" 2>/dev/null || echo "$name" >>"$REL/assets" ;;
  edit)
    while [ $# -gt 0 ]; do [ "$1" = --notes-file ] && cp "$2" "$REL/notes"; shift; done ;;
  *) exit 2 ;;
esac
GH
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" UPLOAD_RETRY_SLEEP=0

cd "$tmp/repo"
g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
g init -q && g commit -q --allow-empty -m 'First' && g tag v0.1.161
g commit -q --allow-empty -m 'Second' && g tag v0.1.162

fails=0
check() { if grep -qF -- "$2" "$REL/notes"; then echo "ok   $1"; else echo "FAIL $1: no '$2' in notes:"; grep -E '^\| (Windows|Mac|Android)' "$REL/notes" | sed 's/^/       /'; fails=$((fails + 1)); fi; }
dl=https://github.com/o/r/releases/download/v0.1.162

# Run 1: Android failed, so out/ has the desktop and iPhone files only.
mkdir out
touch out/Slopify-0.1.162-arm64.dmg out/Slopify-0.1.162-arm64-mac.zip out/Slopify.Setup.0.1.162.exe out/Slopify.0.1.162.exe out/Slopify-0.1.162.ipa
bash "$publish" v0.1.162 o/r out >/dev/null
check 'first run: no apk yet' '| Android | Phones and tablets | not in this release |'

# Run 2: the re-run of the Android job succeeded; out/ now has the APK too.
touch out/Slopify-0.1.162.apk
bash "$publish" v0.1.162 o/r out >/dev/null
check 're-run: apk linked' "[Slopify-0.1.162.apk]($dl/Slopify-0.1.162.apk)"
check 're-run: windows linked' "[Slopify.Setup.0.1.162.exe]($dl/Slopify.Setup.0.1.162.exe) (installer)"
check 're-run: commits kept' '- Second'
grep -qxF Slopify-0.1.162.apk "$REL/assets" && echo 'ok   apk uploaded' || { echo 'FAIL apk not uploaded'; fails=$((fails + 1)); }

[ "$fails" -eq 0 ] || { echo "$fails failed"; exit 1; }
