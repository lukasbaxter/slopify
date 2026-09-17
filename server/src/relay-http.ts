// The relay's HTTP endpoints the Conduit app calls (under /relay), answered
// from Slopify's tables. Explo-flavoured ones (discography, radar, similar,
// popular, gsearch, request) answer empty until Explo exists.
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { tracksByIds } from './library.js';

export function registerRelayHttp(app: FastifyInstance, db: DB, requireUser: any) {
  const auth = { preHandler: requireUser };
  const uid = (req: any) => req.user.id as string;
  const jfTrack = (t: any) => ({ Id: t.id, Name: t.title, Type: 'Audio', Artists: t.artists, ArtistItems: t.artists.map((n: string, i: number) => ({ Name: n, Id: t.artistIds[i] })).filter((a: any) => a.Id), Album: t.album, AlbumId: t.albumId, AlbumArtist: t.albumArtist, ProductionYear: t.year, RunTimeTicks: t.durationMs * 10000, ImageTags: t.cover ? { Primary: t.cover } : {}, UserData: { IsFavorite: false } });
  const jfAlbum = (a: any) => ({ Id: a.id, Name: a.name, Type: 'MusicAlbum', AlbumArtist: a.artist, AlbumArtists: [{ Name: a.artist, Id: a.artist_id }], ArtistItems: [{ Name: a.artist, Id: a.artist_id }], ProductionYear: a.year, ChildCount: a.track_count, ImageTags: a.cover_hash ? { Primary: a.cover_hash } : {} });
  const jfArtist = (a: any) => ({ Id: a.id, Name: a.name, Type: 'MusicArtist', ImageTags: a.image_hash ? { Primary: a.image_hash } : {} });

  app.get('/relay/likes', auth, async (req) => ({ at: Object.fromEntries((db.prepare('SELECT track_id, at FROM likes WHERE user_id = ?').all(uid(req)) as any[]).map((r) => [r.track_id, r.at])) }));
  app.post('/relay/likes', auth, async (req) => { const seed = (req.body || {}) as Record<string, number>; const ins = db.prepare('INSERT INTO likes (user_id, track_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'); for (const [id, at] of Object.entries(seed)) if (typeof at === 'number') ins.run(uid(req), id, at); return { at: Object.fromEntries((db.prepare('SELECT track_id, at FROM likes WHERE user_id = ?').all(uid(req)) as any[]).map((r) => [r.track_id, r.at])) }; });
  app.get('/relay/liked', auth, async (req) => { const ids = (db.prepare('SELECT track_id FROM likes WHERE user_id = ? ORDER BY at DESC').all(uid(req)) as any[]).map((r) => r.track_id); const items = tracksByIds(db, ids).map(jfTrack); for (const t of items) t.UserData.IsFavorite = true; return { items, total: ids.length, missing: ids.length - items.length }; });
  app.get('/relay/library', auth, async () => ({ albums: (db.prepare('SELECT * FROM albums ORDER BY sort_name').all() as any[]).map(jfAlbum), artists: (db.prepare('SELECT * FROM artists ORDER BY sort_name').all() as any[]).map(jfArtist) }));
  app.get('/relay/home', auth, async (req) => {
    const u = uid(req);
    const recentIds = (db.prepare('SELECT t.album_id AS id, MAX(p.at) AS last FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? GROUP BY t.album_id ORDER BY last DESC LIMIT 24').all(u) as any[]).map((r) => r.id);
    const albums = new Map((recentIds.length ? db.prepare(`SELECT * FROM albums WHERE id IN (${recentIds.map(() => '?').join(',')})`).all(...recentIds) : []).map((a: any) => [a.id, a]));
    const topIds = (db.prepare('SELECT track_id, COUNT(*) n, MAX(at) last FROM plays WHERE user_id = ? AND at > ? GROUP BY track_id ORDER BY n DESC, last DESC LIMIT 60').all(u, Date.now() - 28 * 86400000) as any[]).map((r) => r.track_id);
    return { recentAlbums: recentIds.map((id) => albums.get(id)).filter(Boolean).map(jfAlbum), topTracks: tracksByIds(db, topIds).map(jfTrack) };
  });
  app.get('/relay/lyrics', auth, async (req, reply) => { const r = db.prepare('SELECT kind, lines FROM lyrics WHERE track_id = ?').get(String((req.query as any).id || '')) as any; if (!r || r.kind === 'instrumental') return reply.code(404).send({ Lyrics: [] }); return { Lyrics: (JSON.parse(r.lines) as any[]).map((l) => ({ Text: l.text, ...(l.start != null ? { Start: l.start * 10000 } : {}) })) }; });
  app.get('/relay/playlist', auth, async (req, reply) => { const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(String((req.query as any).id || ''), uid(req)) as any; if (!p) return reply.code(404).send({ error: 'no such playlist' }); const ids = (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(p.id) as any[]).map((r) => r.track_id); const items = tracksByIds(db, ids).map((t) => ({ ...jfTrack(t), PlaylistItemId: t.id })); return { items, total: ids.length, missing: ids.length - items.length }; });
  // Search page tiles: genres with a cover, most tracks first.
  app.get('/relay/browse', auth, async () => {
    const rows = db.prepare('SELECT t.genres, a.cover_hash, t.album_id FROM tracks t JOIN albums a ON a.id = t.album_id').all() as any[];
    const g = new Map<string, { n: number; cover: string | null; albumId: string }>();
    for (const r of rows) for (const name of JSON.parse(r.genres || '[]') as string[]) { const k = name.trim(); if (!k) continue; const e = g.get(k) || { n: 0, cover: null, albumId: r.album_id }; e.n++; if (!e.cover && r.cover_hash) e.cover = r.cover_hash; g.set(k, e); }
    return { tiles: [...g.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([name, e]) => ({ id: `genre:${name}`, name, count: e.n, coverId: e.albumId, cover: e.cover, kind: 'genre' })) };
  });
  app.get('/relay/history', auth, async (req) => { const rows = db.prepare('SELECT track_id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT 500').all(uid(req)) as any[]; const by = new Map(tracksByIds(db, [...new Set(rows.map((r) => r.track_id))]).map((t) => [t.id, t])); return { streams: rows.length, minutes: Math.round(rows.reduce((a, r) => a + (by.get(r.track_id)?.durationMs || 0), 0) / 60000), recent: rows.map((r) => ({ at: r.at, track: by.get(r.track_id) ? jfTrack(by.get(r.track_id)) : null })).filter((x) => x.track), topTracks: [], topArtists: [], topAlbums: [], sources: {} }; });
  // Explo (Spotify/Deezer/ListenBrainz) is not part of Slopify yet.
  for (const p of ['/relay/discography', '/relay/radar', '/relay/similar', '/relay/popular', '/relay/gsearch']) app.get(p, auth, async () => ({ releases: [], artists: [], items: [], ids: [], results: [] }));
  app.post('/relay/request', auth, async (_req, reply) => reply.code(503).send({ error: 'Requests need Explo, which is not set up on this server yet.' }));
  app.get('/relay/search', auth, async (_req, reply) => reply.code(503).send({ error: 'no index' })); // the app falls back to /jf search
}
