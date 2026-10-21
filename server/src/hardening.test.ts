import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { token as newToken } from './ids.js';

// Audit 2026-10-21: tokens that leave the server, and ids a client may write.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-hard-'));
const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
let app: Awaited<ReturnType<typeof buildServer>>;
let admin = '';
let trackId = '';
beforeAll(async () => {
  app = await buildServer({ dataDir: DATA });
  await scanLibrary((app as any).db, { musicDir: MUSIC, dataDir: DATA });
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin', device: 'test' } });
  admin = r.json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', headers: { authorization: `Bearer ${admin}` }, payload: { password: 'correct horse battery' } });
  trackId = ((app as any).db.prepare('SELECT id FROM tracks LIMIT 1').get() as any).id;
});
afterAll(async () => { await app.close(); });
const H = () => ({ authorization: `Bearer ${admin}` });

describe('tokens that leave the server', () => {
  it('a speaker token opens streams and covers, nothing else', async () => {
    const db = (app as any).db;
    const uid = (db.prepare("SELECT id FROM users WHERE name = 'admin'").get() as any).id;
    const t = newToken();
    db.prepare("INSERT INTO tokens (token, user_id, device, kind, created, last_seen) VALUES (?, ?, 'Home speakers', 'speaker', ?, ?)").run(t, uid, Date.now(), Date.now());
    expect((await app.inject({ method: 'GET', url: `/api/stream/${trackId}?token=${t}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/users?token=${t}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/playlists?token=${t}` })).statusCode).toBe(401);
  });
  it('a token in the URL of a POST is not honoured', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/auth/me?token=${admin}` })).statusCode).toBe(200);
    const r = await app.inject({ method: 'POST', url: `/api/auth/password?token=${admin}`, payload: { current: 'correct horse battery', password: 'another long password' } });
    expect(r.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/playlists', headers: H(), payload: { name: 'ok' } })).statusCode).toBe(200);
  });
  it('wrong passwords per account are throttled regardless of address', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'Admin', password: 'nope', device: 'test' }, headers: { 'x-forwarded-for': `10.0.0.${i}` } });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('ids a client writes', () => {
  it('playlists keep only ids of tracks the library has', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/playlists', headers: H(), payload: { name: 'p', trackIds: [trackId, 'junk', 'f'.repeat(32)] } });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    expect((await app.inject({ method: 'POST', url: `/api/playlists/${id}/tracks`, headers: H(), payload: { trackIds: ['not-a-track', trackId] } })).statusCode).toBe(200);
    const rows = (app as any).db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').all(id) as any[];
    expect(rows.map((x) => x.track_id)).toEqual([trackId, trackId]);
  });
  it('likes and plays refuse ids that are not tracks', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/likes/junk', headers: H() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/likes/${'e'.repeat(32)}`, headers: H() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/likes/${trackId}`, headers: H() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/plays', headers: H(), payload: { trackId: 'junk' } })).statusCode).toBe(400);
  });
  it('a search of only wildcards is empty, not an error', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/search?q=%25', headers: H() });
    expect(r.statusCode).toBe(200);
    expect(r.json().albums).toEqual([]);
  });
  it('the warm queue takes only track ids', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/stream/warm', headers: H(), payload: { ids: ['../../etc', trackId] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().queued).toBeLessThanOrEqual(2);
  });
});
