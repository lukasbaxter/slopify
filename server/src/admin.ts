// Admin: scans and status. The scan runs in the process (one at a time)
// and reports progress; a library version bump tells clients to refetch.
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { scanLibrary } from './scanner.js';

export function registerAdmin(app: FastifyInstance, db: DB, musicDir: string, dataDir: string) {
  const admin = { preHandler: (app as any).requireAdmin };
  let current: { started: number; files: number } | null = null;
  const runScan = async () => {
    if (current) return current;
    current = { started: Date.now(), files: 0 };
    scanLibrary(db, { musicDir, dataDir, onProgress: (n) => { if (current) current.files = n; }, log: (m) => app.log.warn(m) })
      .then((r) => app.log.info(`scan done: ${JSON.stringify(r)}`))
      .catch((e) => app.log.error(`scan failed: ${e.message}`))
      .finally(() => { current = null; });
    return current;
  };
  app.decorate('runScan', runScan);
  app.post('/api/admin/scan', admin, async () => ({ started: true, scan: await runScan() }));
  app.get('/api/admin/status', admin, async () => ({
    scanning: current,
    scans: db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 10').all(),
    users: (db.prepare('SELECT COUNT(*) n FROM users').get() as any).n,
    lyrics: db.prepare("SELECT kind, COUNT(*) n FROM lyrics GROUP BY kind").all(),
    missingLyrics: (db.prepare('SELECT COUNT(*) n FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id)').get() as any).n,
    identity: db.prepare('SELECT identity_state AS state, COUNT(*) n FROM tracks GROUP BY identity_state').all(),
  }));
}
