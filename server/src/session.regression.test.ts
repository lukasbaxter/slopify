// Session bugs that came back before: each test here failed on the code
// before its fix.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import WebSocket from 'ws';
import { buildServer } from './app.js';
import { openDb, type DB } from './db.js';
import { scanLibrary } from './scanner.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));

type App = Awaited<ReturnType<typeof buildServer>>;
async function start(db: DB, dataDir: string) {
  const app = await buildServer({ db, dataDir, musicDir: MUSIC });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port as number;
  return { app, port };
}
async function signIn(app: App, name: string) {
  const admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${admin}` } });
  const { code } = (await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${admin}` } })).json();
  const r = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { invite: code, username: name, password: 'listener password' } })).json();
  return { token: r.token as string, uid: r.user.id as string, admin };
}
async function connect(port: number, token: string, clientId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  await new Promise((r) => ws.on('open', r));
  const ok = new Promise<void>((resolve) => ws.on('message', (d: any) => { if (JSON.parse(String(d)).type === 'hello-ok') resolve(); }));
  ws.send(JSON.stringify({ type: 'hello', token, clientId, instance: `i_${clientId}`, kind: 'web' }));
  await ok;
  let n = 0;
  // Send, then wait until the server has handled it (its pong comes after).
  const send = async (msg: any) => {
    const t = ++n;
    const pong = new Promise<void>((resolve) => { const on = (d: any) => { const m = JSON.parse(String(d)); if (m.type === 'pong' && m.t === t) { ws.off('message', on); resolve(); } }; ws.on('message', on); });
    ws.send(JSON.stringify(msg)); ws.send(JSON.stringify({ type: 'ping', t }));
    await pong;
  };
  return { ws, send };
}

describe('plays and play events of a song played again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-sessreg-'));
  const db = openDb(dir);
  let app: App; let port = 0; let user: { token: string; uid: string };
  let clock = 2e12;
  let track = '';
  beforeAll(async () => {
    await scanLibrary(db, { musicDir: MUSIC, dataDir: dir });
    ({ app, port } = await start(db, dir));
    user = await signIn(app, 'looper');
    track = (db.prepare('SELECT id FROM tracks ORDER BY path LIMIT 1').get() as any).id;
    db.prepare('UPDATE tracks SET duration_ms = 172000 WHERE id = ?').run(track);
  }, 120000);
  afterAll(async () => { await app.close(); });
  afterEach(() => { vi.restoreAllMocks(); });
  const plays = () => (db.prepare('SELECT COUNT(*) n FROM plays WHERE user_id = ? AND track_id = ?').get(user.uid, track) as any).n;
  const events = () => db.prepare('SELECT ms_played, end_ms, reason FROM play_events WHERE user_id = ? AND track_id = ? ORDER BY at').all(user.uid, track) as any[];
  const np = (position: number, playing = true) => ({ type: 'nowplaying', nowPlaying: { itemId: track, title: 'T', playing, position, duration: 172 } });

  it('repeat-one: every time the song comes round again is a play and its own listen', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const c = await connect(port, user.token, 'c_loop_1');
    const t0 = clock;
    // First time through, a report every 2 s or so.
    for (let s = 0; s <= 170; s += 2) { clock = t0 + s * 1000; await c.send(np(s)); }
    expect(plays()).toBe(1);
    // Repeat-one: the same song from the top.
    for (let s = 0; s <= 20; s += 2) { clock = t0 + (172 + s) * 1000; await c.send(np(s)); }
    expect(plays()).toBe(2);
    // And a short song looped well inside a minute still counts each time.
    db.prepare('UPDATE tracks SET duration_ms = 30000 WHERE id = ?').run(track);
    const t1 = clock + 2000;
    for (let lap = 0; lap < 2; lap++) for (let s = 0; s <= 28; s += 2) { clock = t1 + (lap * 30 + s) * 1000; await c.send({ type: 'nowplaying', nowPlaying: { itemId: track, title: 'T', playing: true, position: s, duration: 30 } }); }
    expect(plays()).toBe(4);
    c.ws.close();
    for (let i = 0; i < 40 && events().length < 4; i++) await new Promise((r) => setTimeout(r, 25));
    const ev = events();
    expect(ev.length).toBe(4);
    expect(ev[0].reason).toBe('ended');
    expect(ev[0].end_ms).toBeGreaterThan(160000);
  }, 60000);

  it('the same listen reported twice (a second device, a reconnect) is still one play', async () => {
    db.prepare('DELETE FROM plays').run();
    db.prepare('UPDATE tracks SET duration_ms = 172000 WHERE id = ?').run(track);
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const t0 = clock + 60000; clock = t0;
    const a = await connect(port, user.token, 'c_dup_a');
    for (let s = 0; s <= 12; s += 2) { clock = t0 + s * 1000; await a.send(np(s)); }
    expect(plays()).toBe(1);
    a.ws.close();
    // The same device back on a new socket, mid-song, the same listen going on.
    const b = await connect(port, user.token, 'c_dup_b');
    for (let s = 14; s <= 40; s += 2) { clock = t0 + s * 1000; await b.send(np(s)); }
    expect(plays()).toBe(1);
    b.ws.close();
  }, 60000);
});
