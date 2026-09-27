// Admin: scans and status. The scan runs in the process (one at a time)
// and reports progress; a library version bump tells clients to refetch.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { scanLibrary } from './scanner.js';
import { enrichPass, enrichStatus, artistImagesPass } from './enrich.js';

export function registerAdmin(app: FastifyInstance, db: DB, musicDir: string, dataDir: string) {
  const admin = { preHandler: (app as any).requireAdmin };
  let current: { started: number; files: number } | null = null;
  // Work that waits on new files (generated playlists' requested songs).
  const afterScan: (() => void)[] = [];
  app.decorate('afterScan', (fn: () => void) => { afterScan.push(fn); });
  const runScan = async () => {
    if (current) return current;
    current = { started: Date.now(), files: 0 };
    // The scan is "current" only while it walks the files; the enrichment it
    // kicks off afterwards can run for hours and must not block the next scan.
    scanLibrary(db, { musicDir, dataDir, onProgress: (n) => { if (current) current.files = n; }, log: (m) => app.log.warn(m) })
      .then((r) => { app.log.info(`scan done: ${JSON.stringify(r)}`); current = null; for (const fn of afterScan) { try { fn(); } catch (e: any) { app.log.error(`after scan: ${e.message}`); } } void runEnrich(); })
      .catch((e) => { app.log.error(`scan failed: ${e.message}`); current = null; });
    return current;
  };
  // Lyrics/identity for whatever the scan left unresolved; also on a timer for retries.
  let enriching = false;
  const runEnrich = async () => {
    if (enriching) return;
    enriching = true;
    try {
      // Keep going while there is work: a first run over a big library takes hours.
      for (let i = 0; i < 40; i++) { const a = await artistImagesPass(db, { log: (m) => app.log.warn(m), dataDir, max: 300 }); if (a.found + a.missing) app.log.info(`artist images: ${JSON.stringify(a)}`); if (a.found + a.missing < 300) break; }
      for (let i = 0; i < 100; i++) { const r = await enrichPass(db, { log: (m) => app.log.warn(m), max: 500 }); if (r.done + r.missing + r.instrumental) app.log.info(`enrich: ${JSON.stringify(r)}`); if (r.done + r.missing + r.instrumental < 500) break; }
    }
    catch (e: any) { app.log.error(`enrich failed: ${e.message}`); }
    finally { enriching = false; }
  };
  app.decorate('runEnrich', runEnrich);
  app.post('/api/admin/enrich', admin, async () => { void runEnrich(); return { started: true }; });
  // Just these folders (relative to the library), awaited: Music Requests
  // calls it when an album lands so the album is playable seconds later
  // instead of after the next full walk. Safe beside a running full scan:
  // every write is an upsert and neither removes the other's files.
  const scanFolders = async (rel: string[]) => {
    const only = rel.map((r) => path.resolve(musicDir, r)).filter((p) => p.startsWith(path.resolve(musicDir) + path.sep));
    if (!only.length) throw new Error('no folders inside the library');
    const r = await scanLibrary(db, { musicDir, dataDir, only, log: (m) => app.log.warn(m) });
    app.log.info(`folder scan ${rel.join(', ')}: ${JSON.stringify(r)}`);
    for (const fn of afterScan) { try { fn(); } catch (e: any) { app.log.error(`after scan: ${e.message}`); } }
    return r;
  };
  app.decorate('runScan', runScan);
  app.decorate('scanning', () => current);
  app.post('/api/admin/scan', admin, async (req: any, reply) => {
    const paths = req.body?.paths;
    if (Array.isArray(paths) && paths.length) {
      try { return { folders: await scanFolders(paths.map(String)) }; } catch (e: any) { return reply.code(400).send({ error: e.message }); }
    }
    return { started: true, scan: await runScan() };
  });
  app.get('/api/admin/status', admin, async () => ({
    scanning: current,
    library: {
      tracks: (db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n,
      albums: (db.prepare('SELECT COUNT(*) n FROM albums').get() as any).n,
      artists: (db.prepare('SELECT COUNT(*) n FROM artists').get() as any).n,
      artistsWithImage: (db.prepare('SELECT COUNT(*) n FROM artists WHERE image_hash IS NOT NULL').get() as any).n,
    },
    speakers: (app as any).speakers?.list?.() ?? [],
    scans: db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 10').all(),
    users: (db.prepare('SELECT COUNT(*) n FROM users').get() as any).n,
    lyrics: db.prepare("SELECT kind, COUNT(*) n FROM lyrics GROUP BY kind").all(),
    missingLyrics: (db.prepare('SELECT COUNT(*) n FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id)').get() as any).n,
    identity: db.prepare('SELECT identity_state AS state, COUNT(*) n FROM tracks GROUP BY identity_state').all(),
    enrich: enrichStatus(db),
    enriching,
    explore: (app as any).exploreStatus?.() ?? null,
  }));
}
