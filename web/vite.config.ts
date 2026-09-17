import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import keepAlive from './vite-keepalive.js';
// Conduit's web app, unchanged, on the Slopify server (data layer in src/api).
// keepAlive writes keepalive.wav (20 min of silence) next to the build: the
// phone plays it to keep the lock screen on a session playing elsewhere.
export default defineConfig({
  // Relative asset paths: the desktop app loads the build from disk.
  base: './',
  plugins: [react(), keepAlive()],
  server: { port: 5180, proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  build: { outDir: 'dist', rollupOptions: { output: { manualChunks: { vendor: ['react', 'react-dom'] } } } },
});
