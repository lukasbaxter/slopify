// Everything the container needs, from the environment. Defaults are the
// homelab defaults: mount your music at /music, keep state in /data.
import path from 'node:path';

const env = (k: string, d: string) => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  musicDir: path.resolve(env('MUSIC_DIR', '/music')),
  dataDir: path.resolve(env('DATA_DIR', '/data')),
  publicUrl: env('PUBLIC_URL', '').replace(/\/+$/, ''),
  adminUser: env('ADMIN_USER', 'admin'),
  adminPass: env('ADMIN_PASS', 'admin'),
  logLevel: env('LOG_LEVEL', 'info'),
  loginRateMax: Number(env('LOGIN_RATE_MAX', '10')), // per IP per minute; raised for the E2E suite
  // Find and drive Chromecast / BluOS speakers on the server's network (needs host networking in Docker).
  speakers: env('SPEAKERS', '1') !== '0',
  // slskd (Soulseek) for the Weekly Exploration playlist: tracks the library lacks are fetched through it.
  slskdUrl: env('SLSKD_URL', '').replace(/\/+$/, ''),
  slskdKey: env('SLSKD_API_KEY', ''),
  // Music Requests (Spotify lookups + the album download queue) for the artist
  // page's full discography, "Request" buttons, Release Radar and global search.
  musicRequestsUrl: env('MUSIC_REQUESTS_URL', '').replace(/\/+$/, ''),
  // The local model behind generated playlists (llama.cpp's server, built into
  // the image). Downloaded into /data/models on first use; started on demand
  // and stopped after LLM_IDLE_MIN minutes so the GPU is free the rest of the time.
  llm: {
    llamaBin: env('LLAMA_BIN', '/opt/llama/llama-server'),
    modelFile: env('LLM_MODEL_FILE', 'Qwen3.5-9B-Q4_K_M.gguf'),
    modelPath: env('LLM_MODEL', ''),
    modelUrl: env('LLM_MODEL_URL', 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf'),
    llmUrl: env('LLM_URL', '').replace(/\/+$/, '') || undefined, // an OpenAI-compatible server instead (development)
    port: Number(env('LLM_PORT', '18091')),
    idleMs: Number(env('LLM_IDLE_MIN', '10')) * 60000,
    gpuLayers: env('LLM_GPU_LAYERS', '99'),
    ctx: Number(env('LLM_CTX', '16384')),
  },
};
export type Config = typeof config;
