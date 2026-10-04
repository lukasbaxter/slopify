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
import { lidarrClient, registerLidarrHook } from './lidarr.js';
import { registerTasks, builtinTasks } from './tasks.js';
import { lyricSyncTask, registerLyricSync } from './lyricsync.js';
import { registerIngest } from './ingest.js';
import { SongCache } from './songcache.js';
import { defaultServerName, registerServerInfo } from './advertise.js';

export const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
// server/dist/app.js or server/src/app.ts -> repo root
export const repoRoot = path.resolve(here, '..', '..');

export type BuildOptions = { dataDir?: string; cacheDir?: string; musicDir?: string; db?: DB; speakers?: boolean };

// Tokens ride in URLs (?token=, ?api_key=, ?key= — media elements cannot send
// headers), so mask their values before a request line reaches the log.
const maskUrl = (u: string) => u.replace(/([?&](?:token|api_key|key)=)[^&#]*/gi, '$1***');

export async function buildServer(opts: BuildOptions = {}) {
  // Behind nginx: rate limits per real client, not one bucket for the proxy.
  // TRUST_PROXY (default 1 hop = nginx) keeps clients from minting rate-limit
  // buckets via a forged X-Forwarded-For; Cloudflare-fronted routes still show
  // CF's edge IP unless nginx passes CF-Connecting-IP (out of scope here).
  // Fastify 5 fails closed on a numeric trustProxy, so a hop count becomes a
  // trust function: trust hops 0..N-1, making req.ip the address hop N saw.
  const tp = config.trustProxy;
  const trustProxy = typeof tp === 'number' ? (_addr: string, hop: number) => hop < tp : tp;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: { req: (req: any) => ({ method: req.method, url: maskUrl(req.url), remoteAddress: req.ip }) },
    },
    trustProxy,
  });
  const dataDir = opts.dataDir ?? config.dataDir;
  const cacheDir = opts.cacheDir ?? (opts.dataDir ? opts.dataDir : config.cacheDir);
  const db = opts.db ?? openDb(dataDir);
  await ensureAdmin(db, config.adminUser, config.adminPass);
  app.decorate('db', db);
  app.addHook('onClose', async () => { if (!opts.db) db.close(); });
  // CORS wide open is acceptable here: auth is bearer tokens the browser only
  // sends when the app's own JS attaches them — no cookies, so a foreign
  // origin's request arrives unauthenticated, same as curl.
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocket);
  // Light security headers. CSP is deliberately skipped: the SPA relies on
  // inline scripts/styles and a workable policy would break it.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  const musicDir = opts.musicDir ?? config.musicDir;
  registerAuth(app, db);
  registerLibrary(app, db, cacheDir);
  const songCache = new SongCache(db, cacheDir, config.songCacheGb * 1e9, (m) => app.log.warn(m));
  // A song the library lists on the NAS but the ingest has not copied yet is read from the SSD drop folder.
  const incoming = config.ingest.incomingDir ? path.resolve(config.ingest.incomingDir) : null;
  const altOf = incoming && incoming !== path.resolve(musicDir) ? (f: string) => (f.startsWith(path.resolve(musicDir) + path.sep) ? path.join(incoming, path.relative(path.resolve(musicDir), f)) : null) : undefined;
  registerStream(app, db, cacheDir, songCache, altOf, config.headsEnabled);
  registerSocial(app, db, dataDir, cacheDir);
  const heads = config.headsEnabled ? { cacheDir, seconds: config.headSeconds } : undefined;
  registerAdmin(app, db, musicDir, cacheDir, { heads, pauseMs: config.scanPauseMs, saveToLibrary: config.saveToLibrary });
  app.decorate('ingest', registerIngest(app, db, { ...config.ingest, musicDir, cacheDir, headSeconds: config.headSeconds, headsEnabled: config.headsEnabled }));
  registerServerInfo(app, db, { name: config.serverName || defaultServerName(), version: VERSION, source: config.sourceUrl });
  registerSession(app, db, { speakers: opts.speakers ?? (process.env.NODE_ENV === 'test' ? false : config.speakers), publicUrl: config.publicUrl, bluosGroups: config.bluosGroups });
  registerExplore(app, db, {
    slskdUrl: config.slskdUrl, slskdKey: config.slskdKey,
    slskdDownloadsDir: config.slskdDownloadsDir || undefined, musicDir,
    scanFolders: (rels) => (app as any).scanFolders(rels),
  });
  const lidarr = lidarrClient({ ...config.lidarr, log: (m) => app.log.info(m) });
  registerDiscover(app, db, { lidarr, log: (m) => app.log.info(m) });
  registerJobs(app);
  app.decorate('ai', registerAi(app, db, { ...config.ai, lidarr }));
  registerSpotifyImport(app, db, dataDir);
  registerDownloads(app, db, { lidarr });
  registerLidarrHook(app, { apiKey: config.lidarr.apiKey, musicDir, lidarrRoot: config.lidarr.root });
  registerTasks(app, db, [...builtinTasks(app, {
    db, lidarr, cacheDir, musicDir,
    headsEnabled: config.headsEnabled, headSeconds: config.headSeconds, pauseMs: config.scanPauseMs,
    slskdUrl: config.slskdUrl || undefined, slskdKey: config.slskdKey || undefined, slskdDownloadsDir: config.slskdDownloadsDir || undefined,
    ...config.tasks,
  }), lyricSyncTask(app, {
    db, cacheDir, saveToLibrary: config.saveToLibrary,
    python: config.align.python, script: config.align.script || path.join(repoRoot, 'aligner', 'align.py'), model: config.align.model,
  })]);
  registerLyricSync(app, db, { saveToLibrary: config.saveToLibrary });

  // No version on the unauthenticated health checks (don't hand scanners a
  // fingerprint); nothing in web/src consumes it.
  const health = async () => ({ ok: true });
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
