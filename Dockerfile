# Node server + ffmpeg (streams/transcodes) + fpcalc (audio fingerprints).
# Two images from this file: the default (slim) one, and `--target gpu`,
# which adds the lyric aligner (Whisper + Demucs on CUDA, ~6 GB) for the
# "Sync lyrics" task.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production MUSIC_DIR=/music DATA_DIR=/data PORT=8080
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/package.json web/
RUN npm ci --omit=dev
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY aligner/align.py aligner/align.py
VOLUME ["/data"]
# Run as the bundled non-root user (uid 1000). /data and /music are
# host-mounted: make sure they're writable by uid 1000 (see README).
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]

# The GPU variant: everything above plus the aligner's Python stack. Run it
# with the GPU passed in (CDI: devices nvidia.com/gpu=all); the models
# download into CACHE_DIR/models on first use.
FROM base AS gpu
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY aligner/requirements.txt /opt/align/requirements.txt
RUN python3 -m venv /opt/align \
 && /opt/align/bin/pip install --no-cache-dir -U pip setuptools wheel \
 && /opt/align/bin/pip install --no-cache-dir -r /opt/align/requirements.txt --extra-index-url https://download.pytorch.org/whl/cu121
USER node

# The default target: the slim image.
FROM base AS runtime
