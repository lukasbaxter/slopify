// Read side of the library: lists, details, search, lyrics, artwork.
// Every list is one query over columns the scanner already maintains.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { libraryVersion } from './db.js';
import { artPath, nearestSize, SIZES } from './artwork.js';
import { similarInLibrary } from './discover.js';
import { albumGenreMap } from './genres.js';
import { splitArtists } from './scanner.js';

export type TrackRow = {
  id: string; title: string; artist: string; artists: string; artist_ids: string; album_id: string; album: string; album_artist: string;
  track_no: number | null; disc_no: number | null; year: number | null; genres: string; duration_ms: number; codec: string | null; bitrate: number | null;
  sample_rate?: number | null; bit_depth?: number | null; path?: string;
  identity_state: string; identity_score: number; added_at: number; cover_hash?: string | null;
};
// The file's own format, named the way people know it: the parser says
// "MPEG 1 Layer 3" and "PCM"; a listener says MP3 and WAV.
export function formatOf(t: Pick<TrackRow, 'codec' | 'bitrate' | 'sample_rate' | 'bit_depth' | 'path'>) {
  const raw = String(t.codec || ''); const ext = String(t.path || '').split('.').pop()!.toLowerCase();
  const codec = /layer 3/i.test(raw) ? 'MP3' : /^pcm/i.test(raw) ? (ext === 'aif' || ext === 'aiff' ? 'AIFF' : 'WAV')
    : /alac/i.test(raw) ? 'ALAC' : /aac/i.test(raw) ? 'AAC' : /opus/i.test(raw) ? 'Opus' : /vorbis/i.test(raw) ? 'Ogg Vorbis' : raw || (ext ? ext.toUpperCase() : null);
  if (!codec) return null;
  return { codec, lossless: ['FLAC', 'WAV', 'AIFF', 'ALAC', 'APE', 'WV'].includes(codec), bitrate: t.bitrate ?? null, sampleRate: t.sample_rate ?? null, bitDepth: t.bit_depth ?? null };
}
export const trackOut = (t: TrackRow) => ({
  id: t.id, title: t.title, artist: t.artist, artists: JSON.parse(t.artists) as string[], artistIds: JSON.parse(t.artist_ids) as string[],
  albumId: t.album_id, album: t.album, albumArtist: t.album_artist, trackNo: t.track_no, discNo: t.disc_no, year: t.year,
  genres: JSON.parse(t.genres) as string[], durationMs: t.duration_ms, codec: t.codec, bitrate: t.bitrate, cover: t.cover_hash ?? null,
  format: formatOf(t),
  identity: { state: t.identity_state, score: t.identity_score }, addedAt: t.added_at,
});
const albumOut = (a: any) => ({ id: a.id, name: a.name, artist: a.artist, artistId: a.artist_id, year: a.year, trackCount: a.track_count, durationMs: a.duration_ms, cover: a.cover_hash, addedAt: a.added_at });
const artistOut = (a: any) => ({ id: a.id, name: a.name, trackCount: a.track_count, albumCount: a.album_count, image: a.image_hash, banner: a.banner_hash ?? null });

export const TRACK_SELECT = 'SELECT t.*, a.cover_hash FROM tracks t JOIN albums a ON a.id = t.album_id';
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

