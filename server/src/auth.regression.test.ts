// Account bugs that came back before: each test here failed on the code
// before its fix.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import WebSocket from 'ws';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-authreg-'));
let app: Awaited<ReturnType<typeof buildServer>>; let admin = '';
const invite = async () => (await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${admin}` } })).json().code as string;
const register = (code: string, username: string) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { invite: code, username, password: 'a good password' } });

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: DATA });
  admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${admin}` } });
});
afterAll(async () => { await app.close(); });

describe('registering with an invite', () => {
  it('one invite never makes two accounts, however close together they register', async () => {
    const code = await invite();
    const [a, b] = await Promise.all([register(code, 'racer_a'), register(code, 'racer_b')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const made = (app as any).db.prepare("SELECT COUNT(*) n FROM users WHERE name IN ('racer_a', 'racer_b')").get().n;
    expect(made).toBe(1);
  });
  it('a name taken while the password was hashing is a 409, never a 500, and the invite is not used up', async () => {
    const [c1, c2] = [await invite(), await invite()];
    const [a, b] = await Promise.all([register(c1, 'samename'), register(c2, 'SameName')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? c1 : c2;
    expect((await register(loser, 'othername')).statusCode).toBe(200);
  });
});

describe('deleting an account', () => {
  it('leaves nothing of theirs behind: no row in any table with a user id, no saved session, no live session', async () => {
    const db = (app as any).db;
    const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
    await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
    const track = (db.prepare('SELECT id, album_id FROM tracks LIMIT 1').get() as any);
    const r = (await register(await invite(), 'leaving')).json();
    const uid = r.user.id as string; const H = { authorization: `Bearer ${r.token}` };
    // Some of everything a listener leaves.
    await app.inject({ method: 'PUT', url: `/api/likes/${track.id}`, headers: H });
    await app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'mine' }, headers: H });
    const now = Date.now();
    db.prepare('INSERT INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, ?)').run(uid, track.id, now, 'x');
    db.prepare("INSERT INTO play_events (user_id, track_id, at, ms_played, end_ms, duration_ms, reason, shuffle, client) VALUES (?, ?, ?, 1, 1, 1, 'ended', NULL, 'x')").run(uid, track.id, now);
    db.prepare("INSERT INTO daily_mixes (user_id, artist_id, day, tzo, track_ids, source, made) VALUES (?, 'a', 'd', 0, '[]', 's', 0)").run(uid);
    db.prepare("INSERT INTO spotify_pending (user_id, kind, at, artist, title, created) VALUES (?, 'like', 0, 'a', 't', 0)").run(uid);
    db.prepare("INSERT INTO my_requests (user_id, lidarr_id, source, created) VALUES (?, 1, 's', 0)").run(uid);
    db.prepare("INSERT INTO lyric_jobs (track_id, user_id, state, requested) VALUES (?, ?, 'new', 0)").run(track.id, uid);
    db.prepare("INSERT INTO reports (id, user_id, user_name, device, message, logs, info, version, created) VALUES ('rep1', ?, 'leaving', 'd', 'm', 'l', 'i', 'v', 0)").run(uid);
    db.prepare("INSERT INTO prefs (user_id, json, updated) VALUES (?, '{}', 0)").run(uid);
    db.prepare("INSERT INTO album_likes (user_id, album_id, at) VALUES (?, ?, 0)").run(uid, track.album_id);
    db.prepare("INSERT INTO artist_follows (user_id, artist_id, at) VALUES (?, 'ar', 0)").run(uid);
    db.prepare("INSERT INTO kv (k, v) VALUES (?, '{}')").run(`explore:${uid}`);
    // A device of theirs playing right now.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as any).port}/api/ws`);
    await new Promise((res) => ws.on('open', res));
    const closed = new Promise<void>((res) => ws.on('close', () => res()));
    const ok = new Promise<void>((res) => ws.on('message', (d: any) => { if (JSON.parse(String(d)).type === 'hello-ok') res(); }));
    ws.send(JSON.stringify({ type: 'hello', token: r.token, clientId: 'c_leaving', instance: 'i', kind: 'web' }));
    await ok;
    ws.send(JSON.stringify({ type: 'queue', queue: [{ Id: track.id }] }));
    ws.send(JSON.stringify({ type: 'nowplaying', nowPlaying: { itemId: track.id, playing: true, position: 30 } }));
    await new Promise((res) => setTimeout(res, 1700)); // the session is saved
    expect(db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE ?").get(`%${uid}%`).n).toBeGreaterThan(0);

    expect((await app.inject({ method: 'DELETE', url: `/api/users/${uid}`, headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(200);
    await closed;
    await new Promise((res) => setTimeout(res, 1700)); // anything a closing socket would still save
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((t) => t.name as string);
    const left: Record<string, number> = {};
    for (const t of tables) {
      if (!(db.prepare(`PRAGMA table_info(${t})`).all() as any[]).some((c) => c.name === 'user_id')) continue;
      const n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).get(uid).n;
      if (n) left[t] = n;
    }
    expect(left).toEqual({});
    expect(db.prepare("SELECT k FROM kv WHERE k LIKE ?").all(`%${uid}%`)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM users WHERE id = ?").get(uid).n).toBe(0);
    // A track's lyric sync someone else may wait on, and an admin's problem report, stay (without the account).
    expect(db.prepare("SELECT COUNT(*) n FROM lyric_jobs WHERE track_id = ?").get(track.id).n).toBe(1);
    expect(db.prepare("SELECT user_name FROM reports WHERE id = 'rep1'").get().user_name).toBe('leaving');
  }, 120000);
});
