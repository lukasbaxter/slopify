import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { artistRadio, setRadio, type RadioAsk } from './library.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-radio-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any;
let band: { id: string; name: string }; let ada: { id: string; name: string };

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  band = db.prepare("SELECT id, name FROM artists WHERE name = 'The Fixture Band'").get();
  ada = db.prepare("SELECT id, name FROM artists WHERE name = 'Ada Lovelace'").get();
  // Deezer: Ada Lovelace is related to The Fixture Band.
  vi.stubGlobal('fetch', async (url: string) => {
    const body = String(url).includes('/related') ? { data: [{ name: 'Ada Lovelace' }] } : { data: [{ id: 1, name: 'The Fixture Band' }] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}, 120000);
afterAll(async () => { vi.unstubAllGlobals(); await app.close(); });

const songsOf = (aid: string) => db.prepare('SELECT id FROM tracks WHERE artist_ids LIKE ?').all(`%"${aid}"%`).map((r: any) => r.id) as string[];
const artistsOf = (id: string) => JSON.parse(db.prepare('SELECT artist_ids FROM tracks WHERE id = ?').get(id).artist_ids) as string[];

describe('artist radio: the artist, related artists and the brain', () => {
  it('asks the brain with the artist\'s and the related artists\' songs, and mixes all three', async () => {
    const asked: { seeds: string[]; exclude: string[] }[] = [];
    const others = (db.prepare('SELECT id FROM tracks WHERE artist_ids NOT LIKE ?').all(`%"${band.id}"%`) as any[]).map((r) => r.id);
    const ask: RadioAsk = async (seeds, n, exclude) => { asked.push({ seeds, exclude }); return others.slice(0, n); };
    const out = (await artistRadio(db, band, 30, 'u-radio', ask)).map((t) => t.id);
    expect(asked).toHaveLength(1);
    expect(asked[0].seeds.some((s) => artistsOf(s).includes(band.id))).toBe(true);
    expect(asked[0].seeds.some((s) => artistsOf(s).includes(ada.id))).toBe(true);   // related artist seeds too
    expect(asked[0].exclude.sort()).toEqual(songsOf(band.id).sort());               // the brain adds others, not the artist
    expect(out.some((id) => artistsOf(id).includes(band.id))).toBe(true);
    expect(out.some((id) => artistsOf(id).includes(ada.id))).toBe(true);
    expect(new Set(out).size).toBe(out.length);
  });
  it('without the brain it is the old mix', async () => {
    const out = await artistRadio(db, band, 20, 'u-radio', async () => null);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('album and playlist radio', () => {
  it('opens on one of its songs, then the brain and related artists, none of its own again', async () => {
    const album = db.prepare('SELECT album_id a, COUNT(*) n FROM tracks GROUP BY album_id ORDER BY n DESC').get().a as string;
    const own = new Set((db.prepare('SELECT id FROM tracks WHERE album_id = ?').all(album) as any[]).map((r) => r.id));
    const pool = (db.prepare('SELECT id FROM tracks WHERE album_id != ?').all(album) as any[]).map((r) => r.id);
    let seeds: string[] = [];
    const out = (await setRadio(db, album, 25, async (s, n) => { seeds = s; return pool.slice(0, n); }))!.map((t) => t.id);
    expect(own.has(out[0])).toBe(true);
    expect(out.slice(1).every((id) => !own.has(id))).toBe(true);
    expect(seeds.every((id) => own.has(id))).toBe(true);
    expect(seeds.length).toBe(Math.min(own.size, 15));
    expect(out.length).toBeGreaterThan(1);
  });
  it('falls back to the old mix without the brain, and is null for an unknown id', async () => {
    const album = db.prepare('SELECT album_id a FROM tracks LIMIT 1').get().a as string;
    expect((await setRadio(db, album, 25, async () => null))!.length).toBeGreaterThan(0);
    expect(await setRadio(db, 'f'.repeat(32), 25, async () => null)).toBe(null);
  });
});
