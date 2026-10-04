// Beyond the library: the artist page's full discography (what is here, what
// can be requested), "Fans also like", the Release Radar and the search
// page's "Everywhere" shelf.
//
// Lidarr owns the catalog and the download queue (lidarr.ts): a discography
// is every release group its metadata knows for a name, a request monitors
// the album there, and whatever watches Lidarr's wanted list fetches it into
// this library. This module matches those releases against the albums table
// so the page can open what is here and offer the rest. Similar artists come
// from Deezer's related list, kept only when the library has them, so every
// card opens a real page.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { recordRequest } from './downloads.js';
import type { Lidarr } from './lidarr.js';
import { normTitle as songTitle } from './lyricsources.js';

export type DiscoverOptions = { lidarr?: Lidarr; log?: (m: string) => void; fetcher?: typeof fetch };

type Release = { album_id: string | null; title: string; rtype: string; year: string; date: string; image: string | null; total_tracks: number; group?: string; artists?: string[]; inLibrary: string | null; localName: string | null; requestStatus: string | null };

const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// A library "Deluxe" satisfies a plain catalog title, but a catalog
// "(Drumless Edition)" is only present if that exact edition is.
const normTitle = (t: string) => norm(String(t || '').replace(/\s*[([](deluxe|expanded|remaster(ed)?|edition|version|bonus|anniversary|explicit|clean|drumless|feat\.?|ft\.?)[^)\]]*[)\]]/gi, '').replace(/\s*-\s*(single|ep)$/i, ''));
const qualified = (t: string) => normTitle(t) !== norm(t);

// One in-memory cache for everything here: the sources are slow (Lidarr's
// metadata proxy takes seconds per artist) and change rarely.
const cache = new Map<string, { at: number; v: any }>();
const cached = (k: string, ttl: number) => { const e = cache.get(k); return e && Date.now() - e.at < ttl ? e.v : null; };
const remember = <T>(k: string, v: T): T => { cache.set(k, { at: Date.now(), v }); return v; };

type LibAlbum = { id: string; name: string; year: number | null; track_count: number };
const libraryAlbums = (db: DB, artistId: string) => db.prepare('SELECT id, name, year, track_count FROM albums WHERE artist_id = ?').all(artistId) as LibAlbum[];
// Albums the artist is credited on in any track, not only those filed under
// them: a collaboration stored under a combined album artist ("Porter
// Robinson; League of Legends") is still theirs. Own albums last, so they
// win a title clash in the matcher's map.
const creditedAlbums = (db: DB, artistId: string) => [
  ...db.prepare(`SELECT DISTINCT a.id, a.name, a.year, a.track_count FROM albums a JOIN tracks t ON t.album_id = a.id
    WHERE t.artist_ids LIKE ? AND a.artist_id != ?`).all(`%"${artistId}"%`, artistId) as LibAlbum[],
  ...libraryAlbums(db, artistId),
];
const matcher = (albums: { id: string; name: string }[]) => {
  const exact = new Map(albums.map((a) => [norm(a.name), a]));
  const base = new Map(albums.map((a) => [normTitle(a.name), a]));
  return (title: string) => exact.get(norm(title)) || (!qualified(title) ? base.get(normTitle(title)) : null) || null;
};
const firstArtist = (artist: string) => String(artist || '').split(',')[0].trim();
const artistByName = (db: DB, name: string) => db.prepare('SELECT id, name FROM artists WHERE name = ? COLLATE NOCASE').get(name) as { id: string; name: string } | undefined;

// The library album a catalog release is, if the library has it (matched
// through its first credited artist, as everywhere on these pages).
export function releaseInLibrary(db: DB, artist: string, title: string): { id: string; name: string } | null {
  const a = artistByName(db, firstArtist(artist));
  return a ? matcher(creditedAlbums(db, a.id))(title) : null;
}

