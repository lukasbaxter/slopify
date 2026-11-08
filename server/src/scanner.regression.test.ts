// Scanner bugs that came back before: each test here failed on the code
// before its fix.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const someMp3 = () => { const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mp3') ? [path.join(d, e.name)] : [])); return walk(MUSIC).sort()[0]; };

describe('two files with the same audio (one id)', () => {
  it('the row never flips between them: it stays on the file it has while that file is there', async () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dupes-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dupes-data-'));
    const a = path.join(lib, 'A Album', 'song.mp3'), b = path.join(lib, 'B Album', 'song.mp3');
    for (const f of [a, b]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(someMp3(), f); }
    const db = openDb(data);
    const heads = { cacheDir: data, seconds: 1 };
    const first = await scanLibrary(db, { musicDir: lib, dataDir: data, heads });
    expect(first.added).toBe(1);
    const row = () => db.prepare('SELECT id, path FROM tracks').all() as { id: string; path: string }[];
    expect(row().length).toBe(1);
    // Whichever worker got there first: the lowest path.
    expect(row()[0].path).toBe(a);
    const headAt = () => (db.prepare('SELECT created FROM heads WHERE track_id = ?').get(row()[0].id) as any).created;
    const cut = headAt();
    for (let i = 0; i < 3; i++) {
      const r = await scanLibrary(db, { musicDir: lib, dataDir: data, heads });
      expect([r.added, r.changed, r.removed]).toEqual([0, 0, 0]);
      expect(row()[0].path).toBe(a);
      expect(headAt()).toBe(cut); // never recut
    }
    // The file it was on goes: the other one takes over, the song stays.
    fs.rmSync(path.dirname(a), { recursive: true });
    await scanLibrary(db, { musicDir: lib, dataDir: data, heads });
    expect(row().map((r) => r.path)).toEqual([b]);
  }, 120000);
});

describe('a database error on one file', () => {
  it('never aborts the scan: the other files are indexed, removals run and the scan is finished', async () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dberr-'));
    fs.cpSync(MUSIC, lib, { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dberr-data-'));
    const db = openDb(data);
    await scanLibrary(db, { musicDir: lib, dataDir: data });
    const n = () => (db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n;
    expect(n()).toBe(30);
    // One song is gone from the share, and another one's write fails.
    const gone = db.prepare('SELECT path FROM tracks ORDER BY path LIMIT 1').get() as any;
    fs.rmSync(gone.path);
    const bad = db.prepare('SELECT path, title FROM tracks ORDER BY path LIMIT 1 OFFSET 5').get() as any;
    fs.utimesSync(bad.path, new Date(), new Date(Date.now() + 5000)); // changed: read and written again
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON tracks WHEN NEW.title = '${bad.title.replace(/'/g, "''")}' AND NEW.mtime != OLD.mtime BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    const logs: string[] = [];
    const r = await scanLibrary(db, { musicDir: lib, dataDir: data, log: (m) => logs.push(m) });
    expect(r.removed).toBe(1);
    expect(n()).toBe(29);
    expect(logs.some((m) => m.includes('disk I/O error'))).toBe(true);
    const scan = db.prepare('SELECT finished FROM scans ORDER BY id DESC LIMIT 1').get() as any;
    expect(scan.finished).toBeTruthy();
  }, 120000);
  it('a scan that fails outright still finishes its scans row, with the error', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dberr2-'));
    const db = openDb(data);
    db.exec("CREATE TRIGGER boom2 BEFORE UPDATE OF track_count ON albums BEGIN SELECT RAISE(ABORT, 'recount broke'); END");
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dberr2-lib-'));
    fs.mkdirSync(path.join(lib, 'X')); fs.copyFileSync(someMp3(), path.join(lib, 'X', 'a.mp3'));
    await expect(scanLibrary(db, { musicDir: lib, dataDir: data })).rejects.toThrow(/recount broke/);
    const scan = db.prepare('SELECT finished, error FROM scans ORDER BY id DESC LIMIT 1').get() as any;
    expect(scan.finished).toBeTruthy();
    expect(scan.error).toMatch(/recount broke/);
  }, 120000);
});
