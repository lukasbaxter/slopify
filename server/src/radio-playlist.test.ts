import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { arrangeRadio, type TrackRow } from './library.js';
import { radioFor, radioSeed, RADIO_FRESH_MS } from './radio.js';
import { lbSimilarInLibrary, relatedInLibrary } from './discover.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-radiopl-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any; let tok = ''; let me = '';
let band: { id: string; name: string }; let ada: { id: string; name: string };

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
  me = db.prepare("SELECT id FROM users WHERE name = 'admin'").get().id;
  band = db.prepare("SELECT id, name FROM artists WHERE name = 'The Fixture Band'").get();
  ada = db.prepare("SELECT id, name FROM artists WHERE name = 'Ada Lovelace'").get();
  // Deezer: Ada Lovelace is related to The Fixture Band; nothing from MusicBrainz.
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url);
    const body = u.includes('/related') ? { data: [{ name: 'Ada Lovelace' }] } : u.includes('deezer') ? { data: [{ id: 1, name: 'The Fixture Band' }] } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
}, 120000);
afterAll(async () => { vi.unstubAllGlobals(); await app.close(); });

const as = { authorization: () => ({ authorization: `Bearer ${tok}` }) };
const post = async (id: string, q = '') => app.inject({ method: 'POST', url: `/api/radio/${id}${q}`, headers: as.authorization() });
const artistsOf = (t: any) => (t.artistIds ?? JSON.parse(t.artist_ids)) as string[];
const noBackToBack = (items: any[]) => items.every((t, i) => i === 0 || !artistsOf(t).some((a) => artistsOf(items[i - 1]).includes(a)));

describe('Go to radio: a radio playlist per listener and seed', () => {
  it('an artist: up to 50 songs, opening on theirs, never one artist twice in a row, no repeats', async () => {
    const r = await post(band.id);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.id).toBe(`radio:${band.id}`);
    expect(j.seed).toMatchObject({ kind: 'artist', id: band.id, name: band.name, artistId: band.id });
    expect(j.items.length).toBeGreaterThan(10); expect(j.items.length).toBeLessThanOrEqual(50);
    expect(artistsOf(j.items[0])).toContain(band.id);
    expect(new Set(j.items.map((t: any) => t.id)).size).toBe(j.items.length);
    expect(noBackToBack(j.items)).toBe(true);
    expect(j.items.some((t: any) => artistsOf(t).includes(ada.id))).toBe(true); // related artist (Deezer)
    // The artist recurs but does not take over.
    const theirs = j.items.filter((t: any) => artistsOf(t).includes(band.id)).length;
    expect(theirs).toBeGreaterThan(1); expect(theirs).toBeLessThanOrEqual(Math.ceil(j.items.length / 2));
    expect(j.artists[0]).toEqual({ id: band.id, name: band.name });
  });

  it('is kept: the same radio again, a new one on refresh, never a playlist in Your Library', async () => {
    const a = (await post(band.id)).json(), b = (await post(band.id)).json();
    expect(b.made).toBe(a.made); expect(b.items.map((t: any) => t.id)).toEqual(a.items.map((t: any) => t.id));
    const c = (await post(band.id, '?refresh=1')).json();
    expect(c.made).toBeGreaterThanOrEqual(a.made);
    expect(db.prepare('SELECT COUNT(*) n FROM radios WHERE user_id = ? AND seed_id = ?').get(me, band.id).n).toBe(1);
    const pls = (await app.inject({ url: '/api/playlists', headers: as.authorization() })).json().items;
    expect(pls.some((p: any) => /radio/i.test(p.name) || p.id.startsWith('radio'))).toBe(false);
  });

  it('a day old, it is made again', async () => {
    const seed = radioSeed(db, ada.id, me)!;
    const calls: string[][] = [];
    const ask = async (s: string[]) => { calls.push(s); return null; };
    const t0 = Date.parse('2026-11-01T08:00:00Z');
    const a = await radioFor(db, seed, me, ask, { now: t0 });
    await radioFor(db, seed, me, ask, { now: t0 + RADIO_FRESH_MS - 1000 });
    expect(calls).toHaveLength(1);
    const c = await radioFor(db, seed, me, ask, { now: t0 + RADIO_FRESH_MS + 1000 });
    expect(calls).toHaveLength(2); expect(c!.made).toBeGreaterThan(a!.made);
    await radioFor(db, seed, me, ask, { now: t0 + RADIO_FRESH_MS + 2000, refresh: true });
    expect(calls).toHaveLength(3);
  });

  it('a song opens its own radio; an album opens on one of its songs and repeats none of them', async () => {
    const song = db.prepare('SELECT id, album_id FROM tracks WHERE artist_ids LIKE ? LIMIT 1').get(`%"${ada.id}"%`);
    const s = (await post(song.id)).json();
    expect(s.seed.kind).toBe('track'); expect(s.items[0].id).toBe(song.id); expect(noBackToBack(s.items)).toBe(true);
    const album = db.prepare('SELECT album_id a FROM tracks WHERE artist_ids LIKE ? LIMIT 1').get(`%"${band.id}"%`).a;
    const inAlbum = new Set(db.prepare('SELECT id FROM tracks WHERE album_id = ?').all(album).map((r: any) => r.id));
    const al = (await post(album)).json();
    expect(al.seed.kind).toBe('album'); expect(inAlbum.has(al.items[0].id)).toBe(true);
    expect(al.items.slice(1).every((t: any) => !inAlbum.has(t.id))).toBe(true);
  });

  it('never a disliked song; someone else\'s playlist or an unknown id is a 404', async () => {
    const theirs = db.prepare('SELECT id FROM tracks WHERE artist_ids LIKE ?').all(`%"${band.id}"%`).map((r: any) => r.id);
    const dis = Object.fromEntries(theirs.slice(0, 5).map((id: string) => [id, 1]));
    await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { dislikes: dis }, headers: as.authorization() });
    const j = (await post(band.id, '?refresh=1')).json();
    expect(j.items.some((t: any) => dis[t.id])).toBe(false);
    await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { dislikes: {} }, headers: as.authorization() });
    db.prepare("INSERT INTO playlists (id, user_id, name, created, updated) VALUES ('pl_other', 'someone-else', 'Theirs', 1, 1)").run();
    expect((await post('pl_other')).statusCode).toBe(404);
    expect((await post('f'.repeat(32))).statusCode).toBe(404);
  });

  it('the brain leads when it answers; without it the list is still made', async () => {
    const seed = radioSeed(db, band.id, me)!;
    const others = db.prepare('SELECT id FROM tracks WHERE artist_ids NOT LIKE ?').all(`%"${band.id}"%`).map((r: any) => r.id);
    const asked: { n: number; exclude: string[] }[] = [];
    const r = await radioFor(db, seed, me, async (_s, n, exclude) => { asked.push({ n, exclude }); return others; }, { refresh: true });
    expect(r!.from).toBe('brain'); expect(asked[0].n).toBeGreaterThanOrEqual(50);
    const off = await radioFor(db, seed, me, async () => null, { refresh: true });
    expect(off!.from).toBe('own'); expect(off!.ids.length).toBeGreaterThan(10);
  });
});

