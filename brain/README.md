# Slopify brain

A recommender that learns how your household listens and picks what plays
next: smart shuffle, autoplay when the queue runs out, song radio, the
speakers. Optional. Slopify works fine without it and falls back to its own
mixes whenever the brain is off, slow or busy.

| It learns from | |
|---|---|
| Your listening | plays, how long each played, skips, likes, dislikes |
| How songs sound | [CLAP](https://huggingface.co/laion/larger_clap_general) audio embeddings, two 10 s clips per song |
| The moment | local time, day, weather ([Open-Meteo](https://open-meteo.com), no key), device |

It listens to every song once, then to new ones as they arrive, and retrains
every night. It also:

- **makes generated playlists**: type a vibe and it finds the songs that
  *sound* like it (CLAP understands words and audio in one space).
- **makes Daily Mixes by sound** (opt-in): set `BRAIN_DAILY_MIXES=1` on
  Slopify and each Daily Mix on Home is the artist plus the songs that sound
  most like the artist's songs you play most. Off: similar artists and
  genres, as before. Either way a Daily Mix stays the same all day and
  changes at your midnight.
- **finds damaged songs**: anything it can't hear gets decoded end to end by
  Slopify. A wrong length on record is fixed, a cut-off file or a saved
  preview gets replaced by Upgrade to FLAC, a stub is dropped.

## Add it

Put it next to Slopify in the same `compose.yml` and give both the same key:

```
echo "BRAIN_KEY=$(openssl rand -hex 32)" >> .env
```

```yaml
services:
  slopify:
    # ...as in the main README, plus:
    environment:
      BRAIN_KEY: ${BRAIN_KEY}

  brain:
    image: ghcr.io/lukasbaxter/slopify-brain:nvidia   # or :intel, :cpu
    container_name: slopify-brain
    restart: unless-stopped
    network_mode: host
    environment:
      BRAIN_KEY: ${BRAIN_KEY}
      SLOPIFY_URL: http://127.0.0.1:8080   # Slopify's PORT
    volumes:
      - ./brain:/data
    # NVIDIA (needs the NVIDIA Container Toolkit):
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: all, capabilities: [gpu, utility] }]
    # Intel Arc instead:  devices: ["/dev/dri"]
    # CPU: nothing
```

`docker compose up -d`. That's it. It shows up in Slopify under **Settings ›
Admin › Tasks › Brain** with what it's doing.

On another machine: set `BRAIN_URL: http://<brain box>:8097` on Slopify and
`SLOPIFY_URL: http://<slopify box>:<port>` on the brain. Use the LAN address,
not a public hostname behind a proxy.

## Images

| Tag | For | Notes |
|---|---|---|
| `:nvidia` | GeForce / RTX, driver 570+ | tested on an RTX 5070 Ti |
| `:intel` | Arc A / B series | tested on an Arc Pro B70 |
| `:cpu` | no GPU | fine: the audio model does ~4 songs/s on a 16-core desktop |
| AMD | build it: `docker build --build-arg GPU=amd brain/` | ROCm, not tested yet; add `devices: ["/dev/kfd", "/dev/dri"]` |

Needs about 3.5 GB of GPU memory while it listens, a few GB of RAM, and
~1 GB of disk per 100k songs plus the model (~1 GB, downloaded once).
A first pass over 140k songs took about 10 hours, mostly reading files.

## When it works

In the Brain task's ⋯ menu:

| Setting | |
|---|---|
| Use it for what plays next | off = Slopify's own mixes; it keeps learning |
| GPU power | Full, Normal (10 min on, 10 off), Light (5 on, 15 off), or don't use the GPU |
| Heavy work from / until | e.g. 1 and 7 = only overnight |
| Pause while anyone is listening | it reads each song once; turn on if your disks are slow |
| Pause when other programs use more GPU memory than | games, Ollama, other AI apps |
| Pause while the GPU encodes video | Jellyfin / Plex / Immich transcodes, NVIDIA only |
| Where you listen | a city, for the weather |

The schedule is when it retrains (nightly at 04:00 by default); **Run now**
retrains right away. The rules only hold back listening and training.
Picking the next song takes milliseconds and is never held.

## Environment

| Variable | Default | |
|---|---|---|
| `BRAIN_KEY` | | the same on both, required |
| `SLOPIFY_URL` | `http://127.0.0.1:8080` | Slopify as this box reaches it |
| `DEVICE` | `auto` | `auto` (Intel, then NVIDIA/AMD, then CPU), `xpu`, `cuda`, `cpu` |
| `EMBED_WORKERS` | `3` | songs read at once |
| `HOST` / `PORT` | `0.0.0.0` / `8097` | `HOST: 127.0.0.1` when Slopify is on the same machine |
| `LAT` / `LON` | | instead of the Location setting |
| `TZ` | Slopify's | local time, if the Location doesn't say |

`GET /status` (with `X-Brain-Key`) has the details, including how well the
last training did against Slopify's old mix. Songs that won't decode are in
`GET /undecodable`: usually a damaged file.

## Develop

```
python -m pytest brain/tests      # needs torch for the last two
```
