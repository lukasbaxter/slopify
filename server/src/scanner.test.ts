import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary, splitArtists, canonicalArtistNames } from './scanner.js';
import { artistId, albumId } from './ids.js';
import { parseLrc } from './lyrics.js';

// vitest runs with cwd = server/; the fixture library lives at the repo root
const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-test-'));

describe('scanner on the fixture library', () => {
  const db = openDb(DATA);
  let first: Awaited<ReturnType<typeof scanLibrary>>;
  beforeAll(async () => { first = await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA, log: (m) => { if (!process.env.SCAN_QUIET) console.log(m); } }); }, 120000);

  it('indexes every track, album and artist', () => {
    expect(first.added).toBe(30);
    expect((db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n).toBe(30);
    expect((db.prepare('SELECT COUNT(*) n FROM albums').get() as any).n).toBe(5); // 4 folders + the mistagged file's "Wrong Album"
    expect((db.prepare("SELECT track_count FROM albums WHERE name = 'First Light'").get() as any).track_count).toBe(8);
  });
  it('stores lyrics from sidecars and renders covers', () => {
    expect((db.prepare('SELECT COUNT(*) n FROM lyrics').get() as any).n).toBe(22);
    const synced = db.prepare("SELECT lines FROM lyrics WHERE kind = 'synced' LIMIT 1").get() as any;
    expect(JSON.parse(synced.lines)[0].start).toBe(0);
    const withCover = (db.prepare('SELECT COUNT(*) n FROM albums WHERE cover_hash IS NOT NULL').get() as any).n;
    expect(withCover).toBe(5); // the mistagged file's 'Wrong Album' sits in a folder with a cover too
    const hash = (db.prepare('SELECT cover_hash FROM albums WHERE cover_hash IS NOT NULL LIMIT 1').get() as any).cover_hash;
    expect(fs.existsSync(path.join(DATA, 'art', hash, '320.webp'))).toBe(true);
  });
  it('is incremental and survives a rename', async () => {
    const again = await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
    expect(again.added + again.changed + again.removed).toBe(0);
    const t = db.prepare('SELECT id, path FROM tracks ORDER BY path LIMIT 1').get() as any;
    const moved = t.path.replace(/\.mp3$/, ' (renamed).mp3');
    fs.renameSync(t.path, moved);
    try {
      const r = await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
      expect(r.added).toBe(1); // new path...
      expect((db.prepare('SELECT id FROM tracks WHERE path = ?').get(moved) as any).id).toBe(t.id); // ...same id: audio hash
      expect((db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n).toBe(30);
    } finally { fs.renameSync(moved, t.path); await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA }); }
  }, 120000);
  it('searches with FTS', () => {
    const rows = db.prepare("SELECT t.title FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH 'harbour' LIMIT 5").all() as any[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('folder scan (a download landing)', () => {
  it('reads only the given folders and removes nothing outside them', async () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-lib-'));
    fs.cpSync(MUSIC, lib, { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-only-'));
    const db = openDb(data);
    await scanLibrary(db, { musicDir: lib, dataDir: data });
    const count = () => (db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n;
    expect(count()).toBe(30);
    // an album arrives in a new folder, and a file elsewhere disappears
    const albumDir = path.dirname((db.prepare("SELECT path FROM tracks WHERE album = 'First Light' LIMIT 1").get() as any).path);
    const landed = path.join(lib, 'Landed', path.basename(albumDir));
    fs.mkdirSync(path.dirname(landed)); fs.renameSync(albumDir, landed);
    const gone = (db.prepare("SELECT path FROM tracks WHERE album != 'First Light' LIMIT 1").get() as any).path;
    fs.rmSync(gone);
    const r = await scanLibrary(db, { musicDir: lib, dataDir: data, only: [path.join(lib, 'Landed')] });
    expect(r.files).toBe(8);
    expect(r.removed).toBe(0);
    expect(count()).toBe(30);
    expect((db.prepare("SELECT COUNT(*) n FROM tracks WHERE album = 'First Light' AND path LIKE ?").get(`${landed}%`) as any).n).toBe(8);
    // the full walk still notices the missing file
    expect((await scanLibrary(db, { musicDir: lib, dataDir: data })).removed).toBe(1);
    expect(count()).toBe(29);
  }, 120000);
});

describe('artist spelling', () => {
  it('keeps the artist\'s own spelling ("INZO") over the most common one, and never renames to another artist', () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-names-')));
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, added_at, sort_name) VALUES ('al', 'A', 'x', 'x', '/m', 0, 'a')").run();
    const t = db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at) VALUES (?, ?, 0, 0, 't', ?, ?, ?, 'al', 'A', ?, 0)`);
    const add = (id: string, name: string) => { t.run(id, `/m/${id}`, name, JSON.stringify([name]), JSON.stringify([artistId(name)]), name); db.prepare('INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run(artistId(name), name, name.toLowerCase()); };
    add('1', 'Inzo'); add('2', 'Inzo'); add('3', 'INZO');   // most files say Inzo
    add('4', 'Lauv');
    add('5', 'Syko');
    const cache = db.prepare('INSERT INTO ext_cache (k, json, at) VALUES (?, ?, 0)');
    cache.run('artistspelling:inzo', JSON.stringify({ name: 'INZO' }));
    cache.run('artistspelling:lauv', JSON.stringify({ name: 'LAUV Official' })); // not the same name: ignored
    cache.run('artistspelling:syko', JSON.stringify({ name: 'SyKo' }));
    cache.run('spotify:artistname:syko', JSON.stringify({ name: 'Syko Other' })); // old Spotify cache rows are ignored
    canonicalArtistNames(db);
    const names = (db.prepare('SELECT DISTINCT artist FROM tracks ORDER BY artist').all() as any[]).map((r) => r.artist);
    expect(names).toEqual(['INZO', 'Lauv', 'SyKo']);
    expect((db.prepare('SELECT name FROM artists WHERE id = ?').get(artistId('inzo')) as any).name).toBe('INZO');
  });
});

describe('helpers', () => {
  it('splits artist credits but keeps known bands', () => {
    expect(splitArtists(undefined, 'Tyla feat. Gunna')).toEqual(['Tyla', 'Gunna']);
    expect(splitArtists(undefined, 'AC/DC')).toEqual(['AC/DC']);
    expect(splitArtists(['A', 'B'], 'A; B')).toEqual(['A', 'B']);
  });
  it('parses LRC with repeated timestamps and offsets', () => {
    const l = parseLrc('[offset:+500]\n[ar:x]\n[00:01.00][00:03.00] hi\nplain');
    expect(l.map((x) => x.start)).toEqual([null, 1500, 3500]);
  });
});

describe('artist spelling', () => {
  it('writes the majority spelling to the artist, its albums and every credit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-canon-'));
    const db = openDb(dir);
    const id = artistId('Tory Lanez');
    db.prepare('INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run(id, 'TORY LANEZ', 'tory lanez');
    const alb = (name: string, spelled: string) => {
      const a = albumId(spelled, name);
      db.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 0, ?)').run(a, name, id, spelled, '/x', name);
      return a;
    };
    const a1 = alb('One', 'Tory Lanez'), a2 = alb('Two', 'TORY LANEZ');
    const tr = (tid: string, a: string, spelled: string) => db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, genres, duration_ms, added_at)
      VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, 'x', ?, '[]', 0, 0)`).run(tid, `/x/${tid}`, tid, spelled, JSON.stringify([spelled]), JSON.stringify([id]), a, spelled);
    tr('t1', a1, 'Tory Lanez'); tr('t2', a1, 'Tory Lanez'); tr('t3', a2, 'TORY LANEZ');
    canonicalArtistNames(db);
    expect((db.prepare('SELECT name FROM artists WHERE id = ?').get(id) as any).name).toBe('Tory Lanez');
    expect(db.prepare('SELECT DISTINCT artist FROM albums').all()).toEqual([{ artist: 'Tory Lanez' }]);
    expect(db.prepare('SELECT DISTINCT artist, artists, album_artist FROM tracks').all()).toEqual([{ artist: 'Tory Lanez', artists: '["Tory Lanez"]', album_artist: 'Tory Lanez' }]);
  });
});
