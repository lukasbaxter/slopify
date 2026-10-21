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
    # A marker says the tree was made theirs once; without it (or with another
    # PUID in it) the tree is walked. Walking a 60 GB cache on every start
    # took minutes for nothing.
    marker="$d/.owned-by"
    if [ "$(cat "$marker" 2>/dev/null)" != "$PUID:$PGID" ]; then
      if [ "$(stat -c %u "$d")" != "$PUID" ] || [ -n "$(find "$d" \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit 2>/dev/null)" ]; then
        echo "slopify: making $d owned by $PUID:$PGID"
        chown -R "$PUID:$PGID" "$d" || echo "slopify: could not chown $d (a share without ownership?); carrying on"
      fi
      echo "$PUID:$PGID" > "$marker" 2>/dev/null && chown "$PUID:$PGID" "$marker" 2>/dev/null
    fi
  done
  if [ "$PUID" = 1000 ]; then export HOME=/home/node; else export HOME=/tmp; fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi
exec "$@"
