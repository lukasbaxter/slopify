# Slopify brain

A recommender that learns how your household listens and picks what plays next:
smart shuffle, autoplay when the queue runs out, song radio. Runs on its own box
with a GPU; Slopify works fine without it.

What it uses:

| | |
|---|---|
| Your listening | plays, how long each played, skips, likes, dislikes |
| How songs sound | [CLAP](https://huggingface.co/laion/larger_clap_general) audio embeddings, two 10 s clips per song |
| The moment | local time, day, weather ([Open-Meteo](https://open-meteo.com), no key), device |

It retrains every night and listens to new songs as they arrive. A song that
won't decode shows up in `GET /undecodable`.

## Run it

```
docker compose up -d   # see docker-compose.example.yml
```

| Variable | |
|---|---|
| `SLOPIFY_URL` | your Slopify server, as this box reaches it |
| `BRAIN_KEY` | a long random secret; set the same one on Slopify with `BRAIN_URL` |
| `LAT` / `LON` / `TZ` | where you listen, for weather and local time |
| `DEVICE` | `auto` (Intel XPU, then CUDA, then CPU) |
| `EMBED_WORKERS` | songs decoded at once (3) |

Built for an Intel Arc card. For NVIDIA build with
`--build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128` and give the
container the GPU instead of `/dev/dri`.

`GET /status` (with `X-Brain-Key`) shows what it's doing and how well the last
training did against Slopify's old mix.
