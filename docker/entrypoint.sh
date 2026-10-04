#!/bin/sh
# Starts as root only long enough to make the state folders belong to the
# user the server runs as (PUID/PGID, default 1000:1000, the image's `node`
# user), then drops to that user. Docker creates a missing ./data mount as
# root, which would otherwise stop the server opening its database.
# The music folder is never chowned: it is yours.
# With `user:` set in compose the container is not root, nothing is changed
# here, and the server says which folder it cannot write if one is wrong.
set -e
if [ "$(id -u)" = 0 ]; then
  PUID="${PUID:-1000}"; PGID="${PGID:-1000}"
  for d in "${CONFIG_DIR:-${DATA_DIR:-/data}}" "${CACHE_DIR:-}"; do
    [ -n "$d" ] || continue
    mkdir -p "$d"
    if [ "$(stat -c %u "$d")" != "$PUID" ] || [ -n "$(find "$d" \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit 2>/dev/null)" ]; then
      echo "slopify: making $d owned by $PUID:$PGID"
      chown -R "$PUID:$PGID" "$d"
    fi
  done
  if [ "$PUID" = 1000 ]; then export HOME=/home/node; else export HOME=/tmp; fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi
exec "$@"
