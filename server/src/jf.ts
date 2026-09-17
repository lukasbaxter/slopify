// A Jellyfin-shaped façade: the subset of Jellyfin's API the Conduit app
// uses, answered from Slopify's own tables and served under /jf so the app
// runs unchanged (same item shapes: Id, Name, Artists, AlbumId, RunTimeTicks,
// UserData.IsFavorite...). Everything here is one or two SQLite queries.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import fs from 'node:fs';
import type { DB } from './db.js';
import { token as newToken } from './ids.js';
import { publicUser, type User } from './auth.js';
import { artPath, nearestSize } from './artwork.js';
import { PROFILES } from './stream.js';
import { playlistId } from './ids.js';

const TICKS = 10_000;
type Row = any;
const arr = <T>(v: T | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function registerJellyfinFacade(app: FastifyInstance, db: DB, dataDir: string, requireUser: any) {
  const auth = { preHandler: requireUser };
  const uid = (req: FastifyRequest) => req.user!.id;

  // ---- shapes ----
  const trackItem = (t: Row, likedSet?: Set<string>) => {
    const artists: string[] = JSON.parse(t.artists || '[]'), ids: string[] = JSON.parse(t.artist_ids || '[]');
    return {
      Id: t.id, Name: t.title, Type: 'Audio', MediaType: 'Audio', ServerId: 'slopify',
      Artists: artists, ArtistItems: artists.map((n, i) => ({ Name: n, Id: ids[i] })).filter((a) => a.Id),
      AlbumArtist: t.album_artist, AlbumArtists: [{ Name: t.album_artist, Id: t.album_artist_id }],
      Album: t.album, AlbumId: t.album_id, ParentId: t.album_id, AlbumPrimaryImageTag: t.cover_hash || undefined,
      IndexNumber: t.track_no ?? undefined, ParentIndexNumber: t.disc_no ?? undefined, ProductionYear: t.year ?? undefined,
      Genres: JSON.parse(t.genres || '[]'), RunTimeTicks: (t.duration_ms || 0) * TICKS, Container: (t.codec || '').toLowerCase().includes('flac') ? 'flac' : 'mp3',
      ImageTags: t.cover_hash ? { Primary: t.cover_hash } : {}, UserData: { IsFavorite: likedSet ? likedSet.has(t.id) : !!t.liked, PlayCount: t.plays || 0 },
      DateCreated: new Date(t.added_at || 0).toISOString(),
    };
  };
  const albumItem = (a: Row) => ({
    Id: a.id, Name: a.name, Type: 'MusicAlbum', ServerId: 'slopify', AlbumArtist: a.artist, AlbumArtists: [{ Name: a.artist, Id: a.artist_id }], ArtistItems: [{ Name: a.artist, Id: a.artist_id }], Artists: [a.artist],
    ProductionYear: a.year ?? undefined, ChildCount: a.track_count, RunTimeTicks: (a.duration_ms || 0) * TICKS, ImageTags: a.cover_hash ? { Primary: a.cover_hash } : {},
    UserData: { IsFavorite: !!a.liked }, DateCreated: new Date(a.added_at || 0).toISOString(),
  });
  const artistItem = (a: Row) => ({ Id: a.id, Name: a.name, Type: 'MusicArtist', ServerId: 'slopify', ImageTags: a.image_hash ? { Primary: a.image_hash } : {}, UserData: { IsFavorite: false } });
  const playlistItem = (p: Row) => ({ Id: p.id, Name: p.name, Type: 'Playlist', ServerId: 'slopify', ChildCount: p.track_count ?? 0, Path: `/config/data/playlists/${p.id}`, ImageTags: p.cover ? { Primary: p.cover } : {}, UserData: { IsFavorite: false }, DateCreated: new Date(p.created || 0).toISOString() });

  const TRACK = `SELECT t.*, a.cover_hash, a.artist_id AS album_artist_id FROM tracks t JOIN albums a ON a.id = t.album_id`;
  const likedSet = (u: string) => new Set((db.prepare('SELECT track_id FROM likes WHERE user_id = ?').all(u) as any[]).map((r) => r.track_id));
  const tracksByIds = (u: string, ids: string[]) => {
    const ls = likedSet(u); const out: any[] = [];
    for (let i = 0; i < ids.length; i += 500) { const c = ids.slice(i, i + 500); const rows = db.prepare(`${TRACK} WHERE t.id IN (${c.map(() => '?').join(',')})`).all(...c) as Row[]; const by = new Map(rows.map((r) => [r.id, r])); for (const id of c) { const r = by.get(id); if (r) out.push(trackItem(r, ls)); } }
    return out;
  };
  const page = (q: any) => ({ limit: Math.min(5000, Math.max(1, Number(q.Limit) || 100)), offset: Math.max(0, Number(q.StartIndex) || 0) });
  const result = (items: any[], total: number, offset = 0) => ({ Items: items, TotalRecordCount: total, StartIndex: offset });

  // ---- auth ----
  app.post('/jf/Users/AuthenticateByName', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = (req.body || {}) as any; const name = String(b.Username || '').trim(), pw = String(b.Pw || '');
    const u = db.prepare('SELECT id, name, role, must_change_pw, pass_hash FROM users WHERE name = ?').get(name) as (User & { pass_hash: string }) | undefined;
    if (!u || !(await argon2.verify(u.pass_hash, pw))) return reply.code(401).send({ error: 'wrong username or password' });
    const t = newToken();
    const device = /Device="([^"]*)"/.exec(String(req.headers.authorization || ''))?.[1] || 'conduit';
    db.prepare('INSERT INTO tokens (token, user_id, device, kind, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(t, u.id, device.slice(0, 80), 'web', Date.now(), Date.now());
    return { AccessToken: t, User: { Id: u.id, Name: u.name, Policy: { IsAdministrator: u.role === 'admin' }, HasPassword: true }, ServerId: 'slopify' };
  });
  app.get('/jf/System/Info/Public', async () => ({ ServerName: 'Slopify', Version: '0.1.0', Id: 'slopify', ProductName: 'Slopify' }));
  app.get('/jf/Users/:id', auth, async (req) => { const u = req.user!; return { Id: u.id, Name: u.name, ServerId: 'slopify', HasPassword: true, PrimaryImageTag: fs.existsSync(`${dataDir}/avatars/${u.id}.jpg`) ? '1' : undefined, Policy: { IsAdministrator: u.role === 'admin', EnableAllFolders: true }, ...publicUser(u) }; });

  // ---- prefs blob (DisplayPreferences) ----
  app.get('/jf/DisplayPreferences/:client', auth, async (req) => { const row = db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid(req)) as any; return { Id: 'conduit', Client: 'conduit', CustomPrefs: row ? JSON.parse(row.json) : {} }; });
  app.post('/jf/DisplayPreferences/:client', auth, async (req, reply) => { const b = (req.body || {}) as any; const prefs = b.CustomPrefs || {}; db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = excluded.updated').run(uid(req), JSON.stringify(prefs), Date.now()); return reply.code(204).send(); });

  // ---- the /Items query engine (the combos the app uses) ----
  const items = (req: FastifyRequest) => {
    const q = req.query as any; const u = uid(req); const { limit, offset } = page(q);
    const type = String(q.IncludeItemTypes || '').split(',')[0];
    const filters = String(q.Filters || '').split(',').filter(Boolean);
    const sortBy = String(q.SortBy || 'SortName').split(',')[0]; const desc = String(q.SortOrder || 'Ascending') === 'Descending';
    const term = String(q.searchTerm || q.SearchTerm || '').trim().toLowerCase();
    if (q.Ids) { const ids = String(q.Ids).split(',').filter(Boolean); const tr = tracksByIds(u, ids); if (tr.length) return result(tr, tr.length); const al = ids.map((id) => db.prepare('SELECT * FROM albums WHERE id = ?').get(id)).filter(Boolean).map(albumItem); if (al.length) return result(al, al.length); const ar = ids.map((id) => db.prepare('SELECT * FROM artists WHERE id = ?').get(id)).filter(Boolean).map(artistItem); return result(ar, ar.length); }
    if (type === 'MusicAlbum') {
      const where: string[] = [], args: any[] = [];
      if (filters.includes('IsFavorite')) { where.push('a.id IN (SELECT t.album_id FROM likes l JOIN tracks t ON t.id = l.track_id WHERE l.user_id = ? GROUP BY t.album_id HAVING COUNT(*) >= 3)'); args.push(u); }
      if (q.AlbumArtistIds) { where.push('(a.artist_id = ? OR a.id IN (SELECT DISTINCT album_id FROM tracks WHERE artist_ids LIKE ?))'); args.push(String(q.AlbumArtistIds), `%"${q.AlbumArtistIds}"%`); }
      if (term) { where.push('(lower(a.name) LIKE ? OR lower(a.artist) LIKE ?)'); args.push(`%${term}%`, `%${term}%`); }
      const order = sortBy === 'DateCreated' ? `a.added_at ${desc ? 'DESC' : 'ASC'}, a.sort_name` : sortBy === 'ProductionYear' ? `a.year ${desc ? 'DESC' : 'ASC'}, a.sort_name` : sortBy === 'Random' ? 'RANDOM()' : `a.sort_name ${desc ? 'DESC' : 'ASC'}`;
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) n FROM albums a ${w}`).get(...args) as any).n;
      const rows = db.prepare(`SELECT a.* FROM albums a ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[];
      return result(rows.map(albumItem), total, offset);
    }
    if (type === 'Playlist') {
      const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks x WHERE x.playlist_id = p.id) AS track_count, (SELECT a.cover_hash FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id JOIN albums a ON a.id = t.album_id WHERE x.playlist_id = p.id AND a.cover_hash IS NOT NULL ORDER BY x.pos LIMIT 1) AS cover FROM playlists p WHERE p.user_id = ? ORDER BY p.name`).all(u) as Row[];
      return result(rows.map(playlistItem), rows.length);
    }
    if (type === 'MusicArtist') { const rows = db.prepare(`SELECT * FROM artists ${term ? 'WHERE lower(name) LIKE ?' : ''} ORDER BY sort_name LIMIT ? OFFSET ?`).all(...(term ? [`%${term}%`] : []), limit, offset) as Row[]; return result(rows.map(artistItem), (db.prepare('SELECT COUNT(*) n FROM artists').get() as any).n, offset); }
    // Audio
    const where: string[] = [], args: any[] = [];
    let join = '';
    if (filters.includes('IsFavorite')) { join += ' JOIN likes l ON l.track_id = t.id AND l.user_id = ?'; args.push(u); }
    if (filters.includes('IsPlayed')) { join += ' JOIN (SELECT track_id, COUNT(*) plays, MAX(at) last FROM plays WHERE user_id = ? GROUP BY track_id) p ON p.track_id = t.id'; args.push(u); }
    if (q.ParentId) { where.push('t.album_id = ?'); args.push(String(q.ParentId)); }
    if (q.ArtistIds) { where.push('t.artist_ids LIKE ?'); args.push(`%"${q.ArtistIds}"%`); }
    if (q.GenreIds || q.Genres) { where.push('t.genres LIKE ?'); args.push(`%"${String(q.Genres || q.GenreIds).replace(/"/g, '')}"%`); }
    if (term) { where.push('t.rowid IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)'); args.push(term.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(' ') || '""'); }
    const order = sortBy === 'ParentIndexNumber' ? 't.disc_no, t.track_no, t.title' : sortBy === 'DateCreated' ? `t.added_at ${desc ? 'DESC' : 'ASC'}` : sortBy === 'DatePlayed' ? `p.last ${desc ? 'DESC' : 'ASC'}` : sortBy === 'PlayCount' ? `p.plays ${desc ? 'DESC' : 'ASC'}, p.last DESC` : sortBy === 'Random' ? 'RANDOM()' : filters.includes('IsFavorite') ? 'l.at DESC' : `t.title ${desc ? 'DESC' : 'ASC'}`;
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let rows: Row[];
    try { rows = db.prepare(`${TRACK}${join} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[]; } catch { rows = []; }
    const total = (() => { try { return (db.prepare(`SELECT COUNT(*) n FROM tracks t${join} ${w}`).get(...args) as any).n; } catch { return rows.length; } })();
    const ls = likedSet(u);
    return result(rows.map((r) => trackItem(r, ls)), total, offset);
  };
  app.get('/jf/Items', auth, async (req) => items(req));
  app.get('/jf/Users/:uid/Items', auth, async (req) => items(req));
  app.get('/jf/Artists', auth, async (req) => { const q = req.query as any; const { limit, offset } = page(q); const term = String(q.searchTerm || '').trim().toLowerCase(); const rows = db.prepare(`SELECT * FROM artists ${term ? 'WHERE lower(name) LIKE ?' : ''} ORDER BY sort_name LIMIT ? OFFSET ?`).all(...(term ? [`%${term}%`] : []), limit, offset) as Row[]; return result(rows.map(artistItem), (db.prepare('SELECT COUNT(*) n FROM artists').get() as any).n, offset); });
  app.get('/jf/Items/Latest', auth, async (req) => (db.prepare('SELECT * FROM albums ORDER BY added_at DESC LIMIT ?').all(Math.min(100, Number((req.query as any).Limit) || 20)) as Row[]).map(albumItem));
  const one = (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as any).id as string; const u = uid(req);
    const t = db.prepare(`${TRACK} WHERE t.id = ?`).get(id) as Row; if (t) return trackItem(t, likedSet(u));
    const a = db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as Row; if (a) return albumItem(a);
    const ar = db.prepare('SELECT * FROM artists WHERE id = ?').get(id) as Row; if (ar) return artistItem(ar);
    const p = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks x WHERE x.playlist_id = p.id) AS track_count FROM playlists p WHERE p.id = ? AND p.user_id = ?`).get(id, u) as Row; if (p) return playlistItem(p);
    return reply.code(404).send({ error: 'not found' });
  };
  app.get('/jf/Items/:id', auth, async (req, reply) => one(req, reply));
  app.get('/jf/Users/:uid/Items/:id', auth, async (req, reply) => one(req, reply));
  app.get('/jf/Items/:id/InstantMix', auth, async (req) => {
    // Same artists first, then the same genres, then anything: a mix, not a science.
    const id = (req.params as any).id as string; const limit = Math.min(200, Number((req.query as any).Limit) || 100);
    const seed = db.prepare(`${TRACK} WHERE t.id = ?`).get(id) as Row || db.prepare(`${TRACK} WHERE t.album_id = ? LIMIT 1`).get(id) as Row;
    if (!seed) return result([], 0);
    const aid = JSON.parse(seed.artist_ids || '[]')[0]; const genre = JSON.parse(seed.genres || '[]')[0];
    const rows = db.prepare(`${TRACK} WHERE t.id != ? ORDER BY (t.artist_ids LIKE ?) DESC, (t.genres LIKE ?) DESC, RANDOM() LIMIT ?`).all(id, `%"${aid}"%`, `%${(genre || '~~').replace(/"/g, '')}%`, limit) as Row[];
    return result(rows.map((r) => trackItem(r, likedSet(uid(req)))), rows.length);
  });
  app.get('/jf/Genres', auth, async () => { const rows = db.prepare('SELECT genres FROM tracks').all() as Row[]; const count = new Map<string, number>(); for (const r of rows) for (const g of JSON.parse(r.genres || '[]')) count.set(g, (count.get(g) || 0) + 1); return result([...count.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => ({ Id: g, Name: g, Type: 'MusicGenre', ChildCount: n })), count.size); });

  // ---- favourites / likes ----
  app.post('/jf/Users/:uid/FavoriteItems/:id', auth, async (req) => { const id = (req.params as any).id; db.prepare('INSERT INTO likes (user_id, track_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(uid(req), id, Date.now()); return { IsFavorite: true }; });
  app.delete('/jf/Users/:uid/FavoriteItems/:id', auth, async (req) => { db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(uid(req), (req.params as any).id); return { IsFavorite: false }; });
  app.post('/jf/Users/:uid/Items/:id/Rating', auth, async () => ({ Likes: false }));
  app.delete('/jf/Users/:uid/Items/:id/Rating', auth, async () => ({}));

  // ---- playlists ----
  app.post('/jf/Playlists', auth, async (req) => { const b = (req.body || {}) as any; const id = playlistId(), now = Date.now(); db.transaction(() => { db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid(req), String(b.Name || 'New playlist').slice(0, 120), now, now); arr(b.Ids ? String(b.Ids).split(',') : []).forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t, now)); })(); return { Id: id }; });
  app.post('/jf/Playlists/:id/Items', auth, async (req, reply) => { const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get((req.params as any).id, uid(req)) as Row; if (!p) return reply.code(404).send(); const ids = String((req.query as any).Ids || '').split(',').filter(Boolean); db.transaction(() => { let pos = ((db.prepare('SELECT COALESCE(MAX(pos), -1) m FROM playlist_tracks WHERE playlist_id = ?').get(p.id) as any).m as number) + 1; for (const t of ids) db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(p.id, pos++, t, Date.now()); db.prepare('UPDATE playlists SET updated = ? WHERE id = ?').run(Date.now(), p.id); })(); return reply.code(204).send(); });
  app.get('/jf/Playlists/:id/Items', auth, async (req, reply) => { const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get((req.params as any).id, uid(req)) as Row; if (!p) return reply.code(404).send(); const rows = db.prepare('SELECT rowid, track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(p.id) as Row[]; const by = new Map(tracksByIds(uid(req), rows.map((r) => r.track_id)).map((t) => [t.Id, t])); const out = rows.map((r) => { const t = by.get(r.track_id); return t ? { ...t, PlaylistItemId: String(r.rowid) } : null; }).filter(Boolean); return result(out, out.length); });
  const renumber = (pid: string) => db.prepare(`WITH o AS (SELECT rowid AS r, ROW_NUMBER() OVER (ORDER BY pos) - 1 AS n FROM playlist_tracks WHERE playlist_id = ?) UPDATE playlist_tracks SET pos = (SELECT n FROM o WHERE o.r = playlist_tracks.rowid) WHERE playlist_id = ?`).run(pid, pid);
  app.delete('/jf/Playlists/:id/Items', auth, async (req, reply) => { const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get((req.params as any).id, uid(req)) as Row; if (!p) return reply.code(404).send(); const entries = String((req.query as any).EntryIds || '').split(',').filter(Boolean); db.transaction(() => { for (const e of entries) db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND rowid = ?').run(p.id, Number(e)); renumber(p.id); })(); return reply.code(204).send(); });
  app.post('/jf/Playlists/:id/Items/:entry/Move/:index', auth, async (req, reply) => { const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get((req.params as any).id, uid(req)) as Row; if (!p) return reply.code(404).send(); const entry = Number((req.params as any).entry), to = Number((req.params as any).index); db.transaction(() => { const rows = db.prepare('SELECT rowid, track_id, added FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(p.id) as Row[]; const from = rows.findIndex((r) => r.rowid === entry); if (from < 0) return; const [m] = rows.splice(from, 1); rows.splice(Math.min(to, rows.length), 0, m); rows.forEach((r, i) => db.prepare('UPDATE playlist_tracks SET pos = ? WHERE rowid = ?').run(i, r.rowid)); })(); return reply.code(204).send(); });
  app.delete('/jf/Items/:id', auth, async (req, reply) => { const r = db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run((req.params as any).id, uid(req)); return r.changes ? reply.code(204).send() : reply.code(404).send(); });
  app.post('/jf/Items/:id', auth, async (req, reply) => { const b = (req.body || {}) as any; if (b.Name) db.prepare('UPDATE playlists SET name = ?, updated = ? WHERE id = ? AND user_id = ?').run(String(b.Name).slice(0, 120), Date.now(), (req.params as any).id, uid(req)); return reply.code(204).send(); });

  // ---- playback reporting -> plays ----
  const recordPlay = (u: string, itemId: string) => { if (!itemId) return; const last = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(u) as any; if (last && last.track_id === itemId && Date.now() - last.at < 60000) return; db.prepare('INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(u, itemId, Date.now(), 'conduit'); };
  app.post('/jf/Sessions/Playing', auth, async (req, reply) => { recordPlay(uid(req), (req.body as any)?.ItemId); return reply.code(204).send(); });
  app.post('/jf/Sessions/Playing/Progress', auth, async (_req, reply) => reply.code(204).send());
  app.post('/jf/Sessions/Playing/Stopped', auth, async (_req, reply) => reply.code(204).send());

  // ---- lyrics ----
  app.get('/jf/Audio/:id/Lyrics', auth, async (req, reply) => { const r = db.prepare('SELECT kind, lines FROM lyrics WHERE track_id = ?').get((req.params as any).id) as Row; if (!r || r.kind === 'instrumental') return reply.code(404).send({ error: 'no lyrics' }); const lines = JSON.parse(r.lines) as { start: number | null; text: string }[]; return { Metadata: { IsSynced: r.kind === 'synced' }, Lyrics: lines.map((l) => ({ Text: l.text, ...(l.start != null ? { Start: l.start * TICKS } : {}) })) }; });

  // ---- images: by item id -> the album/artist cover hash ----
  const coverOf = (id: string): string | null => {
    const a = db.prepare('SELECT cover_hash FROM albums WHERE id = ?').get(id) as Row; if (a) return a.cover_hash;
    const t = db.prepare('SELECT a.cover_hash FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = ?').get(id) as Row; if (t) return t.cover_hash;
    const ar = db.prepare('SELECT image_hash FROM artists WHERE id = ?').get(id) as Row; if (ar) return ar.image_hash;
    const p = db.prepare(`SELECT a.cover_hash FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id JOIN albums a ON a.id = t.album_id WHERE x.playlist_id = ? AND a.cover_hash IS NOT NULL ORDER BY x.pos LIMIT 1`).get(id) as Row; if (p) return p.cover_hash;
    return null;
  };
  const sendArt = (reply: FastifyReply, hash: string | null, maxHeight: number, accept: string) => {
    if (!hash) return reply.code(404).send();
    const size = nearestSize(maxHeight || 320); const webp = /image\/webp/.test(accept);
    const p = artPath(dataDir, hash, size, webp ? 'webp' : 'jpg');
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800').header('Vary', 'Accept').type(webp ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(p));
  };
  app.get('/jf/Items/:id/Images/:kind', async (req, reply) => sendArt(reply, coverOf((req.params as any).id), Number((req.query as any).maxHeight) || 320, String(req.headers.accept || '')));
  app.get('/jf/Items/:id/Images/:kind/:index', async (req, reply) => sendArt(reply, coverOf((req.params as any).id), Number((req.query as any).maxHeight) || 320, String(req.headers.accept || '')));
  app.get('/jf/Users/:uid/Images/:kind', async (req, reply) => { const p = `${dataDir}/avatars/${(req.params as any).uid}.jpg`; if (!fs.existsSync(p)) return reply.code(404).send(); reply.header('Cache-Control', 'public, max-age=3600').type('image/jpeg'); return reply.send(fs.createReadStream(p)); });
  app.post('/jf/Users/:uid/Images/:kind', auth, async (req, reply) => { let body = ''; for await (const c of req.raw) body += c; fs.mkdirSync(`${dataDir}/avatars`, { recursive: true }); fs.writeFileSync(`${dataDir}/avatars/${uid(req)}.jpg`, Buffer.from(body, 'base64')); return reply.code(204).send(); });

  // ---- streams: the same files the /api routes serve, under Jellyfin's paths ----
  app.get('/jf/Audio/:id/stream', auth, async (req, reply) => reply.redirect(`/api/stream/${(req.params as any).id}?token=${encodeURIComponent(req.tokenId || '')}`, 307));
  app.get('/jf/Audio/:id/universal', auth, async (req, reply) => { const br = Number((req.query as any).audioBitRate) || 320000; const profile = br >= 256000 ? 'aac-320' : br >= 128000 ? 'aac-160' : 'aac-96'; return reply.redirect(`/api/stream/${(req.params as any).id}/hls/${profile}/index.m3u8?token=${encodeURIComponent(req.tokenId || '')}`, 307); });
  app.get('/jf/Audio/:id/main.m3u8', auth, async (req, reply) => { const br = Number((req.query as any).audioBitRate) || 320000; const profile = br >= 256000 ? 'aac-320' : br >= 128000 ? 'aac-160' : 'aac-96'; if (!PROFILES[profile]) return reply.code(404).send(); return reply.redirect(`/api/stream/${(req.params as any).id}/hls/${profile}/index.m3u8?token=${encodeURIComponent(req.tokenId || '')}`, 307); });
}
