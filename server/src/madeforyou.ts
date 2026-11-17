// Themed playlists made for each listener, Spotify's "type" playlists:
// Rock Classics, Chill Vibes, 90s Hits, Christmas Hits, This Is <artist>.
// Each person gets their own copy: their own songs that fit (and songs they
// play that sound close to it, whatever the tags say), and songs the brain
// finds by how they sound, leaning toward their taste; nothing they turned
// down. Rebuilt daily by the "Made for you playlists" task, and on first ask.
// Covers in the approved flat look (typecover.ts): an artist from the
// listener's copy cut out of their photo (the brain checks it is a photo and
// cuts it out, once per photo), or a quiet one-colour object.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import type { TaskDef } from './tasks.js';
import { albumGenreMap } from './genres.js';
import { brainOn, brainPhoto, brainSearch, dislikedOf, type SoundHit } from './brain.js';
import { coverArt, photoOf } from './homemixes.js';
import { renderTypeCover, mix, type CoverSpec, type Prop } from './typecover.js';
import { tracksByIds } from './library.js';

const SIZE = 50;
const MIN_SONGS = 10;
const PROPS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'props');
const prop = (name: string) => { try { return fs.readFileSync(path.join(PROPS, `${name}.svg`)); } catch { return null; } };
const CREAM = '#F1EADF';

export type Theme = {
  id: string; title: string; kind: 'genre' | 'mood' | 'decade' | 'season' | 'thisis';
  description: string;
  words: string[];                    // what finds it in search ("rock", "christmas")
  genres?: string[];                  // canonical album genres (genres.ts) its songs come from
  notGenres?: string[];               // never these (a workout without Classical)
  years?: [number, number];
  match?: RegExp;                     // the song's title or album must say so (Christmas)
  text?: string;                      // what the brain listens for (CLAP words)
  season?: [string, string];          // MM-DD to MM-DD, inclusive (wraps the new year)
  color: string;
  look: 'artist' | 'object';
  style?: 'editorial' | 'behind';
  prop?: string;                      // the flat object (assets/props)
  tint?: 'dark' | 'light' | 'cream';
  ornaments?: boolean;
};

