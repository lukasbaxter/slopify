import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary, splitArtists } from './scanner.js';
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
