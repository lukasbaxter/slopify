// A Daily Mix without the brain: other artists' songs come in by genre, and a
// shared broad tag ("R&B") is not enough; skits and sped-up edits stay out.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { artistMix, genreFill, rngOf, type TrackRow } from './library.js';
import { nearOf } from './dailymix.js';

const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-artistmix-')));
const aid = (name: string) => name.toLowerCase().replace(/\W/g, '').padEnd(32, '0').slice(0, 32);
const track = (id: string, title: string, artist: string, genres: string[]) => {
  const a = aid(artist);
  db.prepare('INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run(a, artist, artist.toLowerCase());
  db.prepare('INSERT OR IGNORE INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 1, 0, ?)').run(`al-${a}`, `${artist} Album`, a, artist, `/m/${a}`, artist);
  db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at, genres)
    VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(id, `/m/${id}.flac`, title, artist, JSON.stringify([artist]), JSON.stringify([a]), `al-${a}`, `${artist} Album`, artist, JSON.stringify(genres));
};
const RNB = ['Contemporary R&B', 'Trap Soul', 'R&B', 'Hip Hop'];
beforeAll(() => {
  for (let i = 1; i <= 4; i++) track(`seed${i}`, `Seed ${i}`, 'Seed Singer', RNB);
  track('skit', 'Jalissa (Skit)', 'Seed Singer', RNB);
  for (let i = 1; i <= 4; i++) track(`near${i}`, `Near ${i}`, 'Near Singer', ['Contemporary R&B', 'R&B']);
  track('nearsped', 'Near 5 (Sped Up)', 'Near Singer', ['Contemporary R&B', 'R&B']);
  for (let i = 1; i <= 4; i++) track(`kpop${i}`, `Ballad ${i}`, 'Kpop Group', ['K-Pop', 'Pop', 'R&B', 'Korean Ballad']);
});
const ids = (xs: TrackRow[]) => xs.map((t) => t.id);

describe("a Daily Mix's own songs", () => {
  it('fills by genre only from songs that share a specific tag, not only "R&B"', () => {
    const theirs = db.prepare("SELECT * FROM tracks WHERE artist = 'Seed Singer'").all() as TrackRow[];
    const out = ids(genreFill(db, theirs, aid('Seed Singer'), 20, rngOf('d')));
    expect(out.filter((id) => id.startsWith('near')).length).toBeGreaterThan(0);
    expect(out.filter((id) => id.startsWith('kpop'))).toEqual([]);
  });

  it('an artist with only broad tags still gets others who share them', () => {
    track('broad1', 'Broad 1', 'Broad Singer', ['Electronic']);
    track('broad2', 'Broad 2', 'Other Broad', ['Electronic']);
    const theirs = db.prepare("SELECT * FROM tracks WHERE artist = 'Broad Singer'").all() as TrackRow[];
    expect(ids(genreFill(db, theirs, aid('Broad Singer'), 20, rngOf('d')))).toEqual(['broad2']);
  });

  it('leaves out skits and sped-up edits', async () => {
    const mix = ids(await artistMix(db, { id: aid('Seed Singer'), name: 'Seed Singer' }, 6, undefined, { sounds: ['near1', 'nearsped', 'near2', 'near3', 'near4'], day: '2026-11-17' }));
    expect(mix).not.toContain('skit');
    expect(mix).not.toContain('nearsped');
    expect(mix.some((id) => id.startsWith('seed'))).toBe(true);
  });
});

describe("the brain's Daily Mix keeps to the artist's scene", () => {
  it('near: the artist, related artists closest first, theirs a little; nothing far', async () => {
    const put = (a: string, related: string[]) => db.prepare('INSERT OR REPLACE INTO ext_cache (k, json, at) VALUES (?, ?, ?)').run(`dzrel:${aid(a)}`, JSON.stringify({ fans: 1, related: related.map((r) => ({ name: r, id: aid(r) })) }), Date.now());
    put('Seed Singer', ['Near Singer']);
    put('Near Singer', ['Second Hop']);
    const near = await nearOf(db, aid('Seed Singer'));
    expect(near[aid('Seed Singer')]).toBe(1);
    expect(near[aid('Near Singer')]).toBe(1);
    expect(near[aid('Second Hop')]).toBeCloseTo(0.35);
    expect(near[aid('Kpop Group')]).toBeUndefined();
    // A charity single of thirty names does not make them all the scene.
    const many = Array.from({ length: 30 }, (_, i) => `Charity Voice ${i}`);
    for (const m of many) db.prepare('INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run(aid(m), m, m);
    db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at, genres)
      VALUES ('charity', '/m/charity.flac', 0, 0, 'Charity Single', 'Seed Singer', '[]', ?, ?, 'x', 'x', 0, '[]')`).run(JSON.stringify([aid('Seed Singer'), ...many.map(aid)]), `al-${aid('Seed Singer')}`);
    db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at, genres)
      VALUES ('duet', '/m/duet.flac', 0, 0, 'Duet', 'Seed Singer', '[]', ?, ?, 'x', 'x', 0, '[]')`).run(JSON.stringify([aid('Seed Singer'), aid('Duet Partner')]), `al-${aid('Seed Singer')}`);
    const again = await nearOf(db, aid('Seed Singer'));
    expect(again[aid('Charity Voice 3')]).toBeUndefined();
    expect(again[aid('Duet Partner')]).toBe(0.6);
  });
});
