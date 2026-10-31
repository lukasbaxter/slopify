#!/usr/bin/env bash
# Build the lab receivers (gmrender-resurrect + shairport-sync) on the Linux lab host.
#
# Run from the Mac:   LAB_HOST=user@labhost tools/device-lab/receivers/build.sh
#   (or put LAB_HOST=... in lab.env next to this script; see lab.env.example, lab.env is gitignored)
#   -> copies this directory to the lab host's ~/apps/slopify-lab/receivers/tools and builds there over ssh.
# Run on the lab host: ~/apps/slopify-lab/receivers/tools/build.sh
#
# Idempotent: every step is skipped when its output already exists. FORCE=1 rebuilds gmrender + shairport.
# No sudo. Missing -dev headers for libraries that ARE installed at runtime are fetched with
# `apt-get download` and unpacked into $L/sysroot (exact ABI match). Libraries missing at runtime
# (libconfig) and build tools (m4/autoconf/automake/libtool) are built from source into $L/prefix.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/lab.env" ] && . "$HERE/lab.env"

if [ "$(uname)" = Darwin ]; then
  : "${LAB_HOST:?set LAB_HOST=user@host (env or lab.env)}"
  ssh "$LAB_HOST" 'mkdir -p ~/apps/slopify-lab/receivers/tools'
  rsync -a --delete "$HERE/" "$LAB_HOST:apps/slopify-lab/receivers/tools/"
  exec ssh "$LAB_HOST" 'bash ~/apps/slopify-lab/receivers/tools/build.sh'
fi

L=$HOME/apps/slopify-lab/receivers
P=$L/prefix
S=$L/sysroot
J=$(( $(nproc) / 2 ))
mkdir -p "$L"/{src,prefix,debs,sysroot,logs,run,media}
export PATH=$P/bin:$S/usr/bin:$PATH
export PKG_CONFIG_PATH=$P/lib/pkgconfig:$S/usr/lib/x86_64-linux-gnu/pkgconfig:$S/usr/lib/pkgconfig:$S/usr/share/pkgconfig
export CPPFLAGS="-I$P/include -I$S/usr/include -I$S/usr/include/x86_64-linux-gnu"
export ACLOCAL_PATH=$P/share/aclocal:/usr/share/aclocal
export LDFLAGS="-L$P/lib -L$S/usr/lib/x86_64-linux-gnu -Wl,-rpath,$P/lib"
N="nice -n 10"
log() { printf '\n=== %s\n' "$*"; }

