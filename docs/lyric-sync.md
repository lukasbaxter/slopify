# Sync lyrics (GPU image)

Right-click a song (or use the now-playing menu, or the button in the
lyrics view) and pick **Sync Lyrics**. The song joins a queue that the
**Sync lyrics** task works through on an NVIDIA GPU; a pill above the
player shows which song and what stage it is at, and a toast says how it
went.

- **Lyrics in hand:** they are lined up with the vocals. Demucs isolates
  the voice and Whisper finds when each *known* line is sung (forced
  alignment: nothing is transcribed or invented). Plain lyrics get
  timestamps; synced ones are checked, and a file that is consistently
  early or late (timed to another version or intro) is shifted as a whole.
- **No lyrics, or plain ones that will not line up:** it looks further:
  LrcLib (fresh), NetEase Cloud Music (time-synced), then Genius (plain).
  Every copy it finds is lined up with the song before it is kept, which is
  also the proof that it is the right song; a copy that does not match the
  recording is dropped, and a song nobody has lyrics for is left without.

Every change is recorded with the original, and **Undo all changes** in the
task's ⋯ menu puts everything back. With `SAVE_TO_LIBRARY=1` the result is
written to the song's `.lrc`; a `.lrc` that came with your music is kept
once as `<name>.orig.lrc`.

It needs the GPU image and the card passed in:

```yaml
services:
  slopify:
    image: ghcr.io/lukasbaxter/slopify:gpu   # or build with --target gpu
    deploy:
      resources:
        reservations:
          devices:
            - driver: cdi
              device_ids: [nvidia.com/gpu=all]
              capabilities: [gpu]
```

(NVIDIA driver plus the container toolkit with CDI on the host; on older
setups `driver: nvidia, count: 1` works too.) The model downloads into
`CACHE_DIR/models` on first use (~1.6 GB). It peaks around 3.5 GB of VRAM
and **GPU power** in the task's menu decides how hard it leans on the card:
the lower levels pause while anything (Jellyfin, Immich) is encoding. On an
RTX 4060 a song takes about a tenth of its own length.

The GPU image is built for amd64 (x86-64) only.
