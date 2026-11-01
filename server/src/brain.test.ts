import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { playTracker, type PlayEvent } from './playEvents.js';
import { config } from './config.js';

describe('play tracker', () => {
  const run = (steps: [number, any][], close = false) => {
    const out: PlayEvent[] = []; let t = 0;
    const tr = playTracker((e) => out.push(e), () => t);
    for (const [at, np] of steps) { t = at; tr.report('c1', 'u1', 'Phone', np); }
    if (close) tr.close('c1');
    return out;
  };
  // A client reports every 2 s while it plays.
  const playing = (id: string, from: number, to: number, duration: number): [number, any][] => {
    const out: [number, any][] = [];
    for (let t = from; t < to; t += 2000) out.push([t, { itemId: id, playing: true, position: (t - from) / 1000, duration }]);
    return out;
  };
  it('a song that plays to its end, then the next: ended, with the time it played', () => {
    const e = run([...playing('a', 0, 30000, 30), [30000, { itemId: 'b', playing: true, position: 0, duration: 200 }]]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ track_id: 'a', reason: 'ended', ms_played: 30000, end_ms: 28000 });
  });
  it('another song 20 s into a 3-minute one: skipped', () => {
    const e = run([...playing('a', 0, 20000, 180), [20000, { itemId: 'b', playing: true, position: 0, duration: 200 }]]);
    expect(e[0]).toMatchObject({ track_id: 'a', reason: 'skipped', ms_played: 20000 });
  });
  it('paused time does not count, and nothing playing or a disconnect is stopped', () => {
    const e = run([...playing('a', 0, 10000, 180), [10000, { itemId: 'a', playing: false, position: 10, duration: 180 }], [100000, { itemId: 'a', playing: true, position: 10, duration: 180 }], [102000, { itemId: 'a', playing: true, position: 12, duration: 180 }], [104000, null]]);
    expect(e[0]).toMatchObject({ reason: 'stopped', ms_played: 14000 });
    const d = run([[0, { itemId: 'a', playing: true, position: 0, duration: 180 }], [4000, { itemId: 'a', playing: true, position: 4, duration: 180 }]], true);
    expect(d[0]).toMatchObject({ reason: 'stopped', track_id: 'a' });
  });
  it('a long silence between reports (a sleeping phone) is not listening', () => {
    const e = run([[0, { itemId: 'a', playing: true, position: 0, duration: 600 }], [3600000, { itemId: 'b', playing: true, position: 0 }]]);
    expect(e[0].ms_played).toBeLessThanOrEqual(15000);
  });
});

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-brain-'));
let app: Awaited<ReturnType<typeof buildServer>>; let tok = '';
let fake: http.Server; let answer: (body: any) => any = () => ({ items: [] }); let asked: any = null;
const saved = { ...config.brain };

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      if (req.headers['x-brain-key'] !== 'test brain key') { res.writeHead(401).end(); return; }
      asked = JSON.parse(b); const out = answer(asked);
      if (out === 'hang') return; // never answers
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  Object.assign(config.brain, { url: `http://127.0.0.1:${(fake.address() as any).port}`, key: 'test brain key', timeoutMs: 500 });
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  await scanLibrary((app as any).db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
}, 120000);
afterAll(async () => { await app.close(); fake.close(); Object.assign(config.brain, saved); });

const ids = () => ((app as any).db.prepare('SELECT id FROM tracks ORDER BY id').all() as any[]).map((r) => r.id as string);

describe('brain', () => {
  it('its data routes want the key, not a sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/brain/catalog' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/brain/catalog', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/brain/catalog', headers: { 'x-brain-key': 'wrong' } })).statusCode).toBe(401);
    const c = (await app.inject({ method: 'GET', url: '/api/brain/catalog?limit=3', headers: { 'x-brain-key': 'test brain key' } })).json();
    expect(c.items).toHaveLength(3); expect(c.total).toBe(ids().length);
    const next = (await app.inject({ method: 'GET', url: `/api/brain/catalog?after=${c.items[2].seq}`, headers: { 'x-brain-key': 'test brain key' } })).json();
    expect(next.items[0].seq).toBeGreaterThan(c.items[2].seq);
    const a = await app.inject({ method: 'GET', url: `/api/brain/audio/${ids()[0]}`, headers: { 'x-brain-key': 'test brain key', range: 'bytes=0-99' } });
    expect(a.statusCode).toBe(206); expect(a.rawPayload.length).toBe(100);
  });
  it('a song\'s mix comes from the brain, in its order, with only songs that exist and the listener context sent along', async () => {
    const all = ids(); const want = [all[3], 'f'.repeat(32), all[1], all[2]];
    answer = () => ({ items: want });
    const r = (await app.inject({ method: 'GET', url: `/api/tracks/${all[0]}/mix?limit=10&mode=smart`, headers: { authorization: `Bearer ${tok}` } })).json();
    expect(r.from).toBe('brain');
    expect(r.items.map((t: any) => t.id)).toEqual([all[0], all[3], all[1], all[2]]);
    expect(asked).toMatchObject({ mode: 'smart', seeds: [all[0]], n: 9 });
    expect(asked.exclude).toContain(all[0]); expect(Array.isArray(asked.recent)).toBe(true); expect(asked.now).toBeGreaterThan(0);
  });
  it('a brain that is down, slow or empty-handed leaves the mix to the server', async () => {
    const all = ids();
    for (const a of [() => 'hang', () => ({ items: [] }), () => ({ items: ['f'.repeat(32)] })]) {
      answer = a as any;
      const t0 = Date.now();
      const r = (await app.inject({ method: 'GET', url: `/api/tracks/${all[0]}/mix?limit=10`, headers: { authorization: `Bearer ${tok}` } })).json();
      expect(r.from).toBeUndefined(); expect(r.items[0].id).toBe(all[0]); expect(r.items.length).toBeGreaterThan(1);
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });
});