const T = (t: Theme) => t;
export const THEMES: Theme[] = [
  // Genres: the shelves of the library, the listener's way.
  T({ id: 'rock', title: 'Rock Classics', kind: 'genre', description: 'Rock legends and the rock you play', words: ['rock', 'rock classics', 'classic rock'], genres: ['Rock'], text: 'classic rock, electric guitars, drums, anthem', color: '#B3261E', look: 'artist', style: 'editorial', prop: 'guitar', tint: 'dark' }),
  T({ id: 'hiphop', title: 'Hip-Hop Hits', kind: 'genre', description: 'The hip-hop you play and more like it', words: ['hip hop', 'hip-hop', 'rap', 'hiphop'], genres: ['Hip-Hop'], text: 'hip hop beat, rap vocals, 808 bass', color: '#1E3264', look: 'artist', style: 'behind', prop: 'studio_microphone', tint: 'light' }),
  T({ id: 'pop', title: 'Pop Hits', kind: 'genre', description: 'Pop, your way', words: ['pop', 'pop hits'], genres: ['Pop', 'K-Pop'], text: 'catchy pop song, upbeat vocals', color: '#DC148C', look: 'artist', style: 'editorial', prop: 'sparkles', tint: 'dark' }),
  T({ id: 'rnb', title: 'R&B Vibes', kind: 'genre', description: 'Smooth R&B', words: ['r&b', 'rnb', 'r and b', 'r n b'], genres: ['R&B'], text: 'smooth r&b, soulful vocals, slow groove', color: '#8C1932', look: 'artist', style: 'behind', prop: 'rose', tint: 'dark' }),
  T({ id: 'electronic', title: 'Electronic Essentials', kind: 'genre', description: 'Synths, beats and everything electronic', words: ['electronic', 'edm', 'electronica'], genres: ['Electronic'], text: 'electronic music, synthesizers, beat', color: '#0D5FC9', look: 'artist', style: 'editorial', prop: 'headphone', tint: 'light' }),
  T({ id: 'dance', title: 'Dance Hits', kind: 'genre', description: 'House, techno and floor fillers', words: ['dance', 'house', 'techno', 'club'], genres: ['Dance'], text: 'dance music, four on the floor, club', color: '#0D73EC', look: 'artist', style: 'editorial', prop: 'mirror_ball', tint: 'light' }),
  T({ id: 'alternative', title: 'Indie & Alternative', kind: 'genre', description: 'Indie and alternative picks', words: ['indie', 'alternative', 'alt'], genres: ['Alternative'], text: 'indie rock, alternative, jangly guitars', color: '#477D95', look: 'artist', style: 'behind', prop: 'optical_disk', tint: 'dark' }),
  T({ id: 'metal', title: 'Metal Essentials', kind: 'genre', description: 'Heavy riffs', words: ['metal', 'heavy metal'], genres: ['Metal'], text: 'heavy metal, distorted guitars, double kick drums', color: '#3A3A3A', look: 'artist', style: 'editorial', prop: 'fire', tint: 'light' }),
  T({ id: 'jazz', title: 'Jazz Classics', kind: 'genre', description: 'Jazz greats and the jazz you play', words: ['jazz'], genres: ['Jazz'], text: 'jazz, saxophone, upright bass, swing', color: '#27856A', look: 'artist', style: 'editorial', prop: 'musical_notes', tint: 'dark' }),
  T({ id: 'classical', title: 'Classical Essentials', kind: 'genre', description: 'The great composers', words: ['classical', 'orchestra', 'piano', 'symphony'], genres: ['Classical'], text: 'classical music, orchestra, strings, piano', color: '#7D4B32', look: 'object', prop: 'violin', tint: 'light' }),
  T({ id: 'country', title: 'Country Hits', kind: 'genre', description: 'Country, old and new', words: ['country'], genres: ['Country'], text: 'country music, twang, acoustic guitar', color: '#BA5D07', look: 'artist', style: 'editorial', prop: 'banjo', tint: 'dark' }),
  T({ id: 'kpop', title: 'K-Pop Hits', kind: 'genre', description: 'K-pop favourites', words: ['k-pop', 'kpop', 'k pop', 'korean'], genres: ['K-Pop'], text: 'k-pop, catchy, bright production', color: '#AF2896', look: 'artist', style: 'behind', prop: 'sparkles', tint: 'light' }),
  T({ id: 'latin', title: 'Latin Hits', kind: 'genre', description: 'Reggaeton, Latin pop and more', words: ['latin', 'reggaeton', 'latino'], genres: ['Latin'], text: 'reggaeton, latin pop, dembow rhythm', color: '#608108', look: 'artist', style: 'editorial', prop: 'sunglasses', tint: 'dark' }),
  T({ id: 'soul', title: 'Soul & Funk Classics', kind: 'genre', description: 'Grooves and soul', words: ['soul', 'funk', 'motown'], genres: ['Soul & Funk'], text: 'soul, funk, groovy bass, horns', color: '#8D67AB', look: 'artist', style: 'editorial', prop: 'trumpet', tint: 'dark' }),
  T({ id: 'soundtrack', title: 'Soundtracks', kind: 'genre', description: 'Film, TV and game scores', words: ['soundtrack', 'score', 'film', 'movie', 'ost'], genres: ['Soundtrack'], text: 'film score, cinematic orchestra', color: '#2E3A59', look: 'object', prop: 'musical_score', tint: 'light' }),
  // Moods: by how songs sound (the brain), not by tags.
  T({ id: 'chill', title: 'Chill Vibes', kind: 'mood', description: 'Kick back', words: ['chill', 'relax', 'calm', 'chill vibes'], notGenres: ['Metal'], text: 'chill, relaxed, mellow, laid back', color: '#477D95', look: 'object', prop: 'palm_tree', tint: 'light' }),
  T({ id: 'workout', title: 'Workout', kind: 'mood', description: 'High energy to keep you going', words: ['workout', 'gym', 'exercise', 'training', 'running'], notGenres: ['Classical', 'Jazz', 'Folk', 'Soundtrack'], text: 'high energy workout music, fast tempo, hard hitting', color: '#E0701B', look: 'artist', style: 'behind', prop: 'high_voltage', tint: 'dark' }),
  T({ id: 'drive', title: 'Late Night Drive', kind: 'mood', description: 'For the road after dark', words: ['drive', 'driving', 'night drive', 'late night', 'car'], notGenres: ['Classical'], text: 'late night drive, moody synths, nocturnal', color: '#1B1F3B', look: 'object', prop: 'automobile', tint: 'light' }),
  T({ id: 'sad', title: 'Sad Songs', kind: 'mood', description: 'For when you need a cry', words: ['sad', 'sad songs', 'heartbreak', 'crying'], text: 'sad, melancholic, heartbreak ballad', color: '#2E3A59', look: 'object', prop: 'broken_heart', tint: 'light' }),
  T({ id: 'happy', title: 'Feel Good', kind: 'mood', description: 'Songs that lift you up', words: ['happy', 'feel good', 'good vibes', 'upbeat'], notGenres: ['Metal'], text: 'happy, upbeat, feel good, sunny', color: '#F59B23', look: 'object', prop: 'sun', tint: 'dark' }),
  T({ id: 'focus', title: 'Deep Focus', kind: 'mood', description: 'Keep calm and focus', words: ['focus', 'study', 'concentration', 'work'], notGenres: ['Hip-Hop', 'Metal'], text: 'instrumental focus music, calm, ambient, no vocals', color: '#5A6B7B', look: 'object', prop: 'books', tint: 'light' }),
  T({ id: 'lofi', title: 'Lofi Beats', kind: 'mood', description: 'Beats to relax and study to', words: ['lofi', 'lo-fi', 'lo fi', 'beats'], text: 'lofi hip hop beats, dusty, mellow, vinyl crackle', color: '#8D67AB', look: 'object', prop: 'headphone', tint: 'dark' }),
  T({ id: 'party', title: 'Party', kind: 'mood', description: 'Turn it up', words: ['party', 'party songs', 'pregame'], notGenres: ['Classical', 'Jazz', 'Folk', 'Soundtrack'], text: 'party anthem, loud, danceable, crowd', color: '#AF2896', look: 'object', prop: 'party_popper', tint: 'light' }),
  T({ id: 'rainy', title: 'Rainy Day', kind: 'mood', description: 'For grey skies', words: ['rain', 'rainy', 'rainy day'], notGenres: ['Metal'], text: 'rainy day, soft, acoustic, cozy, melancholic', color: '#5A6B7B', look: 'object', prop: 'cloud_with_rain', tint: 'light' }),
  T({ id: 'sleep', title: 'Sleep', kind: 'mood', description: 'Gentle songs to drift off to', words: ['sleep', 'sleeping', 'bedtime'], notGenres: ['Metal', 'Hip-Hop', 'Dance'], text: 'very calm, soft, slow, peaceful lullaby, ambient', color: '#1B1F3B', look: 'object', prop: 'crescent_moon', tint: 'cream' }),
  // Decades: the years on the songs.
  T({ id: '70s', title: 'All Out 70s', kind: 'decade', description: 'The 70s, your way', words: ['70s', '1970s', 'seventies'], years: [1970, 1979], color: '#BA5D07', look: 'artist', style: 'editorial', prop: 'radio', tint: 'dark' }),
  T({ id: '80s', title: 'All Out 80s', kind: 'decade', description: 'The 80s, your way', words: ['80s', '1980s', 'eighties'], years: [1980, 1989], color: '#DC148C', look: 'artist', style: 'editorial', prop: 'videocassette', tint: 'dark' }),
  T({ id: '90s', title: 'All Out 90s', kind: 'decade', description: 'The 90s, your way', words: ['90s', '1990s', 'nineties'], years: [1990, 1999], color: '#7D4B32', look: 'artist', style: 'editorial', prop: 'optical_disk', tint: 'dark' }),
  T({ id: '00s', title: '2000s Throwbacks', kind: 'decade', description: 'The 2000s, your way', words: ['2000s', '00s', 'two thousands', 'throwback'], years: [2000, 2009], color: '#8D67AB', look: 'artist', style: 'editorial', prop: 'dvd', tint: 'dark' }),
  T({ id: '10s', title: '2010s Hits', kind: 'decade', description: 'The 2010s, your way', words: ['2010s', '10s', 'twenty tens'], years: [2010, 2019], color: '#0D73EC', look: 'artist', style: 'editorial', prop: 'headphone', tint: 'dark' }),
  // Seasons: only while it is the season.
  T({ id: 'christmas', title: 'Christmas Hits', kind: 'season', description: 'Christmas songs you love and more', words: ['christmas', 'xmas', 'holiday', 'holidays', 'navidad'], match: /\b(christmas|xmas|santa|jingle|sleigh|snowman|mistletoe|rudolph|reindeer|noel|navidad|silent night|holy night|deck the hall|let it snow|winter wonderland|feliz|holiday)/i, text: 'christmas music, sleigh bells, festive', season: ['11-15', '12-26'], color: '#C8102E', look: 'artist', style: 'editorial', ornaments: true }),
  T({ id: 'summer', title: 'Summer Hits', kind: 'season', description: 'The sound of summer', words: ['summer', 'summer hits', 'beach'], text: 'summer, sunny, beach, upbeat', season: ['06-01', '08-31'], notGenres: ['Classical', 'Metal'], color: '#F59B23', look: 'artist', style: 'editorial', prop: 'sun', tint: 'dark' }),
  T({ id: 'halloween', title: 'Halloween', kind: 'season', description: 'Spooky season', words: ['halloween', 'spooky', 'scary'], match: /\b(halloween|spooky|monster|zombie|ghost|witch|haunted|thriller|scream|vampire|werewolf|graveyard|ghostbusters)/i, text: 'spooky, eerie, halloween', season: ['10-01', '10-31'], color: '#E0701B', look: 'object', prop: 'jack_o_lantern', tint: 'dark' }),
];
export const THIS_IS_COUNT = 6;
const THIS_IS_COLORS = ['#509BF5', '#E8115B', '#148A08', '#E13300', '#8D67AB', '#BA5D07'];

