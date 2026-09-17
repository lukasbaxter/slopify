// Read side of the library: lists, details, search, lyrics, artwork.
// Every list is one query over columns the scanner already maintains.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { libraryVersion } from './db.js';
import { artPath, nearestSize, SIZES } from './artwork.js';

export type TrackRow = {
  id: string; title: string; artist: string; artists: string; artist_ids: string; album_id: string; album: string; album_artist: string;
  track_no: number | null; disc_no: number | null; year: number | null; genres: string; duration_ms: number; codec: string | null; bitrate: number | null;
  identity_state: string; identity_score: number; added_at: number; cover_hash?: string | null;
};
export const trackOut = (t: TrackRow) => ({
  id: t.id, title: t.title, artist: t.artist, artists: JSON.parse(t.artists) as string[], artistIds: JSON.parse(t.artist_ids) as string[],
  albumId: t.album_id, album: t.album, albumArtist: t.album_artist, trackNo: t.track_no, discNo: t.disc_no, year: t.year,
  genres: JSON.parse(t.genres) as string[], durationMs: t.duration_ms, codec: t.codec, bitrate: t.bitrate, cover: t.cover_hash ?? null,
  identity: { state: t.identity_state, score: t.identity_score }, addedAt: t.added_at,
});
const albumOut = (a: any) => ({ id: a.id, name: a.name, artist: a.artist, artistId: a.artist_id, year: a.year, trackCount: a.track_count, durationMs: a.duration_ms, cover: a.cover_hash, addedAt: a.added_at });
const artistOut = (a: any) => ({ id: a.id, name: a.name, trackCount: a.track_count, albumCount: a.album_count, image: a.image_hash });

const TRACK_SELECT = 'SELECT t.*, a.cover_hash FROM tracks t JOIN albums a ON a.id = t.album_id';
const page = (q: any) => ({ offset: Math.max(0, Number(q.offset) || 0), limit: Math.min(20000, Math.max(1, Number(q.limit) || 200)) });

