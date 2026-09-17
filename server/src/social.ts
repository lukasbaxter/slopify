// Per-user state: likes, playlists, plays, prefs, and the Home feed built
// from the play log (recently played albums, most played tracks, newest
// albums). Every write is one statement; every read is one query + a batch
// of rows.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { playlistId } from './ids.js';
import { tracksByIds } from './library.js';

export function registerSocial(app: FastifyInstance, db: DB) {
  const auth = { preHandler: (app as any).requireUser };
  const uid = (req: any) => req.user.id as string;

  // --- likes ---
  app.get('/api/likes', auth, async (req) => {
    const rows = db.prepare('SELECT track_id, at FROM likes WHERE user_id = ? ORDER BY at DESC').all(uid(req)) as any[];
    const at = Object.fromEntries(rows.map((r) => [r.track_id, r.at]));
    const full = (req.query as any).full === '1';
    return full ? { at, items: tracksByIds(db, rows.map((r) => r.track_id)) } : { at };
  });
  app.put('/api/likes/:id', auth, async (req) => {
    const id = (req.params as any).id as string;
    const at = Number((req.body as any)?.at) || Date.now();
    db.prepare('INSERT INTO likes (user_id, track_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(uid(req), id, at);
    return { ok: true, at };
  });
  app.delete('/api/likes/:id', auth, async (req) => { db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(uid(req), (req.params as any).id); return { ok: true }; });

  // --- playlists ---
  const plOut = (p: any) => ({ id: p.id, name: p.name, userId: p.user_id, created: p.created, updated: p.updated, trackCount: p.track_count ?? 0, cover: p.cover ?? null });
  const listPl = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks x WHERE x.playlist_id = p.id) AS track_count,
      (SELECT a.cover_hash FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id JOIN albums a ON a.id = t.album_id WHERE x.playlist_id = p.id AND a.cover_hash IS NOT NULL ORDER BY x.pos LIMIT 1) AS cover
    FROM playlists p WHERE p.user_id = ? ORDER BY p.updated DESC`);
  const onePl = db.prepare(listPl.source.replace('WHERE p.user_id = ? ORDER BY p.updated DESC', 'WHERE p.id = ? AND p.user_id = ?'));
  app.get('/api/playlists', auth, async (req) => ({ items: (listPl.all(uid(req)) as any[]).map(plOut) }));
  const PlBody = z.object({ name: z.string().min(1).max(120), trackIds: z.array(z.string()).max(5000).optional() });
  app.post('/api/playlists', auth, async (req, reply) => {
    const b = PlBody.safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'name required' });
    const id = playlistId(), now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid(req), b.data.name, now, now);
      (b.data.trackIds ?? []).forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t, now));
    })();
    return { id, name: b.data.name };
  });
  const own = (req: any, id: string) => db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(id, uid(req)) as any;
  app.get('/api/playlists/:id', auth, async (req, reply) => {
    const p = onePl.get((req.params as any).id, uid(req)) as any; if (!p) return reply.code(404).send({ error: 'no such playlist' });
    const ids = (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(p.id) as any[]).map((r) => r.track_id);
    return { ...plOut(p), tracks: tracksByIds(db, ids) };
  });
  app.patch('/api/playlists/:id', auth, async (req, reply) => {
    const p = own(req, (req.params as any).id); if (!p) return reply.code(404).send({ error: 'no such playlist' });
    const b = z.object({ name: z.string().min(1).max(120) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'name required' });
    db.prepare('UPDATE playlists SET name = ?, updated = ? WHERE id = ?').run(b.data.name, Date.now(), p.id); return { ok: true };
  });
  app.delete('/api/playlists/:id', auth, async (req, reply) => {
    const p = own(req, (req.params as any).id); if (!p) return reply.code(404).send({ error: 'no such playlist' });
    db.prepare('DELETE FROM playlists WHERE id = ?').run(p.id); return { ok: true };
  });
  // Track edits: add (append), remove (by position), move (from -> to). Positions are renumbered after each.
  const renumber = db.prepare(`WITH o AS (SELECT rowid AS r, ROW_NUMBER() OVER (ORDER BY pos) - 1 AS n FROM playlist_tracks WHERE playlist_id = ?) UPDATE playlist_tracks SET pos = (SELECT n FROM o WHERE o.r = playlist_tracks.rowid) WHERE playlist_id = ?`);
  app.post('/api/playlists/:id/tracks', auth, async (req, reply) => {
    const p = own(req, (req.params as any).id); if (!p) return reply.code(404).send({ error: 'no such playlist' });
    const b = z.object({ trackIds: z.array(z.string()).min(1).max(2000) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'trackIds required' });
    db.transaction(() => {
      let pos = ((db.prepare('SELECT COALESCE(MAX(pos), -1) m FROM playlist_tracks WHERE playlist_id = ?').get(p.id) as any).m as number) + 1;
      for (const t of b.data.trackIds) db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(p.id, pos++, t, Date.now());
      db.prepare('UPDATE playlists SET updated = ? WHERE id = ?').run(Date.now(), p.id);
    })();
    return { ok: true };
  });
  app.delete('/api/playlists/:id/tracks/:pos', auth, async (req, reply) => {
    const p = own(req, (req.params as any).id); if (!p) return reply.code(404).send({ error: 'no such playlist' });
    db.transaction(() => { db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND pos = ?').run(p.id, Number((req.params as any).pos)); renumber.run(p.id, p.id); db.prepare('UPDATE playlists SET updated = ? WHERE id = ?').run(Date.now(), p.id); })();
    return { ok: true };
  });
  app.post('/api/playlists/:id/move', auth, async (req, reply) => {
    const p = own(req, (req.params as any).id); if (!p) return reply.code(404).send({ error: 'no such playlist' });
    const b = z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).safeParse(req.body); if (!b.success) return reply.code(400).send({ error: 'from/to required' });
    db.transaction(() => {
      const rows = db.prepare('SELECT track_id, added FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(p.id) as any[];
      if (b.data.from >= rows.length || b.data.to >= rows.length) return;
      const [m] = rows.splice(b.data.from, 1); rows.splice(b.data.to, 0, m);
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(p.id);
      rows.forEach((r, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(p.id, i, r.track_id, r.added));
      db.prepare('UPDATE playlists SET updated = ? WHERE id = ?').run(Date.now(), p.id);
    })();
    return { ok: true };
  });

  // --- plays + home ---
  app.post('/api/plays', auth, async (req, reply) => {
    const b = z.object({ trackId: z.string(), at: z.number().optional(), client: z.string().max(80).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'trackId required' });
    const at = b.data.at ?? Date.now();
    // The same track again within 60 s is the same play.
    const last = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(uid(req)) as any;
    if (last && last.track_id === b.data.trackId && Math.abs(at - last.at) < 60000) return { ok: true, dup: true };
    db.prepare('INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(uid(req), b.data.trackId, at, b.data.client ?? null);
    return { ok: true };
  });
  app.get('/api/home', auth, async (req) => {
    const u = uid(req);
    const recentAlbumIds = (db.prepare(`SELECT t.album_id AS id, MAX(p.at) AS last FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? GROUP BY t.album_id ORDER BY last DESC LIMIT 24`).all(u) as any[]).map((r) => r.id);
    const recentAlbums = recentAlbumIds.length ? (db.prepare(`SELECT * FROM albums WHERE id IN (${recentAlbumIds.map(() => '?').join(',')})`).all(...recentAlbumIds) as any[]) : [];
    const byId = new Map(recentAlbums.map((a) => [a.id, a]));
    const since = Date.now() - 28 * 86400000;
    const topIds = (db.prepare('SELECT track_id, COUNT(*) n, MAX(at) last FROM plays WHERE user_id = ? AND at > ? GROUP BY track_id ORDER BY n DESC, last DESC LIMIT 50').all(u, since) as any[]).map((r) => r.track_id);
    const newest = db.prepare('SELECT * FROM albums ORDER BY added_at DESC, sort_name LIMIT 24').all() as any[];
    const out = (a: any) => ({ id: a.id, name: a.name, artist: a.artist, artistId: a.artist_id, year: a.year, trackCount: a.track_count, cover: a.cover_hash });
    return { recentAlbums: recentAlbumIds.map((id) => byId.get(id)).filter(Boolean).map(out), topTracks: tracksByIds(db, topIds), newestAlbums: newest.map(out) };
  });
  app.get('/api/history', auth, async (req) => {
    const limit = Math.min(500, Number((req.query as any).limit) || 100);
    const rows = db.prepare('SELECT track_id, at, client FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(uid(req), limit) as any[];
    const by = new Map(tracksByIds(db, [...new Set(rows.map((r) => r.track_id))]).map((t) => [t.id, t]));
    return { items: rows.map((r) => ({ at: r.at, client: r.client, track: by.get(r.track_id) })).filter((x) => x.track) };
  });

  // --- prefs (a JSON blob per user, patched) ---
  app.get('/api/prefs', auth, async (req) => JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid(req)) as any)?.json ?? '{}'));
  app.patch('/api/prefs', auth, async (req, reply) => {
    if (typeof req.body !== 'object' || !req.body) return reply.code(400).send({ error: 'object required' });
    const cur = JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid(req)) as any)?.json ?? '{}');
    const next = { ...cur, ...(req.body as object) };
    db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = excluded.updated').run(uid(req), JSON.stringify(next), Date.now());
    return next;
  });
}
