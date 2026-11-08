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

// A bare server with just the session routes, on a real database whose kv
// writes are recorded; a fresh copy of session.ts each time (its state is
// per process), as a restart would have.
async function bareSession(db: DB, writes?: string[]) {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const websocket = (await import('@fastify/websocket')).default;
  const { registerSession, WS_MAX_PAYLOAD } = await import('./session.js');
  const spy: DB = writes ? new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        const st = target.prepare(sql);
        if (!/INTO kv/.test(sql)) return st;
        return new Proxy(st, { get(s, p) { if (p === 'run') return (...a: any[]) => { writes.push(a.map(String).join(' ')); return (s as any).run(...a); }; const v = (s as any)[p]; return typeof v === 'function' ? v.bind(s) : v; } });
      };
      const v = (target as any)[prop]; return typeof v === 'function' ? v.bind(target) : v;
    },
  }) : db;
  const app = Fastify();
  app.decorate('requireUser', (_req: any, _reply: any, done: any) => done());
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  registerSession(app, spy);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, port: (app.server.address() as any).port as number };
}
function bareDb() {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-sessbare-')));
  db.prepare("INSERT INTO users (id, name, pass_hash, role, must_change_pw, created) VALUES ('u_q', 'q', 'x', 'user', 0, 0)").run();
  db.prepare("INSERT INTO tokens (token, user_id, device, kind, created, last_seen) VALUES ('tok_q', 'u_q', 'web', 'web', 0, 0)").run();
  return db;
}
const until = async (ok: () => boolean, ms = 5000) => { for (let i = 0; i < ms / 25 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)); };

describe('saving the remembered session', () => {
  it('a now-playing report never rewrites the whole queue; only a changed queue does', async () => {
    const db = bareDb();
    const writes: string[] = [];
    const { app, port } = await bareSession(db, writes);
    try {
      const c = await connect(port, 'tok_q', 'c_saver_1');
      const queue = Array.from({ length: 3000 }, (_, i) => ({ Id: `t${i}`, Name: `QUEUE-MARKER ${i}` }));
      await c.send({ type: 'queue', queue });
      for (let i = 0; i < 3; i++) {
        await c.send({ type: 'nowplaying', nowPlaying: { itemId: 't0', title: 'T', playing: true, position: i * 2 } });
        await new Promise((r) => setTimeout(r, 1700)); // past the save debounce
      }
      const withQueue = writes.filter((w) => w.includes('QUEUE-MARKER'));
      expect(writes.length).toBeGreaterThanOrEqual(3);
      expect(withQueue.length).toBe(1);
      // A new queue is written again.
      await c.send({ type: 'queue', queue: queue.slice(0, 10) });
      await c.send({ type: 'nowplaying', nowPlaying: { itemId: 't0', title: 'T', playing: true, position: 8 } });
      await until(() => writes.filter((w) => w.includes('QUEUE-MARKER')).length === 2);
      expect(writes.filter((w) => w.includes('QUEUE-MARKER')).length).toBe(2);
      c.ws.close();
    } finally { await app.close(); }
    // What a restart brings back: the last queue and where it was.
    const again = await bareSession(db);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${again.port}/api/ws`);
      await new Promise((r) => ws.on('open', r));
      const got = new Promise<any>((resolve) => ws.on('message', (d: any) => { const m = JSON.parse(String(d)); if (m.type === 'session') resolve(m); }));
      ws.send(JSON.stringify({ type: 'hello', token: 'tok_q', clientId: 'c_saver_2', instance: 'i2', kind: 'web' }));
      const m = await got;
      expect(m.queue.length).toBe(10);
      expect(m.nowPlaying.itemId).toBe('t0');
      expect(m.nowPlaying.position).toBeGreaterThanOrEqual(8);
      ws.close();
    } finally { await again.app.close(); }
  }, 60000);
});
