// The Daily Mix must look new each day: before this, every day's mix opened
// on the listener's most played song of the artist and put their favourites
// back in the same places (prod 11-13 vs 11-14 rebuilt with the live code:
// 17 of 17 of the artist's songs on the page in the same slots), and Home's
// tile said only "<artist> and more", the same every day.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dmrot-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any; let tok = ''; let me = '';
let band = ''; let theirs: string[] = [];

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
  me = db.prepare("SELECT id FROM users WHERE name = 'admin'").get().id;
  band = db.prepare("SELECT id FROM artists WHERE name = 'The Fixture Band'").get().id;
  theirs = db.prepare('SELECT id FROM tracks WHERE artist_ids LIKE ? ORDER BY id').all(`%"${band}"%`).map((r: any) => r.id);
  // A clear favourite order: song i played 30 - 2i times.
  const ins = db.prepare('INSERT INTO plays (user_id, track_id, at) VALUES (?, ?, ?)');
  theirs.slice(0, 12).forEach((id, i) => { for (let k = 0; k < 30 - 2 * i; k++) ins.run(me, id, Date.parse('2026-10-01T00:00:00Z') + i * 1000 + k); });
  // No Deezer, no ListenBrainz: the mix stays inside this library.
  vi.stubGlobal('fetch', async () => new Response('{"data":[]}', { status: 200 }));
}, 120000);
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { vi.unstubAllGlobals(); await app.close(); });

const mixOn = async (iso: string, limit = 50) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso));
  const r = (await app.inject({ url: `/api/tracks/${band}/mix?limit=${limit}&tzo=0`, headers: { authorization: `Bearer ${tok}` } })).json();
  vi.useRealTimers();
  return r;
};
const ownOrder = (m: any) => m.items.map((t: any) => t.id).filter((id: string) => theirs.includes(id));

describe('Daily Mix: new each day, the same all day', () => {
  it('opens on a different favourite each day and puts the artist\'s songs in a new order', async () => {
    const days = ['2026-11-10', '2026-11-11', '2026-11-12'];
    const mixes = [];
    for (const d of days) mixes.push(await mixOn(`${d}T09:00:00Z`));
    const leads = mixes.map((m) => m.items[0].id);
    expect(new Set(leads).size).toBe(3);                         // a new opener every day
    for (const l of leads) expect(theirs.slice(0, 7)).toContain(l); // always one of their favourites
    expect(ownOrder(mixes[1])).not.toEqual(ownOrder(mixes[0]));
    expect(ownOrder(mixes[2])).not.toEqual(ownOrder(mixes[1]));
    // Same day, later: the same mix.
    const again = await mixOn('2026-11-12T22:00:00Z');
    expect(again.items.map((t: any) => t.id)).toEqual(mixes[2].items.map((t: any) => t.id));
  });

  it('says who is in it, the artist first', async () => {
    const m = await mixOn('2026-11-12T23:00:00Z');
    expect(m.artists[0].id).toBe(band);
  });

  it('Home\'s tiles: today\'s mix of each seed, made now on a new day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-20T09:00:00Z'));
    const r = await app.inject({ url: `/api/daily-mixes?ids=${band},${'f'.repeat(32)}&tzo=0`, headers: { authorization: `Bearer ${tok}` } });
    vi.useRealTimers();
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.items).toHaveLength(1);
    expect(j.items[0]).toMatchObject({ artistId: band, day: '2026-11-20' });
    expect(j.items[0].artists[0].id).toBe(band);
    expect(db.prepare('SELECT day FROM daily_mixes WHERE user_id = ? AND artist_id = ?').get(me, band).day).toBe('2026-11-20');
  });
});
