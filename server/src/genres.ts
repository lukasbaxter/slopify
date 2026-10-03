// Genres, made canonical. File tags are a mess ("Rap/Hip Hop", "Hip Hop" and
// "Rap" as three different strings, 15% of tracks with none at all), so
// browsing by raw tags gives a wall of near-duplicate tiles. This module
// settles ONE canonical genre per album: Deezer's album genre when we can
// match the album there (clean ~20-bucket taxonomy, fetched gently by the
// enrich cycle), the majority vote of the album's normalized file tags
// otherwise, the artist's other albums after that, and 'Other' at the end
// of the road. The browse tiles and genre hubs read from here.
import type { DB } from './db.js';

// The shelf labels, in display order of nothing in particular.
export const CANON = [
  'Pop', 'Hip-Hop', 'R&B', 'Rock', 'Metal', 'Alternative', 'Electronic', 'Dance',
  'Jazz', 'Classical', 'Country', 'Folk', 'Latin', 'Reggae', 'Blues', 'Soul & Funk',
  'K-Pop', 'Afrobeats', 'Soundtrack', 'Other',
] as const;

const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Ordered contains-rules over a normalized tag: first match wins, so the
// specific ("k pop", "latin trap"?) must sit above the generic ("pop", "trap").
const RULES: [RegExp, string][] = [
  [/k ?pop|korean/, 'K-Pop'],
  [/afro/, 'Afrobeats'],
  [/reggaeton|latin|salsa|bachata|cumbia|bossa|brazil|mpb|flamenco/, 'Latin'],
  [/reggae|dancehall|ska|\bdub\b/, 'Reggae'],
  [/hip ?hop|\brap\b|trap|drill|grime|phonk|boom bap/, 'Hip-Hop'],
  [/r ?(and|n) ?b|r b\b|rnb|neo soul/, 'R&B'],
  [/soul|funk|motown|gospel|disco/, 'Soul & Funk'],
  [/metal|deathcore|djent/, 'Metal'],
  [/punk|grunge|rock|psychedel/, 'Rock'],
  [/alternative|indie|shoegaze|emo|dream pop|slowcore/, 'Alternative'],
  [/house|techno|trance|eurodance|big room|club|\bedm\b|dance/, 'Dance'],
  [/electro|synth|ambient|downtempo|chill|idm|dubstep|drum ?((and|n) ?)?bass|dnb|breakbeat|garage|future|wave\b|lo ?fi/, 'Electronic'],
  [/jazz|bebop|swing/, 'Jazz'],
  [/classical|orchestr|opera|baroque|symphon|piano|composer/, 'Classical'],
  [/country|bluegrass|americana/, 'Country'],
  [/folk|singer ?songwriter|acoustic/, 'Folk'],
  [/blues/, 'Blues'],
  [/soundtrack|score|film|game|anime|musical|disney|television/, 'Soundtrack'],
  [/\bpop\b|chanson|schlager/, 'Pop'],
];

export function canonicalize(raw: string): string | null {
  const t = norm(raw);
  if (!t) return null;
  for (const [re, name] of RULES) if (re.test(t)) return name;
  return null;
}

// Deezer's genre ids, folded into the same shelves.
const DEEZER_GENRES: Record<number, string> = {
  132: 'Pop', 116: 'Hip-Hop', 152: 'Rock', 113: 'Dance', 165: 'R&B', 85: 'Alternative',
  106: 'Electronic', 466: 'Folk', 144: 'Reggae', 129: 'Jazz', 84: 'Country', 52: 'Pop',
  98: 'Classical', 173: 'Soundtrack', 464: 'Metal', 169: 'Soul & Funk', 2: 'Afrobeats',
  16: 'K-Pop', 153: 'Blues', 75: 'Latin', 197: 'Latin', 81: 'Other', 95: 'Other',
};

// The majority among an album's canonicalized tags; ties to the first seen.
export function voteFromTags(tagLists: string[][]): string | null {
  const count = new Map<string, number>();
  for (const tags of tagLists) for (const raw of tags) { const c = canonicalize(raw); if (c) count.set(c, (count.get(c) || 0) + 1); }
  let best: string | null = null, n = 0;
  for (const [g, c] of count) if (c > n) { best = g; n = c; }
  return best;
}