// Deezer's related artists (up to 40) that this library has, cached a day.
// Shared by the artist page and generated playlists (where they bring in
// artists the listener has never played).
export async function similarInLibrary(db: DB, a: { id: string; name: string }, o: { fetcher?: typeof fetch; log?: (m: string) => void } = {}): Promise<{ id: string; name: string }[]> {
  const hit = cached(`similar:${a.id}`, 24 * 60 * 60 * 1000); if (hit) return hit;
  const f = o.fetcher || fetch;
  const json = (url: string) => f(url, { signal: AbortSignal.timeout(8000) }).then(async (r) => { if (!r.ok) throw new Error(`${url.split('?')[0]} ${r.status}`); return r.json() as any; });
  const out: { id: string; name: string }[] = [];
  try {
    const s = await json(`https://api.deezer.com/search/artist?q=${encodeURIComponent(a.name)}&limit=5`);
    const dz = (s.data || []).find((x: any) => norm(x.name) === norm(a.name)) || (s.data || [])[0];
    if (dz) {
      const rel = await json(`https://api.deezer.com/artist/${dz.id}/related?limit=40`);
      const byName = db.prepare('SELECT id, name FROM artists WHERE name = ? COLLATE NOCASE');
      for (const r of rel.data || []) {
        const h = byName.get(r.name) as any;
        if (h && h.id !== a.id) out.push({ id: h.id, name: h.name });
      }
    }
  } catch (e: any) { o.log?.(`similar ${a.name}: ${e.message}`); return out; }
  return remember(`similar:${a.id}`, out);
}

// An artist's songs in the order people actually play them: Deezer's top
// tracks for the artist (the world's listening, cached a week), matched to the
// library one row per song title (a remix or live take is its own title), then
// everything else of theirs by plays on this server, then by title. Without
// Deezer (offline, unknown artist) it is plays alone.
export async function popularOrder(db: DB, a: { id: string; name: string }, o: { fetcher?: typeof fetch; log?: (m: string) => void } = {}): Promise<string[]> {
  const rows = db.prepare('SELECT t.id, t.title, t.album_id, al.artist_id FROM tracks t JOIN albums al ON al.id = t.album_id WHERE t.artist_ids LIKE ?').all(`%"${a.id}"%`) as { id: string; title: string; album_id: string; artist_id: string }[];
  if (!rows.length) return [];
  const plays = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 400) {
    const ids = rows.slice(i, i + 400).map((r) => r.id);
    for (const p of db.prepare(`SELECT track_id, COUNT(*) n FROM plays WHERE track_id IN (${ids.map(() => '?').join(',')}) GROUP BY track_id`).all(...ids) as any[]) plays.set(p.track_id, p.n);
  }
  // Within one title: the artist's own release first, then the most played.
  const better = (x: typeof rows[number], y: typeof rows[number]) =>
    Number(y.artist_id === a.id) - Number(x.artist_id === a.id) || (plays.get(y.id) || 0) - (plays.get(x.id) || 0);
  let top: string[] = cached(`top:${a.id}`, 7 * 24 * 60 * 60 * 1000);
  if (!top) {
    const f = o.fetcher || fetch;
    const json = (url: string) => f(url, { signal: AbortSignal.timeout(8000) }).then(async (r) => { if (!r.ok) throw new Error(`${url.split('?')[0]} ${r.status}`); return r.json() as any; });
    try {
      const s = await json(`https://api.deezer.com/search/artist?q=${encodeURIComponent(a.name)}&limit=5`);
      const dz = (s.data || []).find((x: any) => norm(x.name) === norm(a.name));
      const t = dz ? await json(`https://api.deezer.com/artist/${dz.id}/top?limit=50`) : { data: [] };
      top = remember(`top:${a.id}`, (t.data || []).map((x: any) => songTitle(x.title_short || x.title)).filter(Boolean));
    } catch (e: any) { o.log?.(`popular ${a.name}: ${e.message}`); top = []; }
  }
  const byTitle = new Map<string, typeof rows>();
  for (const r of rows) { const k = songTitle(r.title); byTitle.set(k, [...(byTitle.get(k) || []), r]); }
  const out: string[] = []; const taken = new Set<string>();
  for (const title of top) {
    const pick = (byTitle.get(title) || []).filter((r) => !taken.has(r.id)).sort(better)[0];
    if (pick && !out.includes(pick.id)) { out.push(pick.id); for (const r of byTitle.get(title) || []) taken.add(r.id); }
  }
  const rest = rows.filter((r) => !out.includes(r.id))
    .sort((x, y) => (plays.get(y.id) || 0) - (plays.get(x.id) || 0) || Number(taken.has(x.id)) - Number(taken.has(y.id)) || x.title.localeCompare(y.title));
  return [...out, ...rest.map((r) => r.id)];
}

