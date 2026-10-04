// Admin: scans and status. The scan runs in the process (one at a time)
// and reports progress; a library version bump tells clients to refetch.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { scanLibrary } from './scanner.js';
import { enrichPass, enrichStatus, artistImagesPass, artistBannersPass, albumCoversPass } from './enrich.js';
import { config } from './config.js';
import { albumGenresPass } from './genres.js';

// heads: cut each scanned song's head into the cache; pauseMs: breathing room
// between files when the library is on a network share; saveToLibrary:
// fetched lyrics and pictures are written into the library too (enrich.ts).
export function registerAdmin(app: FastifyInstance, db: DB, musicDir: string, dataDir: string, scanOpts: { heads?: { cacheDir: string; seconds: number }; pauseMs?: number; saveToLibrary?: boolean } = {}) {
  const admin = { preHandler: (app as any).requireAdmin };
  let current: { started: number; files: number } | null = null;
  // Work that waits on new files (generated playlists' requested songs).
  const afterScan: (() => void)[] = [];
  app.decorate('afterScan', (fn: () => void) => { afterScan.push(fn); });
  let lastScan: Promise<any> | null = null;
  const runScan = (over: { pauseMs?: number } = {}) => {
    if (current) return current;
    current = { started: Date.now(), files: 0 };
    // The scan is "current" only while it walks the files; the enrichment it
    // kicks off afterwards can run for hours and must not block the next scan.
    lastScan = scanLibrary(db, { musicDir, dataDir, ...scanOpts, ...over, onProgress: (n) => { if (current) current.files = n; }, log: (m) => app.log.warn(m) })
      .then((r) => { app.log.info(`scan done: ${JSON.stringify(r)}`); current = null; for (const fn of afterScan) { try { fn(); } catch (e: any) { app.log.error(`after scan: ${e.message}`); } } void runEnrich(); return r; },
        (e) => { app.log.error(`scan failed: ${e.message}`); current = null; throw e; });
    lastScan.catch(() => {}); // awaited by whoever asked; never unhandled
    return current;
  };
  // Lyrics/identity for whatever the scan left unresolved; also on a timer for retries.
  let enriching = false;
  type Parts = { artists?: boolean; covers?: boolean; genres?: boolean; lyrics?: boolean; onPhase?: (name: string) => void };
  const runEnrich = async (parts: Parts = {}) => {
    if (enriching) return;
    enriching = true;
    const on = (k: keyof Parts) => parts[k] !== false;
    const phase = parts.onPhase ?? (() => {});
    try {
      const lib = { musicDir, saveToLibrary: scanOpts.saveToLibrary };
      // Keep going while there is work: a first run over a big library takes hours.
      if (on('artists')) phase('Artist pictures');
      for (let i = 0; on('artists') && i < 40; i++) { const a = await artistImagesPass(db, { log: (m) => app.log.warn(m), dataDir, max: 300, ...lib }); if (a.found + a.missing) app.log.info(`artist images: ${JSON.stringify(a)}`); if (a.found + a.missing < 300) break; }
      if (on('artists') && config.theAudioDbKey !== '') phase('Artist banners');
      for (let i = 0; on('artists') && i < 40; i++) { const b = await artistBannersPass(db, { log: (m) => app.log.warn(m), dataDir, max: 100, audioDbKey: config.theAudioDbKey, ...lib }); if (b.found + b.missing) app.log.info(`artist banners: ${JSON.stringify(b)}`); if (b.found + b.missing < 100) break; }
      if (on('covers')) phase('Album covers');
      for (let i = 0; on('covers') && i < 40; i++) { const c = await albumCoversPass(db, { log: (m) => app.log.warn(m), dataDir, max: 300, ...lib }); if (c.found + c.missing) app.log.info(`album covers: ${JSON.stringify(c)}`); if (c.found + c.missing < 300) break; }
      if (on('genres')) phase('Genres');
      for (let i = 0; on('genres') && i < 40; i++) { const g = await albumGenresPass(db, { log: (m) => app.log.warn(m), max: 300 }); if (g.settled) app.log.info(`album genres: ${JSON.stringify(g)}`); if (g.settled < 300) break; }
      if (on('lyrics')) phase('Lyrics');
      for (let i = 0; on('lyrics') && i < 100; i++) { const r = await enrichPass(db, { log: (m) => app.log.warn(m), max: 500, ...lib }); if (r.done + r.missing + r.instrumental) app.log.info(`enrich: ${JSON.stringify(r)}`); if (r.done + r.missing + r.instrumental < 500) break; }
    }
    catch (e: any) { app.log.error(`enrich failed: ${e.message}`); }
    finally { enriching = false; }
  };
  app.decorate('runEnrich', runEnrich);
  app.post('/api/admin/enrich', admin, async () => { void runEnrich(); return { started: true }; });
  // Just these folders (relative to the library), awaited: the Lidarr
  // import webhook calls it when an album lands so the album is playable
  // seconds later instead of after the next full walk. Safe beside a running full scan:
  // every write is an upsert and neither removes the other's files.
  const scanFolders = async (rel: string[]) => {
    // '' (or '.') is the library root itself: a track that lives directly in
    // MUSIC_DIR resolves there, and the FLAC upgrade task scans by the
    // replaced file's folder, whatever that is.
    const root = path.resolve(musicDir);
    const only = rel.map((r) => path.resolve(musicDir, r)).filter((p) => p === root || p.startsWith(root + path.sep));
    if (!only.length) throw new Error('no folders inside the library');
    const r = await scanLibrary(db, { musicDir, dataDir, heads: scanOpts.heads, only, log: (m) => app.log.warn(m) });
    app.log.info(`folder scan ${rel.join(', ')}: ${JSON.stringify(r)}`);
    for (const fn of afterScan) { try { fn(); } catch (e: any) { app.log.error(`after scan: ${e.message}`); } }
    return r;
  };
  app.decorate('runScan', runScan);
  // The Tasks dashboard runs a scan to completion and reports its result.
  app.decorate('runScanAwaited', (over: { pauseMs?: number } = {}) => { runScan(over); return lastScan; });
  app.decorate('enrichRunning', () => enriching);
  app.decorate('scanFolders', scanFolders);
  app.decorate('runAfterScan', () => { for (const fn of afterScan) { try { fn(); } catch (e: any) { app.log.error(`after scan: ${e.message}`); } } });
  app.decorate('scanning', () => current);
  app.post('/api/admin/scan', admin, async (req: any, reply) => {
    const paths = req.body?.paths;
    if (Array.isArray(paths) && paths.length) {
      // With an ingest, a folder that just landed is still on the SSD: take it
      // to the NAS first (that indexes it), then scan what is in the library.
      const ing = (app as any).ingest;
      const ingested = ing ? await ing.sweep({ only: paths.map(String), settleMs: 0 }) : null;
      try { return { ingested, folders: await scanFolders(paths.map(String)) }; }
      catch (e: any) { return ingested ? { ingested, folders: null } : reply.code(400).send({ error: e.message }); }
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
