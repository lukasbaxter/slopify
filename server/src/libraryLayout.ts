// Your Library's own arrangement, per account, the same on every device:
// the order people drag their playlists, saved albums and followed artists
// into, and folders holding some of them (one level: no folder in a folder).
//
// The order is a list of ids (a folder takes a place in it like anything
// else); each folder has its own list. What the library holds is not kept
// here: an id here that is no longer saved is skipped by the app, and
// something saved with no place here shows at the top (new things first,
// like Spotify). Deleting a folder puts what it held back in the library,
// where the folder was; nothing in it is ever removed.
//
// Every change tells the account's other clients over the session socket
// ({ type: 'prefs', prefs: { _libraryLayout } }), which read it again.
// x-slopify-rev is the writer's own mark for its change, sent back with the
// ping so that client knows the change is the one it already shows.
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';

export const folderId = () => `fd_${crypto.randomBytes(12).toString('hex')}`;
const isFolder = (id: string) => id.startsWith('fd_');
const ID = /^[\w-]{1,64}$/;
const MAX = 20000;

export type Layout = { order: string[]; folders: { id: string; name: string; items: string[] }[] };

export function readLayout(db: DB, uid: string): Layout {
  const folders = db.prepare('SELECT id, name FROM library_folders WHERE user_id = ? ORDER BY created').all(uid) as { id: string; name: string }[];
  const rows = db.prepare('SELECT item_id, folder_id FROM library_order WHERE user_id = ? ORDER BY pos, item_id').all(uid) as { item_id: string; folder_id: string | null }[];
  const known = new Set(folders.map((f) => f.id));
  const inside = new Map(folders.map((f) => [f.id, [] as string[]]));
  const order: string[] = [];
  for (const r of rows) {
    if (r.folder_id && inside.has(r.folder_id)) inside.get(r.folder_id)!.push(r.item_id);
    else if (!isFolder(r.item_id) || known.has(r.item_id)) order.push(r.item_id);
  }
  // A folder always has a place: a new one goes first.
  for (const f of [...folders].reverse()) if (!order.includes(f.id)) order.unshift(f.id);
  return { order, folders: folders.map((f) => ({ ...f, items: inside.get(f.id)! })) };
}

// The whole arrangement at once, as the app has it after a drag. What does
// not fit is put right rather than refused: an id twice keeps its first
// place, a folder inside a folder goes to the top level, a folder deleted
// on another device meanwhile gives its items to the top level in its
// place, and a mix (never in the library) is left out.
export function writeLayout(db: DB, uid: string, order: string[], inFolders: Record<string, string[]>) {
  const mine = new Set((db.prepare('SELECT id FROM library_folders WHERE user_id = ?').all(uid) as { id: string }[]).map((r) => r.id));
  const mixes = new Set((db.prepare('SELECT id FROM playlists WHERE user_id = ? AND mix IS NOT NULL').all(uid) as { id: string }[]).map((r) => r.id));
  const seen = new Set<string>();
  const top: string[] = []; const rows: [string, string | null, number][] = [];
  const take = (id: string) => { if (seen.has(id) || mixes.has(id)) return false; seen.add(id); return true; };
  const fill = (fid: string) => {
    let i = 0;
    for (const id of inFolders[fid] || []) {
      if (isFolder(id)) { if (mine.has(id) && !seen.has(id)) top.push(id); continue; }
      if (take(id)) rows.push([id, fid, i++]);
    }
  };
  for (const id of order) {
    if (isFolder(id) && !mine.has(id)) { for (const x of inFolders[id] || []) if (!isFolder(x) && take(x)) top.push(x); continue; }
    if (take(id)) top.push(id);
  }
  for (const fid of mine) { if (!seen.has(fid)) { seen.add(fid); top.unshift(fid); } }
  for (const fid of mine) fill(fid);
  // ids that were inside a folder another device deleted, not placed above
  for (const [fid, ids] of Object.entries(inFolders)) if (!mine.has(fid)) for (const x of ids) if (!isFolder(x) && take(x)) top.push(x);
  db.transaction(() => {
    db.prepare('DELETE FROM library_order WHERE user_id = ?').run(uid);
    const ins = db.prepare('INSERT INTO library_order (user_id, item_id, folder_id, pos) VALUES (?, ?, ?, ?)');
    top.forEach((id, i) => ins.run(uid, id, null, i));
    for (const [id, fid, i] of rows) ins.run(uid, id, fid, i);
  })();
}

export function registerLibraryLayout(app: FastifyInstance, db: DB) {
  const auth = { preHandler: (app as any).requireUser };
  const uid = (req: any) => req.user.id as string;
  const told = (req: any) => {
    const rev = String(req.headers['x-slopify-rev'] || '').slice(0, 64) || String(Date.now());
    (app as any).sessionLibraryLayout?.(uid(req), rev);
  };
  const ownFolder = (req: any, id: string) => db.prepare('SELECT * FROM library_folders WHERE id = ? AND user_id = ?').get(id, uid(req)) as any;
  const Ids = z.array(z.string().regex(ID)).max(MAX);
  const Name = z.object({ name: z.string().trim().min(1).max(120) });

  app.get('/api/library/layout', auth, async (req) => readLayout(db, uid(req)));
  app.put('/api/library/layout', auth, async (req, reply) => {
    const b = z.object({ order: Ids, folders: z.record(z.string().regex(ID), Ids).default({}) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'order required' });
    if (b.data.order.length + Object.values(b.data.folders).reduce((n, l) => n + l.length, 0) > MAX) return reply.code(400).send({ error: 'too many' });
    writeLayout(db, uid(req), b.data.order, b.data.folders);
    told(req);
    return readLayout(db, uid(req));
  });
  // A new folder goes first in the library, empty.
  app.post('/api/library/folders', auth, async (req, reply) => {
    const b = Name.safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'name required' });
    const id = folderId(), now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO library_folders (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid(req), b.data.name, now, now);
      const first = (db.prepare('SELECT MIN(pos) m FROM library_order WHERE user_id = ? AND folder_id IS NULL').get(uid(req)) as any).m as number | null;
      db.prepare('INSERT INTO library_order (user_id, item_id, folder_id, pos) VALUES (?, ?, NULL, ?)').run(uid(req), id, (first ?? 0) - 1);
    })();
    told(req);
    return { id, name: b.data.name };
  });
  app.patch('/api/library/folders/:id', auth, async (req, reply) => {
    const f = ownFolder(req, (req.params as any).id); if (!f) return reply.code(404).send({ error: 'no such folder' });
    const b = Name.safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'name required' });
    db.prepare('UPDATE library_folders SET name = ?, updated = ? WHERE id = ?').run(b.data.name, Date.now(), f.id);
    told(req);
    return { ok: true };
  });
  // What the folder held goes back to the library where the folder was, in
  // the folder's order.
  app.delete('/api/library/folders/:id', auth, async (req, reply) => {
    const f = ownFolder(req, (req.params as any).id); if (!f) return reply.code(404).send({ error: 'no such folder' });
    const before = readLayout(db, uid(req));
    const items = before.folders.find((x) => x.id === f.id)?.items ?? [];
    const order = before.order.flatMap((id) => (id === f.id ? items : [id]));
    const folders = Object.fromEntries(before.folders.filter((x) => x.id !== f.id).map((x) => [x.id, x.items]));
    db.transaction(() => {
      db.prepare('DELETE FROM library_folders WHERE id = ?').run(f.id);
      writeLayout(db, uid(req), order, folders);
    })();
    told(req);
    return { ok: true, items };
  });
}
