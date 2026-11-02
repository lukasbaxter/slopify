import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { dailyMix, dayOf, type MakeMix } from './dailymix.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dailymix-'));
let app: Awaited<ReturnType<typeof buildServer>>; let tok = ''; let db: any;
let artist = ''; let songs: string[] = [];

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
  artist = db.prepare("SELECT id FROM artists WHERE name = 'The Fixture Band'").get().id;
  songs = db.prepare('SELECT id FROM tracks ORDER BY id').all().map((r: any) => r.id);
}, 120000);
afterAll(async () => { await app.close(); });

// A maker that hands out a different list every time it is called, and counts.
const maker = () => {
  const calls: (string[] | undefined)[] = [];
  const make: MakeMix = async (sounds) => { calls.push(sounds); const k = calls.length; return songs.slice(k % songs.length).concat(songs.slice(0, k % songs.length)).slice(0, 8).map((id) => ({ id })); };
  return { make, calls };
};
const at = (iso: string) => new Date(iso).getTime();

describe('Daily Mix: truly daily', () => {
  it('the listener\'s calendar day, from the browser\'s offset', () => {
    expect(dayOf(at('2026-11-02T06:30:00Z'), 420)).toBe('2026-11-01'); // 23:30 at UTC-7
    expect(dayOf(at('2026-11-02T07:30:00Z'), 420)).toBe('2026-11-02');
    expect(dayOf(at('2026-11-01T23:30:00Z'), -120)).toBe('2026-11-02'); // 01:30 at UTC+2
  });

  it('the same songs all day, through a restart, and new ones the next day', async () => {
    const u = 'u-same-day'; const { make, calls } = maker();
    const a = await dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-01T08:00:00Z'), brain: false });
    const b = await dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-01T23:59:00Z'), brain: false });
    expect(b.ids).toEqual(a.ids); expect(calls).toHaveLength(1); expect(a.day).toBe('2026-11-01');
    // a restart: only the database is left, nothing gets made again
    const never: MakeMix = async () => { throw new Error('made again'); };
    expect((await dailyMix(db, artist, u, never, { tzo: 0, now: at('2026-11-01T20:00:00Z'), brain: false })).ids).toEqual(a.ids);
    const c = await dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-02T00:01:00Z'), brain: false });
    expect(calls).toHaveLength(2); expect(c.day).toBe('2026-11-02'); expect(c.ids).not.toEqual(a.ids);
    const d = await dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-02T12:00:00Z'), brain: false });
    expect(d.ids).toEqual(c.ids); expect(calls).toHaveLength(2);
  });

  it('the day turns at the listener\'s midnight, not the server\'s', async () => {
    const u = 'u-tz'; const { make, calls } = maker();
    const a = await dailyMix(db, artist, u, make, { tzo: 420, now: at('2026-11-01T20:00:00Z'), brain: false }); // 13:00 at UTC-7
    // 06:30 UTC on the 2nd is still the 1st at UTC-7: the same mix
    expect((await dailyMix(db, artist, u, make, { tzo: 420, now: at('2026-11-02T06:30:00Z'), brain: false })).ids).toEqual(a.ids);
    expect(calls).toHaveLength(1);
    // the offset rides along once; a request without it keeps the listener's day
    expect((await dailyMix(db, artist, u, make, { now: at('2026-11-02T06:45:00Z'), brain: false })).day).toBe('2026-11-01');
    expect(calls).toHaveLength(1);
    const b = await dailyMix(db, artist, u, make, { tzo: 420, now: at('2026-11-02T07:05:00Z'), brain: false }); // 00:05 local
    expect(b.day).toBe('2026-11-02'); expect(calls).toHaveLength(2); expect(b.ids).not.toEqual(a.ids);
  });

  it('two at once on a new day make one mix', async () => {
    const u = 'u-race'; const { make, calls } = maker();
    const [a, b] = await Promise.all([1, 2].map(() => dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-05T09:00:00Z'), brain: false })));
    expect(a.ids).toEqual(b.ids); expect(calls).toHaveLength(1);
  });

  it('a disliked song leaves today\'s mix', async () => {
    const u = 'u-dislike'; const { make } = maker();
    const a = await dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-01T08:00:00Z'), brain: false });
    db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run(u, JSON.stringify({ dislikes: { [a.ids[1]]: 1 } }), 1);
    const b = await dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-01T09:00:00Z'), brain: false });
    expect(b.ids).toEqual(a.ids.filter((id) => id !== a.ids[1]));
  });
});

describe('Daily Mix from the brain (BRAIN_DAILY_MIXES)', () => {
  const brainOpts = (fetcher: any, timeoutMs = 1500) => ({ url: 'http://brain.test', key: 'k', fetcher, timeoutMs });

  it('opted in: the songs that sound like the artist\'s, asked of /similar with the artist\'s songs as seeds', async () => {
    const u = 'u-brain'; const { make, calls } = maker();
    let asked: any = null, url = '';
    const theirs = db.prepare('SELECT id FROM tracks WHERE artist_ids LIKE ?').all(`%"${artist}"%`).map((r: any) => r.id);
    const picks = songs.filter((id) => !theirs.includes(id)).slice(0, 3);
    const fetcher = async (u: string, init: any) => { url = u; asked = JSON.parse(init.body); return new Response(JSON.stringify({ items: [...picks, 'f'.repeat(32)] })); };
    const m = await dailyMix(db, artist, u, make, { tzo: 0, now: at('2026-11-01T08:00:00Z'), brain: true, brainOpts: brainOpts(fetcher) });
    expect(url).toBe('http://brain.test/similar');
    expect(m.from).toBe('brain'); expect(calls).toEqual([picks]); // only songs this library has
    expect(asked.seeds.length).toBeGreaterThan(0);
    for (const s of asked.seeds) expect(theirs).toContain(s);
    expect(asked.user).toBe(u); expect(typeof asked.seed).toBe('number');
  });

  it('a brain that errors, hangs or is off: the usual mix, quickly', async () => {
    const answers = [
      async () => { throw new Error('ECONNREFUSED'); },
      async () => new Response('no model yet', { status: 503 }),
      (_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' })))),
    ];
    for (const [i, f] of answers.entries()) {
      const { make, calls } = maker();
      const t0 = Date.now();
      const m = await dailyMix(db, artist, `u-down-${i}`, make, { tzo: 0, now: at('2026-11-01T08:00:00Z'), brain: true, brainOpts: brainOpts(f, 200) });
      expect(m.from).toBe('own'); expect(calls).toEqual([undefined]); expect(m.ids.length).toBeGreaterThan(0);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
    // not opted in: the brain is never asked
    let hit = false; const { make } = maker();
    const m = await dailyMix(db, artist, 'u-off', make, { tzo: 0, now: at('2026-11-01T08:00:00Z'), brain: false, brainOpts: brainOpts(async () => { hit = true; return new Response('{}'); }) });
    expect(hit).toBe(false); expect(m.from).toBe('own');
  });
});

describe('Daily Mix over the API', () => {
  it('Home\'s mix and its page agree, and stay put for the day', async () => {
    const get = async (limit: number) => (await app.inject({ method: 'GET', url: `/api/tracks/${artist}/mix?limit=${limit}&tzo=${new Date().getTimezoneOffset()}`, headers: { authorization: `Bearer ${tok}` } })).json();
    const a = await get(20), b = await get(20), c = await get(5);
    expect(a.items.length).toBeGreaterThan(3); expect(a.items[0].artistIds).toContain(artist);
    expect(b.items.map((t: any) => t.id)).toEqual(a.items.map((t: any) => t.id));
    expect(c.items.map((t: any) => t.id)).toEqual(a.items.slice(0, 5).map((t: any) => t.id));
    expect(a.from).toBe('own'); expect(a.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
