#!/usr/bin/env bash
# Start/stop the lab receivers on the lab host.
#   run.sh start|stop|restart|status [dlna|airplay|airplay-pw|all]   (default: all)
#   run.sh logs <dlna|airplay|airplay-pw> [n]                        (tail of every log for it)
# From the Mac it forwards to the lab host over ssh (LAB_HOST env or lab.env), using the copy
# that build.sh rsyncs to ~/apps/slopify-lab/receivers/tools.
#
# Settings (env, or $L/lab.conf on the lab host, or lab.env here):
#   LAB_IFACE        interface to bind/advertise on (default: interface of the default route)
#   DLNA_NAME        "Lab DLNA"             DLNA_PORT   49494
#   AIRPLAY_NAME     "Lab AirPlay"          AIRPLAY_PORT 5000     (UDP 6001-6010)
#   AIRPLAY_PW_NAME  "Lab AirPlay Locked"   AIRPLAY_PW_PORT 5100  (UDP 6101-6110)
#   AIRPLAY_PW       password for the locked receiver (default: labpass)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/lab.env" ] && . "$HERE/lab.env"

if [ "$(uname)" = Darwin ]; then
  : "${LAB_HOST:?set LAB_HOST=user@host (env or lab.env)}"
  rsync -a "$HERE/" "$LAB_HOST:apps/slopify-lab/receivers/tools/"
  exec ssh "$LAB_HOST" "bash ~/apps/slopify-lab/receivers/tools/run.sh $(printf '%q ' "$@")"
fi

L=$HOME/apps/slopify-lab/receivers
[ -f "$L/lab.conf" ] && . "$L/lab.conf"
P=$L/prefix
T=$L/tools
LOG=$L/logs
RUN=$L/run
mkdir -p "$LOG" "$RUN" "$L/artwork"
export PATH=$P/bin:$PATH
export GST_REGISTRY=$RUN/gst-registry.bin    # keep GStreamer's plugin cache out of ~/.cache
export GST_PLUGIN_PATH=$L/sysroot/usr/lib/x86_64-linux-gnu/gstreamer-1.0   # adds gst-libav (AAC/ALAC/WMA decoders)
export LD_LIBRARY_PATH=$P/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

IFACE=${LAB_IFACE:-$(ip -o -4 route show default | awk '{print $5; exit}')}
IP=$(ip -o -4 addr show dev "$IFACE" | awk '{split($4,a,"/"); print a[1]; exit}')
DLNA_NAME=${DLNA_NAME:-Lab DLNA}
DLNA_PORT=${DLNA_PORT:-49494}
AIRPLAY_NAME=${AIRPLAY_NAME:-Lab AirPlay}
AIRPLAY_PORT=${AIRPLAY_PORT:-5000}
AIRPLAY_PW_NAME=${AIRPLAY_PW_NAME:-Lab AirPlay Locked}
AIRPLAY_PW_PORT=${AIRPLAY_PW_PORT:-5100}
AIRPLAY_PW=${AIRPLAY_PW:-labpass}

# Stable UDN per lab host, generated once (not stored in the repo).
[ -f "$RUN/dlna.uuid" ] || python3 -c 'import uuid; print(uuid.uuid4())' > "$RUN/dlna.uuid"
DLNA_UUID=$(cat "$RUN/dlna.uuid")

pidfile() { echo "$RUN/$1.pid"; }
running() { local p; p=$(cat "$(pidfile "$1")" 2>/dev/null) || return 1; kill -0 "$p" 2>/dev/null; }

start_dlna() {
  # Audio goes through a real playbin -> audioconvert -> fdsink sync=true, i.e. paced by the
  # pipeline clock like a real sink, and the PCM is fed to pcm_rms.py. Video is discarded.
  local sinkpipe="audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=44100,channels=2 ! fdsink fd=3 sync=true"
  setsid nohup bash -c '
    exec 3> >(exec python3 "$0" --label dlna >> "$1")
    exec gmediarender -I "$2" -p "$3" -u "$4" -f "$5" --mime-filter audio \
      --gstout-audiopipe "$6" --gstout-videosink fakesink --logfile stderr
  ' "$T/pcm_rms.py" "$LOG/dlna-rms.log" "$IFACE" "$DLNA_PORT" "$DLNA_UUID" "$DLNA_NAME" "$sinkpipe" \
    >> "$LOG/dlna.log" 2>&1 < /dev/null &
  echo $! > "$(pidfile dlna)"
}

