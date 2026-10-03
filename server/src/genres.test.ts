import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { canonicalize, voteFromTags, albumGenreMap, albumGenresPass, dropGenreCache } from './genres.js';

describe('canonical genres', () => {
  it('folds the tag zoo into one vocabulary', () => {
    expect(canonicalize('Rap/Hip Hop')).toBe('Hip-Hop');
    expect(canonicalize('Hip Hop')).toBe('Hip-Hop');
    expect(canonicalize('rap')).toBe('Hip-Hop');
    expect(canonicalize('Progressive House')).toBe('Dance');
    expect(canonicalize('Electro')).toBe('Electronic');
    expect(canonicalize('Drum & Bass')).toBe('Electronic');
    expect(canonicalize('K-POP')).toBe('K-Pop');
    expect(canonicalize('Indie Pop')).toBe('Alternative');
    expect(canonicalize('R&B')).toBe('R&B');
    expect(canonicalize('rnb')).toBe('R&B');
    expect(canonicalize('French Chanson')).toBe('Pop');
    expect(canonicalize('Film Score')).toBe('Soundtrack');
    expect(canonicalize('')).toBeNull();
    expect(canonicalize('Birdsong Field Recordings')).toBeNull();
  });

  it('does not fall for substrings and prefix rules', () => {
    expect(canonicalize('Afro-Cuban Jazz')).toBe('Jazz');       // not Afrobeats
    expect(canonicalize('Italo Disco')).toBe('Dance');          // not Soul & Funk
    expect(canonicalize('Contrapunto')).not.toBe('Hip-Hop');    // "trap" is bounded now
    expect(canonicalize('Trap')).toBe('Hip-Hop');
    expect(canonicalize('Afrobeats')).toBe('Afrobeats');
  });

  it('the album vote takes the majority of its tracks', () => {
    expect(voteFromTags([['Hip Hop'], ['Rap'], ['Pop']])).toBe('Hip-Hop');
    expect(voteFromTags([[''], []])).toBeNull();
  });
});

describe('settling album genres', () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-genres-')));
  const album = db.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 1, 0, ?)');
  const artist = db.prepare('INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?)');
  const track = db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, genres, added_at)
    VALUES (?, ?, 0, 0, 'T', ?, '[]', '[]', ?, 'A', ?, ?, 0)`);
  artist.run('ar1', 'MF DOOM', 'mf doom');
  album.run('al-deezer', 'Madvillainy', 'ar1', 'MF DOOM', '/m/1', 'madvillainy');
  album.run('al-tags', 'Special Herbs', 'ar1', 'MF DOOM', '/m/2', 'special herbs');
  album.run('al-artist', 'Bootleg Live Thing', 'ar1', 'MF DOOM', '/m/3', 'bootleg');
  track.run('t1', '/m/2/1.mp3', 'MF DOOM', 'al-tags', 'MF DOOM', '["Instrumental Hip Hop"]');

  it('Deezer first, then the tags, then the artist, then Other', async () => {
    const fetcher: any = async (url: string) => ({
      status: 200,
      json: async () => (url.includes(encodeURIComponent('Madvillainy'))
        ? { data: [{ title: 'Madvillainy', artist: { name: 'MF DOOM' }, genre_id: 116 }] }
        : { data: [] }),
    });
    const r = await albumGenresPass(db, { fetcher, max: 10 });
    expect(r.settled).toBe(3);
    const g = Object.fromEntries((db.prepare('SELECT id, genre FROM albums').all() as any[]).map((a) => [a.id, a.genre]));
    expect(g['al-deezer']).toBe('Hip-Hop');  // Deezer's genre id
    expect(g['al-tags']).toBe('Hip-Hop');    // its tracks' tags
    expect(g['al-artist']).toBe('Hip-Hop');  // the artist's other albums
    expect((await albumGenresPass(db, { fetcher, max: 10 })).settled).toBe(0); // settled stays settled
  });

  it('a Deezer failure leaves the album unsettled; a real empty answer settles it', async () => {
    const db2 = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-genres-f-')));
    db2.prepare('INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run('ar1', 'MF DOOM', 'mf doom');
    db2.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 1, 0, ?)')
      .run('b1', 'Special Herbs', 'ar1', 'MF DOOM', '/m/1', 'special herbs');
    db2.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, genres, added_at)
      VALUES ('t1', '/m/1/1.mp3', 0, 0, 'T', 'MF DOOM', '[]', '[]', 'b1', 'A', 'MF DOOM', '["Instrumental Hip Hop"]', 0)`).run();
    // HTTP 200 with an error body (Deezer's quota answer): nothing settled
    const errBody: any = async () => ({ status: 200, json: async () => ({ error: { code: 4, message: 'Quota limit exceeded' } }) });
    expect((await albumGenresPass(db2, { fetcher: errBody, max: 10, pauseMs: 0 })).settled).toBe(0);
    expect((db2.prepare('SELECT genre FROM albums WHERE id = ?').get('b1') as any).genre).toBeNull();
    // a real empty answer: Deezer has nothing, the tags vote settles it
    const empty: any = async () => ({ status: 200, json: async () => ({ data: [] }) });
    expect((await albumGenresPass(db2, { fetcher: empty, max: 10, pauseMs: 0 })).settled).toBe(1);
    expect((db2.prepare('SELECT genre FROM albums WHERE id = ?').get('b1') as any).genre).toBe('Hip-Hop');
  });

  it('three Deezer failures in a row stop the pass early', async () => {
    const db3 = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-genres-s-')));
    const album3 = db3.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 1, 0, ?)');
    for (let i = 0; i < 5; i++) album3.run(`c${i}`, `Album ${i}`, 'ar1', 'MF DOOM', `/m/${i}`, `album ${i}`);
    let calls = 0;
    const down: any = async () => { calls++; return { status: 503, json: async () => ({}) }; };
    const r = await albumGenresPass(db3, { fetcher: down, max: 10, pauseMs: 0 });
    expect(r.settled).toBe(0);
    expect(calls).toBe(3);
    expect((db3.prepare('SELECT COUNT(*) n FROM albums WHERE genre IS NULL').get() as any).n).toBe(5);
  });

  it('the live map covers settled and unsettled albums alike', () => {
    album.run('al-new', 'Fresh Arrival', 'ar1', 'MF DOOM', '/m/4', 'fresh');
    track.run('t2', '/m/4/1.mp3', 'MF DOOM', 'al-new', 'MF DOOM', '["Jazz"]');
    dropGenreCache();
    const m = albumGenreMap(db);
    expect(m.get('al-deezer')).toBe('Hip-Hop');
    expect(m.get('al-new')).toBe('Jazz');
  });
});