describe('related artists: ListenBrainz and Deezer', () => {
  const ok = (body: any) => new Response(JSON.stringify(body), { status: 200 });
  it('ListenBrainz\'s similar artists, by MusicBrainz id, only the ones the library has, best first', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('musicbrainz.org')) return ok({ artists: [{ id: 'mb-band', name: 'The Fixture Band', score: 100 }] });
      return ok([{ name: 'Not Here', score: 900 }, { name: 'Ada Lovelace', score: 500 }]);
    }) as any;
    const got = await lbSimilarInLibrary(db, { id: 'x-band', name: band.name }, { fetcher });
    expect(got).toEqual([{ id: ada.id, name: ada.name }]);
    expect(urls.some((u) => u.includes('labs.api.listenbrainz.org/similar-artists') && u.includes('mb-band'))).toBe(true);
  });
  it('a ListenBrainz that fails leaves Deezer\'s list', async () => {
    const fetcher = (async (url: string) => {
      const u = String(url);
      if (u.includes('listenbrainz') || u.includes('musicbrainz')) throw new Error('ENOTFOUND');
      return ok(u.includes('/related') ? { data: [{ name: 'Ada Lovelace' }] } : { data: [{ id: 2, name: 'The Fixture Band' }] });
    }) as any;
    expect(await relatedInLibrary(db, { id: 'y-band', name: band.name }, { fetcher })).toEqual([{ id: ada.id, name: ada.name }]);
  });
});

describe('the radio\'s order', () => {
  const row = (id: string, artist: string, title = id): TrackRow => ({ id, title, artist, artists: JSON.stringify([artist]), artist_ids: JSON.stringify([artist]), album_id: 'al', album: 'Al', album_artist: artist,
    track_no: 1, disc_no: 1, year: 2000, genres: '[]', duration_ms: 1, codec: null, bitrate: null, identity_state: 'ok', identity_score: 1, added_at: 0 });
  it('50 songs: the seed first, its artist every fourth, nobody twice in a row or more than three times, no dislikes or repeats', () => {
    const seedSongs = Array.from({ length: 40 }, (_, i) => row(`s${i}`, 'seed'));
    const others = Array.from({ length: 120 }, (_, i) => row(`o${i}`, `a${i % 15}`));
    const skip = new Set(['o0', 's1']);
    const out = arrangeRadio(row('lead', 'seed'), seedSongs, others, 50, { skip });
    expect(out).toHaveLength(50);
    expect(out[0].id).toBe('lead');
    expect(noBackToBack(out)).toBe(true);
    expect(new Set(out.map((t) => t.id)).size).toBe(50);
    expect(out.some((t) => skip.has(t.id))).toBe(false);
    const seedN = out.filter((t) => t.artist === 'seed').length;
    expect(seedN).toBeGreaterThanOrEqual(10); expect(seedN).toBeLessThanOrEqual(15);
    const per = new Map<string, number>(); for (const t of out) per.set(t.artist, (per.get(t.artist) || 0) + 1);
    for (const [a, n] of per) if (a !== 'seed') expect(n).toBeLessThanOrEqual(3);
  });
  it('one copy of a song: a live take or a remaster of the same title is the same song', () => {
    const out = arrangeRadio(row('lead', 'seed'), [], [row('o1', 'x', 'Song'), row('o2', 'y'), row('o3', 'x', 'Song (Live)'), row('o4', 'x', 'Song - 2011 Remaster'), row('o5', 'z')], 50);
    expect(out.map((t) => t.id)).toEqual(['lead', 'o1', 'o2', 'o5']);
  });
  it('stops short rather than play one artist twice in a row', () => {
    const out = arrangeRadio(row('lead', 'seed'), [row('s1', 'seed'), row('s2', 'seed')], [row('o1', 'x')], 50);
    expect(out.map((t) => t.id)).toEqual(['lead', 'o1', 's1']);
  });
});
