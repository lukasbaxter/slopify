// Home's stations and top mixes: whose they are, what they hold, the colour
// each keeps, and the covers drawn for them.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import sharp from 'sharp';
import { openDb } from './db.js';
import { dropGenreCache } from './genres.js';
import { storeArtwork } from './artwork.js';
import { tileColor, stations, topMixes, topMixTracks, dailyMixArt, coverArt } from './homemixes.js';
import { STATION_COLORS, MIXBAR_COLORS, DAILY_COLORS } from './typecover.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-homemixes-'));
const db = openDb(dir);
const photo = (c: string) => sharp({ create: { width: 300, height: 300, channels: 3, background: c } }).jpeg().toBuffer();

// Artists a..f; genres: a, b Hip-Hop; c, d Rock; e Jazz; f Pop. u1 plays
// Hip-Hop most, then Rock, then Jazz; u2 only Pop.
beforeAll(async () => {
  const art: Record<string, string> = {};
  for (const [id, c] of [['a', '#ff0000'], ['b', '#00ff00'], ['c', '#0000ff'], ['d', '#ffff00'], ['e', '#00ffff'], ['f', '#ff00ff']]) art[id] = (await storeArtwork(dir, await photo(c))).hash;
  const genre: Record<string, string> = { a: 'Hip-Hop', b: 'Hip-Hop', c: 'Rock', d: 'Rock', e: 'Jazz', f: 'Pop' };
  for (const id of Object.keys(genre)) {
    const aid = `${id.repeat(32)}`;
    db.prepare('INSERT INTO artists (id, name, sort_name, image_hash) VALUES (?, ?, ?, ?)').run(aid, `Artist ${id.toUpperCase()}`, `artist ${id}`, art[id]);
    db.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name, genre) VALUES (?, ?, ?, ?, ?, 3, 0, ?, ?)').run(`al-${id}`, `Album ${id}`, aid, `Artist ${id.toUpperCase()}`, `/m/${id}`, `album ${id}`, genre[id]);
    for (let k = 1; k <= 3; k++) db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
      VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0)`).run(`t-${id}${k}`, `/m/${id}/${k}.flac`, `Song ${id}${k}`, `Artist ${id.toUpperCase()}`, JSON.stringify([`Artist ${id.toUpperCase()}`]), JSON.stringify([aid]), `al-${id}`, `Album ${id}`, `Artist ${id.toUpperCase()}`);
  }
  const play = db.prepare('INSERT INTO plays (user_id, track_id, at) VALUES (?, ?, ?)');
  const now = Date.now();
  const times = (uid: string, track: string, n: number) => { for (let i = 0; i < n; i++) play.run(uid, track, now - i * 60000); };
  times('u1', 't-a1', 9); times('u1', 't-b1', 5); times('u1', 't-c1', 6); times('u1', 't-d1', 2); times('u1', 't-e1', 3);
  times('u2', 't-f1', 4);
  dropGenreCache();
});

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);

describe('tile colours', () => {
  it('a tile keeps its colour, and differs from the tile beside it', () => {
    const one = tileColor(db, 'cu', 'station:x', STATION_COLORS);
    const two = tileColor(db, 'cu', 'station:y', STATION_COLORS, ['station:x']);
    expect(two).not.toBe(one);
    expect(tileColor(db, 'cu', 'station:x', STATION_COLORS, ['station:y'])).toBe(one);
    expect(tileColor(db, 'other', 'station:x', STATION_COLORS)).toBe(STATION_COLORS[0]); // each listener their own
  });
});

describe('Recommended Stations', () => {
  it("are the listener's artists after the Daily Mix seeds, with who each brings in and a drawn cover", async () => {
    const mixOf = async (a: { id: string }) => ({ artists: [{ id: a.id, name: 'self' }, { id: B, name: 'Artist B' }, { id: C, name: 'Artist C' }] });
    const s = await stations(db, dir, 'u1', new Set([A]), mixOf);
    expect(s.map((x) => x.name)).toEqual(['Artist C', 'Artist B', 'Artist E', 'Artist D', 'Artist A']); // by plays, the Daily Mix one (A) last
    expect(s[0].with.map((w) => w.name)).toEqual(['Artist B']); // not itself
    expect(new Set(s.map((x) => x.color)).size).toBe(5);
    expect(s[0].art).toMatch(/^art_[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(dir, 'art', s[0].art!.slice(4), '640.jpg'))).toBe(true);
    const again = await stations(db, dir, 'u1', new Set([A]), mixOf);
    expect(again.map((x) => [x.color, x.art])).toEqual(s.map((x) => [x.color, x.art])); // same colours, same pictures
  });
});

describe('Your top mixes', () => {
  it("are the listener's most played genres, each with its own artists and colour", async () => {
    const m = await topMixes(db, dir, 'u1');
    expect(m.map((x) => x.name)).toEqual(['Hip-Hop Mix', 'Rock Mix', 'Jazz Mix']);
    expect(m[0].artists.map((a) => a.name)).toEqual(['Artist A', 'Artist B']);
    expect(MIXBAR_COLORS).toContain(m[0].color);
    expect(m.every((x) => /^art_/.test(x.art || ''))).toBe(true);
    expect((await topMixes(db, dir, 'u2')).map((x) => x.name)).toEqual(['Pop Mix']);
  });

  it("a mix holds only that genre's songs, the same all day, a new pick the next", () => {
    const day = Date.parse('2026-11-17T12:00:00Z');
    const one = topMixTracks(db, 'u1', 'Rock', 4, day);
    expect(one.length).toBe(4);
    expect(one.every((id) => /^t-[cd]/.test(id))).toBe(true);
    expect(topMixTracks(db, 'u1', 'Rock', 4, day + 3600e3)).toEqual(one);
    expect(topMixTracks(db, 'u1', 'Nope')).toEqual([]);
  });
});

describe('drawn covers', () => {
  it('a Daily Mix tile is drawn in its number\'s colour, once per look', async () => {
    const art = (db.prepare('SELECT image_hash FROM artists WHERE id = ?').get(A) as any).image_hash;
    const one = await dailyMixArt(db, dir, 1, art);
    expect(await dailyMixArt(db, dir, 1, art)).toBe(one);
    expect(await dailyMixArt(db, dir, 2, art)).not.toBe(one);
    expect(DAILY_COLORS[0]).toBe('#00F5F2');
    let draws = 0;
    const look = ['test', Math.random()];
    const a = await coverArt(db, dir, look, async () => { draws++; return photo('#123456'); });
    const b = await coverArt(db, dir, look, async () => { draws++; return photo('#123456'); });
    expect([a === b, draws]).toEqual([true, 1]);
  });
});
