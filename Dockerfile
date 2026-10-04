# Node server + ffmpeg (streams/transcodes) + fpcalc (audio fingerprints).
# Two images from this file: the default (slim) one, and `--target gpu`,
# which adds the lyric aligner (Whisper + Demucs on CUDA, ~6 GB) for the
# "Sync lyrics" task.
# The build stage runs on the builder's own CPU (the output is plain JS and
# static files); only the runtime stages are per-platform (amd64, arm64).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS base
LABEL org.opencontainers.image.title="Slopify" \
      org.opencontainers.image.description="Self-hosted music server and apps" \
      org.opencontainers.image.source="https://github.com/lukasbaxter/slopify" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
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
COPY docker/entrypoint.sh /usr/local/bin/slopify-entrypoint
VOLUME ["/data"]
# The entrypoint makes /data (and CACHE_DIR) belong to PUID:PGID (default
# 1000, the bundled `node` user) and runs the server as that user.
EXPOSE 8080
ENTRYPOINT ["slopify-entrypoint"]
HEALTHCHECK --interval=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 64 KB of headers: older apps ask for 500 track ids in one URL (~16.5 KB),
# just past Node's 16 KB default.
CMD ["node", "--max-http-header-size=65536", "server/dist/index.js"]

# The GPU variant: everything above plus the aligner's Python stack. Run it
# with the GPU passed in (CDI: devices nvidia.com/gpu=all); the models
# download into CACHE_DIR/models on first use.
FROM base AS gpu
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY aligner/requirements.txt /opt/align/requirements.txt
RUN python3 -m venv /opt/align \
 && /opt/align/bin/pip install --no-cache-dir -U pip setuptools wheel \
 && /opt/align/bin/pip install --no-cache-dir -r /opt/align/requirements.txt --extra-index-url https://download.pytorch.org/whl/cu121

# The default target: the slim image.
FROM base AS runtime