// Tracks that go with one: same artists first, then the same genres, shuffled.
// The track itself leads. Shared by the mix endpoint and the server player's
// end-of-queue continuation.
export function mixFor(db: DB, id: string, limit: number): TrackRow[] | null {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined;
  if (!t) return null;
  const artistIds = JSON.parse(t.artist_ids) as string[], genres = JSON.parse(t.genres) as string[];
  const pick = new Map<string, TrackRow>();
  for (const a of artistIds) for (const r of db.prepare(`${TRACK_SELECT} WHERE t.artist_ids LIKE ? AND t.id != ? ORDER BY RANDOM() LIMIT 40`).all(`%"${a}"%`, t.id) as TrackRow[]) pick.set(r.id, r);
  for (const g of genres) for (const r of db.prepare(`${TRACK_SELECT} WHERE t.genres LIKE ? AND t.id != ? ORDER BY RANDOM() LIMIT 60`).all(`%${JSON.stringify(g)}%`, t.id) as TrackRow[]) pick.set(r.id, r);
  if (pick.size < 20) for (const r of db.prepare(`${TRACK_SELECT} WHERE t.id != ? ORDER BY RANDOM() LIMIT 60`).all(t.id) as TrackRow[]) pick.set(r.id, r);
  const rows = [...pick.values()]; for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return [t, ...rows.slice(0, limit - 1)];
}

