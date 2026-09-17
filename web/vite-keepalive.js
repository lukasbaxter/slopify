// Serves / emits `keepalive.wav`: 20 minutes of 8 kHz 8-bit mono PCM silence
// (9.6 MB, generated, never checked in). The Media Session keep-alive
// (src/player/keepalive.js) plays it from a real URL because iOS does not
// seek inside blob: media (the clock froze at every seek target); a file
// behind HTTP range requests seeks like any song. The dev server answers
// ranges itself; the build emits the file next to index.html.
export const KEEPALIVE_SECONDS = 20 * 60;
const RATE = 8000;

export function keepAliveWav() {
  const n = KEEPALIVE_SECONDS * RATE, buf = Buffer.alloc(44 + n, 128); // 8-bit PCM: 128 is silence
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  return buf;
}

export default function keepAlivePlugin() {
  let wav = null;
  const file = () => (wav ||= keepAliveWav());
  return {
    name: 'conduit-keepalive',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/keepalive.wav')) return next();
        const data = file(); const total = data.length;
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        let start = 0, end = total - 1;
        if (m) { if (m[1]) start = Number(m[1]); if (m[2]) end = Number(m[2]); if (!m[1] && m[2]) { start = total - Number(m[2]); end = total - 1; } }
        end = Math.min(end, total - 1);
        res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (m) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`); }
        res.setHeader('Content-Length', end - start + 1);
        res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
      });
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'keepalive.wav', source: file() }); },
  };
}
