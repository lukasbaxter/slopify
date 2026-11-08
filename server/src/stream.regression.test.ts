// Streaming bugs that came back before: each test here failed on the code
// before its fix.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
