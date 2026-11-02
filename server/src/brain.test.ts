import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { playTracker, type PlayEvent } from './playEvents.js';
import { config } from './config.js';
import { brainLine } from './brain.js';

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
let trainedAt = 1000; let trainAsked = 0; let searched: any = null; let retried: string[] = []; let undecodable: string[] = [];
const saved = { ...config.brain };

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      if (req.headers['x-brain-key'] !== 'test brain key') { res.writeHead(401).end(); return; }
      const json = (x: any) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(x));
      if (req.url === '/train') { trainAsked++; setTimeout(() => { trainedAt += 1000; }, 200); json({ queued: true }); return; }
      if (req.url === '/search') { searched = JSON.parse(b); json({ items: ids().slice(0, 6).reverse().map((id, i) => ({ id, sound: 0.5 - i / 100 })) }); return; }
      if (req.url === '/undecodable') { json({ items: undecodable.map((id) => ({ id, artist: 'a', title: 't', error: 'no audio decoded' })) }); return; }
      if (req.url === '/retry') { retried = JSON.parse(b).ids; json({ retrying: retried.length }); return; }
      if (req.url === '/status') {
        json({ phase: 'listening', songs: 10, heard: 4, left: 6, eta_s: 7200, undecodable: undecodable.length, paused: null,
          last_train: { trained_at: trainedAt, metrics: { 'hit@10': 0.106 }, baselines: { old_mix: { 'hit@10': 0.006 } } } });
        return;
      }
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
  it('the brain is not rate limited, a visitor is', async () => {
    const saved = config.rateMax; config.rateMax = 5;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-brain-rl-'));
    const small = await buildServer({ dataDir: dir, musicDir: MUSIC });
    try {
      const codes = async (headers: any) => { const out: number[] = []; for (let i = 0; i < 12; i++) out.push((await small.inject({ method: 'GET', url: '/api/brain/catalog?limit=1', headers })).statusCode); return out; };
      expect(await codes({ 'x-brain-key': 'test brain key' })).not.toContain(429);
      expect(await codes({ 'x-brain-key': 'wrong' })).toContain(429);
    } finally { await small.close(); config.rateMax = saved; }
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

describe('the Brain task', () => {
  const admin = () => ({ authorization: `Bearer ${tok}` });
  const brainKey = { 'x-brain-key': 'test brain key' };
  it('holds the household\'s rules, which the brain reads with the time zone and whether anyone is listening', async () => {
    const tasks = (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: admin() })).json().tasks;
    const brain = tasks.find((t: any) => t.id === 'brain');
    expect(brain.schedule).toEqual({ mode: 'daily', at: '04:00' });
    expect(brain.settings.map((x: any) => x.key)).toEqual(['enabled', 'power', 'fromHour', 'toHour', 'pauseListening', 'otherGb', 'pauseEncoding', 'location']);
    expect(brain.info).toBe('Connecting…');
    const put = await app.inject({ method: 'PUT', url: '/api/admin/tasks/brain/settings', headers: admin(), payload: { values: { power: 'light', location: '  Victoria, BC  ', otherGb: 999, fromHour: 1, toHour: 7 } } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/tasks/brain/settings', headers: admin(), payload: { values: { power: 'turbo' } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/brain/settings', headers: admin() })).statusCode).toBe(401);
    const got = (await app.inject({ method: 'GET', url: '/api/brain/settings', headers: brainKey })).json();
    expect(got.settings).toMatchObject({ enabled: true, power: 'light', location: 'Victoria, BC', otherGb: 256, fromHour: 1, toHour: 7, pauseListening: false });
    expect(typeof got.tz).toBe('string'); expect(got.listening).toBe(false);
    await app.inject({ method: 'GET', url: `/api/stream/${ids()[0]}`, headers: { ...admin(), range: 'bytes=0-9' } });
    expect((await app.inject({ method: 'GET', url: '/api/brain/settings', headers: brainKey })).json().listening).toBe(true);
  });
  it('turned off, the brain is not asked and the mix is the server\'s own', async () => {
    await app.inject({ method: 'PUT', url: '/api/admin/tasks/brain/settings', headers: admin(), payload: { values: { enabled: false } } });
    try {
      answer = () => ({ items: [ids()[2]] }); asked = null;
      const r = (await app.inject({ method: 'GET', url: `/api/tracks/${ids()[0]}/mix?limit=10`, headers: admin() })).json();
      expect(r.from).toBeUndefined(); expect(asked).toBeNull();
    } finally {
      await app.inject({ method: 'PUT', url: '/api/admin/tasks/brain/settings', headers: admin(), payload: { values: { enabled: true } } });
    }
  });
  it('Run now retrains it and says how the new model did', async () => {
    const before = trainAsked;
    expect((await app.inject({ method: 'POST', url: '/api/admin/tasks/brain/run', headers: admin() })).statusCode).toBe(200);
    let brain: any;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      brain = (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: admin() })).json().tasks.find((t: any) => t.id === 'brain');
      if (!brain.running && brain.last) break;
    }
    expect(trainAsked).toBe(before + 1);
    expect(brain.last).toMatchObject({ ok: true, summary: 'next song in its top 10 10.6% of the time (old mix 0.6%)' });
    expect(brain.info).toBe('Heard 4 of 10 songs, about 2 h to go · Next song in its top 10: 10.6% (old mix 0.6%)');
  }, 30000);
  it('its row says what the brain is doing in one line', () => {
    expect(brainLine(null, 'ECONNREFUSED')).toBe("Can't reach it: ECONNREFUSED");
    expect(brainLine({ songs: 143443, heard: 143425, left: 0, undecodable: 18, phase: 'idle', weather_now: 'raining, 9 C', place: 'Victoria, British Columbia, Canada' }, null))
      .toBe('Heard all 143,425 songs · raining, 9 C in Victoria, British Columbia, Canada · 18 won\'t decode');
    expect(brainLine({ songs: 100, heard: 10, left: 90, eta_s: 300, paused: 'paused while someone is listening', phase: 'paused' }, null))
      .toBe('Heard 10 of 100 songs · Paused while someone is listening');
  });
});

