// The Downloads page: albums requested through Slopify (the artist page's
// Request buttons, generated playlists' missing songs) and where each one
// is: waiting in line, downloading, stuck, done or failed.
//
// Lidarr owns the queue and the downloaders and knows nothing about Slopify
// accounts, so who asked for what is kept here (my_requests, by Lidarr's
// album id); the live state is read from Lidarr on every look.
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { releaseInLibrary } from './discover.js';
import type { Lidarr, AlbumState } from './lidarr.js';

// Monitored with nothing moving for this long = stuck (a Soulseek watcher
// polls Lidarr's wanted list every few minutes, so quiet half-hours mean
// nobody found anything).
export const STUCK_MS = 30 * 60 * 1000;

export function recordRequest(db: DB, uid: string, r: { id?: number; album_id?: string; artist?: string; title?: string }, source: 'request' | 'ai' | 'retry', note: string | null = null) {
  if (!r?.id) return;
  db.prepare(`INSERT OR IGNORE INTO my_requests (user_id, lidarr_id, album_id, artist, title, source, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, r.id, r.album_id ?? null, r.artist ?? null, r.title ?? null, source, note, Date.now());
}

type Meta = { source: string | null; note: string | null; created: number | null; mine: boolean };

// One album's row as the page shows it.
export function downloadOut(a: AlbumState, meta: Meta | undefined, inLibrary: { id: string } | null, now = Date.now()) {
  let state: string; let via = 'soulseek'; let detail: string | null = null; let reason: string | null = null;
  if (a.queue) { state = a.queue.state; via = 'torrent'; detail = a.queue.detail; reason = state === 'failed' ? a.queue.detail : null; }
  else if (a.total > 0 && a.done >= a.total) state = inLibrary ? 'done' : 'adding';
  else if (a.done > 0) state = 'downloading';
  else if (a.monitored) state = meta?.created && now - meta.created > STUCK_MS ? 'stuck' : 'queued';
  else { state = 'failed'; reason = 'no longer monitored in Lidarr'; }
  return {
    id: a.id, albumId: a.album_id, artist: a.artist, title: a.title, type: a.rtype, year: a.year, image: a.image,
    state, total: a.total, done: a.done, queuePos: null,
    requested: meta?.created ?? null, started: null, progressAt: meta?.created ?? null, finished: null,
    reason, via, detail,
    libraryAlbumId: inLibrary?.id ?? null, source: meta?.source ?? null, note: meta?.note ?? null, mine: meta?.mine ?? false,
  };
}

export function registerDownloads(app: FastifyInstance, db: DB, opts: { lidarr?: Lidarr }) {
  const auth = { preHandler: (app as any).requireUser };
  const lidarr = opts.lidarr;
  const ready = lidarr?.enabled;

  const metaFor = (uid: string): Map<number, Meta> => {
    const rows = db.prepare('SELECT user_id, lidarr_id, source, note, created FROM my_requests ORDER BY created ASC LIMIT 2000').all() as any[];
    const m = new Map<number, Meta>();
    for (const r of rows) {
      const prev = m.get(r.lidarr_id);
      // first requester's source/time wins; "mine" if any of the rows is this account's
      m.set(r.lidarr_id, { source: prev?.source ?? r.source, note: r.user_id === uid ? r.note : prev?.note ?? null, created: prev?.created ?? r.created, mine: (prev?.mine ?? false) || r.user_id === uid });
    }
    return m;
  };

  // scope=mine: what this account asked for (newest first); scope=all:
  // everything wanted or moving in Lidarr, whoever asked.
  app.get('/api/downloads', auth, async (req: any, reply) => {
    if (!ready) return reply.code(503).send({ error: 'Downloads are not set up on this server (LIDARR_URL / LIDARR_API_KEY)' });
    const scope = req.query.scope === 'all' ? 'all' : 'mine';
    const meta = metaFor(req.user.id);
    let rows: AlbumState[] = [];
    try {
      if (scope === 'mine') {
        const ids = (db.prepare('SELECT DISTINCT lidarr_id FROM my_requests WHERE user_id = ? ORDER BY created DESC LIMIT 500').all(req.user.id) as any[]).map((r) => r.lidarr_id);
        rows = await lidarr!.albums(ids);
      } else {
        rows = await lidarr!.all();
        // Finished requests drop off Lidarr's wanted list: keep this
        // account's recent ones visible with their final state.
        const seen = new Set(rows.map((r) => r.id));
        const mine = (db.prepare('SELECT DISTINCT lidarr_id FROM my_requests WHERE user_id = ? ORDER BY created DESC LIMIT 100').all(req.user.id) as any[]).map((r) => r.lidarr_id).filter((i) => !seen.has(i));
        rows = rows.concat(await lidarr!.albums(mine));
      }
    } catch (e: any) { return reply.code(502).send({ error: e.message }); }
    const now = Date.now();
    const items = rows.map((a) => downloadOut(a, meta.get(a.id), releaseInLibrary(db, a.artist, a.title), now));
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.state] = (counts[i.state] || 0) + 1;
    const order = ['downloading', 'adding', 'stuck', 'queued', 'failed', 'done'];
    items.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || (b.requested ?? 0) - (a.requested ?? 0));
    return { scope, items, counts, stuckAfterMs: STUCK_MS };
  });

  // Try a failed or stuck album again: monitor it and search Lidarr's
  // indexers right now (the wanted-list watchers get another go too).
  app.post('/api/downloads/:id/retry', auth, async (req: any, reply) => {
    if (!ready) return reply.code(503).send({ error: 'Downloads are not set up on this server (LIDARR_URL / LIDARR_API_KEY)' });
    const id = Number(req.params.id);
    let a: AlbumState | undefined;
    try { a = (await lidarr!.albums([id]))[0]; } catch (e: any) { return reply.code(502).send({ error: e.message }); }
    if (!a) return reply.code(404).send({ error: 'no such download' });
    const meta = metaFor(req.user.id).get(id);
    const state = downloadOut(a, meta, releaseInLibrary(db, a.artist, a.title)).state;
    if (state !== 'failed' && state !== 'stuck') return reply.code(409).send({ error: `It is ${state}, not failed or stuck` });
    try { await lidarr!.retry(id); } catch (e: any) { return reply.code(502).send({ error: e.message }); }
    const old = db.prepare('SELECT * FROM my_requests WHERE user_id = ? AND lidarr_id = ?').get(req.user.id, id) as any;
    recordRequest(db, req.user.id, { id, album_id: a.album_id, artist: a.artist, title: a.title }, old?.source ?? 'retry', old?.note ?? null);
    app.log.info(`download retry #${id} (${a.artist} - ${a.title})`);
    return { ok: true, id };
  });
}
