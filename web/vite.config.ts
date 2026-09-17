import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The Conduit web app, unchanged, on the Slopify server: the server speaks
// the Jellyfin subset the app uses under /jf and the relay protocol under
// /relay, so the UI stays pixel-identical.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5180, proxy: { '/jf': { target: 'http://localhost:8080' }, '/relay': { target: 'ws://localhost:8080', ws: true }, '/api': { target: 'http://localhost:8080' } } },
  build: { outDir: 'dist', rollupOptions: { output: { manualChunks: { vendor: ['react', 'react-dom'] } } } },
});