describe('the brain and generated playlists', () => {
  const admin = () => ({ authorization: `Bearer ${tok}` });
  it('with no Anthropic key the brain makes the playlist: songs that sound like the request, in its order', async () => {
    const st = (await app.inject({ method: 'GET', url: '/api/ai/status', headers: admin() })).json();
    expect(st).toMatchObject({ ok: true, by: 'brain' });
    const job = (await app.inject({ method: 'POST', url: '/api/ai/playlists', headers: admin(), payload: { prompt: 'rainy sunday morning, soft guitar' } })).json();
    let j: any;
    for (let i = 0; i < 50; i++) { j = (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: admin() })).json(); if (j.state !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
    expect(j.state).toBe('done');
    expect(searched).toMatchObject({ text: 'rainy sunday morning, soft guitar' }); expect(Array.isArray(searched.recent)).toBe(true);
    const tracks = (app as any).db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(j.result.playlistId).map((r: any) => r.track_id);
    const want = ids().slice(0, 6).reverse();
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks[0]).toBe(want[0]);                                    // its best match leads
    expect(tracks.every((id: string) => want.includes(id))).toBe(true); // nothing it did not offer
    expect((app as any).db.prepare('SELECT name FROM playlists WHERE id = ?').get(j.result.playlistId).name).toBe('Rainy sunday morning, soft guitar');
  });
  it('Regenerate fills the same playlist again from a changed request; a name the person gave it stays', async () => {
    const db = (app as any).db;
    const run = async (payload: any) => {
      const job = (await app.inject({ method: 'POST', url: '/api/ai/playlists', headers: admin(), payload })).json();
      let j: any;
      for (let i = 0; i < 50; i++) { j = (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: admin() })).json(); if (j.state !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
      expect(j.state).toBe('done'); return j.result;
    };
    const first = await run({ prompt: 'warm dub techno' });
    const pl = (await app.inject({ method: 'GET', url: `/api/playlists/${first.playlistId}`, headers: admin() })).json();
    expect(pl.aiPrompt).toBe('warm dub techno');
    const count = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
    db.prepare('INSERT INTO ai_pending (playlist_id, artist, title, release, requested) VALUES (?, ?, ?, ?, ?)').run(first.playlistId, 'x', 'y', 'z', Date.now());
    const again = await run({ prompt: 'colder dub techno', playlistId: first.playlistId });
    expect(again).toMatchObject({ playlistId: first.playlistId, regenerated: true, name: 'Colder dub techno' });
    expect(db.prepare('SELECT COUNT(*) n FROM playlists').get().n).toBe(count);     // not a new one
    expect(searched.text).toBe('colder dub techno');
    expect((await app.inject({ method: 'GET', url: `/api/playlists/${first.playlistId}`, headers: admin() })).json()).toMatchObject({ aiPrompt: 'colder dub techno', name: 'Colder dub techno' });
    expect(db.prepare('SELECT COUNT(*) n FROM ai_pending WHERE playlist_id = ?').get(first.playlistId).n).toBe(0);
    // Renamed by the person: the name is theirs from then on.
    await app.inject({ method: 'PATCH', url: `/api/playlists/${first.playlistId}`, headers: admin(), payload: { name: 'Night bus' } });
    expect((await run({ prompt: 'warmer again', playlistId: first.playlistId })).name).toBe('Night bus');
    expect((await app.inject({ method: 'POST', url: '/api/ai/playlists', headers: admin(), payload: { prompt: 'whatever', playlistId: 'nope' } })).statusCode).toBe(404);
  });
  it("songs the brain could not hear are checked by decoding them, and handed back", async () => {
    undecodable = [ids()[1]]; retried = [];
    await app.inject({ method: 'POST', url: '/api/admin/tasks/brain/run', headers: admin() });
    for (let i = 0; i < 50 && !retried.length; i++) await new Promise((r) => setTimeout(r, 100));
    expect((app as any).db.prepare('SELECT kind FROM song_checks WHERE track_id = ?').get(ids()[1])).toMatchObject({ kind: 'fine' });
    expect(retried).toEqual([ids()[1]]);
    undecodable = [];
  }, 30000);
});
