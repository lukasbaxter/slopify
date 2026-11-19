import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { composerOf, parseWork, sameWork, matchClassical, classicalSearches, isComposerAlbum, findClassicalRelease, classicalFileSearches, isClassicalFile } from './classical.js';
import { matchTrack } from './explore.js';

const same = (a: string, b: string) => sameWork(parseWork(a), parseWork(b)).same;

describe('classical: the same piece under another title', () => {
  it('knows composers in any spelling, and only composers', () => {
    expect(composerOf('Frédéric Chopin')?.name).toBe('Chopin');
    expect(composerOf('Fryderyk Chopin')?.name).toBe('Chopin');
    expect(composerOf('Пётр Ильич Чайковский')?.name).toBe('Tchaikovsky');
    expect(composerOf('Сергей Васильевич Рахманинов')?.name).toBe('Rachmaninoff');
    expect(composerOf('Camille Saint-Saens')?.name).toBe('Saint-Saëns');
    expect(composerOf('Frédéric Chopin; Maurizio Pollini')?.name).toBe('Chopin');
    expect(composerOf('The Weeknd')).toBeNull();
    expect(composerOf('Best Part Looped')).toBeNull();
    expect(composerOf('Arvo Pärt')?.name).toBe('Arvo Pärt');
    expect(composerOf('Royal Philharmonic Orchestra')).toBeNull();
  });

  it('reads catalog numbers, numbers, movements and the key out of a title', () => {
    const w = parseWork('Nocturne No. 2 in E-Flat Major, Op. 9 No. 2');
    expect(Object.fromEntries(w.catalog)).toEqual({ op: '9' });
    expect([...w.nums]).toEqual(['2']);
    expect(w.key).toBe('eb:major');
    expect([...w.words]).toEqual(['nocturne']);
    const m = parseWork('Mahler: Symphony No. 5 in C-Sharp Minor: IV. Adagietto. Sehr langsam');
    expect([...m.nums].sort()).toEqual(['4', '5']);
    expect(m.key).toBe('c#:minor');
    expect([...m.words]).toEqual(['symphony']);
    expect(Object.fromEntries(parseWork('Liebestraum No. 3 in A-Flat Major, S. 541 / 3').catalog)).toEqual({ s: '541' });
    expect(parseWork("Chopin's 2 Nocturnes").catalog.size).toBe(0);
  });

  // Spotify title (Ava's playlists) -> how the library has it.
  it.each([
    ['Suite bergamasque, L. 75: III. Clair de lune', 'Suite bergamasque: III. Clair de lune. Andante très expressif'],
    ['Clair de lune', 'Suite bergamasque: III. Clair de lune. Andante très expressif'],
    ['2 Arabesques, CD 74: No. 1, Andantino con moto', 'Deux arabesques: I. Andantino con moto'],
    ['Piano Concerto No. 2 in C Minor, Op. 18: 1. Moderato', 'Piano Concerto No. 2 in C minor, Op. 18: I. Moderato'],
    ['Carnival of the Animals: The Swan - Arranged for Cello and Harp by Miriam Keogh', 'The Carnival of the Animals: XIII. The Swan'],
    ['Tchaikovsky: Swan Lake, Op. 20, Act 2: No. 10, Scene. Moderato', 'Swan Lake, Op. 20: X. Scene - Swan Theme. Moderato'],
    ['Tchaikovsky: The Nutcracker, Op. 71, Act 2: No. 13, Waltz of the Flowers', 'The Nutcracker, Op. 71, Act 2: No. 13, Waltz of the Flowers'],
    ['Six Pieces, Op. 51, TH 143: VI. Valse sentimentale. Tempo di Valse', '6 Pieces, op. 51 no. 6: Valse sentimentale'],
    ['Mahler: Symphony No. 5 in C-Sharp Minor: IV. Adagietto. Sehr langsam', 'Symphony No.5 IV. Adagietto (Sehr langsam)'],
    ['Liebestraum No. 3 in A-Flat Major, S. 541 / 3', 'Liebestraum No. 3'],
    ['Für Elise', 'Bagatelle No. 25 in A Minor, WoO 59 "Für Elise"'],
    ['Massenet / Arr. Parhamovsky: Thaïs, Act 2: Méditation', 'Thaïs: Méditation (Arr. for Cello & Piano)'],
  ])('%s = %s', (a, b) => { expect(same(a, b)).toBe(true); });

  it.each([
    ['Nocturne No. 2 in E-Flat Major, Op. 9 No. 2', 'Nocturne No. 1 in B-Flat Minor, Op. 9 No. 1'],
    ['Nocturne No. 2 in E-Flat Major, Op. 9 No. 2', 'Nocturne in C-sharp minor, Op. posth.'],
    ['Nocturne No. 2 in E-Flat Major, Op. 9 No. 2', 'Nocturne'],
    ['Piano Concerto No. 2 in C Minor, Op. 18: 1. Moderato', 'Piano Concerto No. 2 in C minor, Op. 18: II. Adagio sostenuto'],
    ['Piano Sonata No. 2', 'Violin Sonata No. 2'],
    ['Symphony No. 5 in C minor, Op. 67', 'Symphony No. 5 in E minor, Op. 64'],
    ['The Nutcracker, Op. 71, Act 2: No. 14a, Pas de deux. Andante maestoso', 'The Nutcracker, Op. 71: No. 14 Pas de deux. Variation 2. Dance of the Sugar Plum Fairy'],
  ])('%s != %s', (a, b) => { expect(same(a, b)).toBe(false); });
});

