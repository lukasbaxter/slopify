// Read side of the library: lists, details, search, lyrics, artwork.
// Every list is one query over columns the scanner already maintains.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import path from 'node:path';
import type { DB } from './db.js';
import { libraryVersion } from './db.js';
import { artPath, nearestBig, nearestSize, renderBig, SIZES } from './artwork.js';
import { ensureMosaic, playlistCover } from './mosaic.js';
import { popularOrder, relatedInLibrary, similarInLibrary } from './discover.js';
import { albumGenreMap } from './genres.js';
import { AUDIO_EXT, COVER_EXT, COVER_NAMES, splitArtists } from './scanner.js';
import { gainDb } from './loudness.js';
import { brainNext, dislikedOf } from './brain.js';
import { dailyMix, DAILY_SIZE } from './dailymix.js';

export type TrackRow = {
  id: string; title: string; artist: string; artists: string; artist_ids: string; album_id: string; album: string; album_artist: string;
  track_no: number | null; disc_no: number | null; year: number | null; genres: string; duration_ms: number; codec: string | null; bitrate: number | null;
  sample_rate?: number | null; bit_depth?: number | null; path?: string;
  identity_state: string; identity_score: number; added_at: number; cover_hash?: string | null;
  loudness?: number | null; true_peak?: number | null; album_loudness?: number | null; album_peak?: number | null;
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
  // Volume normalization (loudness.ts): dB to play it at, as a track and
  // within its album; null until the song has been measured.
  gain: { track: gainDb({ loudness: t.loudness ?? null, peak: t.true_peak ?? null }), album: gainDb({ loudness: t.album_loudness ?? null, peak: t.album_peak ?? null }) },
  identity: { state: t.identity_state, score: t.identity_score }, addedAt: t.added_at,
});
const albumOut = (a: any) => ({ id: a.id, name: a.name, artist: a.artist, artistId: a.artist_id, year: a.year, trackCount: a.track_count, durationMs: a.duration_ms, cover: a.cover_hash, addedAt: a.added_at });
const artistOut = (a: any) => ({ id: a.id, name: a.name, trackCount: a.track_count, albumCount: a.album_count, image: a.image_hash, banner: a.banner_hash ?? null });

export const TRACK_SELECT = 'SELECT t.*, a.cover_hash, a.loudness AS album_loudness, a.true_peak AS album_peak FROM tracks t JOIN albums a ON a.id = t.album_id';
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
  return t ? mixFrom(db, [t], limit) : null;
}

// An album's or a playlist's radio: one of its songs leads, then songs that go
// with all of them (their artists and genres), the seeds themselves left out.
export function mixForSet(db: DB, id: string, limit: number): TrackRow[] | null {
  const album = db.prepare('SELECT 1 FROM albums WHERE id = ?').get(id);
  const seeds = (album
    ? db.prepare(`${TRACK_SELECT} WHERE t.album_id = ?`).all(id)
    : db.prepare(`${TRACK_SELECT} JOIN playlist_tracks p ON p.track_id = t.id WHERE p.playlist_id = ? ORDER BY p.pos`).all(id)) as TrackRow[];
  if (!seeds.length) return null;
  const lead = seeds[Math.floor(Math.random() * seeds.length)];
  return mixFrom(db, [lead, ...seeds.filter((s) => s.id !== lead.id).sort(() => Math.random() - 0.5).slice(0, 9)], limit, new Set(seeds.map((s) => s.id)));
}

function mixFrom(db: DB, seeds: TrackRow[], limit: number, skip = new Set(seeds.map((s) => s.id))): TrackRow[] {
  const artistIds = new Set<string>(), genres = new Set<string>();
  for (const s of seeds) { for (const a of JSON.parse(s.artist_ids) as string[]) artistIds.add(a); for (const g of JSON.parse(s.genres) as string[]) genres.add(g); }
  const pick = new Map<string, TrackRow>();
  const add = (rows: TrackRow[]) => { for (const r of rows) if (!skip.has(r.id)) pick.set(r.id, r); };
  const lead = seeds[0].id;
  for (const a of artistIds) add(db.prepare(`${TRACK_SELECT} WHERE t.artist_ids LIKE ? AND t.id != ? ORDER BY RANDOM() LIMIT 40`).all(`%"${a}"%`, lead) as TrackRow[]);
  for (const g of genres) add(db.prepare(`${TRACK_SELECT} WHERE t.genres LIKE ? AND t.id != ? ORDER BY RANDOM() LIMIT 60`).all(`%${JSON.stringify(g)}%`, lead) as TrackRow[]);
  if (pick.size < 20) add(db.prepare(`${TRACK_SELECT} WHERE t.id != ? ORDER BY RANDOM() LIMIT 60`).all(lead) as TrackRow[]);
  const rows = [...pick.values()]; for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return [seeds[0], ...rows.slice(0, limit - 1)];
}

