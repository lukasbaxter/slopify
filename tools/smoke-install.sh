#!/bin/sh
# A first install the way the README describes it, against an image:
# a ./data folder Docker creates as root, a read-only music folder with one
# song, the default network. Passes when the server starts, scans the song,
# forces the first password change, plays the song and leaves the music alone.
#   tools/smoke-install.sh ghcr.io/lukasbaxter/slopify:latest [port]
set -eu
IMAGE="$1"; PORT="${2:-18080}"
DIR="$(mktemp -d)"; NAME="slopify-smoke-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker run --rm -v "$DIR:/x" --entrypoint rm "$IMAGE" -rf /x/data /x/music >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; docker logs "$NAME" 2>&1 | tail -30; exit 1; }

mkdir -p "$DIR/music/Test Artist/Test Album"
docker run --rm -v "$DIR/music:/m" --entrypoint ffmpeg "$IMAGE" -v error -f lavfi -i sine=d=5 \
  -metadata artist="Test Artist" -metadata album="Test Album" -metadata title="Test Song" "/m/Test Artist/Test Album/01.mp3"
before="$(find "$DIR/music" | sort | md5sum 2>/dev/null || find "$DIR/music" | sort | md5)"

docker run -d --name "$NAME" -p "$PORT:8080" -v "$DIR/music:/music:ro" -v "$DIR/data:/data" "$IMAGE" >/dev/null
B="http://127.0.0.1:$PORT"
i=0; until curl -sf "$B/healthz" >/dev/null; do i=$((i+1)); [ $i -lt 60 ] || fail "server did not come up"; sleep 1; done
echo "up after ${i}s on $(docker exec "$NAME" uname -m)"

T="$(curl -sf -XPOST "$B/api/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}')" || fail "admin/admin sign-in"
TOK="$(echo "$T" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
echo "$T" | grep -q '"mustChangePassword":true' || fail "first password change not forced"
curl -sf -XPOST "$B/api/auth/password" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"password":"smoke test password"}' >/dev/null || fail "password change"
i=0; until curl -sf "$B/api/search?q=test%20song" -H "Authorization: Bearer $TOK" | grep -q '"title":"Test Song"'; do i=$((i+1)); [ $i -lt 30 ] || fail "song not scanned"; sleep 1; done
ID="$(curl -sf "$B/api/search?q=test%20song" -H "Authorization: Bearer $TOK" | sed -n 's/.*"tracks":\[{"id":"\([0-9a-f]*\)".*/\1/p')"
code="$(curl -s -o /dev/null -w "%{http_code}" -r 0-1023 -H "Authorization: Bearer $TOK" "$B/api/stream/$ID")"
[ "$code" = 206 ] || [ "$code" = 200 ] || fail "stream answered $code"
docker logs "$NAME" 2>&1 | grep -q 'host networking' || fail "no warning about speakers on the default network"
after="$(find "$DIR/music" | sort | md5sum 2>/dev/null || find "$DIR/music" | sort | md5)"
[ "$before" = "$after" ] || fail "the music folder changed"
NAMEJ="$(curl -sf "$B/api/server" -H "Authorization: Bearer $TOK")"
echo "$NAMEJ" | grep -q '"name":"Slopify"' || fail "server name: $NAMEJ"
echo "PASS: $NAMEJ"
