#!/usr/bin/env bash
# A throwaway Slopify server with speakers on, for cast-check.mjs: runs on a
# Linux box on the same LAN as the speakers (mDNS from macOS does not reach
# Node), on a test library, with its own data dir. Its address is the box's
# own LAN address, found at start.
#
#   tools/device-lab/cast-server.sh start [music dir]   build, then run on :${CAST_PORT:-8095}
#   tools/device-lab/cast-server.sh stop | status | log
#
# Env: CAST_PORT (8095), CAST_DIR (state, default ~/.cache/slopify-cast),
# CLIAIRPLAY (path to the cliairplay binary, for AirPlay), CAST_PASSWORD
# (admin password set on first start, default "lab password 123").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${CAST_PORT:-8095}"
DIR="${CAST_DIR:-$HOME/.cache/slopify-cast}"
PW="${CAST_PASSWORD:-lab password 123}"
mkdir -p "$DIR"
pidf="$DIR/server.pid"
running() { [[ -f "$pidf" ]] && kill -0 "$(cat "$pidf")" 2>/dev/null; }
lan_ip() { ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'; }

case "${1:-}" in
  start)
    running && { echo "already running (pid $(cat "$pidf"))"; exit 0; }
    music="${2:-$ROOT/fixtures/music}"
    ip="$(lan_ip)"; [[ -n "$ip" ]] || { echo "no LAN address" >&2; exit 1; }
    (cd "$ROOT" && npm run build -w server >/dev/null)
    SAVE_TO_LIBRARY=0 SPEAKERS=1 MUSIC_DIR="$music" DATA_DIR="$DIR/data" PORT="$PORT" PUBLIC_URL="http://$ip:$PORT" \
      LOG_LEVEL=info LOGIN_RATE_MAX=1000 RATE_MAX=100000 \
      setsid nohup node "$ROOT/server/dist/index.js" >"$DIR/server.log" 2>&1 </dev/null &
    echo $! >"$pidf"
    for _ in $(seq 40); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.5; done
    # First start: the admin's password (admin/admin until changed).
    tok="$(curl -fs -XPOST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}' 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
    [[ -n "$tok" ]] && curl -fs -XPOST "http://127.0.0.1:$PORT/api/auth/password" -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "{\"password\":\"$PW\"}" >/dev/null
    echo "running at http://$ip:$PORT (pid $(cat "$pidf")); SLOPIFY_USER=admin SLOPIFY_PASSWORD='$PW'"
    ;;
  stop) running && kill "$(cat "$pidf")" && echo stopped || echo "not running"; rm -f "$pidf" ;;
  status) running && echo "running (pid $(cat "$pidf")) at http://$(lan_ip):$PORT" || echo "not running" ;;
  log) tail -n "${2:-50}" "$DIR/server.log" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
