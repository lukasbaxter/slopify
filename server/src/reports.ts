// Problem reports from Settings › Logs: what the person wrote, the app's
// recent log lines and a few facts about the device, kept in the database
// with who sent it and when, for whoever looks after the server:
//   sqlite3 data/slopify.db "SELECT id, datetime(created/1000, 'unixepoch'), user_name, device, message FROM reports ORDER BY created DESC"
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';

const Report = z.object({
  message: z.string().trim().min(1).max(4000),
  logs: z.array(z.string().max(1000)).max(500).default([]),
  info: z.record(z.string(), z.unknown()).default({}),
});

export function registerReports(app: FastifyInstance, db: DB, opts: { version: string }) {
  const auth = { preHandler: (app as any).requireUser };
  app.post('/api/reports', { ...auth, bodyLimit: 512 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req: any, reply) => {
    const b = Report.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Write what went wrong first' });
    let info = JSON.stringify(b.data.info);
    if (info.length > 16384) info = JSON.stringify({ truncated: true });
    const id = crypto.randomBytes(6).toString('hex');
    const device = String(req.headers['user-agent'] || '').slice(0, 300);
    db.prepare('INSERT INTO reports (id, user_id, user_name, device, message, logs, info, version, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, req.user.name, device, b.data.message, b.data.logs.join('\n'), info, opts.version, Date.now());
    app.log.info({ report: id, user: req.user.name }, 'problem report');
    return { id };
  });
}