# ---------- 1. -dev headers for installed runtime libs + a few binaries ----------
DEBS="m4 libupnp-dev libavahi-client-dev libavahi-common-dev libssl-dev libpopt-dev libsoxr-dev libdaemon-dev gstreamer1.0-tools gstreamer1.0-libav ffmpeg"
if [ "$(cat "$S/.done" 2>/dev/null)" != "$DEBS" ]; then
  log "apt-get download dev packages into $S"
  (cd "$L/debs" && apt-get download $DEBS)
  for d in "$L"/debs/*.deb; do dpkg-deb -x "$d" "$S"; done
  # pkg-config files say prefix=/usr; point them at the sysroot for headers.
  # Libs keep resolving through -L sysroot; dangling dev symlinks are repointed to the system .so.N.
  for pc in "$S"/usr/lib/x86_64-linux-gnu/pkgconfig/*.pc; do
    sed -i "s|^prefix=/usr\$|prefix=$S/usr|; s|^libdir=/usr/lib/x86_64-linux-gnu|libdir=$S/usr/lib/x86_64-linux-gnu|; s|^includedir=/usr/include|includedir=$S/usr/include|" "$pc"
  done
  for l in "$S"/usr/lib/x86_64-linux-gnu/*.so; do
    [ -L "$l" ] || continue
    t=$(readlink "$l"); [ -e "$S/usr/lib/x86_64-linux-gnu/$t" ] && continue
    ln -sf "/usr/lib/x86_64-linux-gnu/$t" "$l"
  done
  echo "$DEBS" > "$S/.done"
fi

# ---------- 2. autotools from source ----------
gnu() { # name version url-dir
  local n=$1 v=$2
  [ -f "$P/.$n-$v" ] && return
  log "build $n $v"
  cd "$L/src"; [ -d "$n-$v" ] || curl -fsSL "https://ftp.gnu.org/gnu/$n/$n-$v.tar.gz" | tar xz
  cd "$n-$v"; $N ./configure --prefix="$P" -q; $N make -s -j"$J"; make -s install
  touch "$P/.$n-$v"
}
# m4 comes from the apt-downloaded deb (gnulib in m4 1.4.19/1.4.20 does not compile against glibc 2.43)
gnu autoconf 2.72
gnu automake 1.17
gnu libtool 2.5.4

# ---------- 3. libconfig (not installed at runtime) ----------
if [ ! -f "$P/lib/pkgconfig/libconfig.pc" ]; then
  log "build libconfig"
  cd "$L/src"; [ -d libconfig ] || git clone -q --depth 1 -b v1.7.3 https://github.com/hyperrealm/libconfig.git
  cd libconfig; autoreconf -fi >/dev/null 2>&1
  CFLAGS="-O2 -std=gnu17" $N ./configure --prefix="$P" --disable-shared --enable-static --disable-examples --disable-tests -q
  $N make -s -j"$J" MAKEINFO=true; make -s install MAKEINFO=true
fi

# ---------- 4. gmrender-resurrect ----------
if [ ! -x "$P/bin/gmediarender" ] || [ "${FORCE:-}" = 1 ]; then
  log "build gmrender-resurrect"
  cd "$L/src"; [ -d gmrender-resurrect ] || git clone -q https://github.com/hzeller/gmrender-resurrect.git
  cd gmrender-resurrect; git pull -q --ff-only || true
  ./autogen.sh >/dev/null 2>&1 || autoreconf -fi
  $N ./configure --prefix="$P" -q
  $N make -s -j"$J"; make -s install
fi

# ---------- 5. shairport-sync (classic AirPlay 1) ----------
if [ ! -x "$P/bin/shairport-sync" ] || [ "${FORCE:-}" = 1 ]; then
  log "build shairport-sync"
  cd "$L/src"; [ -d shairport-sync ] || git clone -q https://github.com/mikebrady/shairport-sync.git
  cd shairport-sync; git fetch -q --tags
  TAG=$(git tag -l '[0-9]*' | grep -v -E 'rc|dev|b[0-9]' | sort -V | tail -1); git checkout -q "$TAG"
  echo "shairport-sync tag $TAG"
  autoreconf -fi >/dev/null 2>&1
  # No ALSA/Pulse/PipeWire backends on purpose: nothing may reach the speakers.
  $N ./configure --prefix="$P" --sysconfdir="$L/etc" \
     --with-ssl=openssl --with-avahi --with-soxr --with-metadata \
     --with-pipe --with-stdout --without-alsa \
     --without-configfiles -q
  $N make -s -j"$J"; make -s install
fi

# ---------- 6. python venv with pyatv (via uv; system python has no pip/ensurepip) ----------
if [ ! -x "$L/venv/bin/atvremote" ]; then
  log "pyatv venv"
  [ -x "$L/uv/uv" ] || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$L/uv" UV_NO_MODIFY_PATH=1 sh
  export UV_PYTHON_INSTALL_DIR=$L/uv/python UV_CACHE_DIR=$L/uv/cache
  "$L/uv/uv" venv -q --python 3.12 "$L/venv"
  VIRTUAL_ENV=$L/venv "$L/uv/uv" pip install -q pyatv
fi

# ---------- 7. test media ----------
FF="$S/usr/bin/ffmpeg -hide_banner -loglevel error -y"
M=$L/media
[ -f "$M/tone-60s.mp3" ] || $FF -f lavfi -i "sine=frequency=440:duration=60:sample_rate=44100" -ac 2 -b:a 192k -id3v2_version 3 -metadata title="Lab Tone 440" -metadata artist="Slopify Lab" -metadata album="Receiver Tests" "$M/tone-60s.mp3"
[ -f "$M/sweep-120s.mp3" ] || $FF -f lavfi -i "aevalsrc=0.4*sin(2*PI*(200+t*10)*t)|0.4*sin(2*PI*(300+t*10)*t):s=44100:d=120" -b:a 192k -metadata title="Lab Sweep" -metadata artist="Slopify Lab" -metadata album="Receiver Tests" "$M/sweep-120s.mp3"
[ -f "$M/cover.jpg" ] || $FF -f lavfi -i "testsrc2=size=300x300:duration=1" -frames:v 1 "$M/cover.jpg"
[ -f "$M/tone-art-60s.mp3" ] || $FF -i "$M/tone-60s.mp3" -i "$M/cover.jpg" -map 0:a -map 1:v -c copy -id3v2_version 3 -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)" -disposition:v attached_pic "$M/tone-art-60s.mp3"
[ -f "$M/tone-60s.flac" ] || $FF -i "$M/tone-60s.mp3" "$M/tone-60s.flac"
[ -f "$M/tone-60s.wav" ] || $FF -i "$M/tone-60s.mp3" "$M/tone-60s.wav"

log "done"
"$P/bin/gmediarender" --version 2>&1 | head -1 || true
"$P/bin/shairport-sync" -V 2>&1 || true
