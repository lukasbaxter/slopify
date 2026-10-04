# Downloads: your own Lidarr and slskd

Optional. Without them Slopify plays the music folder you give it; with them it can fill that folder.

Slopify speaks Lidarr and slskd natively — no glue services. With a Lidarr
that manages the same music folder, the artist pages grow full
discographies with Request buttons, search gets an "Everywhere" shelf, the
Release Radar fills, generated playlists can fetch what the library lacks,
and a Downloads page shows where everything is. Requests simply monitor the
album in Lidarr; whatever you have watching Lidarr does the fetching — its
own indexers, [Soularr](https://github.com/mrusse/soularr) bridging slskd
for Soulseek, or both.

```yaml
    environment:
      # Lidarr: catalog + download queue
      LIDARR_URL: http://127.0.0.1:8686
      LIDARR_API_KEY: ...
      LIDARR_ROOT: /music              # the library as LIDARR's container sees it
      LIDARR_QUALITY_PROFILE: ""       # profile (name or id) for artists Slopify adds; blank = Lidarr's first
      LIDARR_METADATA_PROFILE: ""
      LIDARR_SEARCH_ON_REQUEST: "0"    # "1": every request also fires Lidarr's indexer search immediately
      # slskd: Weekly Exploration fetches single missing tracks directly
      SLSKD_URL: http://127.0.0.1:5030
      SLSKD_API_KEY: ...
      SLSKD_DOWNLOADS_DIR: /slskd-downloads  # slskd's finished-downloads folder, mounted here,
                                             # so fetched tracks move into the library and scan at once
```

In Lidarr add a Webhook notification (Settings → Connect → Webhook, on
Release Import + on Upgrade) pointed at
`http://<slopify>:8080/api/hooks/lidarr?key=<LIDARR_API_KEY>` — imported
albums become playable seconds later instead of at the next library scan.
Artists Slopify adds to Lidarr while browsing stay unmonitored; only a
Request monitors an album.

## Tasks

Settings → Admin has a Tasks list, Jellyfin-style: every recurring chore
on one line with its last run, live progress, a Run now button and its
schedule, editable in place — every N hours, daily at a time, weekly on a
day, on file change (tasks that watch the music folder), or off. Built in,
with their defaults: **Scan library** (daily 04:00; can also watch the
folder and scan two minutes after files change), **Fetch lyrics & artwork**
(hourly, `ENRICH_EVERY_H`), **Cut song heads** (daily 05:00, when
`HEADS=1`), **Discover new music** (Sundays 06:00 — an album each from
artists similar to your most played, via Deezer + Lidarr,
`DISCOVERY_PER_RUN`), and **Fill in discographies** (every 6 h,
`BACKLOG_EVERY_H`/`BACKLOG_PER_RUN`/`BACKLOG_ARTISTS_PER_RUN` — missing
studio albums and EPs of the artists you actually play). The background
chores never fill Lidarr's wanted list past `TASKS_WANTED_TARGET` (default
25), so a person's own request is always near the front of the line.

There is also **Upgrade to FLAC** (`FLAC_PER_RUN` per run). **Warning:**
setting the three slskd envs (`SLSKD_URL`, `SLSKD_API_KEY`,
`SLSKD_DOWNLOADS_DIR`) enables it, hourly by default, and it **replaces
lossy files in your library** with lossless ones as it finds them. If you
want slskd for Weekly Exploration but not that, set the task to Off in the
Tasks UI.

Every task's ⋯ menu holds its own settings (pace, how much per run, which
parts to fetch, ...). They are saved in the database and apply from the
task's next step, even mid-run; the env values above only seed the defaults.