// Home's Daily Mix for an artist, Spotify-style: the artist (what this
// listener plays most first), artists like them that the library has (Deezer,
// cached), then the artist's genres; interleaved so the artist recurs without
// running back to back, one copy of each song.
export async function artistMix(db: DB, artist: { id: string; name: string }, limit: number, uid?: string): Promise<TrackRow[]> {
  const plays = new Map<string, number>();
  if (uid) for (const r of db.prepare('SELECT track_id, COUNT(*) n FROM plays WHERE user_id = ? GROUP BY track_id').all(uid) as any[]) plays.set(r.track_id, r.n);
  const shuffle = <T>(xs: T[]) => { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };
  const byArtist = (aid: string) => db.prepare(`${TRACK_SELECT} WHERE t.artist_ids LIKE ?`).all(`%"${aid}"%`) as TrackRow[];
  // theirs: half the ones they play most, the rest at random
  const all = shuffle(byArtist(artist.id));
  const played = all.filter((t) => plays.has(t.id)).sort((a, b) => (plays.get(b.id) || 0) - (plays.get(a.id) || 0));
  const own = [...played.slice(0, Math.ceil(limit * 0.2)), ...all.filter((t) => !played.slice(0, Math.ceil(limit * 0.2)).includes(t))].slice(0, Math.ceil(limit * 0.4));
  const others: TrackRow[] = [];
  let similar: { id: string; name: string }[] = [];
  try { similar = await similarInLibrary(db, artist); } catch { /* offline: genres only */ }
  for (const s of similar.slice(0, 10)) others.push(...shuffle(byArtist(s.id)).slice(0, 6));
  if (others.length < limit - own.length) {
    const genres = new Map<string, number>();
    for (const t of all) for (const g of JSON.parse(t.genres) as string[]) genres.set(g, (genres.get(g) || 0) + 1);
    for (const [g] of [...genres].sort((a, b) => b[1] - a[1]).slice(0, 3)) others.push(...db.prepare(`${TRACK_SELECT} WHERE t.genres LIKE ? AND t.artist_ids NOT LIKE ? ORDER BY RANDOM() LIMIT 40`).all(`%${JSON.stringify(g)}%`, `%"${artist.id}"%`) as TrackRow[]);
  }
  shuffle(others);
  const out: TrackRow[] = []; const seen = new Set<string>();
  const key = (t: TrackRow) => `${t.artist.toLowerCase()}|${t.title.toLowerCase().replace(/\s*[([].*$/, '')}`;
  const push = (t: TrackRow | undefined) => { if (t && !seen.has(key(t))) { seen.add(key(t)); out.push(t); } };
  let i = 0, j = 0;
  while (out.length < limit && (i < own.length || j < others.length)) {
    push(own[i++]);                       // the artist, then two others
    push(others[j++]); push(others[j++]);
  }
  return out.slice(0, limit);
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
    const own = db.prepare('SELECT * FROM albums WHERE artist_id = ? ORDER BY year DESC, sort_name').all(id) as any[];
    const others = db.prepare(`SELECT DISTINCT a.* FROM albums a JOIN tracks t ON t.album_id = a.id WHERE t.artist_ids LIKE ? AND a.artist_id != ? ORDER BY a.year DESC`).all(`%"${id}"%`, id) as any[];
    // An album whose album-artist credit names this artist ("Drake, 21
    // Savage") is a collab and belongs to their discography; someone else's
    // album with one feature on it (Migos' Culture III) only appears on.
    const norm = (x: string) => x.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const isCollab = (al: any) => splitArtists(undefined, al.artist).some((n) => norm(n) === norm(a.name));
    const albums = [...own, ...others.filter(isCollab)].sort((x, y) => (y.year || 0) - (x.year || 0)).map(albumOut);
    const appearsOn = others.filter((al) => !isCollab(al)).map(albumOut);
    // Most played first (the page then reorders by real-world popularity, /popular).
    const tracks = (db.prepare(`${TRACK_SELECT} LEFT JOIN (SELECT track_id, COUNT(*) n FROM plays GROUP BY track_id) pc ON pc.track_id = t.id WHERE t.artist_ids LIKE ? ORDER BY COALESCE(pc.n, 0) DESC, t.title LIMIT 200`).all(`%"${id}"%`) as TrackRow[]).map(trackOut);
    const followed = !!db.prepare('SELECT 1 FROM artist_follows WHERE user_id = ? AND artist_id = ?').get((req as any).user?.id, id);
    return { ...artistOut(a), followed, albums, appearsOn, tracks };
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
    // Albums and artists: every word of the query somewhere in name + artist
    // ("ok computer radiohead" finds the album), the exact name first.
    const words = q.normalize('NFKC').replace(/[%_]/g, '').split(/\s+/).filter(Boolean).slice(0, 8);
    const where = (expr: string) => words.map(() => `${expr} LIKE ? COLLATE NOCASE`).join(' AND ');
    const params = words.map((w) => `%${w}%`);
    const albums = (db.prepare(`SELECT * FROM albums WHERE ${where("(name || ' ' || artist)")} ORDER BY (name = ? COLLATE NOCASE) DESC, track_count DESC LIMIT ?`).all(...params, q, limit) as any[]).map(albumOut);
    const artists = (db.prepare(`SELECT * FROM artists WHERE ${where('name')} ORDER BY (name = ? COLLATE NOCASE) DESC, track_count DESC LIMIT ?`).all(...params, q, limit) as any[]).map(artistOut);
    return { tracks, albums, artists };
  });
  app.get('/api/tracks/:id/mix', auth, async (req, reply) => {
    const id = (req.params as any).id as string; const limit = Math.min(200, Number((req.query as any).limit) || 100);
    // An artist seeds Home's Daily Mixes.
    const artist = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as { id: string; name: string } | undefined;
    if (artist) return { items: (await artistMix(db, artist, limit, (req as any).user?.id)).map(trackOut) };
    const items = mixFor(db, id, limit);
    if (!items) return reply.code(404).send({ error: 'no such track' });
    return { items: items.map(trackOut) };
  });
  // Search page tiles: one per canonical genre (genres.ts), covers from the
  // genre's most played albums, biggest shelves first.
  // Play counts aggregate the whole plays table, so they are cached for a
  // minute: popularity ordering can run a play behind.
  let playsCache: { at: number; v: Map<string, number> } | null = null;
  const albumPlays = () => {
    if (playsCache && Date.now() - playsCache.at < 60000) return playsCache.v;
    const v = new Map<string, number>((db.prepare('SELECT t.album_id a, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id GROUP BY t.album_id').all() as any[]).map((r) => [r.a, r.n]));
    playsCache = { at: Date.now(), v };
    return v;
  };
  const genreAlbums = (name: string) => {
    const genreOf = albumGenreMap(db);
    return (db.prepare('SELECT id, name, artist, artist_id, year, track_count, added_at, cover_hash FROM albums').all() as any[]).filter((a) => genreOf.get(a.id) === name);
  };
  app.get('/api/browse', auth, async () => {
    const genreOf = albumGenreMap(db);
    const plays = albumPlays();
    const g = new Map<string, { n: number; albums: { id: string; plays: number; cover: string | null }[] }>();
    for (const a of db.prepare('SELECT id, track_count, cover_hash FROM albums').all() as any[]) {
      const name = genreOf.get(a.id) || 'Other';
      const e = g.get(name) || { n: 0, albums: [] };
      e.n += a.track_count; e.albums.push({ id: a.id, plays: plays.get(a.id) || 0, cover: a.cover_hash });
      g.set(name, e);
    }
    const tiles = [...g.entries()]
      .filter(([name, e]) => e.n >= 10 && name !== 'Other').concat(g.has('Other') ? [['Other', g.get('Other')!] as [string, any]] : [])
      .sort((x, y) => (x[0] === 'Other' ? 1 : y[0] === 'Other' ? -1 : y[1].n - x[1].n))
      .slice(0, 24)
      .map(([name, e]) => {
        const top = e.albums.filter((a) => a.cover).sort((x, y) => y.plays - x.plays);
        return { id: `genre:${name}`, name, count: e.n, coverId: top[0]?.id ?? null, cover: top[0]?.cover ?? null, covers: top.slice(0, 4).map((a) => a.id), kind: 'genre' };
      });
    return { tiles };
  });
  // A genre's hub: how big it is, its most played artists and albums, what
  // just arrived. The page builds its sections from this one answer.
  app.get('/api/genres/:name', auth, async (req) => {
    const name = String((req.params as any).name || '').slice(0, 40);
    const albums = genreAlbums(name);
    const plays = albumPlays();
    const byPlays = [...albums].sort((x, y) => (plays.get(y.id) || 0) - (plays.get(x.id) || 0));
    const artists = new Map<string, { id: string; name: string; plays: number; albums: number }>();
    for (const a of albums) {
      if (!a.artist_id || /^various/i.test(a.artist || '')) continue;
      const e = artists.get(a.artist_id) || { id: a.artist_id, name: a.artist, plays: 0, albums: 0 };
      e.plays += plays.get(a.id) || 0; e.albums++;
      artists.set(a.artist_id, e);
    }
    return {
      name,
      trackCount: albums.reduce((n, a) => n + a.track_count, 0),
      albumCount: albums.length,
      topArtists: [...artists.values()].sort((x, y) => y.plays - x.plays || y.albums - x.albums).slice(0, 12),
      albums: byPlays.slice(0, 60).map(albumOut),
      recent: [...albums].sort((x, y) => y.added_at - x.added_at).slice(0, 18).map(albumOut),
    };
  });
  // The genre's tracks, most played first (the hub's Popular list and the
  // search page's scoped search).
  const genreTracks = (name: string, limit: number): TrackRow[] => {
    const ids = genreAlbums(name).map((a) => a.id);
    // One grouped pass over plays for the whole call, not a scan per chunk.
    const plays = new Map<string, number>((db.prepare('SELECT track_id, COUNT(*) n FROM plays GROUP BY track_id').all() as any[]).map((r) => [r.track_id, r.n]));
    const out: (TrackRow & { _n: number })[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of db.prepare(`${TRACK_SELECT} WHERE t.album_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[]) { r._n = plays.get(r.id) || 0; out.push(r); }
    }
    return out.sort((x, y) => y._n - x._n).slice(0, limit);
  };
  // The hub's Popular list walks every track of the genre; cached a minute
  // per genre (staleness is fine, the genre map itself is minutes stale too).
  const genreTracksCache = new Map<string, { at: number; v: any }>();
  app.get('/api/genres/:name/tracks', auth, async (req) => {
    const name = String((req.params as any).name || '').slice(0, 40);
    const hit = genreTracksCache.get(name);
    if (hit && Date.now() - hit.at < 60000) return hit.v;
    const v = { items: genreTracks(name, 100).map(trackOut) };
    if (genreTracksCache.size > 64) genreTracksCache.clear(); // made-up names cannot grow it unbounded
    genreTracksCache.set(name, { at: Date.now(), v });
    return v;
  });
  // A shuffled sitting of the genre, leaning toward what gets played and liked.
  app.get('/api/genres/:name/mix', auth, async (req) => {
    const name = String((req.params as any).name || '').slice(0, 40);
    const liked = new Set((db.prepare('SELECT DISTINCT track_id FROM likes').all() as any[]).map((r) => r.track_id));
    const pool = genreTracks(name, 4000).map((t: any) => ({ t, w: 1 + Math.min(t._n || 0, 20) + (liked.has(t.id) ? 5 : 0) }));
    const picked: TrackRow[] = [];
    while (picked.length < 50 && pool.length) {
      let r = Math.random() * pool.reduce((s, x) => s + x.w, 0);
      const i = pool.findIndex((x) => (r -= x.w) <= 0);
      picked.push(...pool.splice(i < 0 ? pool.length - 1 : i, 1).map((x) => x.t));
    }
    return { items: picked.map(trackOut) };
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
    const ar = db.prepare('SELECT image_hash, banner_hash FROM artists WHERE id = ?').get(id) as any;
    if (ar) {
      // A banner: the artist's wide photo when there is one (its size is
      // filled in by the route), else a wide cut of the portrait.
      if (kind === 'banner' && ar.banner_hash) return `${ar.banner_hash}/banner-{w}`;
      if (ar.image_hash) return kind === 'banner' ? `${ar.image_hash}/banner` : ar.image_hash;
      // No portrait yet: the cover of their biggest album (a broken image otherwise).
      if (kind === 'banner') return null;
      return (db.prepare('SELECT cover_hash FROM albums WHERE artist_id = ? AND cover_hash IS NOT NULL ORDER BY track_count DESC LIMIT 1').get(id) as any)?.cover_hash
        ?? (db.prepare('SELECT a.cover_hash FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.artist_ids LIKE ? AND a.cover_hash IS NOT NULL LIMIT 1').get(`%"${id}"%`) as any)?.cover_hash ?? null;
    }
    return null;
  };
  // Own, larger bucket: one album grid is hundreds of covers, and every phone on
  // the LAN reaches the public hostname through the router's hairpin NAT, so the
  // whole house shares one client IP. The 600/min default 429'd covers.
  // Deliberately unauthenticated: the web client and the speaker bridge do carry
  // ?token= on these URLs, but follows.test.ts and speaker hardware fetching
  // artwork by bare URL pin the route public. The exposure is cover art behind
  // unguessable-ish hash ids, held in check by this route's own rate bucket;
  // flipping to requireUser is a one-liner here if that trade stops being worth it.
  app.get('/api/image/:id', { config: { rateLimit: { max: 6000, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = String((req.params as any).id || ''); const q = req.query as any;
    const kind = q.kind === 'banner' ? 'banner' : 'primary';
    const hash = coverOf(id, kind);
    if (!hash) return reply.code(404).send();
    const webp = /image\/webp/.test(String(req.headers.accept || ''));
    const size = kind === 'banner' ? 'banner' : String(nearestSize(Number(q.size) || Number(q.maxHeight) || 320));
    // Banner width: 640 for a small screen or a slow / metered connection, 1280 otherwise.
    const [h, sub] = hash.replace('{w}', Number(q.w) > 0 && Number(q.w) <= 800 ? '640' : '1280').split('/');
    const p = path.join(dataDir, 'art', h, sub ? `${sub}.${webp ? 'webp' : 'jpg'}` : `${size}.${webp ? 'webp' : 'jpg'}`);
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('Cache-Control', 'private, max-age=86400').header('Vary', 'Accept').type(webp ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(p));
  });
}
