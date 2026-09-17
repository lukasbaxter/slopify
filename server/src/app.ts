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

export const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
// server/dist/app.js or server/src/app.ts -> repo root
export const repoRoot = path.resolve(here, '..', '..');

export async function buildServer() {
  const app = Fastify({ logger: { level: config.logLevel } });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  const health = async () => ({ ok: true, version: VERSION });
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  const webDist = path.join(repoRoot, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', index: ['index.html'], wildcard: false });
    // SPA: any non-API, non-file path gets index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    });
  }
  return app;
}
