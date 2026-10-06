// A playlist page's "Recommended": songs that belong to the playlist's own
// circle of artists, the way Spotify's do. A playlist is a scene (1nonly and
// the lilbubblegum/Ciscaux crew, Drake-adjacent R&B, 4th-gen K-pop), so the
// genre tags are far too coarse to recommend from: "Hip-Hop" is 20k songs.
//
// Candidates come from Deezer's related-artists lists of the playlist's
// artists (in the library only), scored by consensus: an artist several
// playlist artists point to beats one a single seed mentions. Then:
// - back-links: the candidate's own related list must land in the circle,
//   which keeps hubs (big names everyone is "related" to) from taking over;
// - popularity match: in a playlist of 3k-fan artists a 10M-fan star counts
//   less (an eclectic playlist that has stars keeps them);
// - specific file-tag genres ("Alternative R&B", "Cloud Rap") as a fit factor,
//   never as a source;
// - spread: after each pick, candidates reached through the same playlist
//   artist weigh less, so a mixed playlist gets all of its circles.
// Deezer answers are kept in ext_cache for two weeks and warmed in the
// background for every playlist's artists, so opening a playlist is quick.
import type { FastifyInstance } from 'fastify';
import { libraryVersion, type DB } from './db.js';
import { TRACK_SELECT, trackOut, type TrackRow } from './library.js';

type Fetcher = typeof fetch;
type Rel = { fans: number | null; related: { name: string; id: string | null }[] };
type Opts = { fetcher?: Fetcher; log?: (m: string) => void; background?: boolean; deadline?: number };