// albumId -> shelf, for every album: the settled albums.genre, else a live
// tag vote, else 'Other'. One walk of the tracks table, cached briefly -
// the browse page and every genre hub ask for the whole thing.
let mapCache: { at: number; v: Map<string, string> } | null = null;
export function albumGenreMap(db: DB): Map<string, string> {
  if (mapCache && Date.now() - mapCache.at < 5 * 60 * 1000) return mapCache.v;
  const settled = new Map<string, string>((db.prepare('SELECT id, genre FROM albums WHERE genre IS NOT NULL').all() as any[]).map((a) => [a.id, a.genre]));
  const tags = new Map<string, string[][]>();
  for (const r of db.prepare("SELECT album_id, genres FROM tracks WHERE genres != '[]'").all() as any[]) {
    if (settled.has(r.album_id)) continue;
    if (!tags.has(r.album_id)) tags.set(r.album_id, []);
    try { tags.get(r.album_id)!.push(JSON.parse(r.genres)); } catch { /* bad tag json */ }
  }
  const v = new Map<string, string>();
  for (const a of db.prepare('SELECT id FROM albums').all() as any[]) {
    v.set(a.id, settled.get(a.id) ?? voteFromTags(tags.get(a.id) ?? []) ?? 'Other');
  }
  mapCache = { at: Date.now(), v };
  return v;
}
export const dropGenreCache = () => { mapCache = null; };

// Settle albums.genre for albums that have none yet: Deezer's genre for the
// matched album, the file tags' vote, the artist's other albums, 'Other'.
// Paced like the other enrich passes; results are permanent (a re-run never
// second-guesses a settled album).
export async function albumGenresPass(db: DB, opts: { fetcher?: (url: string) => Promise<{ status: number; json: () => Promise<any> }>; log?: (m: string) => void; max?: number } = {}): Promise<{ settled: number; deezer: number }> {
  const f = opts.fetcher ?? ((url: string) => fetch(url, { headers: { 'User-Agent': 'slopify/0.1 (https://github.com/lukasbaxter/slopify)' } }));
  const log = opts.log ?? (() => {});
  const normName = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const due = db.prepare('SELECT id, name, artist, artist_id FROM albums WHERE genre IS NULL ORDER BY track_count DESC LIMIT ?').all(opts.max ?? 300) as any[];
  const byArtist = db.prepare('SELECT genre, COUNT(*) n FROM albums WHERE artist_id = ? AND genre IS NOT NULL GROUP BY genre ORDER BY n DESC LIMIT 1');
  const trackTags = db.prepare("SELECT genres FROM tracks WHERE album_id = ? AND genres != '[]'");
  const set = db.prepare('UPDATE albums SET genre = ? WHERE id = ?');
  let deezer = 0;
  for (const al of due) {
    let g: string | null = null;
    try {
      const r = await f(`https://api.deezer.com/search/album?q=${encodeURIComponent(`${al.artist} ${al.name}`)}&limit=10`);
      if (r.status === 200) {
        const hit = (((await r.json()).data || []) as any[]).find((d) => normName(d.title) === normName(al.name) && normName(d.artist?.name ?? '') === normName(al.artist));
        const mapped = hit ? DEEZER_GENRES[Number(hit.genre_id)] : null;
        if (mapped && mapped !== 'Other') { g = mapped; deezer++; }
      }
    } catch (e: any) { log(`deezer genre ${al.artist} - ${al.name}: ${e.message}`); }
    g = g
      ?? voteFromTags((trackTags.all(al.id) as any[]).map((t) => { try { return JSON.parse(t.genres); } catch { return []; } }))
      ?? (byArtist.get(al.artist_id) as any)?.genre
      ?? 'Other';
    set.run(g, al.id);
  }
  if (due.length) dropGenreCache();
  return { settled: due.length, deezer };
}
