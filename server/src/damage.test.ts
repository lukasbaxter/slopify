import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { classify, checkSongs, decodeLength } from './damage.js';
import { verifyFlac } from './tasks.js';

// Real files, made here: a good FLAC, one cut short (its header still says
// the full length: what a broken download or a saved preview looks like),
// an MP3 whose length on record is wrong, and a stub under a second.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-damage-'));
const MUSIC = path.join(DIR, 'music', 'Band', 'Album'); fs.mkdirSync(MUSIC, { recursive: true });
const tone = (out: string, secs: number, extra: string[] = []) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, ...extra, out]);
const tag = (title: string) => ['-metadata', `title=${title}`, '-metadata', 'artist=Band', '-metadata', 'album=Album'];
let db: ReturnType<typeof openDb>;
const idOf = (title: string) => (db.prepare('SELECT id FROM tracks WHERE title = ?').get(title) as any)?.id as string;

beforeAll(async () => {
  tone(path.join(MUSIC, '01 Good.flac'), 12, tag('Good'));
  tone(path.join(MUSIC, '02 Cut.flac'), 30, tag('Cut'));
  const cut = path.join(MUSIC, '02 Cut.flac'); const buf = fs.readFileSync(cut); fs.writeFileSync(cut, buf.subarray(0, Math.floor(buf.length * 0.25)));
  tone(path.join(MUSIC, '03 Lies.mp3'), 12, [...tag('Lies'), '-b:a', '128k']);
  tone(path.join(MUSIC, '04 Stub.flac'), 0.05, tag('Stub'));
  db = openDb(path.join(DIR, 'data'));
  await scanLibrary(db, { musicDir: path.join(DIR, 'music'), dataDir: path.join(DIR, 'data') } as any);
  // The MP3's header lies about its length (the Moby rips: 22 min on record, 4 of audio).
  db.prepare('UPDATE tracks SET duration_ms = 300000 WHERE id = ?').run(idOf('Lies'));
}, 60000);

describe('song checks', () => {
  it('a stub under a second never enters the library', () => {
    expect(idOf('Stub')).toBeUndefined();
    expect(idOf('Good')).toBeDefined();
  });
  it('sorts each song by decoding all of it: fine, wrong length (fixed), damaged', async () => {
    expect((await decodeLength(path.join(MUSIC, '02 Cut.flac'))).ms).toBeLessThan(15000);
    const c = await checkSongs(db, [idOf('Good'), idOf('Cut'), idOf('Lies')]);
    expect(c.fine).toEqual([idOf('Good')]);
    expect(c.damaged).toEqual([idOf('Cut')]);
    expect(c.length).toEqual([idOf('Lies')]);
    const lies = db.prepare('SELECT duration_ms FROM tracks WHERE id = ?').get(idOf('Lies')) as any;
    expect(lies.duration_ms).toBeGreaterThan(11000); expect(lies.duration_ms).toBeLessThan(13500);
    expect((db.prepare('SELECT kind FROM song_checks WHERE track_id = ?').get(idOf('Cut')) as any).kind).toBe('damaged');
  });
  it('a rescan keeps the corrected length', async () => {
    const id = idOf('Lies');
    db.prepare('UPDATE tracks SET mtime = 0 WHERE id = ?').run(id); // forces the file to be read again
    await scanLibrary(db, { musicDir: path.join(DIR, 'music'), dataDir: path.join(DIR, 'data') } as any);
    const d = (db.prepare('SELECT duration_ms FROM tracks WHERE id = ?').get(id) as any).duration_ms;
    expect(d).toBeLessThan(13500);
  });
  it('the rules: exact formats are damaged when short, an MP3 that decodes cleanly is a wrong length', () => {
    expect(classify(192000, 29000, 0, 'FLAC')).toBe('damaged');
    expect(classify(1318000, 223000, 0, 'MPEG 1 Layer 3')).toBe('length');
    expect(classify(300000, 120000, 3, 'MPEG 1 Layer 3')).toBe('damaged');
    expect(classify(240000, 239500, 0, 'FLAC')).toBe('fine');
    expect(classify(58, 40, 0, 'FLAC')).toBe('empty');
  });
  it('a replacement must decode to its full length: a preview with a full-length header is refused', async () => {
    expect(await verifyFlac(path.join(MUSIC, '01 Good.flac'), 12000)).toBe(true);
    expect(await verifyFlac(path.join(MUSIC, '02 Cut.flac'), 30000)).toBe(false);
  });
});
