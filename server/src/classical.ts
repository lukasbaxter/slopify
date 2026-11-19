// Classical music: the same piece, told apart from a different one.
//
// Spotify credits a classical track to its composer and names it in full
// ("Nocturne No. 2 in E-Flat Major, Op. 9 No. 2"). A library file usually
// has the performer as artist ("Arthur Rubinstein", "Royal Philharmonic
// Orchestra"), the composer in another script ("Пётр Ильич Чайковский") and
// a shorter title ("Nocturne in E-flat, Op. 9/2"). Title + artist matching
// misses all of these, so a composer's song gets matched by the work.
//
// The flow:
//   1. composerOf(artist) says whether a song is classical at all: its
//      artist is a composer from the table below. Everything else keeps the
//      normal matching untouched.
//   2. parseWork(title) pulls out what identifies the piece: catalog numbers
//      (Op. 9, BWV 1007, K. 545, L. 75...), "No." numbers and movements,
//      the key, and the name words ("nocturne", "clair lune").
//   3. sameWork(a, b) says two titles are the same piece: nothing that
//      identifies them disagrees, and the name words line up.
//   4. matchClassical() looks through the library for such a track, and
//      only takes one by another performer when there is enough to go on
//      (the composer named somewhere on it, a shared catalog number, or a
//      long shared name like "Carnival of the Animals: The Swan").
//
// The table is built in: nothing to configure. A composer missing here just
// gets the normal matching; add a line to cover them.
import type { DB } from './db.js';