export function tracksByIds(db: DB, ids: string[]) {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`${TRACK_SELECT} WHERE t.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as TrackRow[];
    const by = new Map(rows.map((r) => [r.id, trackOut(r)]));
    for (const id of chunk) { const t = by.get(id); if (t) out.push(t); }
  }
  return out;
}

// FTS5 prefix query from free text: each word becomes a prefix term; a
// hyphen/apostrophe stays inside a phrase.
export function ftsQuery(q: string) {
  const words = q.normalize('NFKC').replace(/[^\p{L}\p{N}\s']/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
}

export function registerLibrary(app: FastifyInstance, db: DB, dataDir: string) {
  const auth = { preHandler: (app as any).requireUser };

  app.get('/api/library', auth, async () => ({
    version: libraryVersion(db),
    tracks: (db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n,
    albums: (db.prepare('SELECT COUNT(*) n FROM albums').get() as any).n,
    artists: (db.prepare('SELECT COUNT(*) n FROM artists').get() as any).n,
    lastScan: db.prepare('SELECT started, finished, files, added, changed, removed FROM scans ORDER BY id DESC LIMIT 1').get() ?? null,
  }));

  app.get('/api/albums', auth, async (req) => {
    const { offset, limit } = page(req.query);
    const sort = (req.query as any).sort === 'added' ? 'added_at DESC' : 'sort_name ASC';
    const rows = db.prepare(`SELECT * FROM albums ORDER BY ${sort} LIMIT ? OFFSET ?`).all(limit, offset) as any[];
    return { items: rows.map(albumOut), total: (db.prepare('SELECT COUNT(*) n FROM albums').get() as any).n, offset, limit };
  });
  app.get('/api/albums/:id', auth, async (req, reply) => {
    const a = db.prepare('SELECT * FROM albums WHERE id = ?').get((req.params as any).id) as any;
    if (!a) return reply.code(404).send({ error: 'no such album' });
    const tracks = (db.prepare(`${TRACK_SELECT} WHERE t.album_id = ? ORDER BY t.disc_no, t.track_no, t.title`).all(a.id) as TrackRow[]).map(trackOut);
    return { ...albumOut(a), tracks };
  });
  app.get('/api/artists', auth, async (req) => {
    const { offset, limit } = page(req.query);
    const rows = db.prepare('SELECT * FROM artists ORDER BY sort_name LIMIT ? OFFSET ?').all(limit, offset) as any[];
    return { items: rows.map(artistOut), total: (db.prepare('SELECT COUNT(*) n FROM artists').get() as any).n, offset, limit };
  });
  app.get('/api/artists/:id', auth, async (req, reply) => {
    const id = (req.params as any).id as string;
    const a = db.prepare('SELECT * FROM artists WHERE id = ?').get(id) as any;
    if (!a) return reply.code(404).send({ error: 'no such artist' });
    const albums = (db.prepare('SELECT * FROM albums WHERE artist_id = ? ORDER BY year DESC, sort_name').all(id) as any[]).map(albumOut);
    const appearsOn = (db.prepare(`SELECT DISTINCT a.* FROM albums a JOIN tracks t ON t.album_id = a.id WHERE t.artist_ids LIKE ? AND a.artist_id != ? ORDER BY a.year DESC`).all(`%"${id}"%`, id) as any[]).map(albumOut);
    const tracks = (db.prepare(`${TRACK_SELECT} WHERE t.artist_ids LIKE ? ORDER BY t.title LIMIT 200`).all(`%"${id}"%`) as TrackRow[]).map(trackOut);
    return { ...artistOut(a), albums, appearsOn, tracks };
  });
  // Any id -> what it is (album, artist or track), for a page opened by id.
  app.get('/api/items/:id', auth, async (req, reply) => {
    const id = (req.params as any).id as string;
    const al = db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as any; if (al) return { kind: 'album', item: albumOut(al) };
    const ar = db.prepare('SELECT * FROM artists WHERE id = ?').get(id) as any; if (ar) return { kind: 'artist', item: artistOut(ar) };
    const t = tracksByIds(db, [id])[0]; if (t) return { kind: 'track', item: t };
    return reply.code(404).send({ error: 'no such item' });
  });
  app.get('/api/tracks/:id', auth, async (req, reply) => {
    const t = tracksByIds(db, [(req.params as any).id])[0];
    return t ?? reply.code(404).send({ error: 'no such track' });
  });
  app.get('/api/tracks', auth, async (req) => {
    const ids = String((req.query as any).ids || '').split(',').filter((x) => /^[0-9a-f]{32}$/.test(x)).slice(0, 2000);
    return { items: tracksByIds(db, ids) };
  });
  app.get('/api/search', auth, async (req) => {
    const q = String((req.query as any).q || '').trim().slice(0, 200);
    const limit = Math.min(50, Number((req.query as any).limit) || 20);
    if (!q) return { tracks: [], albums: [], artists: [] };
    const fq = ftsQuery(q);
    let tracks: any[] = [];
    if (fq) {
      try {
        tracks = (db.prepare(`SELECT t.*, a.cover_hash, bm25(tracks_fts, 10, 5, 2) AS rank FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid JOIN albums a ON a.id = t.album_id WHERE tracks_fts MATCH ? ORDER BY rank LIMIT ?`).all(fq, limit) as TrackRow[]).map(trackOut);
      } catch { tracks = []; }
    }
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const albums = (db.prepare('SELECT * FROM albums WHERE name LIKE ? OR artist LIKE ? ORDER BY track_count DESC LIMIT ?').all(like, like, limit) as any[]).map(albumOut);
    const artists = (db.prepare('SELECT * FROM artists WHERE name LIKE ? ORDER BY track_count DESC LIMIT ?').all(like, limit) as any[]).map(artistOut);
    return { tracks, albums, artists };
  });
  // Tracks that go with one: same artists first, then the same genres, shuffled.
  app.get('/api/tracks/:id/mix', auth, async (req, reply) => {
    const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get((req.params as any).id) as TrackRow | undefined;
    if (!t) return reply.code(404).send({ error: 'no such track' });
    const limit = Math.min(200, Number((req.query as any).limit) || 100);
    const artistIds = JSON.parse(t.artist_ids) as string[], genres = JSON.parse(t.genres) as string[];
    const pick = new Map<string, TrackRow>();
    for (const a of artistIds) for (const r of db.prepare(`${TRACK_SELECT} WHERE t.artist_ids LIKE ? AND t.id != ? ORDER BY RANDOM() LIMIT 40`).all(`%"${a}"%`, t.id) as TrackRow[]) pick.set(r.id, r);
    for (const g of genres) for (const r of db.prepare(`${TRACK_SELECT} WHERE t.genres LIKE ? AND t.id != ? ORDER BY RANDOM() LIMIT 60`).all(`%${JSON.stringify(g)}%`, t.id) as TrackRow[]) pick.set(r.id, r);
    if (pick.size < 20) for (const r of db.prepare(`${TRACK_SELECT} WHERE t.id != ? ORDER BY RANDOM() LIMIT 60`).all(t.id) as TrackRow[]) pick.set(r.id, r);
    const rows = [...pick.values()]; for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    return { items: [trackOut(t), ...rows.slice(0, limit - 1).map(trackOut)] };
  });
  // Search page tiles: genres with a cover, most tracks first.
  app.get('/api/browse', auth, async () => {
    const rows = db.prepare('SELECT t.genres, a.cover_hash, t.album_id FROM tracks t JOIN albums a ON a.id = t.album_id').all() as any[];
    const g = new Map<string, { n: number; cover: string | null; albumId: string }>();
    for (const r of rows) for (const name of JSON.parse(r.genres || '[]') as string[]) { const k = name.trim(); if (!k) continue; const e = g.get(k) || { n: 0, cover: null, albumId: r.album_id }; e.n++; if (!e.cover && r.cover_hash) e.cover = r.cover_hash; g.set(k, e); }
    return { tiles: [...g.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([name, e]) => ({ id: `genre:${name}`, name, count: e.n, coverId: e.albumId, cover: e.cover, kind: 'genre' })) };
  });
  app.get('/api/genres/:name/tracks', auth, async (req) => {
    const name = String((req.params as any).name || '').slice(0, 100);
    const rows = db.prepare(`${TRACK_SELECT} WHERE t.genres LIKE ? ORDER BY t.album_artist, t.album, t.disc_no, t.track_no LIMIT 500`).all(`%${JSON.stringify(name)}%`) as TrackRow[];
    return { items: rows.map(trackOut) };
  });
  app.get('/api/lyrics/:id', auth, async (req, reply) => {
    const r = db.prepare('SELECT kind, lines, source FROM lyrics WHERE track_id = ?').get((req.params as any).id) as any;
    if (!r) return reply.code(404).send({ error: 'no lyrics' });
    return { kind: r.kind, source: r.source, lines: JSON.parse(r.lines) };
  });

  // Artwork: public by hash (unguessable), immutable.
  app.get('/api/art/:hash/:file', async (req, reply) => {
    const { hash, file } = req.params as any;
    const m = /^(\d+)\.(webp|jpg)$/.exec(file);
    if (!/^[0-9a-f]{40}$/.test(hash) || !m) return reply.code(404).send();
    const size = nearestSize(Number(m[1]));
    const p = artPath(dataDir, hash, size, m[2] as 'webp' | 'jpg');
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.type(m[2] === 'webp' ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(p));
  });
  app.get('/api/art/sizes', async () => ({ sizes: SIZES }));
  // The picture for any id: an album's cover, a track's album cover, an
  // artist's portrait (or its banner), a playlist's own cover or its first
  // track's. Served straight from the rendered files; webp when accepted.
  const coverOf = (id: string, kind: string): string | null => {
    if (id.startsWith('pl_')) { const p = db.prepare('SELECT cover_hash FROM playlists WHERE id = ?').get(id) as any; if (!p) return null; return p.cover_hash ?? (db.prepare('SELECT a.cover_hash FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id JOIN albums a ON a.id = t.album_id WHERE x.playlist_id = ? AND a.cover_hash IS NOT NULL ORDER BY x.pos LIMIT 1').get(id) as any)?.cover_hash ?? null; }
    const al = db.prepare('SELECT cover_hash FROM albums WHERE id = ?').get(id) as any; if (al) return al.cover_hash ?? null;
    const tr = db.prepare('SELECT a.cover_hash FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = ?').get(id) as any; if (tr) return tr.cover_hash ?? null;
    const ar = db.prepare('SELECT image_hash FROM artists WHERE id = ?').get(id) as any; if (ar) return ar.image_hash ? (kind === 'banner' ? `${ar.image_hash}/banner` : ar.image_hash) : null;
    return null;
  };
  app.get('/api/image/:id', async (req, reply) => {
    const id = String((req.params as any).id || ''); const q = req.query as any;
    const kind = q.kind === 'banner' ? 'banner' : 'primary';
    const hash = coverOf(id, kind);
    if (!hash) return reply.code(404).send();
    const webp = /image\/webp/.test(String(req.headers.accept || ''));
    const size = kind === 'banner' ? 'banner' : String(nearestSize(Number(q.size) || Number(q.maxHeight) || 320));
    const [h, sub] = hash.split('/');
    const p = path.join(dataDir, 'art', h, sub ? `${sub}.${webp ? 'webp' : 'jpg'}` : `${size}.${webp ? 'webp' : 'jpg'}`);
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('Cache-Control', 'private, max-age=86400').header('Vary', 'Accept').type(webp ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(p));
  });
}
