#!/bin/bash
# Installs the built app on every iPhone paired with this Mac, over Wi-Fi or
# cable, whichever the phone is on. A phone that is away or asleep is retried
# until it shows up, so nobody has to plug in:
#   tools/install-all.sh <Slopify.app> [hours to keep trying, default 24]
# Starting it again replaces a run that is still waiting, so the newest build wins.
set -u
app=$1
hours=${2:-24}
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
xcrun="xcrun"
[ -d "$app" ] || { echo "no app at $app"; exit 1; }
state=$(dirname "$app")/../../../install-all
mkdir -p "$state"
state=$(cd "$state" && pwd)

if [ -f "$state/pid" ] && kill -0 "$(cat "$state/pid")" 2>/dev/null; then kill "$(cat "$state/pid")" 2>/dev/null; fi
echo $$ > "$state/pid"
trap 'rm -f "$state/pid" "$state/devices.json"' EXIT

# "<udid> <name>" for every paired real phone, reachable or not.
paired() {
  $xcrun devicectl list devices --json-output "$state/devices.json" >/dev/null 2>&1 || return
  python3 - "$state/devices.json" <<'PY'
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    hw, c = d["hardwareProperties"], d["connectionProperties"]
    if hw.get("reality") == "physical" and c.get("pairingState") == "paired" and hw.get("udid"):
        print(hw["udid"], d["deviceProperties"].get("name", "iPhone"))
PY
}

done_ids=" "
deadline=$(( $(date +%s) + hours * 3600 ))
while :; do
  left=0
  seen=0
  while read -r id name; do
    [ -n "$id" ] || continue
    seen=$((seen + 1))
    case "$done_ids" in *" $id "*) continue ;; esac
    if $xcrun devicectl device install app --device "$id" --timeout 120 "$app" >"$state/last.log" 2>&1; then
      echo "$(date '+%H:%M:%S') installed on $name"
      done_ids="$done_ids$id "
    else
      left=$((left + 1))
      [ -n "${said:-}" ] || echo "$(date '+%H:%M:%S') $name is not reachable yet, will keep trying"
    fi
  done < <(paired)
  said=1
  [ "$seen" -gt 0 ] || { echo "no paired iPhone found (pair one in Xcode once, over the cable)"; exit 1; }
  [ "$left" -gt 0 ] || { echo "every paired phone is up to date"; exit 0; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "gave up on $left phone(s) after ${hours}h"; exit 1; }
  sleep 30
done