export const inSeason = (t: Theme, now = new Date()) => {
  if (!t.season) return true;
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [a, b] = t.season;
  return a <= b ? md >= a && md <= b : md >= a || md <= b;
};
const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// Versions nobody means in a themed playlist (ai.ts's list): instrumentals,
// sped-up edits, karaoke, skits; and holiday songs outside the holiday one.
const ODD = /\b(instrumental|karaoke|a ?cappella|sped[ -]?up|slowed|nightcore|skit|interlude|commentary)\b/i;
const XMAS = /\b(christmas|xmas|santa|jingle|sleigh|mistletoe|rudolph|reindeer|holiday)\b/i;
const LIVE = /[([][^)\]]*\b(live|soundcheck|demo)\b/i;

type Row = { id: string; title: string; album: string; album_id: string; year: number | null; artist_ids: string };
export type Lib = { rows: Row[]; byId: Map<string, Row>; genreOf: Map<string, string>; household: Map<string, number> };
export function loadLib(db: DB): Lib {
  const rows = db.prepare('SELECT id, title, album, album_id, year, artist_ids FROM tracks').all() as Row[];
  const household = new Map((db.prepare('SELECT track_id id, COUNT(*) n FROM plays GROUP BY track_id').all() as { id: string; n: number }[]).map((r) => [r.id, r.n]));
  return { rows, byId: new Map(rows.map((r) => [r.id, r])), genreOf: albumGenreMap(db), household };
}
const firstArtist = (r: Row) => { try { return (JSON.parse(r.artist_ids) as string[])[0] || ''; } catch { return ''; } };
const artistsOf = (r: Row) => { try { return JSON.parse(r.artist_ids) as string[]; } catch { return []; } };