// Lower case, no accents, single spaces. Cyrillic survives (й -> и, both
// sides get the same treatment).
export const fold = (s: string) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[‐‑‒–—―]/g, '-').replace(/[^\p{L}\p{N}#\-:;,./()[\]]+/gu, ' ').replace(/\s+/g, ' ').trim();

// One line per composer: the name used in searches first, then every way a
// tag or a catalog spells them (MusicBrainz, Spotify, Deezer, the original
// script). A spelling is matched as whole words, so a surname that is also
// an everyday word ("Part", "Barber", "Glass", "Field") only counts with the
// first name.
const COMPOSERS: string[][] = [
  ['Bach', 'Johann Sebastian Bach', 'J.S. Bach', 'JS Bach', 'Иоганн Себастьян Бах'],
  ['Beethoven', 'Ludwig van Beethoven', 'Бетховен'],
  ['Mozart', 'Wolfgang Amadeus Mozart', 'Моцарт'],
  ['Chopin', 'Frédéric Chopin', 'Fryderyk Chopin', 'Frederic Chopin', 'Шопен'],
  ['Debussy', 'Claude Debussy', 'Дебюсси'],
  ['Ravel', 'Maurice Ravel', 'Равель'],
  ['Satie', 'Erik Satie', 'Эрик Сати'],
  ['Saint-Saëns', 'Camille Saint-Saëns', 'Saint-Saens', 'Сен-Санс'],
  ['Fauré', 'Gabriel Fauré', 'Faure'],
  ['Bizet', 'Georges Bizet', 'Бизе'],
  ['Berlioz', 'Hector Berlioz', 'Берлиоз'],
  ['Massenet', 'Jules Massenet'],
  ['Offenbach', 'Jacques Offenbach'],
  ['Tchaikovsky', 'Pyotr Ilyich Tchaikovsky', 'Peter Ilyich Tchaikovsky', 'Tchaikovski', 'Tschaikowsky', 'Čajkovskij', 'Чайковский'],
  ['Rachmaninoff', 'Sergei Rachmaninoff', 'Sergei Rachmaninov', 'Rachmaninov', 'Rakhmaninov', 'Рахманинов'],
  ['Prokofiev', 'Sergei Prokofiev', 'Prokofieff', 'Прокофьев'],
  ['Shostakovich', 'Dmitri Shostakovich', 'Schostakowitsch', 'Шостакович'],
  ['Stravinsky', 'Igor Stravinsky', 'Strawinsky', 'Стравинский'],
  ['Rimsky-Korsakov', 'Nikolai Rimsky-Korsakov', 'Римский-Корсаков'],
  ['Mussorgsky', 'Modest Mussorgsky', 'Moussorgsky', 'Мусоргский'],
  ['Borodin', 'Alexander Borodin', 'Бородин'],
  ['Scriabin', 'Alexander Scriabin', 'Skryabin', 'Скрябин'],
  ['Khachaturian', 'Aram Khachaturian', 'Хачатурян'],
  ['Liszt', 'Franz Liszt', 'Liszt Ferenc', 'Ференц Лист'],
  ['Bartók', 'Béla Bartók', 'Bartok'],
  ['Schubert', 'Franz Schubert', 'Шуберт'],
  ['Schumann', 'Robert Schumann', 'Шуман'],
  ['Clara Schumann'],
  ['Brahms', 'Johannes Brahms', 'Брамс'],
  ['Mendelssohn', 'Felix Mendelssohn', 'Felix Mendelssohn Bartholdy', 'Мендельсон'],
  ['Wagner', 'Richard Wagner', 'Вагнер'],
  ['Mahler', 'Gustav Mahler', 'Малер'],
  ['Bruckner', 'Anton Bruckner'],
  ['Richard Strauss'],
  ['Johann Strauss', 'Johann Strauss II', 'Johann Strauss Jr.'],
  ['Haydn', 'Joseph Haydn', 'Franz Joseph Haydn', 'Гайдн'],
  ['Handel', 'George Frideric Handel', 'Georg Friedrich Händel', 'Händel', 'Гендель'],
  ['Vivaldi', 'Antonio Vivaldi', 'Вивальди'],
  ['Pachelbel', 'Johann Pachelbel'],
  ['Albinoni', 'Tomaso Albinoni'],
  ['Purcell', 'Henry Purcell'],
  ['Telemann', 'Georg Philipp Telemann'],
  ['Scarlatti', 'Domenico Scarlatti'],
  ['Paganini', 'Niccolò Paganini', 'Niccolo Paganini'],
  ['Rossini', 'Gioachino Rossini'],
  ['Verdi', 'Giuseppe Verdi', 'Верди'],
  ['Puccini', 'Giacomo Puccini', 'Пуччини'],
  ['Grieg', 'Edvard Grieg', 'Григ'],
  ['Sibelius', 'Jean Sibelius'],
  ['Dvořák', 'Antonín Dvořák', 'Antonin Dvorak', 'Dvorak', 'Дворжак'],
  ['Smetana', 'Bedřich Smetana', 'Bedrich Smetana'],
  ['Elgar', 'Edward Elgar'],
  ['Holst', 'Gustav Holst'],
  ['Vaughan Williams', 'Ralph Vaughan Williams'],
  ['Samuel Barber'],
  ['Gershwin', 'George Gershwin'],
  ['Copland', 'Aaron Copland'],
  ['Orff', 'Carl Orff'],
  ['Arvo Pärt', 'Arvo Part'],
  ['Górecki', 'Henryk Górecki', 'Henryk Mikołaj Górecki'],
  ['Philip Glass'],
  ['Einaudi', 'Ludovico Einaudi'],
];

type Composer = { name: string; spellings: string[] };
const TABLE: Composer[] = COMPOSERS.map(([name, ...rest]) => ({ name, spellings: [name, ...rest].map((s) => fold(s).replace(/[.-]/g, ' ').replace(/\s+/g, ' ')) }));
const words = (s: string) => ` ${fold(s).replace(/[^\p{L}\p{N}#]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
const has = (hay: string, spelling: string) => hay.includes(` ${spelling} `);

// The composer an artist credit names, if it is one (the whole credit or a
// part of it: "Frédéric Chopin; Maurizio Pollini").
export function composerOf(artist: string): Composer | null {
  const a = words(artist);
  return TABLE.find((c) => c.spellings.some((s) => has(a, s))) ?? null;
}
// Every composer named anywhere in some text (a track's artists, album, title).
function composersIn(text: string): Composer[] {
  const a = words(text);
  return TABLE.filter((c) => c.spellings.some((s) => has(a, s)));
}

// --- what identifies a piece ----------------------------------------------------
// `words` are compared (singular: "nocturnes" = "nocturne"); `name` keeps them as written, for searches.
export type Work = { catalog: Map<string, string>; nums: Set<string>; key: string; words: Set<string>; name: string[] };

const CATALOG: Record<string, string> = { op: 'op', opus: 'op', bwv: 'bwv', k: 'k', kv: 'k', l: 'l', cd: 'l', s: 's', r: 'r', th: 'th', m: 'm', d: 'd', hob: 'hob', rv: 'rv', hwv: 'hwv', woo: 'woo', b: 'b', fs: 'fs', sz: 'sz', trv: 'trv' };
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
// Words that say nothing about which piece it is: tempo markings, keys,
// counting, filler in the usual languages of classical titles.
const STOP = new Set(`a an and the of in for from with by on to at
  de des du la le les l d di da del della e el en et y und der die das im am zu von
  op opus no nr nos num act acte akt scene vol volume part pt book livre heft
  major minor dur moll flat sharp
  allegro allegretto andante andantino adagio adagietto moderato presto prestissimo largo larghetto lento vivace grave
  maestoso sostenuto cantabile espressivo expressif tres molto poco piu meno assai ma non troppo con moto mosso quasi
  sehr langsam massig rasch lebhaft tempo animato agitato tranquillo dolce scherzando giocoso risoluto lent modere vif
  one two three four five six seven eight nine ten eleven twelve un deux trois quatre cinq six sept huit neuf dix
  arr arranged arrangement version remastered remaster live recorded recording excerpt excerpts`.split(/\s+/).filter(Boolean));

// Endings that say how this recording was made, not what was played:
// " - Arranged for Cello and Harp", "(Live)", "- Remastered 2015".
const HOW = /\b(arr|arranged|arrangement|transcri\w*|version|remaster\w*|live|recorded|edit|soundtrack)\b|from the|from "|piano solo/;
// A composer's spelling inside a title, as whole words, punctuation kept around it.
const spellingRe = (s: string) => new RegExp(`(?<![\\p{L}])${s.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s.\\-]+')}(?![\\p{L}])`, 'gu');

export function parseWork(title: string): Work {
  let t = fold(title);
  t = t.replace(/\s+-\s+(.*)$/, (m, rest) => (HOW.test(rest) ? '' : ` ${rest}`));
  t = t.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (m, a, b) => (HOW.test(a || b || '') ? ' ' : ` ${a || b} `));
  t = t.replace(/(?<![\p{L}])arr(?:anged)?\.?\s+(?:by\s+)?[\p{L}-]+/gu, ' '); // "Massenet / Arr. Parhamovsky: Thaïs"
  // A composer named in the title ("Tchaikovsky: The Nutcracker") is not part of the piece's name.
  for (const c of composersIn(t)) for (const s of c.spellings) t = t.replace(spellingRe(s), ' ');
  t = ` ${t} `;
  const catalog = new Map<string, string>();
  // Catalog numbers. A one-letter catalog needs its dot ("K. 545", "S. 541"):
  // "Chopin's 2 Nocturnes" is not S. 2.
  const cat = (m: string, kind: string, n: string) => { catalog.set(CATALOG[kind], n); return ' '; };
  t = t.replace(/(?<![\p{L}\p{N}])(opus|op|bwv|kv|cd|th|hob|rv|hwv|woo|fs|sz|trv)\.?\s*(posth|[0-9]+[a-z]?)(?![\p{L}\p{N}])/gu, cat);
  t = t.replace(/(?<![\p{L}\p{N}])(k|l|s|r|m|d|b)\.\s*([0-9]+[a-z]?)(?![\p{L}\p{N}])/gu, cat);
  let key = '';
  t = t.replace(/(?<![\p{L}])([a-h])(?:\s*-?\s*(flat|sharp|#|b))?\s+(major|minor|dur|moll)(?![\p{L}])/gu, (m, note, acc, mode) => {
    key = `${note}${acc === 'flat' || acc === 'b' ? 'b' : acc ? '#' : ''}:${/minor|moll/.test(mode) ? 'minor' : 'major'}`; return ' ';
  });
  t = t.replace(/(?<![\p{L}])(act|akt|acte|vol|volume|book|part|pt)\.?\s+([0-9]+|[ivx]+)(?![\p{L}\p{N}])/gu, ' ');
  // Numbers keep a letter: "No. 14a" (the Pas de deux's opening) is not "No. 14".
  const nums = new Set<string>();
  t = t.replace(/(?<![\p{L}])(?:no|nr|nos|num|variation|var)\.?\s*([0-9]+[a-z]?)(?![\p{L}\p{N}])/gu, (m, n) => { nums.add(n); return ' '; });
  // Movements: "IV. Adagietto", ": 2. Adagio sostenuto", "VI. Valse"; also "/ 3" (Liebestraum S. 541/3).
  t = t.replace(/(?<![\p{L}\p{N}])([ivx]{1,5})\.(?=\s|$)/gu, (m, r) => { if (ROMAN[r]) nums.add(String(ROMAN[r])); return ' '; });
  t = t.replace(/[:,]\s*([0-9]{1,2})\.(?=\s)/g, (m, n) => { nums.add(String(Number(n))); return ' '; });
  t = t.replace(/\/\s*([0-9]{1,2})(?![0-9])/g, (m, n) => { nums.add(String(Number(n))); return ' '; });
  const w = new Set<string>(); const name: string[] = [];
  for (const x of t.replace(/[^\p{L}#]+/gu, ' ').split(' ')) {
    if (x.length < 2 || STOP.has(x)) continue;
    if (!name.includes(x)) name.push(x);
    w.add(x.length > 4 && x.endsWith('s') ? x.slice(0, -1) : x); // "Nocturnes" = "Nocturne"
  }
  return { catalog, nums, key, words: w, name };
}

const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every((x) => b.has(x));

// Whether a library title `b` is the piece a wanted title `a` names:
//   - nothing that identifies them disagrees: catalog numbers of the same
//     kind, the key;
//   - the numbers `a` names are exactly `b`'s ("No. 2 ... I. Moderato" is
//     not the second movement). A plain "Clair de lune" names no number, so
//     any Clair de lune will do;
//   - `a`'s name words are all in `b`. Or `b` is the shorter title ("III.
//     Finale") and its album (`albumWords`) fills in most of the rest
//     ("Cello Concerto in B minor"): titles on Spotify often carry more
//     words than the file's.
// `catalog` and `words` say how much they share, for the caller to decide
// whether that is enough on its own.
export function sameWork(a: Work, b: Work, albumWords: Set<string> = new Set()): { same: boolean; catalog: boolean; words: number } {
  const no = { same: false, catalog: false, words: 0 };
  let catalog = false;
  for (const [kind, n] of a.catalog) {
    const m = b.catalog.get(kind);
    if (m == null) continue;
    if (m !== n) return no;
    catalog = true;
  }
  if (a.key && b.key && a.key !== b.key) return no;
  if (a.nums.size && (a.nums.size !== b.nums.size || !subset(a.nums, b.nums))) return no;
  const shared = [...a.words].filter((x) => b.words.has(x)).length;
  if (!shared) return no;
  if (!subset(a.words, b.words)) {
    if (!subset(b.words, a.words)) return no;
    const covered = [...a.words].filter((x) => b.words.has(x) || albumWords.has(x)).length;
    if (covered / a.words.size < 0.6) return no;
  }
  return { same: true, catalog, words: shared };
}

// --- finding it in the library -------------------------------------------------
type Song = { title: string; artist: string; album?: string };

// A library track that is the same piece as a composer's song, or null.
// Any performer counts, as long as there is enough to go on: the composer
// named on the track (artist, album or title), or else a shared catalog
// number with two name words, or three name words ("Carnival of the
// Animals: The Swan"). A track that names a different composer is never
// taken. "Nocturne, Op. 9 No. 2" alone is not enough: John Field wrote one.
export function matchClassical(db: DB, song: Song): string | null {
  const composer = composerOf(song.artist);
  if (!composer) return null;
  const want = parseWork(song.title);
  if (!want.words.size) return null;
  const q = db.prepare('SELECT t.id, t.title, t.artist, t.artists, t.album, t.album_artist FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH ? LIMIT 400');
  const fts = (ws: string[]) => ws.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
  const ws = [...want.words];
  let rows: any[] = [];
  try { rows = q.all(fts(ws)); } catch { /* odd characters: no candidates */ }
  if (!rows.length && ws.length > 1) { try { rows = q.all(fts([ws.sort((x, y) => y.length - x.length)[0]])); } catch { /* none */ } }
  const album = song.album ? fold(song.album) : '';
  let best: { id: string; score: number } | null = null;
  for (const r of rows) {
    const named = composersIn([r.artist, ...JSON.parse(r.artists || '[]'), r.album_artist, r.album, r.title].join(' ; '));
    if (named.some((c) => c !== composer)) continue; // someone else's piece
    const m = sameWork(want, parseWork(r.title), parseWork(r.album || '').words);
    if (!m.same) continue;
    const byComposer = named.includes(composer);
    if (!byComposer && !(m.catalog && m.words >= 2) && m.words < 3) continue;
    const score = (album && fold(r.album) === album ? 4 : 0) + (byComposer ? 2 : 0) + (m.catalog ? 1 : 0) + m.words / 10;
    if (!best || score > best.score) best = { id: r.id, score };
  }
  return best?.id ?? null;
}

// --- asking for it ----------------------------------------------------------------
// The searches that find a composer's album in Lidarr. MusicBrainz files
// classical albums under the performer or the composer's own spelling
// ("Fryderyk Chopin"), and Spotify's album name often starts with the
// composer ("Chopin: Nocturnes"), so "Frédéric Chopin Chopin: Nocturnes"
// finds nothing useful. Short searches by surname work: the album first,
// then the piece itself.
export function classicalSearches(song: Song): { q: string; want: Work }[] {
  const composer = composerOf(song.artist);
  if (!composer) return [];
  const out: { q: string; want: Work }[] = [];
  // A few words search best: Lidarr's lookup finds nothing for a whole Spotify title.
  const name = (w: Work) => w.name.slice(0, 4).join(' ');
  if (song.album) {
    const a = parseWork(song.album);
    if (a.words.size) out.push({ q: `${composer.name} ${name(a)}`, want: a });
  }
  const t = parseWork(song.title);
  if (t.words.size && !out.some((o) => o.q === `${composer.name} ${name(t)}`)) out.push({ q: `${composer.name} ${name(t)}`, want: t });
  return out;
}

// Whether a Lidarr search result is that composer's album of that name: by
// the composer (any spelling) or naming them, and the album's name words all
// in the result's title (the result may hold more pieces besides).
export function isComposerAlbum(song: Song, want: Work, hit: { artist: string; title: string }): boolean {
  const composer = composerOf(song.artist);
  if (!composer) return false;
  const named = composersIn(`${hit.artist} ; ${hit.title}`);
  if (!named.includes(composer)) return false;
  const got = parseWork(hit.title);
  return subset(want.words, got.words) && !(want.key && got.key && want.key !== got.key)
    && ![...want.catalog].some(([k, n]) => got.catalog.has(k) && got.catalog.get(k) !== n);
}

// The Lidarr release to ask for, for a composer's song: the first search
// (album, then piece) with a result that is the composer's album of that
// name, a regular album over a compilation. null when nothing fits; the
// caller then tries its usual searches.
export async function findClassicalRelease<R extends { artist: string; title: string; rtype?: string }>(
  search: (q: string) => Promise<R[]>, song: Song,
): Promise<R | null> {
  for (const { q, want } of classicalSearches(song)) {
    const hits = (await search(q)).filter((h) => isComposerAlbum(song, want, h));
    const pick = hits.find((h) => !h.rtype || h.rtype === 'Album') ?? hits[0];
    if (pick) return pick;
  }
  return null;
}

// --- fetching one recording -----------------------------------------------------
// The Soulseek searches for a composer's song, one file at a time: the
// surname and the piece's first name words, with its catalog number first
// ("Chopin Nocturne op 9"), then without. A whole Spotify title finds
// nothing: files are named "03 - Nocturne in E flat, Op.9 No.2.flac" in a
// folder named after the composer or the performer.
// One track that runs several movements ("Suite No. 2: I. Lever du jour –
// II. Pantomime – III. Danse générale") is the whole work: a file of the
// whole suite is it, a file of one movement is not.
const wholeWork = (title: string) => {
  const marks = [...String(title).matchAll(/(?:^|[\s:,–—-])([IVX]{1,4})\.\s/g)];
  return marks.length >= 2 ? title.slice(0, marks[0].index).replace(/[\s:,–—-]+$/, '') : title;
};

export function classicalFileSearches(song: Song): string[] {
  const composer = composerOf(song.artist);
  if (!composer) return [];
  const t = parseWork(wholeWork(song.title));
  if (!t.words.size) return [];
  const name = `${composer.name} ${t.name.slice(0, 2).join(' ')}`;
  const [kind, n] = [...t.catalog].find(([, x]) => x !== 'posth') ?? [];
  return kind ? [`${name} ${kind} ${n}`, name] : [name];
}

// Whether a file (its whole path on Soulseek, or in the library) is that
// piece by that composer: the composer named somewhere on the path, and the
// file name the same work (the folder fills in words, as an album does).
export function isClassicalFile(song: Song, filePath: string): boolean {
  const composer = composerOf(song.artist);
  if (!composer) return false;
  const parts = String(filePath).split(/[\\/]/).filter(Boolean);
  const base = (parts.pop() || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/^\s*(?:\d{1,2}[-.])?\d{1,3}\s*[-_.]?\s+/, '');
  if (!composersIn(`${parts.join(' ; ')} ; ${base}`).includes(composer)) return false;
  return sameWork(parseWork(wholeWork(song.title)), parseWork(base), parseWork(parts.slice(-2).join(' ')).words).same;
}

// Whether some text (a file's tags and path) names the composer of `artist`.
export function namesComposer(artist: string, text: string): boolean {
  const composer = composerOf(artist);
  return !!composer && composersIn(text).includes(composer);
}
