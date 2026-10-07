// The Downloads page: albums requested through Slopify (the artist page's
// Request buttons, generated playlists' missing songs) and where each one
// is: waiting in line, downloading, stuck, done or failed.
//
// Lidarr owns the queue and the downloaders and knows nothing about Slopify
// accounts, so who asked for what is kept here (my_requests, by Lidarr's
// album id); the live state is read from Lidarr on every look.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { releaseInLibrary } from './discover.js';
import type { Lidarr, AlbumState } from './lidarr.js';

// Monitored with nothing moving for this long = stuck (a Soulseek watcher
// polls Lidarr's wanted list every few minutes, so quiet half-hours mean
// nobody found anything).
export const STUCK_MS = 30 * 60 * 1000;

// All files down but no library album under this name for a day = the
// names simply do not line up with the library's tags (a retagged import,
// a renamed artist): show it done rather than "adding" forever. Lidarr
// keeps no import timestamp we can read, so the request time stands in.
export const ADDING_GRACE_MS = 24 * 60 * 60 * 1000;

export function recordRequest(db: DB, uid: string, r: { id?: number; album_id?: string; artist?: string; title?: string }, source: 'request' | 'ai' | 'retry' | 'spotify', note: string | null = null) {
  if (!r?.id) return;
  // Asked for again: whatever the watcher concluded before starts over.
  db.prepare('DELETE FROM download_watch WHERE lidarr_id = ?').run(r.id);
  db.prepare(`INSERT OR IGNORE INTO my_requests (user_id, lidarr_id, album_id, artist, title, source, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, r.id, r.album_id ?? null, r.artist ?? null, r.title ?? null, source, note, Date.now());
}

type Meta = { source: string | null; note: string | null; created: number | null; mine: boolean };
type Watch = { first_seen: number; progress_at: number; gave_up: number | null; reason: string | null };

const hours = (ms: number) => { const h = Math.round(ms / 3600000); return h < 1 ? 'under an hour' : h === 1 ? '1 hour' : `${h} hours`; };

// One album's row as the page shows it.
export function downloadOut(a: AlbumState, meta: Meta | undefined, inLibrary: { id: string } | null, now = Date.now(), watch?: Watch) {
  // Albums nobody asked for here (the chores' backlog, Lidarr's own) run
  // their stuck clock from when the watcher first saw them.
  const since = meta?.created ?? watch?.first_seen ?? null;
  let state: string; let via = 'soulseek'; let detail: string | null = null; let reason: string | null = null;
  if (a.queue) { state = a.queue.state; via = a.queue.protocol || 'download'; detail = a.queue.detail; reason = state === 'failed' ? a.queue.detail : null; }
  else if (a.total > 0 && a.done >= a.total) state = inLibrary || (meta?.created && now - meta.created > ADDING_GRACE_MS) ? 'done' : 'adding';
  else if (!a.monitored) { state = 'failed'; reason = watch?.gave_up && watch.reason ? watch.reason : 'no longer monitored in Lidarr'; }
  else if (a.done > 0) state = 'downloading';
  else if (since && now - since > STUCK_MS) { state = 'stuck'; reason = `nothing matching on Soulseek yet (looking for ${hours(now - since)})`; }
  else state = 'queued';
  return {
    id: a.id, albumId: a.album_id, artist: a.artist, title: a.title, type: a.rtype, year: a.year, image: a.image,
    state, total: a.total, done: a.done, queuePos: null,
    requested: meta?.created ?? null, started: null, progressAt: watch?.progress_at ?? meta?.created ?? null,
    finished: state === 'failed' && watch?.gave_up ? watch.gave_up : null,
    reason, via, detail,
    libraryAlbumId: inLibrary?.id ?? null, source: meta?.source ?? null, note: meta?.note ?? null, mine: meta?.mine ?? false,
  };
}

export function registerDownloads(app: FastifyInstance, db: DB, opts: { lidarr?: Lidarr }) {
  const auth = { preHandler: (app as any).requireUser };
  const lidarr = opts.lidarr;
  const ready = lidarr?.enabled;

  const watchOf = (ids: number[]): Map<number, Watch> => {
    const m = new Map<number, Watch>();
    const q = db.prepare('SELECT first_seen, progress_at, gave_up, reason FROM download_watch WHERE lidarr_id = ?');
    for (const id of ids) { const r = q.get(id) as Watch | undefined; if (r) m.set(id, r); }
    return m;
  };

  const metaFor = (uid: string): Map<number, Meta> => {
    // The newest 2000 rows (old ones may fall off), merged oldest-first so
    // the first requester's source/time still wins below.
    const rows = (db.prepare('SELECT user_id, lidarr_id, source, note, created FROM my_requests ORDER BY created DESC LIMIT 2000').all() as any[]).reverse();
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
        const mine = (db.prepare('SELECT DISTINCT lidarr_id FROM my_requests WHERE user_id = ? ORDER BY created DESC LIMIT 100').all(req.user.id) as any[]).map((r) => r.lidarr_id);
        // and what the watcher gave up on lately, whoever queued it
        const quit = (db.prepare('SELECT lidarr_id FROM download_watch WHERE gave_up > ? ORDER BY gave_up DESC LIMIT 100').all(Date.now() - 7 * 86400000) as any[]).map((r) => r.lidarr_id);
        rows = rows.concat(await lidarr!.albums([...new Set([...mine, ...quit])].filter((i) => !seen.has(i))));
      }
    } catch (e: any) { return reply.code(502).send({ error: e.message }); }
    const now = Date.now();
    const watch = watchOf(rows.map((a) => a.id));
    const items = rows.map((a) => downloadOut(a, meta.get(a.id), releaseInLibrary(db, a.artist, a.title), now, watch.get(a.id)));
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
    const state = downloadOut(a, meta, releaseInLibrary(db, a.artist, a.title), Date.now(), watchOf([id]).get(id)).state;
    if (state !== 'failed' && state !== 'stuck') return reply.code(409).send({ error: `It is ${state}, not failed or stuck` });
    try { await lidarr!.retry(id); } catch (e: any) { return reply.code(502).send({ error: e.message }); }
    const old = db.prepare('SELECT * FROM my_requests WHERE user_id = ? AND lidarr_id = ?').get(req.user.id, id) as any;
    recordRequest(db, req.user.id, { id, album_id: a.album_id, artist: a.artist, title: a.title }, old?.source ?? 'retry', old?.note ?? null);
    // The stuck clock runs from `created`: a retry restarts it (every row for
    // the album, whoever asked first - the clock is the album's), else the
    // album is back to "stuck" on the next poll no matter what the retry did.
    db.prepare('UPDATE my_requests SET created = ? WHERE lidarr_id = ?').run(Date.now(), id);
    app.log.info(`download retry #${id} (${a.artist} - ${a.title})`);
    return { ok: true, id };
  });
}

