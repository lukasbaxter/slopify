import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from './db.js';
import { SongCache, songPath } from './songcache.js';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const settle = async (c: SongCache) => { for (let i = 0; i < 100 && c.stats().fetching; i++) await new Promise((r) => setTimeout(r, 10)); };

describe('song cache', () => {
  it('fetches a song whole, serves it locally, and drops the least recently played past the limit', async () => {
    const db = openDb(tmp('slopify-sc-')); const cache = tmp('slopify-scc-'); const nas = tmp('slopify-scn-');
    const mk = (id: string) => { const f = path.join(nas, `${id}.flac`); fs.writeFileSync(f, Buffer.alloc(1000, id.charCodeAt(0))); return f; };
    const c = new SongCache(db, cache, 2500); // room for two 1000-byte songs
    for (const id of ['aa1', 'bb2']) { c.want(id, mk(id), 1000); await settle(c); }
    expect(c.get('aa1', 1000)).toBe(songPath(cache, 'aa1'));
    expect(fs.readFileSync(songPath(cache, 'aa1')).equals(fs.readFileSync(path.join(nas, 'aa1.flac')))).toBe(true);
    // play aa1 again later, then a third song arrives: bb2 (least recently played) goes
    db.prepare("UPDATE song_cache SET last_used = 1 WHERE track_id = 'bb2'").run();
    c.want('cc3', mk('cc3'), 1000); await settle(c);
    expect(c.get('bb2', 1000)).toBeNull();
    expect(fs.existsSync(songPath(cache, 'bb2'))).toBe(false);
    expect(c.get('aa1', 1000)).not.toBeNull(); expect(c.get('cc3', 1000)).not.toBeNull();
    expect(c.stats()).toMatchObject({ songs: 2, bytes: 2000 });
  });
  it('off at size 0; a changed file (size differs) is not served from the cache', async () => {
    const db = openDb(tmp('slopify-sc2-'));
    const off = new SongCache(db, tmp('slopify-sc2c-'), 0);
    off.want('x', '/nope', 10); expect(off.stats().fetching).toBe(0);
    const cache = tmp('slopify-sc3c-'); const f = path.join(tmp('slopify-sc3n-'), 'a.mp3'); fs.writeFileSync(f, 'abcd');
    const c = new SongCache(db, cache, 1e6); c.want('dd4', f, 4); await settle(c);
    expect(c.get('dd4', 5)).toBeNull(); expect(c.get('dd4', 4)).not.toBeNull();
  });
  it('a hung copy (a wedged NAS mount) times out and gives the fetch slot back', async () => {
    const db = openDb(tmp('slopify-sc5-')); const cache = tmp('slopify-sc5c-');
    const fifo = path.join(tmp('slopify-sc5n-'), 'pipe');
    execFileSync('mkfifo', [fifo]); // a read of it blocks forever: no writer
    const c = new SongCache(db, cache, 1e6, () => {}, 2, 200); // 200 ms copy timeout
    c.want('ee5', fifo, 10);
    expect(c.stats().fetching).toBe(1);
    await settle(c);
    expect(c.stats().fetching).toBe(0); // the slot came back
    expect(c.get('ee5', 10)).toBeNull();
    // unwedge the blocked open so the worker can exit cleanly
    try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* reader already gone */ }
  });
});