describe('classical: matching a composer\'s song to the library', () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-classical-')));
  const albums = new Set<string>();
  const add = (id: string, title: string, artist: string, album: string) => {
    if (!albums.has(album)) { albums.add(album); db.prepare('INSERT INTO albums (id, name, artist, dir, added_at, sort_name) VALUES (?, ?, ?, ?, 1, ?)').run(album, album, artist, album, album); }
    db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
      VALUES (?, ?, 1, 1, ?, ?, ?, '[]', ?, ?, ?, 1)`).run(id, `${id}.flac`, title, artist, JSON.stringify([artist]), album, album, artist);
  };
  add('swan', 'The Carnival of the Animals: XIII. The Swan', 'Yo‐Yo Ma', 'Appassionato');
  add('valse', '6 Pieces, op. 51 no. 6: Valse sentimentale', 'Пётр Ильич Чайковский', 'Songs From the Arc of Life');
  add('waltz', 'The Nutcracker, Op. 71, Act 2: No. 13, Waltz of the Flowers', 'Royal Philharmonic Orchestra', 'Last Night of the Proms');
  add('noct1', 'Nocturne No. 1 in B-flat minor, Op. 9 No. 1', 'Arthur Rubinstein', 'Chopin: Nocturnes');
  add('other', 'Nocturne No. 2 in E-flat major, Op. 9 No. 2', 'John Field', 'Field: Nocturnes');

  it('finds the piece by another performer, in another script', () => {
    expect(matchClassical(db, { artist: 'Camille Saint-Saëns', title: 'Carnival of the Animals: The Swan - Arranged for Cello and Harp by Miriam Keogh', album: 'Romance' })).toBe('swan');
    expect(matchClassical(db, { artist: 'Pyotr Ilyich Tchaikovsky', title: 'Six Pieces, Op. 51, TH 143: VI. Valse sentimentale. Tempo di Valse' })).toBe('valse');
    expect(matchClassical(db, { artist: 'Pyotr Ilyich Tchaikovsky', title: 'Tchaikovsky: The Nutcracker, Op. 71, Act 2: No. 13, Waltz of the Flowers', album: 'Last Night of the Proms' })).toBe('waltz');
  });

  it('never takes another number, or another composer\'s piece', () => {
    // Only Op. 9 No. 1 is here by Chopin; the No. 2 in the library is John Field's.
    db.prepare("UPDATE tracks SET title = 'Nocturne No. 2 in E-flat major, Op. 9 No. 2', artist = 'John Field', artists = '[\"John Field\"]' WHERE id = 'other'").run();
    expect(matchClassical(db, { artist: 'Frédéric Chopin', title: 'Nocturne No. 2 in E-Flat Major, Op. 9 No. 2' })).toBeNull();
    expect(matchClassical(db, { artist: 'Frédéric Chopin', title: 'Nocturne No. 1 in B-Flat Minor, Op. 9 No. 1' })).toBe('noct1');
  });

  it('takes a short title when its album says the rest', () => {
    add('finale', 'III. Finale', 'Antonin Dvorak, Mstislav Rostropovich', 'Cello Concerto in B minor / Rondo / Silent Woods');
    expect(matchClassical(db, { artist: 'Antonín Dvořák', title: 'Dvořák: Cello Concerto in B Minor, Op. 104, B. 191: III. Finale. Allegro moderato' })).toBe('finale');
    expect(matchClassical(db, { artist: 'Antonín Dvořák', title: 'Symphony No. 9 in E Minor, Op. 95 "From the New World": III. Finale' })).toBeNull();
  });

  it('is what matchTrack falls back to, so every import and playlist gets it', () => {
    expect(matchTrack(db, { artist: 'Camille Saint-Saëns', title: 'Carnival of the Animals: The Swan' })).toBe('swan');
    expect(matchTrack(db, { artist: 'The Weeknd', title: 'The Swan' })).toBeNull();
  });
});

describe('classical: asking Lidarr for the album', () => {
  const song = { artist: 'Frédéric Chopin', title: 'Nocturne No. 2 in E-Flat Major, Op. 9 No. 2', album: 'Chopin: Nocturnes' };
  it('searches by surname: the album, then the piece', () => {
    expect(classicalSearches(song).map((s) => s.q)).toEqual(['Chopin nocturnes', 'Chopin nocturne']);
    expect(classicalSearches({ artist: 'The Weeknd', title: 'x' })).toEqual([]);
  });
  it('takes the composer\'s album of that name, under any spelling', () => {
    const [byAlbum] = classicalSearches(song);
    expect(isComposerAlbum(song, byAlbum.want, { artist: 'Fryderyk Chopin', title: 'Chopin Nocturnes' })).toBe(true);
    expect(isComposerAlbum(song, byAlbum.want, { artist: 'Peter Schmalfuss', title: 'Chopin Nocturnes' })).toBe(true);
    expect(isComposerAlbum(song, byAlbum.want, { artist: 'John Field', title: 'Nocturnes' })).toBe(false);
    expect(isComposerAlbum(song, byAlbum.want, { artist: 'Fryderyk Chopin', title: 'Ballades' })).toBe(false);
  });
  it('picks a regular album over a compilation, and falls through to the piece', async () => {
    const asked: string[] = [];
    const search = async (q: string) => { asked.push(q); return q === 'Chopin nocturnes' ? [
      { album_id: 'c', artist: 'Fryderyk Chopin', title: 'Chopin: Nocturnes', rtype: 'Compilation' },
      { album_id: 'a', artist: 'Fryderyk Chopin', title: 'Chopin Nocturnes', rtype: 'Album' },
    ] : []; };
    expect((await findClassicalRelease(search, song))?.album_id).toBe('a');
    const ballade = { artist: 'Frédéric Chopin', title: 'Ballade No. 1 in G Minor, Op. 23', album: 'Chopin: Ballades; Barcarolle; Fantaisie' };
    asked.length = 0;
    expect(await findClassicalRelease(search, ballade)).toBeNull();
    expect(asked).toEqual(['Chopin ballades barcarolle fantaisie', 'Chopin ballade']);
  });
});

describe('classical: one recording from Soulseek', () => {
  const noct = { artist: 'Frédéric Chopin', title: 'Nocturne No. 2 in E-Flat Major, Op. 9 No. 2' };
  it('searches by surname and piece, the catalog number first', () => {
    expect(classicalFileSearches(noct)).toEqual(['Chopin nocturne op 9', 'Chopin nocturne']);
    expect(classicalFileSearches({ artist: 'Frédéric Chopin', title: 'Chopin: Nocturne No. 20 in C-Sharp Minor, Op. Posth.' })).toEqual(['Chopin nocturne']);
    expect(classicalFileSearches({ artist: 'The Weeknd', title: 'Blinding Lights' })).toEqual([]);
  });
  it("takes any performer's file of that piece, named on the path, and nothing else", () => {
    expect(isClassicalFile(noct, '@@a\\Music\\Chopin - Nocturnes (Pollini)\\02 - Nocturne in E flat major, Op. 9 No. 2.flac')).toBe(true);
    expect(isClassicalFile(noct, 'Music/Fryderyk Chopin/Nocturnes/1-02 Nocturne Op.9 No.2.mp3')).toBe(true);
    expect(isClassicalFile(noct, 'Music/Chopin - Nocturnes/01 - Nocturne in B flat minor, Op. 9 No. 1.flac')).toBe(false); // the first one
    expect(isClassicalFile(noct, 'Music/Pollini/Nocturnes/02 - Nocturne Op. 9 No. 2.flac')).toBe(false); // no composer anywhere: could be John Field
    expect(isClassicalFile(noct, 'Music/Field - Nocturnes/Chopin style/02 - Nocturne Op. 9 No. 2.flac')).toBe(true);
    const daphnis = { artist: 'Maurice Ravel', title: 'Daphnis et Chloé Suite No. 2, M. 57b: I. Lever du jour – II. Pantomime – III. Danse générale' };
    expect(classicalFileSearches(daphnis)).toEqual(['Ravel daphnis chloe m 57b', 'Ravel daphnis chloe']);
    expect(isClassicalFile(daphnis, 'x/Ravel - Orchestral Works (Boulez)/04 - Daphnis et Chloé, Suite No. 2, M. 57b.flac')).toBe(true); // the whole suite
    expect(isClassicalFile(daphnis, 'x/Ravel - Orchestral Works (Boulez)/05 - Daphnis et Chloé Suite No. 2: I. Lever du jour.flac')).toBe(false); // one movement of it
    expect(isClassicalFile({ artist: 'Ludwig van Beethoven', title: 'Für Elise' }, 'x/Beethoven - Piano Pieces/05 Bagatelle in A minor WoO 59 - Für Elise.flac')).toBe(true);
  });
});