export function registerDiscover(app: FastifyInstance, db: DB, opts: DiscoverOptions = {}) {
  const auth = { preHandler: (app as any).requireUser };
  const log = opts.log || (() => {});
  const fetcher = opts.fetcher || fetch;
  const lidarr = opts.lidarr?.enabled ? opts.lidarr : null;
  const requestStatuses = async (): Promise<Map<string, { status: string; updated: number }>> =>
    lidarr ? lidarr.statuses().catch(() => new Map()) : new Map();
  // 'queued' | 'downloading' | 'failed' from Lidarr; an album with files is
  // simply in the library (or seconds from it, through the import webhook).
  const stateOf = (e: { status: string; updated: number } | undefined) => e?.status ?? null;
  async function discography(artistId: string, name: string): Promise<{ artist: any; releases: Release[] }> {
    // Only Lidarr's answer is cached: what the library has and each request's
    // state are read fresh, so an album that just landed turns playable.
    const upstream = async () => {
      const hit = cached(`discog:${artistId}`, 30 * 60 * 1000); if (hit) return hit;
      const r = lidarr ? await lidarr.discography(name).catch((e) => { log(`discography ${name}: ${e.message}`); return { artist: null, releases: [] }; }) : { artist: null, releases: [] };
      // Nothing from upstream is not worth remembering for half an hour.
      return r.releases?.length ? remember(`discog:${artistId}`, r) : r;
    };
    const lib = libraryAlbums(db, artistId);
    const [known, status] = await Promise.all([upstream(), requestStatuses()]);
    const have = matcher(creditedAlbums(db, artistId));
    const releases: Release[] = (known.releases || []).map((r: any) => {
      const local = have(r.title);
      return { ...r, inLibrary: local ? local.id : null, localName: local?.name || null, requestStatus: stateOf(status.get(r.album_id)) };
    });
    // Library albums the catalog does not list (bootlegs, compilations) still belong on the page.
    const listed = new Set(releases.filter((r) => r.inLibrary).map((r) => r.inLibrary));
    const extra: Release[] = lib.filter((a) => !listed.has(a.id)).map((a) => ({ album_id: null, title: a.name, rtype: 'Album', year: a.year ? String(a.year) : '', date: a.year ? String(a.year) : '', image: null, total_tracks: a.track_count, inLibrary: a.id, localName: a.name, requestStatus: null }));
    return { artist: known.artist || null, releases: [...releases, ...extra] };
  }

  app.get('/api/discography/:id', auth, async (req, reply) => {
    const id = (req.params as any).id as string;
    const a = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as any;
    if (!a) return reply.code(404).send({ error: 'no such artist' });
    return discography(a.id, a.name);
  });

  // "Fans also like": Deezer's related artists that the library has. Cached a day.
  app.get('/api/artists/:id/popular', auth, async (req, reply) => {
    const a = db.prepare('SELECT id, name FROM artists WHERE id = ?').get((req.params as any).id) as { id: string; name: string } | undefined;
    if (!a) return reply.code(404).send({ error: 'no such artist' });
    return { ids: await popularOrder(db, a, { fetcher, log }) };
  });
  app.get('/api/similar/:id', auth, async (req, reply) => {
    const id = (req.params as any).id as string;
    const a = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as any;
    if (!a) return reply.code(404).send({ error: 'no such artist' });
    return { artists: (await similarInLibrary(db, a, { fetcher, log })).slice(0, 12) };
  });

  // Request an album: monitor it in Lidarr; whatever watches the wanted
  // list downloads it into this library.
  const Request = z.object({ album_id: z.string().min(1) });
  app.post('/api/requests', auth, async (req, reply) => {
    if (!lidarr) return reply.code(503).send({ error: 'Requests are not set up on this server (LIDARR_URL / LIDARR_API_KEY)' });
    const body = Request.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'album_id required' });
    let r;
    try { r = await lidarr.request(body.data.album_id); }
    catch (e: any) { return reply.code(502).send({ error: e.message }); }
    recordRequest(db, (req as any).user.id, r, 'request');
    log(`request ${body.data.album_id}: ${r.status}${r.artist ? ` ${r.artist} - ${r.title}` : ''}`);
    return r;
  });

  // Every album Lidarr's metadata knows for a query, each flagged with the
  // library album it matches (so the app opens it) or its request state (so
  // it offers "Request").
  app.get('/api/gsearch', auth, async (req) => {
    const q = String((req.query as any).q || '').trim();
    if (!q || !lidarr) return { albums: [], artists: [] };
    // Only Lidarr's results are cached; library and request flags are fresh.
    const key = `gsearch:${norm(q)}`;
    const upstream = async () => cached(key, 10 * 60 * 1000) || remember(key, await lidarr.search(q));
    const [results, status] = await Promise.all([upstream() as Promise<any[]>, requestStatuses()]);
    const first = (r: any) => firstArtist(r.artist);
    const byArtist = new Map<string, { artist: any; have: (t: string) => { id: string; name: string } | null }>();
    for (const name of new Set(results.map(first))) {
      const art = artistByName(db, name);
      byArtist.set(norm(name), { artist: art || null, have: art ? matcher(creditedAlbums(db, art.id)) : () => null });
    }
    const albums = results.map((r) => {
      const lib = byArtist.get(norm(first(r)));
      const have = lib?.have(r.title)?.id || null;
      return { ...r, inLibrary: have, artistId: lib?.artist?.id || null, requestStatus: stateOf(status.get(r.album_id)) };
    });
    const artists = [...byArtist.entries()].map(([k, v]) => ({ name: results.find((r) => norm(first(r)) === k) ? first(results.find((r) => norm(first(r)) === k)) : null, id: v.artist?.id || null })).filter((a) => a.name);
    return { albums, artists };
  });

  // The library's most played artists; their releases from the last 90 days.
  // Only the raw releases are cached: library presence and request state
  // change by the minute, so they are flagged fresh on every look.
  const radarRaw = async (): Promise<any[]> => {
    const hit = cached('radar', 6 * 60 * 60 * 1000); if (hit) return hit;
    const top = db.prepare(`SELECT a.id, a.name, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id JOIN albums al ON al.id = t.album_id JOIN artists a ON a.id = al.artist_id
      WHERE p.at > ? GROUP BY a.id ORDER BY n DESC LIMIT 40`).all(Date.now() - 180 * 86400000) as { id: string; name: string }[];
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const out: any[] = [];
    // A few at a time: each discography is a round trip through Lidarr.
    const queue = [...top];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const a = queue.shift()!;
        try {
          const d = await discography(a.id, a.name);
          for (const rel of d.releases) {
            if (!rel.album_id || !rel.date || rel.date < since) continue;
            // cache only the raw release: the per-render flags are re-applied fresh on every GET
            const r: any = { ...rel, artistId: a.id, artistName: a.name };
            delete r.inLibrary; delete r.localName; delete r.requestStatus;
            out.push(r);
          }
        } catch { /* one artist failing must not sink the radar */ }
      }
    }));
    out.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    return remember('radar', out);
  };
  app.get('/api/radar', auth, async () => {
    if (!lidarr) return { releases: [] };
    const [raw, status] = await Promise.all([radarRaw(), requestStatuses()]);
    const have = new Map<string, (t: string) => { id: string; name: string } | null>();
    const releases = raw.map((r) => {
      let h = have.get(r.artistId);
      if (!h) { h = matcher(creditedAlbums(db, r.artistId)); have.set(r.artistId, h); }
      const local = h(r.title);
      return { ...r, inLibrary: local?.id ?? null, localName: local?.name ?? null, requestStatus: stateOf(status.get(r.album_id)) };
    });
    return { releases };
  });
}
