// The Fastify app, built without listening so tests can inject requests.
// API lives under /api; the built web app is served from / when present.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb, type DB } from './db.js';
import { ensureAdmin, registerAuth } from './auth.js';
import { registerLibrary } from './library.js';
import { registerStream } from './stream.js';
import { registerSocial } from './social.js';
import { registerAdmin } from './admin.js';
import websocket from '@fastify/websocket';
import { registerSession } from './session.js';
import { registerExplore } from './explore.js';
import { registerDiscover } from './discover.js';
import { registerJobs } from './jobs.js';
import { registerAi } from './ai.js';
import { registerSpotifyImport } from './spotifyImport.js';
import { registerDownloads } from './downloads.js';
import { registerIngest } from './ingest.js';
import { SongCache } from './songcache.js';

export const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
// server/dist/app.js or server/src/app.ts -> repo root
export const repoRoot = path.resolve(here, '..', '..');

export type BuildOptions = { dataDir?: string; cacheDir?: string; musicDir?: string; db?: DB; speakers?: boolean };

export async function buildServer(opts: BuildOptions = {}) {
  // Behind nginx: rate limits per real client, not one bucket for the proxy.
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });
  const dataDir = opts.dataDir ?? config.dataDir;
  const cacheDir = opts.cacheDir ?? (opts.dataDir ? opts.dataDir : config.cacheDir);
  const db = opts.db ?? openDb(dataDir);
  await ensureAdmin(db, config.adminUser, config.adminPass);
  app.decorate('db', db);
  app.addHook('onClose', async () => { if (!opts.db) db.close(); });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocket);

  const musicDir = opts.musicDir ?? config.musicDir;
  registerAuth(app, db);
  registerLibrary(app, db, cacheDir);
  const songCache = new SongCache(db, cacheDir, config.songCacheGb * 1e9, (m) => app.log.warn(m));
  // A song the library lists on the NAS but the ingest has not copied yet is read from the SSD drop folder.
  const incoming = config.ingest.incomingDir ? path.resolve(config.ingest.incomingDir) : null;
  const altOf = incoming && incoming !== path.resolve(musicDir) ? (f: string) => (f.startsWith(path.resolve(musicDir) + path.sep) ? path.join(incoming, path.relative(path.resolve(musicDir), f)) : null) : undefined;
  registerStream(app, db, cacheDir, songCache, altOf);
  registerSocial(app, db, dataDir, cacheDir);
  const heads = { cacheDir, seconds: config.headSeconds };
  registerAdmin(app, db, musicDir, cacheDir, { heads, pauseMs: config.scanPauseMs });
  app.decorate('ingest', registerIngest(app, db, { ...config.ingest, musicDir, cacheDir, headSeconds: config.headSeconds }));
  registerSession(app, db, { speakers: opts.speakers ?? (process.env.NODE_ENV === 'test' ? false : config.speakers), publicUrl: config.publicUrl });
  registerExplore(app, db, { slskdUrl: config.slskdUrl, slskdKey: config.slskdKey });
  registerDiscover(app, db, { musicRequestsUrl: config.musicRequestsUrl, log: (m) => app.log.info(m) });
  registerJobs(app);
  app.decorate('ai', registerAi(app, db, { ...config.ai, musicRequestsUrl: config.musicRequestsUrl }));
  registerSpotifyImport(app, db, dataDir);
  registerDownloads(app, db, { musicRequestsUrl: config.musicRequestsUrl });

  const health = async () => ({ ok: true, version: VERSION });
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  const webDist = path.join(repoRoot, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', index: ['index.html'], wildcard: false });
    // SPA: any non-API, non-file path gets index.html
    app.setNotFoundHandler((req, reply) => {
      if (/^\/api\//.test(req.url)) return reply.code(404).send({ error: 'not found' });
      // a missing file (favicon.ico, an old hashed asset) is a 404, not the app: browsers and scrapers took the HTML as the icon
      if (/\.(ico|png|svg|jpe?g|webp|gif|js|mjs|css|map|json|webmanifest|txt|xml|woff2?)$/i.test(req.url.split('?')[0])) return reply.code(404).send('not found');
      return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    });
  }
  return app;
}
