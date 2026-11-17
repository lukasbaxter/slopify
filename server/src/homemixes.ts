// Home's made-for-you tiles beyond the Daily Mixes, and the covers of all of
// them, drawn here (typecover.ts) so every device shows the same picture:
//  - Recommended Stations: an artist's radio, for artists the listener plays
//    (after the ones that already seed a Daily Mix);
//  - Your top mixes: one per genre the listener plays most ("Hip-Hop Mix"),
//    their own songs in it leaning the mix, refreshed daily.
// Each tile keeps the colour it was first given (kv colors:<user>), so a
// station is the same pink tomorrow; covers are rendered once per look
// (photo, words, colour) and served as art_<hash> through /api/image.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { storeArtwork, artDir } from './artwork.js';
import { albumGenreMap } from './genres.js';
import { renderDailyMix, renderRadio, renderMixBar, DAILY_COLORS, STATION_COLORS, MIXBAR_COLORS } from './typecover.js';

const COVER_VERSION = 1;
const kvGet = (db: DB, k: string) => (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;
const kvSet = (db: DB, k: string, v: string) => db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v);

// The colour a tile keeps: given once, the first in the palette that none of
// the other tiles on the same shelf has (the palette over again past 6).
export function tileColor(db: DB, uid: string, key: string, palette: string[], neighbours: string[] = []): string {
  const k = `colors:${uid}`;
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(kvGet(db, k) || '{}'); } catch { /* start over */ }
  if (saved[key] && palette.includes(saved[key])) return saved[key];
  const taken = new Set(neighbours.map((n) => saved[n]).filter(Boolean));
  const c = palette.find((p) => !taken.has(p)) ?? palette[Object.keys(saved).length % palette.length];
  saved[key] = c;
  kvSet(db, k, JSON.stringify(saved));
  return c;
}

// An artist photo's bytes (the stored 640 px copy).
export function photoOf(cacheDir: string, hash: string | null | undefined): Buffer | null {
  if (!hash) return null;
  try { return fs.readFileSync(path.join(artDir(cacheDir), hash, '640.jpg')); } catch { return null; }
}

// A cover drawn once for what is on it: the same look asked again is the
// stored picture (its hash is the image id clients use, art_<hash>).
const rendering = new Map<string, Promise<string | null>>();
export function coverArt(db: DB, cacheDir: string, look: unknown, draw: () => Promise<Buffer>): Promise<string | null> {
  const key = crypto.createHash('sha1').update(JSON.stringify([COVER_VERSION, look])).digest('hex');
  const kept = kvGet(db, `cover:${key}`);
  if (kept && fs.existsSync(path.join(artDir(cacheDir), kept, 'done'))) return Promise.resolve(`art_${kept}`);
  let job = rendering.get(key);
  if (!job) {
    job = (async () => {
      try {
        const { hash } = await storeArtwork(cacheDir, await draw());
        kvSet(db, `cover:${key}`, hash);
        return `art_${hash}`;
      } catch { return null; }
    })().finally(() => rendering.delete(key));
    rendering.set(key, job);
  }
  return job;
}

const imageOf = (db: DB, artistId: string) => (db.prepare('SELECT image_hash FROM artists WHERE id = ?').get(artistId) as { image_hash: string | null } | undefined)?.image_hash ?? null;

export function dailyMixArt(db: DB, cacheDir: string, n: number, coverImage: string | null) {
  const color = DAILY_COLORS[(n - 1) % DAILY_COLORS.length];
  return coverArt(db, cacheDir, ['daily', n, color, coverImage], () => renderDailyMix(photoOf(cacheDir, coverImage), n, color));
}

// The listener's artists by their own plays (the first credited artist of
// each song), most played first.
export function listenerArtists(db: DB, uid: string, sinceMs: number, limit = 40): { id: string; name: string; n: number }[] {
  return db.prepare(`SELECT a.id, a.name, x.n FROM (
      SELECT json_extract(t.artist_ids, '$[0]') id, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id
      WHERE p.user_id = ? AND p.at > ? GROUP BY 1 ORDER BY n DESC LIMIT ?
    ) x JOIN artists a ON a.id = x.id WHERE a.name NOT IN ('Various Artists', 'Unknown Artist', '') ORDER BY x.n DESC`)
    .all(uid, sinceMs, limit + 10) as { id: string; name: string; n: number }[];
}

