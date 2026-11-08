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