// --- the watcher ---------------------------------------------------------------
//
// The Soulseek watcher (Soularr) retries every wanted album every few
// minutes, forever, and cannot tell when Lidarr filed what it fetched under
// a different album. This pass, run by the "Watch downloads" task, keeps
// the wanted list honest:
//  - an album whose downloads keep landing in ANOTHER album of the same
//    artist (a near-identical title: "Piano Concerto No. 4" for "No. 1")
//    while it stays empty is given up after WRONG_ROUNDS such imports;
//  - an album with no new file for giveUpMs is given up.
// Giving up = unmonitored in Lidarr (off the wanted list, so the searching
// stops) and the reason kept for the Downloads page. A Request or Retry
// clears it (recordRequest), and the chores skip given-up albums.
export const WRONG_ROUNDS = 2;

export async function watchDownloads(db: DB, lidarr: Lidarr, opts: { giveUpMs: number; now?: number; log?: (m: string) => void }) {
  const now = opts.now ?? Date.now();
  const log = opts.log ?? (() => {});
  const rows = await lidarr.all();
  const get = db.prepare('SELECT * FROM download_watch WHERE lidarr_id = ?');
  const ins = db.prepare('INSERT INTO download_watch (lidarr_id, album_id, first_seen, done, progress_at) VALUES (?, ?, ?, ?, ?)');
  const prog = db.prepare('UPDATE download_watch SET done = ?, progress_at = ? WHERE lidarr_id = ?');
  const quit = db.prepare('UPDATE download_watch SET gave_up = ?, reason = ? WHERE lidarr_id = ?');
  // Albums someone is (or the watcher is) waiting on: imports into these
  // are expected, never "the wrong album".
  const wantedIds = new Set(rows.filter((a) => a.monitored).map((a) => a.id));
  const requested = new Set((db.prepare('SELECT DISTINCT lidarr_id FROM my_requests').all() as any[]).map((r) => r.lidarr_id));
  const history = new Map<number, Promise<{ albumId: number; album: string; at: number }[]>>();
  let watching = 0; const gaveUp: string[] = [];
  for (const a of rows) {
    if (!a.monitored || (a.total > 0 && a.done >= a.total)) continue;
    // Lidarr's own download clients (torrents) report their own failures.
    if (a.queue?.state === 'downloading') continue;
    watching++;
    const w = get.get(a.id) as any;
    if (!w) { ins.run(a.id, a.album_id, now, a.done, now); continue; }
    if (a.done > w.done) { prog.run(a.done, now, a.id); continue; }
    let reason: string | null = null;
    if (a.done === 0 && a.artistId && now - w.first_seen > STUCK_MS) {
      if (!history.has(a.artistId)) history.set(a.artistId, lidarr.importsSince(a.artistId, 0).catch(() => []));
      const elsewhere = new Map<number, { album: string; rounds: Set<number> }>();
      for (const h of await history.get(a.artistId)!) {
        if (h.at < w.first_seen || h.albumId === a.id || wantedIds.has(h.albumId) || requested.has(h.albumId)) continue;
        const e = elsewhere.get(h.albumId) ?? { album: h.album, rounds: new Set<number>() };
        e.rounds.add(Math.floor(h.at / 60000)); // one import = one minute's batch of files
        elsewhere.set(h.albumId, e);
      }
      const worst = [...elsewhere.values()].sort((x, y) => y.rounds.size - x.rounds.size)[0];
      if (worst && worst.rounds.size >= WRONG_ROUNDS) reason = `downloads kept turning out to be a different album ("${worst.album}")`;
    }
    if (!reason && now - w.progress_at > opts.giveUpMs) reason = a.done > 0
      ? `stopped at ${a.done} of ${a.total} songs, nothing new for ${hours(now - w.progress_at)}`
      : `nothing matching found on Soulseek in ${hours(now - w.progress_at)}`;
    if (!reason) continue;
    try { await lidarr.unmonitor(a.id); } catch (e: any) { log(`${a.artist} - ${a.title}: could not unmonitor: ${e.message}`); continue; }
    quit.run(now, reason, a.id);
    gaveUp.push(`${a.artist} - ${a.title}`);
    log(`gave up on ${a.artist} - ${a.title}: ${reason}`);
  }
  // Done or no longer wanted, and not a give-up worth remembering: forget it.
  const keep = new Set(rows.filter((a) => a.monitored).map((a) => a.id));
  for (const r of db.prepare('SELECT lidarr_id FROM download_watch WHERE gave_up IS NULL').all() as any[]) {
    if (!keep.has(r.lidarr_id)) db.prepare('DELETE FROM download_watch WHERE lidarr_id = ?').run(r.lidarr_id);
  }
  return { watching, gaveUp };
}

