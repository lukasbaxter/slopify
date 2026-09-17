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
};
export type Config = typeof config;
