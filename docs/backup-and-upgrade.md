# Backups and upgrades

## What to back up

Only the state folder, `/data` in the container (`./data` next to your
compose file in the examples). It holds the database (accounts, sign-ins,
likes, playlists, listening history, lyrics, task settings), profile
pictures and imports. It grows with the library and its history: about
1.7 GB for 27,000 songs with lyrics and a few years of listening.

Everything else can be rebuilt:

- `CACHE_DIR`'s `heads`, `transcodes`, `songs` and `models` folders (song
  heads, transcodes, cached songs, the lyric aligner's model) refill on their
  own. Its `art` folder also holds artwork found online, so keep that one.
  If you left `CACHE_DIR` at the default it lives inside `/data` and the
  command below skips the rebuildable parts.
- Your music is your own and Slopify never needs it backed up for its sake.
  With `SAVE_TO_LIBRARY=1` it also holds found lyrics and artwork, which are
  in the database too.

The database is SQLite in WAL mode, so copy it while the server is stopped
(a copy taken mid-write can miss the last changes):

```
docker compose stop slopify
tar czf slopify-$(date +%F).tar.gz --exclude=data/heads --exclude=data/transcodes \
    --exclude=data/songs --exclude=data/models data
docker compose start slopify
```

It takes a second or two; a nightly cron job is enough. To restore, stop the
server, put the folder back, start it.

## Upgrading

```
docker compose pull
docker compose up -d
```

The database updates itself on start. Release notes are on the
[releases page](https://github.com/lukasbaxter/slopify/releases), along with
the desktop and Android apps for the same version.

The database only moves forward: once a newer Slopify has updated it, an
older one is not guaranteed to work with it. To be able to go back, take a
backup before upgrading.

### Pinning a version

`:latest` follows every release. To upgrade on your own schedule, pin a
release and change the tag when you want to move:

```yaml
    image: ghcr.io/lukasbaxter/slopify:v0.1.28
```

The GPU image has the same tags with `-gpu` (`:gpu`, `:v0.1.28-gpu`).

## Moving to another machine

Copy the state folder (and `CACHE_DIR`'s `art` if it is separate) across and
start Slopify there with your music mounted at `/music`. Songs are known by
their audio, not their path, so likes, playlists and history carry over even
if the files moved or were retagged. Then update `PUBLIC_URL` if you set it,
and in Home Assistant use **Reconfigure** on the Slopify entry to give it the
new address.