// Seeded randomness: the same key gives the same draw (a Daily Mix's day),
// another key another one. No key: Math.random.
export function rngOf(key?: string): () => number {
  if (!key) return Math.random;
  let s = crypto.createHash('sha1').update(key).digest().readUInt32BE(0);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffleWith = <T>(xs: T[], r: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const playsOf = (db: DB, uid?: string) => new Map<string, number>(uid ? (db.prepare('SELECT track_id, COUNT(*) n FROM plays WHERE user_id = ? GROUP BY track_id').all(uid) as any[]).map((r) => [r.track_id, r.n]) : []);
// Most played first; a tie by id, so the order holds from one day to the next.
const byPlays = (plays: Map<string, number>) => (a: TrackRow, b: TrackRow) => (plays.get(b.id) || 0) - (plays.get(a.id) || 0) || (a.id < b.id ? -1 : 1);

// Home's Daily Mix for an artist, Spotify-style: the artist (what this
// listener plays most first), artists like them that the library has (Deezer,
// cached), then the artist's genres; interleaved so the artist recurs without
// running back to back, one copy of each song. `sounds`: songs the brain
// heard as sounding like the artist (CLAP, dailymix.ts), closest first; they
// take the others' place, Deezer and genres only topping up a short list.
// `day` (a Daily Mix): the day picks the artist's songs and their order. It
// opens on one of their seven most played, a different one each day, and
// draws their other favourites from twice as many as it uses, so the same
// songs do not come back in the same places every morning.
export async function artistMix(db: DB, artist: { id: string; name: string }, limit: number, uid?: string, opts: { sounds?: string[]; day?: string } = {}): Promise<TrackRow[]> {
  const plays = playsOf(db, uid);
  const rnd = rngOf(opts.day ? `${opts.day}|${artist.id}|${uid || ''}` : undefined);
  const shuffle = <T>(xs: T[]) => shuffleWith(xs, rnd);
  const byArtist = (aid: string) => db.prepare(`${TRACK_SELECT} WHERE t.artist_ids LIKE ?`).all(`%"${aid}"%`) as TrackRow[];
  // theirs: the ones they play most (a fifth of the mix), the rest at random
  const all = shuffle(byArtist(artist.id).sort((a, b) => (a.id < b.id ? -1 : 1)));
  const played = all.filter((t) => plays.has(t.id)).sort(byPlays(plays));
  const nFav = Math.ceil(limit * 0.2);
  let favs = played.slice(0, nFav);
  if (opts.day && played.length > 1) {
    const top = played.slice(0, 7);
    const n = Math.floor(Date.parse(`${opts.day}T00:00:00Z`) / 86400000);
    const lead = top[((n % top.length) + top.length) % top.length];
    favs = [lead, ...shuffle(played.slice(0, nFav * 2).filter((t) => t !== lead)).slice(0, nFav - 1)];
  }
  let own = [...favs, ...all.filter((t) => !favs.includes(t))].slice(0, Math.ceil(limit * 0.4));
  if (opts.day) own = [own[0], ...shuffle(own.slice(1))].filter(Boolean);
  const ids = opts.sounds || [];
  const found = ids.length ? new Map((db.prepare(`${TRACK_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as TrackRow[]).map((r) => [r.id, r])) : new Map<string, TrackRow>();
  let heard = ids.map((id) => found.get(id)).filter((t): t is TrackRow => !!t && !(JSON.parse(t.artist_ids) as string[]).includes(artist.id));
  // The closest few open the mix; with a day, the rest in the day's order.
  if (opts.day) heard = [...heard.slice(0, 3), ...shuffle(heard.slice(3))];
  const others: TrackRow[] = [];
  if (heard.length < limit - own.length) {
    let similar: { id: string; name: string }[] = [];
    try { similar = await similarInLibrary(db, artist); } catch { /* offline: genres only */ }
    for (const s of similar.slice(0, 10)) others.push(...shuffle(byArtist(s.id)).slice(0, 6));
  }
  if (heard.length + others.length < limit - own.length) {
    const genres = new Map<string, number>();
    for (const t of all) for (const g of JSON.parse(t.genres) as string[]) genres.set(g, (genres.get(g) || 0) + 1);
    for (const [g] of [...genres].sort((a, b) => b[1] - a[1]).slice(0, 3)) others.push(...db.prepare(`${TRACK_SELECT} WHERE t.genres LIKE ? AND t.artist_ids NOT LIKE ? ORDER BY RANDOM() LIMIT 40`).all(`%${JSON.stringify(g)}%`, `%"${artist.id}"%`) as TrackRow[]);
  }
  return interleave(own, [...heard, ...shuffle(others)], limit);
}

// Radio from an artist, a song, an album or a playlist (Go to radio, radio.ts
// keeps it as the listener's radio playlist). Three sources:
//   - the brain (CLAP + the model trained on this house's listening),
//     seeded with the songs themselves and the related artists' songs;
//   - related artists the library has: ListenBrainz's similar artists and
//     Deezer's related ones (relatedInLibrary, cached);
//   - the seed's own artist: their other songs, what they play most first.
// `ask` is the brain (radio mode); null from it (off, slow, down) means the
// related artists and the seed's genres fill in. arrangeRadio orders it all.
export type RadioAsk = (seeds: string[], n: number, exclude: string[]) => Promise<string[] | null>;
export type RadioKind = 'artist' | 'track' | 'album' | 'playlist';
export type RelatedOf = (a: { id: string; name: string }) => Promise<{ id: string; name: string }[]>;
type RadioOpts = { uid?: string; related?: RelatedOf };
const shuffled = <T>(xs: T[]) => shuffleWith(xs, Math.random);
const byArtistId = (db: DB, aid: string) => db.prepare(`${TRACK_SELECT} WHERE t.artist_ids LIKE ?`).all(`%"${aid}"%`) as TrackRow[];
const artistsOf = (t: TrackRow) => JSON.parse(t.artist_ids) as string[];
const artistRow = (db: DB, aid: string) => db.prepare('SELECT id, name FROM artists WHERE id = ?').get(aid) as { id: string; name: string } | undefined;
// Brain picks and related artists' songs, two to one.
function blend(brain: TrackRow[], related: TrackRow[]): TrackRow[] {
  const out: TrackRow[] = []; let i = 0, j = 0;
  while (i < brain.length || j < related.length) { if (i < brain.length) out.push(brain[i++]); if (i < brain.length) out.push(brain[i++]); if (j < related.length) out.push(related[j++]); }
  return out;
}
async function relatedSongs(db: DB, artists: { id: string; name: string }[], perArtist: number, skip: Set<string>, related: RelatedOf, maxArtists = 12) {
  const lists = await Promise.all(artists.map((a) => related(a).catch(() => [] as { id: string; name: string }[])));
  const seen = new Set(artists.map((a) => a.id)); const out: TrackRow[][] = [];
  // Each seed artist's list in turn, so a set's artists all get theirs.
  for (let k = 0; out.length < maxArtists && lists.some((l) => l[k]); k++) for (const list of lists) {
    const r = list[k]; if (!r || seen.has(r.id) || out.length >= maxArtists) continue; seen.add(r.id);
    out.push(shuffled(byArtistId(db, r.id).filter((t) => !skip.has(t.id))).slice(0, perArtist));
  }
  // Round-robin, so every related artist comes up early.
  const flat: TrackRow[] = [];
  for (let k = 0; k < perArtist; k++) for (const l of out) if (l[k]) flat.push(l[k]);
  return flat;
}
// Songs of the seed's genres by other artists, for a list still short.
function genreSongs(db: DB, from: TrackRow[], notArtists: Set<string>, n: number): TrackRow[] {
  const genres = new Map<string, number>();
  for (const t of from) for (const g of JSON.parse(t.genres) as string[]) genres.set(g, (genres.get(g) || 0) + 1);
  const out: TrackRow[] = [];
  for (const [g] of [...genres].sort((a, b) => b[1] - a[1]).slice(0, 3)) out.push(...db.prepare(`${TRACK_SELECT} WHERE t.genres LIKE ? ORDER BY RANDOM() LIMIT ?`).all(`%${JSON.stringify(g)}%`, n) as TrackRow[]);
  if (out.length < n) out.push(...db.prepare(`${TRACK_SELECT} ORDER BY RANDOM() LIMIT ?`).all(n) as TrackRow[]);
  return shuffled(out.filter((t) => !artistsOf(t).some((a) => notArtists.has(a))));
}

// The radio's order: it opens on the seed song, the seed's artists come
// back every `every` songs (a quarter for an artist), no artist plays twice
// in a row, any other artist at most `perArtist` times, one copy of each
// song (a remaster or live take of the same title counts as one), nothing in
// `skip` (dislikes). It stops short rather than break those rules.
export function arrangeRadio(lead: TrackRow | null, seedSongs: TrackRow[], others: TrackRow[], limit: number,
  o: { every?: number; perArtist?: number; skip?: Set<string>; seedArtists?: Set<string> } = {}): TrackRow[] {
  const every = Math.max(2, o.every ?? 4), perArtist = o.perArtist ?? 3, skip = o.skip ?? new Set<string>();
  const seedArtists = o.seedArtists ?? new Set(lead ? artistsOf(lead) : []);
  const out: TrackRow[] = []; const ids = new Set<string>(), keys = new Set<string>(); const count = new Map<string, number>();
  const keyOf = (t: TrackRow) => `${t.artist.toLowerCase()}|${t.title.toLowerCase().replace(/\s*[([].*$/, '').replace(/\s+-\s+.*$/, '').trim()}`;
  const used = (t: TrackRow) => skip.has(t.id) || ids.has(t.id) || keys.has(keyOf(t));
  const capOk = (t: TrackRow) => artistsOf(t).every((a) => seedArtists.has(a) || (count.get(a) || 0) < perArtist);
  const place = (t: TrackRow) => { out.push(t); ids.add(t.id); keys.add(keyOf(t)); for (const a of artistsOf(t)) count.set(a, (count.get(a) || 0) + 1); };
  const take = (q: TrackRow[]) => {
    const prev = new Set(out.length ? artistsOf(out[out.length - 1]) : []);
    for (let i = 0; i < q.length; i++) {
      const t = q[i];
      if (used(t)) { q.splice(i--, 1); continue; }
      if (artistsOf(t).some((a) => prev.has(a)) || !capOk(t)) continue;
      q.splice(i, 1); return t;
    }
    return null;
  };
  const mine = [...seedSongs], rest = [...others];
  if (lead && !skip.has(lead.id)) place(lead);
  while (out.length < limit) {
    const theirs = out.length % every === 0;
    const t = theirs ? take(mine) ?? take(rest) : take(rest) ?? null;
    // Out of others: the seed's own songs may fill in, still never two in a row.
    const u = t ?? (theirs ? null : take(mine));
    if (!u) break;
    place(u);
  }
  return out;
}

export async function buildRadio(db: DB, seed: { kind: RadioKind; id: string }, limit: number, ask: RadioAsk, o: RadioOpts = {}): Promise<{ tracks: TrackRow[]; from: 'brain' | 'own' } | null> {
  const related: RelatedOf = o.related ?? ((a) => relatedInLibrary(db, a));
  const plays = playsOf(db, o.uid);
  const skip = new Set(o.uid ? dislikedOf(db, o.uid) : []);
  let lead: TrackRow | null, own: TrackRow[], exclude: Set<string>, main: { id: string; name: string }[], seeds: (rel: TrackRow[]) => string[], every: number, perRelated: number;
  if (seed.kind === 'artist') {
    const artist = artistRow(db, seed.id); if (!artist) return null;
    const all = shuffled(byArtistId(db, artist.id));
    if (!all.length) return null;
    const played = all.filter((t) => plays.has(t.id)).sort(byPlays(plays));
    // Nothing of theirs played here: the world's favourites (ListenBrainz) lead.
    const ranked = played.length ? played : await popularOrder(db, artist).then((ids) => { const by = new Map(all.map((t) => [t.id, t])); return ids.map((x) => by.get(x)!).filter(Boolean); }).catch(() => all);
    const top = (ranked.length ? ranked : all).slice(0, 5);
    lead = top[Math.floor(Math.random() * top.length)];
    // Their favourites and the rest, half and half, after the lead.
    const favs = shuffled(ranked.slice(0, Math.ceil(limit * 0.3)).filter((t) => t !== lead));
    const rest = shuffled(all.filter((t) => t !== lead && !favs.includes(t)));
    own = []; for (let i = 0; own.length < all.length - 1 && (i < favs.length || i < rest.length); i++) { if (favs[i]) own.push(favs[i]); if (rest[i]) own.push(rest[i]); }
    exclude = new Set(all.map((t) => t.id));
    main = [artist];
    seeds = (rel) => [...(ranked.length ? ranked : all).slice(0, 6), ...rel.slice(0, 6)].map((t) => t.id);
    every = 4; perRelated = 3;
  } else if (seed.kind === 'track') {
    lead = (db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(seed.id) as TrackRow | undefined) ?? null;
    if (!lead) return null;
    const first = artistRow(db, artistsOf(lead)[0] || '');
    const theirs = first ? byArtistId(db, first.id) : [];
    // Their eight most played (in a new order each time), then the rest.
    const mine = theirs.filter((t) => t.id !== lead!.id), played = mine.filter((t) => plays.has(t.id)).sort(byPlays(plays));
    own = [...shuffled(played.slice(0, 8)), ...shuffled(mine.filter((t) => !played.slice(0, 8).includes(t)))];
    exclude = new Set([lead.id, ...theirs.map((t) => t.id)]);
    main = first ? [first] : [];
    seeds = () => [lead!.id];
    every = 5; perRelated = 3;
  } else {
    const songs = (seed.kind === 'album'
      ? db.prepare(`${TRACK_SELECT} WHERE t.album_id = ?`).all(seed.id)
      : db.prepare(`${TRACK_SELECT} JOIN playlist_tracks p ON p.track_id = t.id WHERE p.playlist_id = ? ORDER BY p.pos`).all(seed.id)) as TrackRow[];
    if (!songs.length) return null;
    const inSet = new Set(songs.map((t) => t.id));
    const pick = shuffled(songs.filter((t) => !skip.has(t.id)));
    lead = pick[0] ?? songs[0];
    // The set's main artists (most songs first): their songs outside it recur.
    const n = new Map<string, number>();
    for (const t of songs) for (const a of artistsOf(t)) n.set(a, (n.get(a) || 0) + 1);
    main = [...n].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([aid]) => artistRow(db, aid)).filter((a): a is { id: string; name: string } => !!a);
    own = shuffled(main.flatMap((a) => byArtistId(db, a.id)).filter((t) => !inSet.has(t.id)));
    exclude = new Set([...inSet, ...own.map((t) => t.id)]);
    const l = lead;
    seeds = () => [l, ...pick.filter((t) => t !== l).slice(0, 14)].map((t) => t.id);
    every = 5; perRelated = 2;
  }
  const rel = await relatedSongs(db, main, perRelated, exclude, related);
  const asked = await ask(seeds(rel), Math.ceil(limit * 1.6), [...exclude]);
  const brain = asked ? tracksRows(db, asked).filter((t) => !exclude.has(t.id)) : [];
  let others = asked ? blend(brain, rel) : [...rel];
  // No brain, or a short answer: more of the related artists, then the genres.
  const mainIds = new Set([...main.map((a) => a.id), ...(lead ? artistsOf(lead) : [])]);
  const have = () => new Set(others.map((t) => t.id));
  if (others.length < limit) { const h = have(); others = [...others, ...shuffled(await relatedSongs(db, main, 6, exclude, related)).filter((t) => !h.has(t.id))]; }
  if (others.length < limit * 1.2) { const h = have(); others = [...others, ...genreSongs(db, [lead!, ...own.slice(0, 20)], mainIds, limit * 2).filter((t) => !exclude.has(t.id) && !h.has(t.id))]; }
  const tracks = arrangeRadio(lead, own, others, limit, { every, skip, seedArtists: seed.kind === 'artist' || seed.kind === 'track' ? new Set([...mainIds]) : new Set(main.map((a) => a.id)) });
  return { tracks, from: asked ? 'brain' : 'own' };
}

// The older entry points (the ?mode=radio mix, "Play" on an artist card).
export async function artistRadio(db: DB, artist: { id: string; name: string }, limit: number, uid: string, ask: RadioAsk, o: Omit<RadioOpts, 'uid'> = {}): Promise<TrackRow[]> {
  return (await buildRadio(db, { kind: 'artist', id: artist.id }, limit, ask, { ...o, uid }))?.tracks ?? [];
}
export async function setRadio(db: DB, id: string, limit: number, ask: RadioAsk, o: RadioOpts = {}): Promise<TrackRow[] | null> {
  const album = db.prepare('SELECT 1 FROM albums WHERE id = ?').get(id);
  return (await buildRadio(db, { kind: album ? 'album' : 'playlist', id }, limit, ask, o))?.tracks ?? null;
}

// The brain in radio mode for one listener, minus what their queue holds.
export const radioAskFor = (app: FastifyInstance, db: DB, uid: string): RadioAsk => (seeds, n, exclude) => {
  const queue = ((app as any).sessionOf?.(uid)?.queue || []) as string[];
  return brainNext(db, { user: uid, mode: 'radio', seeds, n, exclude: [...exclude, ...queue.slice(-500)].slice(-2000) }, { log: (m) => app.log.info(m) });
};

// Who a mix or a radio is: its seed artist first, then the artists with the
// most songs in its first `within` (what its page shows), up to `n`.
export function mixArtists(db: DB, ids: string[], seedArtist: string | null, n = 3, within = 50): { id: string; name: string }[] {
  const rows = tracksRows(db, ids.slice(0, within));
  const count = new Map<string, { n: number; at: number }>();
  rows.forEach((t, i) => { for (const a of artistsOf(t).slice(0, 1)) { const c = count.get(a); count.set(a, { n: (c?.n || 0) + 1, at: c?.at ?? i }); } });
  const order = [...count].sort((x, y) => y[1].n - x[1].n || x[1].at - y[1].at).map(([a]) => a).filter((a) => a !== seedArtist);
  return [...(seedArtist ? [seedArtist] : []), ...order].slice(0, n).map((a) => artistRow(db, a)).filter((a): a is { id: string; name: string } => !!a);
}

function tracksRows(db: DB, ids: string[]): TrackRow[] {
  if (!ids.length) return [];
  const rows = new Map((db.prepare(`${TRACK_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as TrackRow[]).map((r) => [r.id, r]));
  return ids.map((x) => rows.get(x)).filter((r): r is TrackRow => !!r);
}

function interleave(own: TrackRow[], others: TrackRow[], limit: number): TrackRow[] {
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
    if (!words.length) return { tracks, albums: [], artists: [] }; // only wildcards: no album/artist predicate to build
    const where = (expr: string) => words.map(() => `${expr} LIKE ? COLLATE NOCASE`).join(' AND ');
    const params = words.map((w) => `%${w}%`);
    const albums = (db.prepare(`SELECT * FROM albums WHERE ${where("(name || ' ' || artist)")} ORDER BY (name = ? COLLATE NOCASE) DESC, track_count DESC LIMIT ?`).all(...params, q, limit) as any[]).map(albumOut);
    const artists = (db.prepare(`SELECT * FROM artists WHERE ${where('name')} ORDER BY (name = ? COLLATE NOCASE) DESC, track_count DESC LIMIT ?`).all(...params, q, limit) as any[]).map(artistOut);
    return { tracks, albums, artists };
  });
  const radioAsk = (uid: string) => radioAskFor(app, db, uid);
  const todaysMix = (artist: { id: string; name: string }, me: string, tzo: unknown) =>
    dailyMix(db, artist.id, me, (sounds, day) => artistMix(db, artist, DAILY_SIZE, me, { sounds, day }), { tzo, log: (m) => app.log.info(m) });
  app.get('/api/tracks/:id/mix', auth, async (req, reply) => {
    const id = (req.params as any).id as string; const limit = Math.min(200, Number((req.query as any).limit) || 100);
    // An artist seeds Home's Daily Mixes.
    const artist = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as { id: string; name: string } | undefined;
    if (artist) {
      const me = (req as any).user?.id as string | undefined;
      // Radio and "more like this" (a ?mode) want fresh songs every time;
      // the Daily Mix (Home's tile, its page, a pinned artist) is the day's.
      if (me && (req.query as any).mode === 'radio') return { items: (await artistRadio(db, artist, limit, me, radioAsk(me))).map(trackOut) };
      if (!me || (req.query as any).mode) return { items: (await artistMix(db, artist, limit, me)).map(trackOut) };
      const m = await todaysMix(artist, me, (req.query as any).tzo);
      return { items: tracksByIds(db, m.ids.slice(0, limit)), from: m.from, day: m.day, artists: mixArtists(db, m.ids, artist.id) };
    }
    // A song: the brain first (smart shuffle and autoplay land here when the
    // queue runs out; ?mode=radio for a song's radio), its own mix otherwise.
    const uid = (req as any).user?.id as string | undefined;
    const seed = uid ? db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as TrackRow | undefined : undefined;
    if (seed && uid) {
      const mode = ['continue', 'smart', 'radio'].includes((req.query as any).mode) ? (req.query as any).mode : 'continue';
      const queue = ((app as any).sessionOf?.(uid)?.queue || []) as string[];
      const ids = await brainNext(db, { user: uid, mode, seeds: [id], n: limit - 1, exclude: [id, ...queue.slice(-500)], client: String((req.query as any).client || '') }, { log: (m) => app.log.info(m) });
      if (ids) return { items: [trackOut(seed), ...tracksByIds(db, ids)], from: 'brain' };
    }
    // An album's or a playlist's radio: related artists and the brain.
    if (uid && !seed && (req.query as any).mode === 'radio') {
      const items = await setRadio(db, id, limit, radioAsk(uid));
      if (items) return { items: items.map(trackOut) };
    }
    // A track, or an album's / playlist's page ("Go to radio").
    const items = mixFor(db, id, limit) || mixForSet(db, id, limit);
    if (!items) return reply.code(404).send({ error: 'no such track' });
    return { items: items.map(trackOut) };
  });
  // Home's Made For You tiles: today's mix of each seed artist (made now if
  // it is a new day), and who is in it, so a tile reads as today's.
  app.get('/api/daily-mixes', auth, async (req) => {
    const me = (req as any).user.id as string;
    const ids = [...new Set(String((req.query as any).ids || '').split(',').filter((x) => /^[0-9a-f]{32}$/.test(x)))].slice(0, 12);
    const items = await Promise.all(ids.map(async (id) => {
      const artist = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as { id: string; name: string } | undefined;
      if (!artist) return null;
      const m = await todaysMix(artist, me, (req.query as any).tzo);
      return { artistId: id, day: m.day, from: m.from, artists: mixArtists(db, m.ids, id) };
    }));
    return { items: items.filter(Boolean) };
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
  // artist's portrait (or its banner); a playlist's is playlistCover's
  // (mosaic.ts). Served straight from the rendered files; webp when accepted.
  const coverOf = (id: string, kind: string): string | null => {
    const al = db.prepare('SELECT cover_hash FROM albums WHERE id = ?').get(id) as any; if (al) return al.cover_hash ?? null;
    const tr = db.prepare('SELECT a.cover_hash FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = ?').get(id) as any; if (tr) return tr.cover_hash ?? null;
    // A track that left the library (replaced file = new id) still names its album:
    // rows a client kept from before the change keep their cover.
    const gt = db.prepare('SELECT a.cover_hash FROM gone_tracks g JOIN albums a ON a.id = g.album_id WHERE g.id = ?').get(id) as any; if (gt?.cover_hash) return gt.cover_hash;
    // A library folder's uploaded picture.
    if (id.startsWith('fd_')) return (db.prepare('SELECT cover_hash FROM library_folders WHERE id = ?').get(id) as any)?.cover_hash ?? null;
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
  // The source bytes of a stored picture: from where the scan (or the
  // download) found them, a cover file, a track's embedded picture or a URL;
  // else, for a folder since renamed or moved in from the drop folder, the
  // covers and first tracks of the albums now showing it. Only bytes that
  // still hash to it count.
  const noOriginal = new Set<string>();
  const originalOf = async (hash: string): Promise<Buffer | null> => {
    const read = async (f: string): Promise<Buffer | null> => {
      if (/^https?:\/\//.test(f)) { const r = await fetch(f, { signal: AbortSignal.timeout(15000) }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; }
      if (!AUDIO_EXT.has(path.extname(f).toLowerCase())) return await fsp.readFile(f);
      const pic = (await parseFile(f, { skipPostHeaders: true })).common.picture?.[0];
      return pic ? Buffer.from(pic.data) : null;
    };
    const src = (db.prepare('SELECT src FROM artwork WHERE hash = ?').get(hash) as any)?.src as string | undefined;
    const tracks = (db.prepare('SELECT (SELECT t.path FROM tracks t WHERE t.album_id = a.id ORDER BY t.disc_no, t.track_no LIMIT 1) path FROM albums a WHERE a.cover_hash = ? LIMIT 3').all(hash) as any[]).map((r) => r.path).filter(Boolean) as string[];
    const covers = tracks.flatMap((t) => COVER_NAMES.flatMap((n) => COVER_EXT.map((e) => path.join(path.dirname(t), n + e))));
    for (const f of [...(src ? [src] : []), ...covers, ...tracks]) {
      const b = await read(f).catch(() => null);
      if (b && crypto.createHash('sha1').update(b).digest('hex') === hash) return b;
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
    // A playlist's picture changes with its songs under the same URL: every
    // client asks again (a 304 while it is the same), none keeps an old grid.
    const playlist = id.startsWith('pl_');
    let hash: string | null; let mosaic = false;
    if (playlist) {
      const pc = playlistCover(db, id);
      hash = pc.hash;
      if (pc.parts) { mosaic = await ensureMosaic(dataDir, pc.hash!, pc.parts); if (!mosaic) hash = pc.parts[0]; }
    } else hash = coverOf(id, kind);
    if (!hash) return reply.code(404).send();
    const webp = /image\/webp/.test(String(req.headers.accept || ''));
    const want = Number(q.size) || Number(q.maxHeight) || 320;
    const caching = (file: string) => {
      if (!playlist) { reply.header('Cache-Control', 'private, max-age=86400').header('Vary', 'Accept'); return false; }
      const tag = `"${hash}-${path.basename(file)}"`;
      reply.header('Cache-Control', 'private, no-cache').header('Vary', 'Accept').header('ETag', tag);
      return req.headers['if-none-match'] === tag;
    };
    // Bigger than the largest stored copy: the big one, made now if need be;
    // the 640 copy when the original cannot be read (a grid has no original).
    if (kind === 'primary' && want > SIZES[SIZES.length - 1] && !hash.includes('/') && !mosaic) {
      const big = nearestBig(want);
      const p = path.join(dataDir, 'art', hash, `${big}.${webp ? 'webp' : 'jpg'}`);
      if (fs.existsSync(p) || (!noOriginal.has(hash) && await renderBig(dataDir, hash, big, () => originalOf(hash!)))) {
        if (caching(p)) return reply.code(304).send();
        reply.type(webp ? 'image/webp' : 'image/jpeg');
        return reply.send(fs.createReadStream(p));
      }
      noOriginal.add(hash);
    }
    const size = kind === 'banner' ? 'banner' : String(nearestSize(want));
    // Banner width: 640 for a small screen or a slow / metered connection, 1280 otherwise.
    const [h, sub] = hash.replace('{w}', Number(q.w) > 0 && Number(q.w) <= 800 ? '640' : '1280').split('/');
    const p = path.join(dataDir, 'art', h, sub ? `${sub}.${webp ? 'webp' : 'jpg'}` : `${size}.${webp ? 'webp' : 'jpg'}`);
    if (!fs.existsSync(p)) return reply.code(404).send();
    if (caching(p)) return reply.code(304).send();
    reply.type(webp ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(p));
  });
}
