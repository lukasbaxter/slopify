// Streaming bugs that came back before: each test here failed on the code
// before its fix.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-streamreg-'));
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-streamreg-lib-'));
let app: Awaited<ReturnType<typeof buildServer>>; let tok = '';
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}`, ...headers } });
const db = () => (app as any).db;
const trackIds = () => (db().prepare('SELECT id FROM tracks ORDER BY path').all() as any[]).map((r) => r.id as string);

beforeAll(async () => {
  fs.cpSync(MUSIC, LIB, { recursive: true });
  app = await buildServer({ dataDir: DATA, musicDir: LIB });
  await scanLibrary(db(), { musicDir: LIB, dataDir: DATA, heads: { cacheDir: DATA, seconds: 1 } });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
}, 120000);
afterAll(async () => { await app.close(); });

describe('a transcode that fails before ffmpeg runs', () => {
  it('never stays failed: the next request for the same song and quality transcodes it', async () => {
    const id = trackIds()[3];
    // Something in the way of the transcode folder: the rm/mkdir before the spawn throws.
    const blocker = path.join(DATA, 'transcodes', id);
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, 'not a folder');
    expect((await get(`/api/stream/${id}/hls/aac-96/index.m3u8`)).statusCode).toBe(503);
    fs.rmSync(blocker);
    const again = await get(`/api/stream/${id}/hls/aac-96/index.m3u8`);
    expect(again.statusCode).toBe(200);
    expect(again.body).toMatch(/#EXTM3U/);
  }, 60000);
});

describe('a normalized variant after the loudness changed', () => {
  it('a master playlist already handed out never points at a 404, and gains the server never chose still get none', async () => {
    const id = trackIds()[4];
    const album = (db().prepare('SELECT album_id FROM tracks WHERE id = ?').get(id) as any).album_id;
    const setLoud = (lufs: number) => {
      db().prepare('UPDATE tracks SET loudness = ?, true_peak = -6, loudness_at = ? WHERE id = ?').run(lufs, Date.now(), id);
      db().prepare('UPDATE albums SET loudness = ?, true_peak = -6 WHERE id = ?').run(lufs, album);
    };
    setLoud(-10); // gain -4 dB
    const master = await get(`/api/stream/${id}/hls/master.m3u8?norm=track`);
    const variant = /^(aac-96g[^/]+)\/index\.m3u8/m.exec(master.body)![1];
    expect(variant).toBe('aac-96g-4');
    setLoud(-11); // re-measured (an album refresh): the server would pick -3 dB now
    expect((await get(`/api/stream/${id}/hls/${variant}/index.m3u8?abr=1`)).statusCode).toBe(200);
    // Still bounded: only what this server handed out (as it spelled it) or picks now.
    for (const bad of ['aac-96g-4.0', 'aac-96g-5', 'aac-96g-25', 'aac-96g13', 'aac-96g04']) expect((await get(`/api/stream/${id}/hls/${bad}/index.m3u8?abr=1`)).statusCode).toBe(404);
  }, 60000);
});

describe('the cache trim removing a transcode while its playlist is asked for', () => {
  it('never answers 500: the playlist is transcoded again', async () => {
    const id = trackIds()[5];
    const dir = path.join(DATA, 'transcodes', id, 'aac-96');
    expect((await get(`/api/stream/${id}/hls/aac-96/index.m3u8`)).statusCode).toBe(200);
    for (let i = 0; i < 400 && !fs.existsSync(path.join(dir, 'done')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(dir, 'done'))).toBe(true);
    // The trim runs between ensureHls finding it done and the playlist being read.
    const real = fsp.readFile;
    let trimmed = false;
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation(((p: any, ...rest: any[]) => {
      if (!trimmed && String(p) === path.join(dir, 'index.m3u8')) { trimmed = true; fs.rmSync(dir, { recursive: true, force: true }); }
      return (real as any).call(fsp, p, ...rest);
    }) as any);
    try {
      const r = await get(`/api/stream/${id}/hls/aac-96/index.m3u8`);
      expect(trimmed).toBe(true);
      expect(r.statusCode).toBe(200);
      expect(r.body).toMatch(/#EXTM3U/);
    } finally { spy.mockRestore(); }
  }, 60000);
});

describe('a file rewritten in place (Lidarr retagging) before the next scan', () => {
  const pick = (n: number) => db().prepare("SELECT t.id, t.path FROM tracks t JOIN heads h ON h.track_id = t.id WHERE t.path LIKE '%.mp3' ORDER BY t.path LIMIT 1 OFFSET ?").get(n) as { id: string; path: string };
  const range = (id: string, r: string) => get(`/api/stream/${id}`, { range: r });
  it('is served at its real size, never the size or head from before the rewrite', async () => {
    const t = pick(0);
    const old = fs.readFileSync(t.path);
    const now = Buffer.concat([Buffer.alloc(3000, 0x41), old]); // a bigger tag in front
    fs.writeFileSync(t.path, now);
    const full = await get(`/api/stream/${t.id}`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-length']).toBe(String(now.length));
    expect(full.rawPayload.equals(now)).toBe(true);
    const head = await range(t.id, 'bytes=0-99');
    expect(head.headers['content-range']).toBe(`bytes 0-99/${now.length}`);
    expect(head.rawPayload.equals(now.subarray(0, 100))).toBe(true);
    const tail = await range(t.id, `bytes=${now.length - 100}-`);
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(now.subarray(now.length - 100))).toBe(true);
    const dl = await get(`/api/download/${t.id}`);
    expect(dl.headers['content-length']).toBe(String(now.length));
    expect(dl.rawPayload.equals(now)).toBe(true);
  }, 60000);
  it('a rewrite that kept the size (new mtime) never serves the old head', async () => {
    const t = pick(1);
    const old = fs.readFileSync(t.path);
    const now = Buffer.from(old); now.fill(0x42, 0, 200); // tag bytes changed, same length
    fs.writeFileSync(t.path, now);
    const later = new Date(Date.now() + 60000); fs.utimesSync(t.path, later, later);
    const head = await range(t.id, 'bytes=0-199');
    expect(head.rawPayload.equals(now.subarray(0, 200))).toBe(true);
  }, 60000);
});

describe('a song whose file went missing (11-13: the NAS moved to NFS and 14k paths stopped resolving)', () => {
  // The Mac app kept "playing" a missing song without asking again: the reply
  // said "keep for an hour" (a 206 cut short, a 500 after it), so its browser
  // replayed the broken answer from its own cache.
  it('answers 404 that nothing keeps, before any byte, at the start and mid-song', async () => {
    const id = trackIds()[6];
    const file = (db().prepare('SELECT path FROM tracks WHERE id = ?').get(id) as any).path as string;
    fs.renameSync(file, file + '.away');
    try {
      for (const range of ['bytes=0-', 'bytes=30000-']) {
        const r = await get(`/api/stream/${id}?chunk=1`, { range });
        expect(r.statusCode, range).toBe(404);
        expect(r.headers['cache-control'], range).toBe('no-store');
        expect(r.headers['content-range'], range).toBeUndefined();
      }
    } finally { fs.renameSync(file + '.away', file); }
    const back = await get(`/api/stream/${id}?chunk=1`, { range: 'bytes=0-' });
    expect(back.statusCode).toBe(206);
  }, 60000);

  it('never lets an error reply be cached', async () => {
    const r = await get('/api/stream/0123456789abcdef0123456789abcdef?chunk=1');
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
