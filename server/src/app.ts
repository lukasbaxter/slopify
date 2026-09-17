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

export const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
// server/dist/app.js or server/src/app.ts -> repo root
export const repoRoot = path.resolve(here, '..', '..');

export type BuildOptions = { dataDir?: string; musicDir?: string; db?: DB; speakers?: boolean };

export async function buildServer(opts: BuildOptions = {}) {
  const app = Fastify({ logger: { level: config.logLevel } });
  const dataDir = opts.dataDir ?? config.dataDir;
  const db = opts.db ?? openDb(dataDir);
  await ensureAdmin(db, config.adminUser, config.adminPass);
  app.decorate('db', db);
  app.addHook('onClose', async () => { if (!opts.db) db.close(); });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocket);

  const musicDir = opts.musicDir ?? config.musicDir;
  registerAuth(app, db);
  registerLibrary(app, db, dataDir);
  registerStream(app, db, dataDir);
  registerSocial(app, db, dataDir);
  registerAdmin(app, db, musicDir, dataDir);
  registerSession(app, db, { speakers: opts.speakers ?? (process.env.NODE_ENV === 'test' ? false : config.speakers), publicUrl: config.publicUrl });

  const health = async () => ({ ok: true, version: VERSION });
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  const webDist = path.join(repoRoot, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', index: ['index.html'], wildcard: false });
    // SPA: any non-API, non-file path gets index.html
    app.setNotFoundHandler((req, reply) => {
      if (/^\/api\//.test(req.url)) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    });
  }
  return app;
}