type Listener = { plays: Map<string, number>; liked: Set<string>; disliked: Set<string> };
export function listenerOf(db: DB, uid: string): Listener {
  return {
    plays: new Map((db.prepare('SELECT track_id id, COUNT(*) n FROM plays WHERE user_id = ? GROUP BY track_id').all(uid) as { id: string; n: number }[]).map((r) => [r.id, r.n])),
    liked: new Set((db.prepare('SELECT track_id id FROM likes WHERE user_id = ?').all(uid) as { id: string }[]).map((r) => r.id)),
    disliked: new Set(dislikedOf(db, uid)),
  };
}

// A seeded random: the same picks all day for one listener and theme.
function seeded(key: string) {
  let s = 2166136261;
  for (const c of key) s = Math.imul(s ^ c.charCodeAt(0), 16777619);
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296; };
}

// One listener's copy of a theme: track ids, best first. `sound` is what the
// brain heard for the theme's words, leaning to this listener ([] without one).
export function pickThemeTracks(lib: Lib, me: Listener, theme: Theme, sound: SoundHit[], day: string, size = SIZE): string[] {
  const odd = (r: Row) => ODD.test(r.title) || LIVE.test(r.title) || LIVE.test(r.album) || (theme.id !== 'christmas' && (XMAS.test(r.title) || XMAS.test(r.album)));
  const genreOk = (r: Row) => {
    const g = lib.genreOf.get(r.album_id);
    if (theme.notGenres && g && theme.notGenres.includes(g)) return false;
    return !theme.genres || (!!g && theme.genres.includes(g));
  };
  const yearOk = (r: Row) => !theme.years || (r.year != null && r.year >= theme.years[0] && r.year <= theme.years[1]);
  const matchOk = (r: Row) => !theme.match || theme.match.test(r.title) || theme.match.test(r.album);
  const fits = (r: Row) => !me.disliked.has(r.id) && !odd(r) && genreOk(r) && yearOk(r) && matchOk(r);
  const known = (id: string) => (me.plays.get(id) || 0) > 0 || me.liked.has(id);
  const rand = seeded(`${theme.id}|${day}`);
  const soundRank = new Map(sound.map((h, i) => [h.id, i]));

  // Their own songs that fit, most played and liked first, with some turn
  // over day to day; then songs they play that SOUND like it (top of what
  // the brain heard) even if tagged otherwise ("close to rock").
  const ownScore = (id: string) => (me.plays.get(id) || 0) + (me.liked.has(id) ? 6 : 0);
  // A mood has no tag to go by: their songs count only when the brain says
  // they sound like it (in the order it heard them), never all they play.
  const byTag = !!(theme.genres || theme.years || theme.match);
  const own = byTag
    ? lib.rows.filter((r) => known(r.id) && fits(r))
      .map((r) => ({ id: r.id, k: Math.log(rand() || 1e-9) / Math.max(1, ownScore(r.id)) })).sort((a, b) => b.k - a.k).map((x) => x.id)
    : sound.slice(0, 250).filter((h) => known(h.id)).map((h) => lib.byId.get(h.id)).filter((r): r is Row => !!r && fits(r)).map((r) => r.id);
  const close = theme.genres ? sound.slice(0, 120).filter((h) => known(h.id)).map((h) => lib.byId.get(h.id)).filter((r): r is Row => !!r && !me.disliked.has(r.id) && !odd(r) && yearOk(r) && matchOk(r) && !own.includes(r.id)).map((r) => r.id) : [];
  // New to them: what the brain heard that fits, in its order; without a
  // brain (or for themes it cannot hear, decades), the household's favourites
  // that fit, shuffled a little by the day.
  let fresh = sound.map((h) => lib.byId.get(h.id)).filter((r): r is Row => !!r && !known(r.id) && fits(r)).map((r) => r.id);
  if (fresh.length < size) {
    const more = lib.rows.filter((r) => !known(r.id) && fits(r) && !soundRank.has(r.id))
      .map((r) => ({ id: r.id, k: Math.log(rand() || 1e-9) / (1 + Math.min(lib.household.get(r.id) || 0, 30)) })).sort((a, b) => b.k - a.k).map((x) => x.id);
    fresh = [...fresh, ...more];
  }
  // Theirs and new, interleaved: about two in five theirs when they have enough.
  const mine = [...own, ...close];
  const out: string[] = [];
  const perArtist = new Map<string, number>();
  const take = (id: string) => {
    if (out.includes(id)) return false;
    const a = firstArtist(lib.byId.get(id)!);
    if ((perArtist.get(a) || 0) >= 4) return false;
    perArtist.set(a, (perArtist.get(a) || 0) + 1); out.push(id); return true;
  };
  let i = 0, j = 0;
  while (out.length < size && (i < mine.length || j < fresh.length)) {
    const wantMine = out.length % 5 === 1 || out.length % 5 === 3;
    if ((wantMine && i < mine.length) || j >= fresh.length) take(mine[i++]); else take(fresh[j++]);
  }
  return out;
}

