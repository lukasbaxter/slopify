// The Downloads page: albums requested through Slopify (the artist page's
// Request buttons, generated playlists' missing songs) and where each one
// is: waiting in line, downloading (songs so far), stuck, done or failed.
//
// Music Requests owns the queue and the downloader and knows nothing about
// Slopify accounts, so who asked for what is kept here (my_requests); the
// live state is read from Music Requests on every look.
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { releaseInLibrary } from './discover.js';

// No finished song for this long while downloading = stuck.
export const STUCK_MS = 10 * 60 * 1000;
// Done in Music Requests but not in the library yet: the folder scan that
// follows a finished download takes seconds, so past this it is not coming.
export const ADDING_MS = 5 * 60 * 1000;

type MrRequest = {
  id: number; album_id: string; artist: string; title: string; rtype: string; year: string; image: string | null;
  total_tracks: number; status: string; tracks_added: number; tracks_done: number | null; created: number; updated: number;
  started: number | null; progress_at: number | null; log: string | null; queue_pos: number | null;
};

export function recordRequest(db: DB, uid: string, r: { id?: number; album_id?: string; artist?: string; title?: string }, source: 'request' | 'ai' | 'retry', note: string | null = null) {
  if (!r?.id) return;
  db.prepare(`INSERT OR IGNORE INTO my_requests (user_id, mr_id, album_id, artist, title, source, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, r.id, r.album_id ?? null, r.artist ?? null, r.title ?? null, source, note, Date.now());
}

// One Music Requests row as the page shows it.
export function downloadOut(r: MrRequest, now = Date.now()) {
  const secs = (t: number | null) => (t ? Math.round(t * 1000) : null);
  const progressAt = secs(r.progress_at) ?? secs(r.started);
  let state = r.status as string;
  if (state === 'downloading' && progressAt && now - progressAt > STUCK_MS) state = 'stuck';
  const reason = state === 'failed' ? String(r.log || '').replace(/^failed:\s*/i, '') || null : null;
  return {
    id: r.id, albumId: r.album_id, artist: r.artist, title: r.title, type: r.rtype, year: r.year, image: r.image,
    state, total: r.total_tracks || 0, done: state === 'done' ? (r.tracks_added || r.total_tracks || 0) : (r.tracks_done || 0),
    queuePos: r.queue_pos ?? null, requested: secs(r.created), started: secs(r.started), progressAt, finished: r.status === 'done' || r.status === 'failed' ? secs(r.updated) : null,
    reason,
  };
}

export function registerDownloads(app: FastifyInstance, db: DB, opts: { musicRequestsUrl?: string; fetcher?: typeof fetch }) {
  const auth = { preHandler: (app as any).requireUser };
  const MR = opts.musicRequestsUrl;
  const f = opts.fetcher ?? fetch;
  const mr = async (path: string, init?: RequestInit) => {
    const r = await f(`${MR}${path}`, { ...init, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Music Requests ${r.status}`);
    return r.json() as Promise<any>;
  };

  // scope=mine: what this account asked for (newest first); scope=all: the
  // whole queue as Music Requests has it (recent 200), whoever asked.
  app.get('/api/downloads', auth, async (req: any, reply) => {
    if (!MR) return reply.code(503).send({ error: 'Downloads are not set up on this server' });
    const scope = req.query.scope === 'all' ? 'all' : 'mine';
    const mine = db.prepare('SELECT mr_id, source, note, created FROM my_requests WHERE user_id = ? ORDER BY created DESC LIMIT 500').all(req.user.id) as any[];
    const meta = new Map(mine.map((m) => [m.mr_id, m]));
    let rows: MrRequest[] = [];
    let counts: Record<string, number> = {};
    try {
      if (scope === 'mine') {
        if (mine.length) rows = (await mr(`/api/requests?ids=${mine.map((m) => m.mr_id).join(',')}`)).requests || [];
      } else {
        const j = await mr('/api/requests?limit=200'); rows = j.requests || []; counts = j.counts || {};
      }
    } catch (e: any) { return reply.code(502).send({ error: e.message }); }
    const now = Date.now();
    const items = rows.map((r) => {
      const d = downloadOut(r, now);
      // A finished download is only done for the listener once it can be
      // played: link the library album, or say it is still being added.
      const album = d.state === 'done' ? releaseInLibrary(db, r.artist, r.title) : null;
      const state = d.state === 'done' && !album && d.finished && now - d.finished < ADDING_MS ? 'adding' : d.state;
      return { ...d, state, libraryAlbumId: album?.id ?? null, source: meta.get(r.id)?.source ?? null, note: meta.get(r.id)?.note ?? null, mine: meta.has(r.id) };
    });
    const order = ['downloading', 'adding', 'stuck', 'queued', 'failed', 'done'];
    items.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || (a.state === 'queued' ? (a.queuePos ?? 1e9) - (b.queuePos ?? 1e9) : (b.finished ?? b.requested ?? 0) - (a.finished ?? a.requested ?? 0)));
    return { scope, items, counts, stuckAfterMs: STUCK_MS };
  });

  // Try a failed or stuck album again: a fresh request for the same release.
  app.post('/api/downloads/:id/retry', auth, async (req: any, reply) => {
    if (!MR) return reply.code(503).send({ error: 'Downloads are not set up on this server' });
    const id = Number(req.params.id);
    let row: MrRequest | undefined;
    try { row = ((await mr(`/api/requests?ids=${id}`)).requests || [])[0]; } catch (e: any) { return reply.code(502).send({ error: e.message }); }
    if (!row?.album_id) return reply.code(404).send({ error: 'no such download' });
    const state = downloadOut(row).state;
    if (state !== 'failed' && state !== 'stuck') return reply.code(409).send({ error: `It is ${state}, not failed or stuck` });
    // A stuck one still counts as active in Music Requests, which would answer
    // "already requested": put it back in line directly.
    const r = state === 'stuck'
      ? await mr('/api/requeue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => null)
      : await mr('/api/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ album_id: row.album_id }) });
    if (!r) return reply.code(502).send({ error: 'Could not put it back in line' });
    const newId = r.id ?? id;
    const old = db.prepare('SELECT * FROM my_requests WHERE user_id = ? AND mr_id = ?').get(req.user.id, id) as any;
    recordRequest(db, req.user.id, { id: newId, album_id: row.album_id, artist: row.artist, title: row.title }, old?.source ?? 'retry', old?.note ?? null);
    if (newId !== id) db.prepare('DELETE FROM my_requests WHERE user_id = ? AND mr_id = ?').run(req.user.id, id);
    app.log.info(`download retry #${id} -> #${newId} (${row.artist} - ${row.title})`);
    return { ok: true, id: newId };
  });
}