airplay_conf() { # key name port udpbase password
  local key=$1 name=$2 port=$3 udp=$4 pw=${5:-} pwline=""
  [ -n "$pw" ] && pwline="password = \"$pw\";"
  cat > "$RUN/$key.conf" <<EOF
general = {
  name = "$name";
  port = $port;
  udp_port_base = $udp;
  udp_port_range = 10;
  interface = "$IFACE";
  output_backend = "stdout";
  mdns_backend = "avahi";
  $pwline
};
stdout = { output_rate = 44100; output_format = "S16_LE"; output_channels = 2; };
metadata = {
  enabled = "yes";
  include_cover_art = "yes";
  pipe_name = "$RUN/$key-metadata";
  cover_art_cache_directory = "";
};
diagnostics = { log_verbosity = ${AIRPLAY_LOG_VERBOSITY:-2}; log_show_file_and_line = "no"; log_show_time_since_startup = "yes"; };
EOF
}

start_airplay_key() {
  local key=$1 name=$2 port=$3 udp=$4 pw=${5:-}
  airplay_conf "$key" "$name" "$port" "$udp" "$pw"
  setsid nohup bash -c '
    python3 "$0/airplay_meta.py" "$1/$2-metadata" --art-dir "$3/$2" >> "$4/$2-meta.log" 2>&1 &
    sleep 0.3
    shairport-sync -c "$1/$2.conf" 2>> "$4/$2.log" | python3 "$0/pcm_rms.py" --label "$2" >> "$4/$2-rms.log"
    kill %1 2>/dev/null; wait
  ' "$T" "$RUN" "$key" "$L/artwork" "$LOG" < /dev/null >/dev/null 2>&1 &
  echo $! > "$(pidfile "$key")"
}

start_one() {
  if running "$1"; then echo "$1 already running (pid $(cat "$(pidfile "$1")"))"; return; fi
  case $1 in
    dlna) start_dlna ;;
    airplay) start_airplay_key airplay "$AIRPLAY_NAME" "$AIRPLAY_PORT" 6001 ;;
    airplay-pw) start_airplay_key airplay-pw "$AIRPLAY_PW_NAME" "$AIRPLAY_PW_PORT" 6101 "$AIRPLAY_PW" ;;
    *) echo "unknown receiver $1" >&2; exit 2 ;;
  esac
  sleep 1.5
  status_one "$1"
}

stop_one() {
  local p
  if p=$(cat "$(pidfile "$1")" 2>/dev/null) && kill -0 "$p" 2>/dev/null; then
    kill -TERM -- "-$p" 2>/dev/null || kill "$p"
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || break; sleep 0.3; done
    kill -KILL -- "-$p" 2>/dev/null || true
    echo "$1 stopped"
  else
    echo "$1 not running"
  fi
  rm -f "$(pidfile "$1")"
}

status_one() {
  local state=stopped
  running "$1" && state="running pgid=$(cat "$(pidfile "$1")")"
  case $1 in
    dlna) echo "dlna:       $state  name=\"$DLNA_NAME\" http=$IP:$DLNA_PORT desc=http://$IP:$DLNA_PORT/description.xml udn=uuid:$DLNA_UUID iface=$IFACE" ;;
    airplay) echo "airplay:    $state  name=\"$AIRPLAY_NAME\" rtsp=$IP:$AIRPLAY_PORT/tcp udp=6001-6010 iface=$IFACE" ;;
    airplay-pw) echo "airplay-pw: $state  name=\"$AIRPLAY_PW_NAME\" rtsp=$IP:$AIRPLAY_PW_PORT/tcp udp=6101-6110 password=$AIRPLAY_PW" ;;
  esac
}

logs_one() {
  local n=${2:-30}
  for f in "$LOG/$1.log" "$LOG/$1-rms.log" "$LOG/$1-meta.log"; do
    [ -f "$f" ] && { echo "==> $f"; tail -n "$n" "$f"; }
  done
}

cmd=${1:-status}; target=${2:-all}
[ "$target" = all ] && targets="dlna airplay airplay-pw" || targets=$target
case $cmd in
  start) for t in $targets; do start_one "$t"; done ;;
  stop) for t in $targets; do stop_one "$t"; done ;;
  restart) for t in $targets; do stop_one "$t"; start_one "$t"; done ;;
  status) for t in $targets; do status_one "$t"; done ;;
  logs) logs_one "${2:?receiver}" "${3:-30}" ;;
  *) echo "usage: $0 start|stop|restart|status [dlna|airplay|airplay-pw|all] | logs <receiver> [n]" >&2; exit 2 ;;
esac
