// Per-user state: likes, playlists, plays, prefs, and the Home feed built
// from the play log (recently played albums, most played tracks, newest
// albums). Every write is one statement; every read is one query + a batch
// of rows.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { playlistId } from './ids.js';
import { tracksByIds } from './library.js';
import { storeArtwork } from './artwork.js';
import fs from 'node:fs';
import path from 'node:path';

export function registerSocial(app: FastifyInstance, db: DB, dataDir: string) {
  const auth = { preHandler: (app as any).requireUser };
  const uid = (req: any) => req.user.id as string;

  // --- likes ---
  app.get('/api/likes', auth, async (req) => {
    const rows = db.prepare('SELECT track_id, at FROM likes WHERE user_id = ? ORDER BY at DESC').all(uid(req)) as any[];
    const at = Object.fromEntries(rows.map((r) => [r.track_id, r.at]));
    const full = (req.query as any).full === '1';
    return full ? { at, items: tracksByIds(db, rows.map((r) => r.track_id)) } : { at };
  });
  // A like on a track, or on an album (saved to Your Library).
  const isAlbum = (id: string) => !!db.prepare('SELECT 1 FROM albums WHERE id = ?').get(id);
  app.put('/api/likes/:id', auth, async (req) => {
    const id = (req.params as any).id as string;
    const at = Number((req.body as any)?.at) || Date.now();
    if (isAlbum(id)) { db.prepare('INSERT INTO album_likes (user_id, album_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(uid(req), id, at); return { ok: true, at, album: true }; }
    db.prepare('INSERT INTO likes (user_id, track_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(uid(req), id, at);
    (app as any).sessionLike?.(uid(req), id, true, at);
    return { ok: true, at };
  });
  app.delete('/api/likes/:id', auth, async (req) => {
    const id = (req.params as any).id as string;
    if (isAlbum(id)) { db.prepare('DELETE FROM album_likes WHERE user_id = ? AND album_id = ?').run(uid(req), id); return { ok: true, album: true }; }
    db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(uid(req), id); (app as any).sessionLike?.(uid(req), id, false, Date.now()); return { ok: true };
  });
  // Albums saved to Your Library.
  app.get('/api/likes/albums', auth, async (req) => {
    const rows = db.prepare('SELECT a.*, l.at FROM album_likes l JOIN albums a ON a.id = l.album_id WHERE l.user_id = ? ORDER BY l.at DESC').all(uid(req)) as any[];
    return { items: rows.map((a) => ({ id: a.id, name: a.name, artist: a.artist, artistId: a.artist_id, year: a.year, trackCount: a.track_count, durationMs: a.duration_ms, cover: a.cover_hash, addedAt: a.added_at, likedAt: a.at })) };
  });

  // Profile picture: one JPEG/PNG/WebP per user, rendered like a cover.
  const avatarPath = (u: string) => path.join(dataDir, 'avatars', `${u}.jpg`);
  app.get('/api/users/:id/avatar', async (req, reply) => {
    const p = avatarPath(String((req.params as any).id).replace(/[^\w-]/g, ''));
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('Cache-Control', 'private, max-age=600').type('image/jpeg');
    return reply.send(fs.createReadStream(p));
  });
  const rawBody = async (req: any) => { const chunks: Buffer[] = []; let n = 0; for await (const c of req.raw) { n += c.length; if (n > 12 * 1024 * 1024) throw new Error('too large'); chunks.push(c); } return Buffer.concat(chunks); };
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/octet-stream'], (_req, _payload, done) => done(null, undefined));
  app.post('/api/users/me/avatar', auth, async (req, reply) => {
    let bytes: Buffer; try { bytes = await rawBody(req); } catch { return reply.code(413).send({ error: 'too large' }); }
    const { default: sharp } = await import('sharp');
    fs.mkdirSync(path.join(dataDir, 'avatars'), { recursive: true });
    try { await sharp(bytes, { failOn: 'none' }).rotate().resize(512, 512, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(avatarPath(uid(req))); } catch { return reply.code(400).send({ error: 'not an image' }); }
    return { ok: true };
  });

  // --- playlists ---
  const plOut = (p: any) => ({ id: p.id, name: p.name, userId: p.user_id, created: p.created, updated: p.updated, trackCount: p.track_count ?? 0, cover: p.cover_hash ?? p.cover ?? null });
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
  app.post('/api/playlists/:id/cover', auth, async (req, reply) => {
    const p = own(req, (req.params as any).id); if (!p) return reply.code(404).send({ error: 'no such playlist' });
    let bytes: Buffer; try { bytes = await rawBody(req); } catch { return reply.code(413).send({ error: 'too large' }); }
    try { const { hash } = await storeArtwork(dataDir, bytes); db.prepare('UPDATE playlists SET cover_hash = ?, updated = ? WHERE id = ?').run(hash, Date.now(), p.id); return { ok: true, cover: hash }; }
    catch { return reply.code(400).send({ error: 'not an image' }); }
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
    if (b.data.client !== 'import') (app as any).scrobbleStart?.(uid(req), b.data.trackId, at);
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
  // Listening history: a page of recent plays, or the stats for a range
  // (streams, minutes, top tracks/artists/albums/genres, per-day counts,
  // and the same numbers for the range before it).
  app.get('/api/history', auth, async (req) => {
    const q = req.query as any; const u = uid(req);
    const rowsOf = (ids: string[]) => new Map(tracksByIds(db, [...new Set(ids)]).map((t) => [t.id, t]));
    if (q.range) {
      const tzo = Number(q.tzo) || 0; // minutes, as the browser reports it
      const now = Date.now();
      const dayStart = (t: number) => { const d = new Date(t - tzo * 60000); d.setUTCHours(0, 0, 0, 0); return d.getTime() + tzo * 60000; };
      const spans: Record<string, number> = { today: 1, week: 7, '4w': 28, '6m': 183, year: 366 };
      let from = 0, prevFrom = 0;
      if (q.range === 'today') { from = dayStart(now); prevFrom = from - 86400000; }
      else if (q.range === 'week') { const d = new Date(now - tzo * 60000); const back = (d.getUTCDay() + 6) % 7; from = dayStart(now) - back * 86400000; prevFrom = from - 7 * 86400000; }
      else if (q.range === 'year') { const d = new Date(now - tzo * 60000); from = Date.UTC(d.getUTCFullYear(), 0, 1) + tzo * 60000; prevFrom = Date.UTC(d.getUTCFullYear() - 1, 0, 1) + tzo * 60000; }
      else if (spans[q.range]) { from = now - spans[q.range] * 86400000; prevFrom = from - spans[q.range] * 86400000; }
      const plays = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? AND at >= ? ORDER BY at DESC').all(u, prevFrom) as any[];
      const by = rowsOf(plays.map((r) => r.track_id));
      const stats = (rows: any[]) => {
        let minutes = 0; const tr = new Map<string, any>(), ar = new Map<string, any>(), al = new Map<string, any>(), ge = new Map<string, number>(), days = new Set<number>();
        for (const r of rows) {
          const t = by.get(r.track_id); if (!t) continue;
          const secs = t.durationMs / 1000; minutes += secs / 60; days.add(dayStart(r.at));
          const T = tr.get(t.id) || { id: t.id, name: t.title, artist: t.artist, artistId: t.artistIds[0] || null, albumId: t.albumId, count: 0, seconds: 0 }; T.count++; T.seconds += secs; tr.set(t.id, T);
          t.artistIds.forEach((aid: string, i: number) => { const A = ar.get(aid) || { artistId: aid, name: t.artists[i], count: 0, seconds: 0 }; A.count++; A.seconds += secs; ar.set(aid, A); });
          const L = al.get(t.albumId) || { albumId: t.albumId, name: t.album, artist: t.albumArtist, count: 0, seconds: 0 }; L.count++; L.seconds += secs; al.set(t.albumId, L);
          for (const g of t.genres) ge.set(g, (ge.get(g) || 0) + 1);
        }
        const top = (m: Map<string, any>) => [...m.values()].sort((a, b) => b.count - a.count || b.seconds - a.seconds).slice(0, 50);
        return { streams: rows.length, minutes: Math.round(minutes), daysStreamed: days.size, uniqueTracks: tr.size, uniqueArtists: ar.size, uniqueAlbums: al.size, topTracks: top(tr), topArtists: top(ar), topAlbums: top(al), topGenres: [...ge.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => ({ id: name, name })) };
      };
      const cur = plays.filter((r) => r.at >= from), prev = plays.filter((r) => r.at < from);
      const perDay = new Map<number, { count: number; minutes: number }>();
      const byHour = new Array(24).fill(0), byHourSeconds = new Array(24).fill(0);
      for (const r of cur) {
        const d = dayStart(r.at); const e = perDay.get(d) || { count: 0, minutes: 0 }; const secs = (by.get(r.track_id)?.durationMs || 0) / 1000; e.count++; e.minutes += secs / 60; perDay.set(d, e);
        const h = new Date(r.at - tzo * 60000).getUTCHours(); byHour[h]++; byHourSeconds[h] += secs;
      }
      const dayKey = (t: number) => new Date(t - tzo * 60000).toISOString().slice(0, 10);
      const total = (db.prepare('SELECT COUNT(*) n FROM plays WHERE user_id = ?').get(u) as any).n;
      const { topTracks: _pt, topArtists: _pa, topAlbums: _pl, topGenres: _pg, ...prevStats } = stats(prev); void _pt; void _pa; void _pl; void _pg;
      return { connected: true, total, sources: {}, ...stats(cur), prev: from ? prevStats : null, byHour, byHourSeconds: byHourSeconds.map(Math.round), perDay: [...perDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, e]) => ({ day: dayKey(d), count: e.count, minutes: Math.round(e.minutes) })) };
    }
    const limit = Math.min(500, Number(q.limit) || 100);
    const before = Number(q.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare('SELECT track_id, at, client FROM plays WHERE user_id = ? AND at < ? ORDER BY at DESC LIMIT ?').all(u, before, limit) as any[];
    const by = rowsOf(rows.map((r) => r.track_id));
    const items = rows.map((r) => ({ at: r.at, client: r.client, track: by.get(r.track_id) })).filter((x) => x.track);
    return { items, listens: items.map((x) => ({ ts: x.at, id: x.track.id, title: x.track.title, artist: x.track.artist, artistId: x.track.artistIds[0] || null, album: x.track.album, albumId: x.track.albumId, seconds: Math.round(x.track.durationMs / 1000) })) };
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
