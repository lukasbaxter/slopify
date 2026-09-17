// The desktop app ships the web build: take ../web/dist (built by `npm run build -w web` at the root).
const fs = require('fs'); const path = require('path');
const src = path.join(__dirname, '..', 'web', 'dist'), dst = path.join(__dirname, 'dist');
if (!fs.existsSync(path.join(src, 'index.html'))) { console.error('web/dist is missing: run `npm run build -w web` at the repo root first'); process.exit(1); }
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`copied web build (${fs.readdirSync(dst).length} entries)`);