// Release groups the watcher gave up on: the chores must not queue them again.
export function givenUp(db: DB): Set<string> {
  return new Set((db.prepare('SELECT album_id FROM download_watch WHERE gave_up IS NOT NULL AND album_id IS NOT NULL').all() as any[]).map((r) => r.album_id));
}

// slskd's staging folder fills with leftovers: folders emptied by an import
// or a Weekly Exploration move, and copies Lidarr imported without moving.
// Anything outside failed_imports untouched for STAGING_STALE_MS is spent
// (the watcher's stalled timeout is an hour, imports take seconds). Failed
// imports stay for a person to look at; the summary lists them.
export const STAGING_STALE_MS = 2 * 86400000;

export async function cleanStaging(dir: string, opts: { now?: number; staleMs?: number } = {}) {
  const now = opts.now ?? Date.now();
  const stale = opts.staleMs ?? STAGING_STALE_MS;
  // Newest mtime under a folder (its own included), or null if unreadable.
  const newest = async (p: string): Promise<number> => {
    let t = (await fsp.stat(p)).mtimeMs;
    for (const e of await fsp.readdir(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      t = Math.max(t, e.isDirectory() ? await newest(q) : (await fsp.stat(q)).mtimeMs);
    }
    return t;
  };
  const size = async (p: string): Promise<number> => {
    let n = 0;
    for (const e of await fsp.readdir(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      n += e.isDirectory() ? await size(q) : (await fsp.stat(q)).size;
    }
    return n;
  };
  let removed = 0, bytes = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'failed_imports' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    try {
      if (now - await newest(p) < stale) {
        // Recent, but an empty folder an hour old is already spent.
        if ((await fsp.readdir(p)).length || now - (await fsp.stat(p)).mtimeMs < 3600000) continue;
      }
      bytes += await size(p);
      await fsp.rm(p, { recursive: true, force: true });
      removed++;
    } catch { /* raced with a download or an import: next run */ }
  }
  const failed: { name: string; bytes: number }[] = [];
  try {
    for (const e of await fsp.readdir(path.join(dir, 'failed_imports'), { withFileTypes: true })) {
      if (e.isDirectory()) failed.push({ name: e.name, bytes: await size(path.join(dir, 'failed_imports', e.name)).catch(() => 0) });
    }
  } catch { /* none */ }
  return { removed, bytes, failed };
}
