# One image: Node server + ffmpeg (streams/transcodes) + fpcalc (audio
# fingerprints) + llama.cpp's server (the local model behind generated
# playlists). slskd (Soulseek) is added in a later phase.
#
# llama.cpp is built here against CUDA 12.2, not taken from its published
# CUDA image: those are built on newer CUDA and need a newer driver than
# .85's 535 (the forward-compat libs that would bridge it only work on
# datacenter cards; on a GeForce they fail and llama.cpp silently runs on the
# CPU). --build-arg LLM=0 skips it (CI, machines without an NVIDIA GPU); the
# app then shows generated playlists as unavailable.
ARG LLM=1
FROM nvidia/cuda:12.2.2-devel-ubuntu22.04 AS llama-1
ARG LLAMA_REF=b11208
ARG CUDA_ARCH=89
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${LLAMA_REF} https://github.com/ggml-org/llama.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH} \
      -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_OPENMP=OFF -DGGML_CUDA_NCCL=OFF \
      -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
 && cmake --build build --target llama-server -j"$(nproc)"
# The binary plus the CUDA runtime it links (the driver's libcuda comes from
# the host through the NVIDIA container runtime). Never /usr/local/cuda/compat.
RUN mkdir -p /opt/llama/lib && cp build/bin/llama-server /opt/llama/ \
 && cp -P /usr/local/cuda/lib64/libcudart.so.12* /usr/local/cuda/lib64/libcublas.so.12* /usr/local/cuda/lib64/libcublasLt.so.12* /opt/llama/lib/
FROM debian:bookworm-slim AS llama-0
RUN mkdir -p /opt/llama
FROM llama-${LLM} AS llama

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production MUSIC_DIR=/music DATA_DIR=/data PORT=8080
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/package.json web/
RUN npm ci --omit=dev
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY --from=llama /opt/llama /opt/llama
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