const TTL = 14 * 24 * 60 * 60 * 1000;
const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const baseTitle = (t: string) => norm(String(t || '').replace(/\s*[([].*$/, '').replace(/\s+-\s+.*$/, ''));
// Alternate takes are not recommendations: the playlist wants the song.
const ALT_TAKE = /\b(live|sped ?up|slowed|instrumental|inst|remix|acapella|a cappella|karaoke|version|reverb)\b|\bver\./i;
// Tags too broad to say anything about a scene.
const BROAD = new Set(['other', 'pop', 'hiphop', 'rap', 'rb', 'electronic', 'electronica', 'dance', 'rock', 'alternative', 'unknown', 'misc', 'music', 'soundtrack', 'filmsgames', 'world']);

// Deezer calls go through one slow lane (their limit is 50 per 5 s per IP).
// A page waiting on an answer goes ahead of the background warm.
const queues: { hi: (() => void)[]; lo: (() => void)[] } = { hi: [], lo: [] };
let pumping = false;
const pump = () => {
  if (pumping) return;
  const next = queues.hi.shift() || queues.lo.shift(); if (!next) return;
  pumping = true; next();
  setTimeout(() => { pumping = false; pump(); }, 130);
};
const throttled = <T>(fn: () => Promise<T>, background = false): Promise<T> => new Promise((resolve, reject) => {
  (background ? queues.lo : queues.hi).push(() => { fn().then(resolve, reject); });
  pump();
});

// Which tracks credit which artist, built once per library version: the
// scoring asks about ~150 artists and a LIKE scan of the tracks is 35 ms each.
let index: { v: string; byArtist: Map<string, { id: string; genres: string; artist_ids: string }[]> } | null = null;
function artistIndex(db: DB) {
  const v = libraryVersion(db);
  if (index?.v === v) return index.byArtist;
  const byArtist = new Map<string, { id: string; genres: string; artist_ids: string }[]>();
  for (const r of db.prepare('SELECT id, genres, artist_ids FROM tracks').iterate() as Iterable<{ id: string; genres: string; artist_ids: string }>) {
    for (const a of JSON.parse(r.artist_ids) as string[]) { let l = byArtist.get(a); if (!l) byArtist.set(a, l = []); l.push(r); }
  }
  index = { v, byArtist };
  return byArtist;
}

function cachedRel(db: DB, artistId: string): Rel | null {
  const row = db.prepare('SELECT json, at FROM ext_cache WHERE k = ?').get(`dzrel:${artistId}`) as { json: string; at: number } | undefined;
  return row && Date.now() - row.at < TTL ? JSON.parse(row.json) : null;
}

// Deezer's related list for a library artist, every entry in Deezer's order
// (rank matters), mapped to library ids where the library has them, plus the
// artist's Deezer fan count. A failure is not cached.
export async function deezerRelated(db: DB, a: { id: string; name: string }, o: Opts = {}): Promise<Rel | null> {
  const hit = cachedRel(db, a.id); if (hit) return hit;
  const f = o.fetcher || fetch;
  const json = (url: string) => throttled(async () => {
    // Its turn came too late for the page that asked: skip, uncached.
    if (o.deadline && Date.now() > o.deadline) throw new Error('out of time');
    const r = await f(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${url.split('?')[0]} ${r.status}`);
    const j = await r.json() as any; if (j?.error) throw new Error(`deezer ${j.error.message || j.error.type}`); return j;
  }, o.background);
  try {
    const s = await json(`https://api.deezer.com/search/artist?q=${encodeURIComponent(a.name)}&limit=5`);
    const dz = (s.data || []).find((x: any) => norm(x.name) === norm(a.name));
    const out: Rel = { fans: dz ? Number(dz.nb_fan) || 0 : null, related: [] };
    if (dz) {
      const rel = await json(`https://api.deezer.com/artist/${dz.id}/related?limit=40`);
      const byName = db.prepare('SELECT id FROM artists WHERE name = ? COLLATE NOCASE');
      for (const r of rel.data || []) {
        const h = byName.get(r.name) as { id: string } | undefined;
        out.related.push({ name: r.name, id: h && h.id !== a.id ? h.id : null });
      }
    }
    db.prepare('INSERT INTO ext_cache (k, json, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET json = excluded.json, at = excluded.at').run(`dzrel:${a.id}`, JSON.stringify(out), Date.now());
    return out;
  } catch (e: any) { if (e.message !== 'out of time') o.log?.(`related ${a.name}: ${e.message}`); return null; }
}

const tagsOf = (genres: string[]) => {
  const out = new Set<string>();
  for (const g of genres) for (const p of String(g).split(/[;,/|]+/)) {
    const t = norm(p.replace(/hip[\s-]?hop/i, 'hiphop').replace(/\brnb\b/i, 'r&b'));
    if (t && !BROAD.has(t)) out.add(t);
  }
  return out;
};
const cosine = (a: Map<string, number>, b: Map<string, number>) => {
  if (!a.size || !b.size) return null;
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { dot += v * (b.get(k) || 0); na += v * v; }
  for (const v of b.values()) nb += v * v;
  return dot / Math.sqrt(na * nb);
};
// Small seeded PRNG: the same Refresh generation gives the same ten.
const prng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const weighted = <T>(rnd: () => number, xs: T[], w: (x: T) => number) => {
  const ws = xs.map(w); let r = rnd() * ws.reduce((s, x) => s + x, 0);
  for (let i = 0; i < xs.length; i++) { r -= ws[i]; if (r <= 0) return i; }
  return xs.length - 1;
};

export async function playlistRecommendations(db: DB, playlistId: string, uid: string, o: Opts & { n?: number; seed?: number; budgetMs?: number } = {}): Promise<TrackRow[]> {
  const n = o.n ?? 10;
  const deadline = Date.now() + (o.budgetMs ?? 4000);
  const idx = artistIndex(db);
  const byArtist = (a: string) => idx.get(a) || [];
  const rows = db.prepare(`${TRACK_SELECT} JOIN playlist_tracks pt ON pt.track_id = t.id WHERE pt.playlist_id = ?`).all(playlistId) as TrackRow[];
  if (!rows.length) return [];
  const have = new Set(rows.map((r) => r.id));
  // A song is its lead artist + title: another album's copy of a playlist
  // song is not a recommendation, another artist's song of that name is.
  const songKey = (t: TrackRow) => `${(JSON.parse(t.artist_ids) as string[])[0] || ''}|${baseTitle(t.title)}`;
  const titles = new Set(rows.map(songKey));
  const prefs = JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid) as any)?.json ?? '{}');
  const disliked = new Set(Object.keys(prefs.dislikes || {}));
  const nameOf = db.prepare('SELECT name FROM artists WHERE id = ?');
  const artist = (id: string) => ({ id, name: (nameOf.get(id) as any)?.name as string | undefined });
  // Before the deadline: fetch what is missing. After it: cache only, the
  // background warm fills the rest for next time.
  const rel = async (id: string) => {
    const hit = cachedRel(db, id); if (hit || Date.now() > deadline) return hit;
    const a = artist(id); return a.name ? deezerRelated(db, { id, name: a.name }, { ...o, deadline }) : null;
  };

  // The playlist's artists, weighted by share of its songs (a feature counts
  // as part of a song).
  const w = new Map<string, number>();
  for (const r of rows) { const ids = JSON.parse(r.artist_ids) as string[]; for (const a of ids) w.set(a, (w.get(a) || 0) + 1 / ids.length); }
  for (const [a, v] of w) w.set(a, v / rows.length);
  const top = [...w].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([a]) => a);
  const ptags = new Map<string, number>();
  for (const r of rows) for (const t of tagsOf(JSON.parse(r.genres))) ptags.set(t, (ptags.get(t) || 0) + 1);

  // Forward: who the playlist's artists point to, by rank.
  const score = new Map<string, number>();
  const src = new Map<string, Map<string, number>>(); // candidate -> playlist artist -> contribution
  const add = (c: string, p: string, v: number) => {
    score.set(c, (score.get(c) || 0) + v);
    const m = src.get(c) || new Map(); m.set(p, (m.get(p) || 0) + v); src.set(c, m);
  };
  const seedRel = new Map<string, Rel | null>();
  await Promise.all(top.map(async (p) => seedRel.set(p, await rel(p))));
  for (const p of top) (seedRel.get(p)?.related || []).forEach((r, i, all) => { if (r.id) add(r.id, p, w.get(p)! * (1 - i / Math.max(all.length, 20))); });
  for (const [p, v] of w) add(p, p, v * 0.6);
  // Collaborators: having worked with a playlist artist at all, not how often
  // (a star with 300 features would otherwise drag in every guest).
  for (const p of top) {
    const co = new Set<string>();
    for (const t of byArtist(p)) for (const b of JSON.parse(t.artist_ids)) co.add(b);
    co.delete(p);
    for (const b of co) add(b, p, w.get(p)! * 0.25 / Math.sqrt(co.size));
  }
  const circle = new Set<string>([...w.keys()]);
  for (const r of seedRel.values()) for (const x of r?.related || []) if (x.id) circle.add(x.id);

  // Backward + popularity + tag fit, for the strongest 60.
  const cand = [...score].sort((x, y) => y[1] - x[1]).slice(0, 60).map(([a]) => a);
  const candRel = new Map<string, Rel | null>();
  await Promise.all(cand.map(async (c) => candRel.set(c, seedRel.get(c) ?? await rel(c))));
  const lf: number[] = [];
  for (const [p, v] of w) { const f = (seedRel.get(p) ?? candRel.get(p))?.fans; if (f) for (let i = 0; i < Math.max(1, Math.round(v * 100)); i++) lf.push(Math.log10(1 + f)); }
  lf.sort((a, b) => a - b);
  const med = lf.length ? lf[lf.length >> 1] : null;
  const artistTags = (a: string) => {
    const m = new Map<string, number>();
    for (const t of byArtist(a).slice(0, 400)) for (const g of tagsOf(JSON.parse(t.genres))) m.set(g, (m.get(g) || 0) + 1);
    return m;
  };
  const final = new Map<string, number>();
  for (const c of cand) {
    const r = candRel.get(c);
    const back = r && r.related.length ? r.related.filter((x) => x.id && circle.has(x.id)).length / Math.max(r.related.length, 10) : 0.15;
    const tg = cosine(artistTags(c), ptags);
    const fit = tg === null ? 1 : 0.35 + 0.65 * Math.min(1, tg * 1.6);
    const pop = !r?.fans || med === null ? 1 : Math.exp(-Math.max(0, Math.log10(1 + r.fans) - med - 0.5) / 1.2);
    final.set(c, (score.get(c)! + 0.15 * back) * (0.4 + back) * fit * pop);
  }

  // Each candidate's best few songs: theirs (not a guest spot) with credits
  // inside the circle, played/liked first. One song per artist, two for the
  // playlist's own artists.
  const known = new Set([...circle, ...final.keys()]);
  const plays = new Map((db.prepare('SELECT track_id, COUNT(*) n FROM plays WHERE user_id = ? GROUP BY track_id').all(uid) as any[]).map((r) => [r.track_id, r.n as number]));
  const likes = new Set((db.prepare('SELECT track_id FROM likes WHERE user_id = ?').all(uid) as any[]).map((r) => r.track_id));
  const rnd = prng(o.seed ?? 0);
  const pool: { s: number; a: string; t: TrackRow }[] = [];
  for (const a of [...final].sort((x, y) => y[1] - x[1]).slice(0, 40).map(([a]) => a)) {
    const ids = byArtist(a).slice(0, 900).map((x) => x.id);
    const ts = (ids.length ? db.prepare(`${TRACK_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as TrackRow[] : [])
      .filter((t) => !have.has(t.id) && !disliked.has(t.id) && !titles.has(songKey(t)) && !ALT_TAKE.test(t.title))
      .map((t) => {
        const ids = JSON.parse(t.artist_ids) as string[];
        const cred = ids.filter((x) => known.has(x)).length / ids.length;
        return { t, q: (1 + 0.4 * Math.log1p(plays.get(t.id) || 0) + (likes.has(t.id) ? 0.6 : 0) + rnd() * 0.3) * (0.3 + 0.7 * cred) * (ids[0] === a ? 1 : 0.7) };
      })
      .sort((x, y) => y.q - x.q);
    ts.slice(0, 3).forEach((x, k) => pool.push({ s: final.get(a)! * x.q * 0.8 ** k, a, t: x.t }));
  }
  const main = (c: string) => { const m = src.get(c); return m ? [...m].sort((x, y) => y[1] - x[1])[0][0] : c; };
  const out: TrackRow[] = []; const per = new Map<string, number>(); const seen = new Set<string>(); const fromSrc = new Map<string, number>();
  while (pool.length && out.length < n) {
    const k = weighted(rnd, pool, (c) => c.s ** 2 * 0.35 ** (fromSrc.get(main(c.a)) || 0));
    const { a, t } = pool.splice(k, 1)[0];
    const key = songKey(t);
    if ((per.get(a) || 0) >= (w.has(a) ? 2 : 1) || seen.has(key)) continue;
    per.set(a, (per.get(a) || 0) + 1); seen.add(key); fromSrc.set(main(a), (fromSrc.get(main(a)) || 0) + 1);
    out.push(t);
  }
  return out;
}

// Fill the Deezer cache for every playlist's artists and the artists they
// point to, so the first open of a playlist does not wait on Deezer.
export async function warmPlaylistReco(db: DB, o: Opts = {}): Promise<number> {
  const seeds = (db.prepare(`SELECT DISTINCT t.artist_ids FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id`).all() as { artist_ids: string }[])
    .flatMap((r) => JSON.parse(r.artist_ids) as string[]);
  const nameOf = db.prepare('SELECT name FROM artists WHERE id = ?');
  const todo = [...new Set(seeds)];
  const done = new Set<string>(); let fetched = 0;
  const visit = async (id: string) => {
    if (done.has(id)) return null; done.add(id);
    if (cachedRel(db, id)) return cachedRel(db, id);
    const name = (nameOf.get(id) as any)?.name; if (!name) return null;
    fetched++; return deezerRelated(db, { id, name }, { ...o, background: true });
  };
  const next: string[] = [];
  for (const id of todo) { const r = await visit(id); for (const x of r?.related || []) if (x.id) next.push(x.id); }
  for (const id of next) await visit(id);
  return fetched;
}

export function registerPlaylistReco(app: FastifyInstance, db: DB, o: Opts & { warm?: boolean } = {}) {
  const auth = { preHandler: (app as any).requireUser };
  app.get('/api/playlists/:id/recommended', auth, async (req, reply) => {
    const uid = (req as any).user.id as string;
    const p = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get((req.params as any).id, uid) as { id: string } | undefined;
    if (!p) return reply.code(404).send({ error: 'no such playlist' });
    const q = req.query as any;
    const items = await playlistRecommendations(db, p.id, uid, { ...o, n: Math.min(Number(q.limit) || 10, 30), seed: Number(q.seed) || 0 });
    return { items: items.map(trackOut) };
  });
  if (!o.warm) return;
  let running = false;
  const warm = () => {
    if (running) return; running = true;
    warmPlaylistReco(db, o).then((n) => { if (n) o.log?.(`playlist recommendations: warmed ${n} artists`); }).catch(() => {}).finally(() => { running = false; });
  };
  const first = setTimeout(warm, 90 * 1000);
  const every = setInterval(warm, 6 * 60 * 60 * 1000);
  app.addHook('onClose', async () => { clearTimeout(first); clearInterval(every); });
}
