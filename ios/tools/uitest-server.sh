#!/bin/sh
# Fixture server for the gesture UI tests (`make uitest`): the e2e fixture library in demo
# mode (guests sign straight in), its admin seeded with a playlist so Your Library has pages.
# Usage: tools/uitest-server.sh <port> <data dir>; prints the base URL once it is up.
set -e
PORT=${1:-18765}
DATA=${2:-$(mktemp -d)}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE="http://localhost:$PORT"
if ! curl -sf "$BASE/healthz" >/dev/null 2>&1; then
  [ -f "$ROOT/server/dist/index.js" ] || (cd "$ROOT" && npm run build -w server >/dev/null)
  rm -rf "$DATA"; mkdir -p "$DATA"
  (cd "$ROOT" && DEMO=1 NODE_ENV=test SAVE_TO_LIBRARY=0 SPEAKERS=0 MUSIC_DIR=fixtures/music DATA_DIR="$DATA" \
    PORT=$PORT LOG_LEVEL=warn LOGIN_RATE_MAX=100000 RATE_MAX=1000000 nohup node server/dist/index.js &) >"$DATA/server.log" 2>&1 </dev/null
  for _ in $(seq 60); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
fi
python3 - "$BASE" <<'PY'
import json, sys, urllib.request
base = sys.argv[1]
def call(m, p, d=None, tok=None):
    h = {"content-type": "application/json"}
    if tok: h["authorization"] = "Bearer " + tok
    r = urllib.request.Request(base + p, method=m, data=None if d is None else json.dumps(d).encode(), headers=h)
    try: return json.loads(urllib.request.urlopen(r).read() or b"{}")
    except urllib.error.HTTPError: return None
pw = "gesture test pw 123"
login = call("POST", "/api/auth/login", {"username": "admin", "password": pw})
if not login:
    first = call("POST", "/api/auth/login", {"username": "admin", "password": "admin"})
    call("POST", "/api/auth/password", {"password": pw}, first["token"])
    login = call("POST", "/api/auth/login", {"username": "admin", "password": pw})
tok = login["token"]
if not any(p["name"] == "Gesture Mix" for p in call("GET", "/api/playlists", tok=tok)["items"]):
    ids = []
    for a in call("GET", "/api/albums?limit=100", tok=tok)["items"]:
        ids += [t["id"] for t in call("GET", "/api/albums/" + a["id"], tok=tok)["tracks"]]
    call("POST", "/api/playlists", {"name": "Gesture Mix", "trackIds": ids}, tok)
PY
echo "$BASE"