export type Station = { id: string; name: string; with: { id: string; name: string }[]; color: string; art: string | null };
export async function stations(db: DB, cacheDir: string, uid: string, skip: Set<string>,
  mixOf: (a: { id: string; name: string }) => Promise<{ artists: { id: string; name: string }[] }>, n = 8): Promise<Station[]> {
  let seeds = listenerArtists(db, uid, Date.now() - 180 * 86400000).filter((a) => !skip.has(a.id));
  if (seeds.length < n) seeds = [...seeds, ...listenerArtists(db, uid, 0).filter((a) => !skip.has(a.id) && !seeds.some((s) => s.id === a.id))];
  seeds = seeds.slice(0, n);
  const keys = seeds.map((s) => `station:${s.id}`);
  return Promise.all(seeds.map(async (s, i) => {
    const color = tileColor(db, uid, keys[i], STATION_COLORS, keys.filter((_, j) => j !== i));
    const others = (await mixOf(s).catch(() => ({ artists: [] }))).artists.filter((a) => a.id !== s.id);
    const withPics = others.filter((a) => imageOf(db, a.id)).slice(0, 2);
    const images = [imageOf(db, s.id), ...withPics.map((a) => imageOf(db, a.id))];
    const art = await coverArt(db, cacheDir, ['radio', s.name, color, images], () => renderRadio(s.name, images.map((h) => photoOf(cacheDir, h)), color));
    return { id: s.id, name: s.name, with: others.slice(0, 3), color, art };
  }));
}

// "Your top mixes": the listener's most played genres in the last half year.
export type TopMix = { genre: string; name: string; artists: { id: string; name: string }[]; color: string; art: string | null; day: string };
const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
function genrePlays(db: DB, uid: string, sinceMs: number) {
  const genreOf = albumGenreMap(db);
  const rows = db.prepare(`SELECT t.album_id al, json_extract(t.artist_ids, '$[0]') ar, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id
    WHERE p.user_id = ? AND p.at > ? GROUP BY 1, 2`).all(uid, sinceMs) as { al: string; ar: string; n: number }[];
  const by = new Map<string, { n: number; artists: Map<string, number> }>();
  for (const r of rows) {
    const g = genreOf.get(r.al);
    if (!g || g === 'Other') continue;
    const e = by.get(g) ?? { n: 0, artists: new Map() };
    e.n += r.n; e.artists.set(r.ar, (e.artists.get(r.ar) || 0) + r.n);
    by.set(g, e);
  }
  return by;
}
export async function topMixes(db: DB, cacheDir: string, uid: string, n = 6, now = Date.now()): Promise<TopMix[]> {
  let by = genrePlays(db, uid, now - 180 * 86400000);
  if (by.size < 3) by = genrePlays(db, uid, 0);
  const top = [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, n);
  const day = dayOf(now);
  const turn = Math.floor(now / 86400000);
  const keys = top.map(([g]) => `mix:${g}`);
  return Promise.all(top.map(async ([genre, e], i) => {
    const ranked = [...e.artists.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as { id: string; name: string } | undefined)
      .filter((a): a is { id: string; name: string } => !!a && !['Various Artists', 'Unknown Artist'].includes(a.name));
    const color = tileColor(db, uid, keys[i], MIXBAR_COLORS, keys.filter((_, j) => j !== i));
    // The photo: one of their top artists in it who has one, a new one each day.
    const pics = ranked.slice(0, 4).map((a) => imageOf(db, a.id)).filter(Boolean) as string[];
    const image = pics.length ? pics[turn % pics.length] : null;
    const name = `${genre} Mix`;
    const art = await coverArt(db, cacheDir, ['mixbar', name, color, image], () => renderMixBar(photoOf(cacheDir, image), name, color));
    return { genre, name, artists: ranked.slice(0, 3), color, art, day };
  }));
}

// A top mix's songs for the day: the genre's songs, the listener's own plays
// and likes leaning hard, the household's plays a little, 50 of them picked
// the same way all day (seeded by listener, genre and day).
export function topMixTracks(db: DB, uid: string, genre: string, n = 50, now = Date.now()): string[] {
  const genreOf = albumGenreMap(db);
  const albums = new Set([...genreOf].filter(([, g]) => g === genre).map(([a]) => a));
  if (!albums.size) return [];
  const mine = new Map((db.prepare('SELECT track_id id, COUNT(*) n FROM plays WHERE user_id = ? GROUP BY track_id').all(uid) as { id: string; n: number }[]).map((r) => [r.id, r.n]));
  const liked = new Set((db.prepare('SELECT track_id id FROM likes WHERE user_id = ?').all(uid) as { id: string }[]).map((r) => r.id));
  const disliked = (() => { try { return new Set(Object.keys(JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid) as any)?.json ?? '{}').dislikes || {})); } catch { return new Set<string>(); } })();
  const rows = (db.prepare('SELECT id, album_id FROM tracks').all() as { id: string; album_id: string }[]).filter((t) => albums.has(t.album_id) && !disliked.has(t.id));
  let seed = 0; for (const c of `${uid}|${genre}|${dayOf(now)}`) seed = (Math.imul(seed, 31) + c.charCodeAt(0)) >>> 0;
  const rand = () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return seed / 4294967296; };
  // Weighted picks without replacement: a key per song (Efraimidis-Spirakis).
  const keyed = rows.map((t) => {
    const w = 1 + 3 * Math.min(mine.get(t.id) || 0, 10) + (liked.has(t.id) ? 8 : 0);
    return { id: t.id, k: Math.log(rand() || 1e-9) / w };
  });
  keyed.sort((a, b) => b.k - a.k);
  return keyed.slice(0, n).map((x) => x.id);
}