// This Is <artist>: their best songs, by the household's plays and this
// listener's own plays and likes.
export function pickThisIs(lib: Lib, me: Listener, artistId: string, size = 40): string[] {
  return lib.rows.filter((r) => artistsOf(r)[0] === artistId && !me.disliked.has(r.id) && !ODD.test(r.title) && !LIVE.test(r.title) && !LIVE.test(r.album))
    .map((r) => ({ id: r.id, title: r.title.toLowerCase().replace(/\s*[([].*$/, ''), s: (lib.household.get(r.id) || 0) + 2 * (me.plays.get(r.id) || 0) + (me.liked.has(r.id) ? 10 : 0) }))
    .sort((a, b) => b.s - a.s)
    .filter((x, k, all) => all.findIndex((y) => y.title === x.title) === k) // one copy of a song
    .slice(0, size).map((x) => x.id);
}

// ---- artist photos ----------------------------------------------------------
// The brain's verdict on each artist photo, kept: a photo of them (with the
// person cut out, cutouts/<hash>.png), or their album cover, a logo, a drawing.
const cutoutPath = (cacheDir: string, hash: string) => path.join(cacheDir, 'cutouts', `${hash}.png`);
export async function checkPhoto(db: DB, cacheDir: string, hash: string, opts: { log?: (m: string) => void } = {}): Promise<{ ok: boolean; cutout: Buffer | null } | null> {
  const row = db.prepare('SELECT kind, photo, cutout FROM artist_photos WHERE image_hash = ?').get(hash) as { kind: string; photo: number; cutout: number } | undefined;
  if (row) {
    const ok = row.photo >= 0.6;
    let cut: Buffer | null = null;
    if (row.cutout) try { cut = fs.readFileSync(cutoutPath(cacheDir, hash)); } catch { /* file gone: ask again below */ }
    if (!row.cutout || cut) return { ok, cutout: cut };
  }
  const img = photoOf(cacheDir, hash);
  if (!img) return null;
  const r = await brainPhoto(db, img, { log: opts.log });
  if (!r) return null; // no brain right now: ask again next time
  if (r.cutout) { fs.mkdirSync(path.join(cacheDir, 'cutouts'), { recursive: true }); fs.writeFileSync(cutoutPath(cacheDir, hash), r.cutout); }
  db.prepare('INSERT OR REPLACE INTO artist_photos (image_hash, kind, photo, cutout, checked) VALUES (?, ?, ?, ?, ?)').run(hash, r.kind, r.photo, r.cutout ? 1 : 0, Date.now());
  return { ok: r.photo >= 0.6, cutout: r.cutout };
}

// ---- covers -----------------------------------------------------------------
// A cut-out person worth a cover: they fill a fair part of their photo (a
// figure far off in a landscape is a speck once it is cut out).
async function bigEnough(cutout: Buffer) {
  const { data } = await sharp(cutout).ensureAlpha().extractChannel(3).resize(64, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let on = 0, top = 64;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (data[y * 64 + x] > 128) { on++; top = Math.min(top, y); }
  return on / 4096 >= 0.12 && top <= 32;
}
const tintOf = (bg: string, t: Theme['tint']) => t === 'cream' ? CREAM : t === 'light' ? mix(bg, '#FFFFFF', 0.22) : mix(bg, '#000000', 0.28);
export async function themeCover(db: DB, cacheDir: string, theme: Theme, artists: string[], day: string, opts: { log?: (m: string) => void; thisIs?: string } = {}): Promise<string | null> {
  const bg = theme.color;
  const p = theme.prop ? prop(theme.prop) : null;
  const imageOf = (id: string) => (db.prepare('SELECT image_hash FROM artists WHERE id = ?').get(id) as { image_hash: string | null } | undefined)?.image_hash ?? null;
  // The artist on it: the first few of the listener's copy that have a real
  // photo the brain could cut out, a different one by the day.
  let cut: { hash: string; cutout: Buffer } | null = null;
  if (theme.look === 'artist' || opts.thisIs) {
    const ok: { hash: string; cutout: Buffer }[] = [];
    for (const a of (opts.thisIs ? [opts.thisIs] : artists).slice(0, 8)) {
      const h = imageOf(a); if (!h) continue;
      const c = await checkPhoto(db, cacheDir, h, opts);
      if (c?.ok && c.cutout && await bigEnough(c.cutout)) ok.push({ hash: h, cutout: c.cutout });
      if (ok.length >= 3) break;
    }
    if (ok.length) cut = ok[Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000) % ok.length];
  }
  const props: Prop[] = [];
  let spec: CoverSpec;
  if (opts.thisIs) {
    const name = (db.prepare('SELECT name FROM artists WHERE id = ?').get(opts.thisIs) as { name: string } | undefined)?.name ?? theme.title;
    // No photo to cut them out of: a microphone instead of an empty square.
    const mic = cut ? null : prop('studio_microphone');
    spec = { title: name, style: 'thisis', color: bg, cutout: cut?.cutout, props: mic ? [{ img: mic, x: 0.62, y: 0.72, size: 0.62, rot: -12, tint: mix(bg, '#000000', 0.25) }] : undefined };
  } else if (cut) {
    if (theme.ornaments) props.push({ hang: true, size: 0.17, tint: mix(bg, '#000000', 0.28) }, { hang: true, size: 0.13, tint: mix(bg, '#000000', 0.28) });
    else if (p) props.push({ img: p, size: 0.26, rot: -10, tint: tintOf(bg, theme.tint) });
    spec = { title: theme.title, style: theme.style ?? 'editorial', color: bg, cutout: cut.cutout, props };
  } else {
    // No photo to cut out (or an object theme): the object, big, or the ornaments.
    if (theme.ornaments) props.push({ hang: true, x: 0.64, y: 0.7, size: 0.42, tint: CREAM }, { hang: true, x: 0.22, y: 0.78, size: 0.2, tint: mix(bg, '#FFFFFF', 0.22) });
    else if (p) props.push({ img: p, x: 0.64, y: 0.72, size: 0.7, rot: -10, tint: tintOf(bg, theme.tint) });
    spec = { title: theme.title, style: 'object', color: bg, props };
  }
  const look = ['made', 2, theme.id, opts.thisIs ?? null, bg, cut?.hash ?? null, theme.prop ?? null, theme.ornaments ?? false, spec.style, spec.title, (spec.props || []).length];
  return coverArt(db, cacheDir, look, () => renderTypeCover(spec));
}

// ---- building ---------------------------------------------------------------
export type Made = { id: string; title: string; kind: Theme['kind']; description: string; color: string; art: string | null; count: number; artists: { id: string; name: string }[] };
const themeOf = (id: string) => THEMES.find((t) => t.id === id);
const thisIsTheme = (artistId: string, name: string): Theme => ({ id: `thisis:${artistId}`, title: `This Is ${name}`, kind: 'thisis', description: `The essential ${name}`, words: [name.toLowerCase(), `this is ${name.toLowerCase()}`], color: THIS_IS_COLORS[[...artistId].reduce((n, c) => n + c.charCodeAt(0), 0) % THIS_IS_COLORS.length], look: 'artist' });

// Everything for one listener, saved. Themes out of season are dropped; a
// theme with too few songs for them is left out until it has enough.
export async function buildForListener(db: DB, cacheDir: string, uid: string, opts: { lib?: Lib; now?: number; search?: (text: string, n: number) => Promise<SoundHit[]>; log?: (m: string) => void; covers?: boolean } = {}) {
  const now = opts.now ?? Date.now();
  const day = dayOf(now);
  const lib = opts.lib ?? loadLib(db);
  const me = listenerOf(db, uid);
  const search = opts.search ?? ((text: string, n: number) => brainSearch(db, { user: uid, text, n }, { log: opts.log }));
  const save = db.prepare('INSERT OR REPLACE INTO made_playlists (user_id, theme, day, built, track_ids, artists, art) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const keep = new Set<string>();
  const ranked = (ids: string[]) => {
    const n = new Map<string, number>();
    for (const id of ids) { const r = lib.byId.get(id); const a = r && firstArtist(r); if (a) n.set(a, (n.get(a) || 0) + 1 + Math.min(me.plays.get(id) || 0, 5)); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  };
  for (const theme of THEMES) {
    if (!inSeason(theme, new Date(now))) continue;
    const sound = theme.text ? await search(theme.text, 400).catch(() => []) : [];
    // A mood is only what songs sound like: without the brain to hear them
    // there is nothing to go on, so no Chill Vibes of random songs.
    if (theme.kind === 'mood' && !sound.length) continue;
    const ids = pickThemeTracks(lib, me, theme, sound, day);
    if (ids.length < MIN_SONGS) continue;
    const artists = ranked(ids);
    const art = opts.covers === false ? null : await themeCover(db, cacheDir, theme, artists, day, { log: opts.log }).catch(() => null);
    save.run(uid, theme.id, day, now, JSON.stringify(ids), JSON.stringify(artists.slice(0, 6)), art);
    keep.add(theme.id);
  }
  // This Is: the listener's most played artists (by the first credit).
  const top = db.prepare(`SELECT a.id, a.name FROM (SELECT json_extract(t.artist_ids, '$[0]') id, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id
      WHERE p.user_id = ? GROUP BY 1 ORDER BY n DESC LIMIT ?) x JOIN artists a ON a.id = x.id WHERE a.name NOT IN ('Various Artists', 'Unknown Artist', '')`).all(uid, THIS_IS_COUNT + 4) as { id: string; name: string }[];
  let made = 0;
  for (const a of top) {
    if (made >= THIS_IS_COUNT) break;
    const ids = pickThisIs(lib, me, a.id);
    if (ids.length < 10) continue;
    const theme = thisIsTheme(a.id, a.name); made++;
    const art = opts.covers === false ? null : await themeCover(db, cacheDir, theme, [a.id], day, { log: opts.log, thisIs: a.id }).catch(() => null);
    save.run(uid, theme.id, day, now, JSON.stringify(ids), JSON.stringify([a.id]), art);
    keep.add(theme.id);
  }
  // What is no longer theirs (out of season, too few songs, no longer a top artist).
  for (const r of db.prepare('SELECT theme FROM made_playlists WHERE user_id = ?').all(uid) as { theme: string }[]) {
    if (!keep.has(r.theme)) db.prepare('DELETE FROM made_playlists WHERE user_id = ? AND theme = ?').run(uid, r.theme);
  }
  return keep.size;
}

// A listener's saved playlists, in Spotify's order: the season's first, then
// This Is, genres by how much they play them, moods, decades.
export function listMade(db: DB, uid: string, now = Date.now()): Made[] {
  const rows = db.prepare('SELECT theme, track_ids, artists, art FROM made_playlists WHERE user_id = ?').all(uid) as { theme: string; track_ids: string; artists: string; art: string | null }[];
  const name = (id: string) => (db.prepare('SELECT name FROM artists WHERE id = ?').get(id) as { name: string } | undefined)?.name;
  const order = { season: 0, thisis: 1, genre: 2, mood: 3, decade: 4 } as const;
  const out: (Made & { o: number })[] = [];
  for (const r of rows) {
    const ids = JSON.parse(r.track_ids) as string[];
    const artists = (JSON.parse(r.artists) as string[]).map((id) => ({ id, name: name(id) })).filter((a): a is { id: string; name: string } => !!a.name);
    if (r.theme.startsWith('thisis:')) {
      const a = artists[0]; if (!a) continue;
      out.push({ id: r.theme, title: `This Is ${a.name}`, kind: 'thisis', description: `The essential ${a.name}`, color: THIS_IS_COLORS[[...a.id].reduce((n, c) => n + c.charCodeAt(0), 0) % THIS_IS_COLORS.length], art: r.art, count: ids.length, artists, o: order.thisis });
      continue;
    }
    const t = themeOf(r.theme);
    if (!t || !inSeason(t, new Date(now))) continue;
    out.push({ id: t.id, title: t.title, kind: t.kind, description: t.description, color: t.color, art: r.art, count: ids.length, artists: artists.slice(0, 3), o: order[t.kind] * 1000 + ids.length * -1 + THEMES.indexOf(t) / 100 });
  }
  return out.sort((a, b) => a.o - b.o).map((m) => { const { o, ...rest } = m; void o; return rest; });
}

// Search: the playlists whose words the query is (or starts like).
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();
export function searchMade(made: Made[], q: string): Made[] {
  const n = norm(q);
  if (n.length < 2) return [];
  return made.filter((m) => {
    const t = themeOf(m.id);
    const words = t ? t.words : [m.title.toLowerCase().replace(/^this is /, '')];
    return words.some((w) => { const nw = norm(w); return nw === n || nw.startsWith(n) || (n.length >= 4 && n.startsWith(nw)); }) || norm(m.title).startsWith(n);
  });
}

// ---- API and the daily task -------------------------------------------------
export function registerMadeForYou(app: FastifyInstance, db: DB, cacheDir: string) {
  const auth = { preHandler: (app as any).requireUser };
  const log = (m: string) => app.log.info(m);
  const building = new Map<string, Promise<number>>();
  // First look of the day (or ever): built behind the scenes, the old ones
  // answer meanwhile; nobody waits on the brain.
  const ensure = (uid: string) => {
    const r = db.prepare('SELECT MAX(day) d FROM made_playlists WHERE user_id = ?').get(uid) as { d: string | null };
    if (r.d === dayOf() || building.has(uid)) return building.get(uid) ?? null;
    const job = buildForListener(db, cacheDir, uid, { log }).catch((e) => { log(`made for you: ${e?.message || e}`); return 0; }).finally(() => building.delete(uid));
    building.set(uid, job);
    return job;
  };
  (app as any).madeSearch = (uid: string, q: string) => searchMade(listMade(db, uid), q);
  app.get('/api/made', auth, async (req) => {
    const uid = (req as any).user.id as string;
    const job = ensure(uid);
    // Nothing yet at all: worth waiting a little for the first build.
    if (job && !(db.prepare('SELECT 1 FROM made_playlists WHERE user_id = ? LIMIT 1').get(uid))) await Promise.race([job, new Promise((r) => setTimeout(r, 20000))]);
    return { items: listMade(db, uid), building: building.has(uid) };
  });
  app.get('/api/made/:id', auth, async (req, reply) => {
    const uid = (req as any).user.id as string;
    const id = String((req.params as any).id || '').slice(0, 80);
    const m = listMade(db, uid).find((x) => x.id === id);
    const row = db.prepare('SELECT track_ids FROM made_playlists WHERE user_id = ? AND theme = ?').get(uid, id) as { track_ids: string } | undefined;
    if (!m || !row) return reply.code(404).send({ error: 'not found' });
    return { ...m, items: tracksByIds(db, JSON.parse(row.track_ids)) };
  });
}

export function madeForYouTask(app: FastifyInstance, db: DB, cacheDir: string): TaskDef {
  return {
    id: 'madeforyou', name: 'Made for you playlists', schedule: { mode: 'daily', at: '04:30' },
    description: "Build each listener's themed playlists (Rock Classics, Chill Vibes, 90s Hits, This Is ...) and their covers",
    run: async (ctx) => {
      const users = (db.prepare('SELECT DISTINCT user_id id FROM plays WHERE at > ?').all(Date.now() - 90 * 86400000) as { id: string }[]).map((u) => u.id);
      const lib = loadLib(db);
      let n = 0;
      for (const [i, u] of users.entries()) {
        ctx.step(`listener ${i + 1} of ${users.length}`, i / Math.max(1, users.length));
        n += await buildForListener(db, cacheDir, u, { lib, log: ctx.log }).catch((e) => { ctx.log(String(e?.message || e)); return 0; });
      }
      return `${n} playlists for ${users.length} listeners${brainOn(db) ? '' : ' (no brain: by tags and plays only)'}`;
    },
  };
}
