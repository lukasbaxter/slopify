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

  it('the live map covers settled and unsettled albums alike', () => {
    album.run('al-new', 'Fresh Arrival', 'ar1', 'MF DOOM', '/m/4', 'fresh');
    track.run('t2', '/m/4/1.mp3', 'MF DOOM', 'al-new', 'MF DOOM', '["Jazz"]');
    dropGenreCache();
    const m = albumGenreMap(db);
    expect(m.get('al-deezer')).toBe('Hip-Hop');
    expect(m.get('al-new')).toBe('Jazz');
  });
});
