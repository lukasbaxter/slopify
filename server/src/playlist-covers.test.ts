// A playlist's picture, Spotify's way (mosaic.ts): a 2x2 grid of the first
// 4 different album covers, else the first song's cover.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import sharp from 'sharp';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-covers-'));
let app: Awaited<ReturnType<typeof buildServer>>; let tok = ''; let db: any; let me = '';
const send = (method: any, url: string, payload?: any, t = tok) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${t}` } });
const get = (url: string, t = tok) => send('GET', url, undefined, t);
let albums: { id: string; name: string; cover_hash: string }[] = [];
const songsOf = (albumId: string) => (db.prepare('SELECT id FROM tracks WHERE album_id = ? ORDER BY disc_no, track_no').all(albumId) as any[]).map((r) => r.id as string);

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
  me = db.prepare("SELECT id FROM users WHERE name = 'admin'").get().id;
  // Albums with covers that differ from each other (the mistagged song's album shares its folder's cover).
  const all = db.prepare("SELECT id, name, cover_hash FROM albums WHERE cover_hash IS NOT NULL ORDER BY name").all() as any[];
  const seen = new Set<string>();
  albums = all.filter((a) => !seen.has(a.cover_hash) && seen.add(a.cover_hash));
}, 120000);
afterAll(async () => { await app.close(); });

describe('playlist covers, Spotify\'s way', () => {
  const make = async (name: string, ids: string[]) => (await send('POST', '/api/playlists', { name, trackIds: ids })).json().id as string;
  const coverOf = async (id: string) => (await get('/api/playlists')).json().items.find((p: any) => p.id === id).cover;
  const pixel = async (buf: Buffer, x: number, y: number) => { const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 12);
  const albumPixel = async (a: { cover_hash: string }) => pixel(fs.readFileSync(path.join(DATA, 'art', a.cover_hash, '640.jpg')), 320, 320);

  it('the fixture has 4 albums with different covers', () => { expect(albums.length).toBeGreaterThanOrEqual(4); });

  it('1 to 3 songs: the first song\'s album cover fills it', async () => {
    const one = await make('one', [songsOf(albums[1].id)[0]]);
    expect(await coverOf(one)).toBe(albums[1].cover_hash);
    const three = await make('three', [songsOf(albums[2].id)[0], songsOf(albums[0].id)[0], songsOf(albums[1].id)[0]]);
    expect(await coverOf(three)).toBe(albums[2].cover_hash);
  });

  it('many songs from fewer than 4 albums: still the first song\'s cover', async () => {
    const ids = [...songsOf(albums[0].id), ...songsOf(albums[1].id), ...songsOf(albums[2].id)];
    expect(await coverOf(await make('three albums', ids))).toBe(albums[0].cover_hash);
  });

  it('4 or more albums: a 2x2 grid of the first 4 different covers, in playlist order', async () => {
    // album 3's songs first, then 3 again (no repeat in the grid), 0, 1, 2
    const ids = [songsOf(albums[3].id)[0], songsOf(albums[3].id)[1], songsOf(albums[0].id)[0], songsOf(albums[1].id)[0], songsOf(albums[2].id)[0]];
    const id = await make('grid', ids);
    const hash = await coverOf(id);
    expect(albums.map((a) => a.cover_hash)).not.toContain(hash);
    const r = await app.inject({ method: 'GET', url: `/api/image/${id}?size=640`, headers: { accept: 'image/jpeg' } });
    expect(r.statusCode).toBe(200);
    const img = r.rawPayload;
    expect((await sharp(img).metadata()).width).toBe(640);
    expect(near(await pixel(img, 160, 160), await albumPixel(albums[3]))).toBe(true);
    expect(near(await pixel(img, 480, 160), await albumPixel(albums[0]))).toBe(true);
    expect(near(await pixel(img, 160, 480), await albumPixel(albums[1]))).toBe(true);
    expect(near(await pixel(img, 480, 480), await albumPixel(albums[2]))).toBe(true);
    // the other sizes too, webp included
    for (const s of [64, 160, 320]) {
      const x = await app.inject({ method: 'GET', url: `/api/image/${id}?size=${s}`, headers: { accept: 'image/webp' } });
      expect(x.statusCode).toBe(200);
      expect((await sharp(x.rawPayload).metadata()).width).toBe(s);
    }
    // bigger than 640: the 640 grid
    expect((await app.inject({ method: 'GET', url: `/api/image/${id}?size=1280` })).statusCode).toBe(200);
  });

  it('the picture follows the songs: a new grid when they change, and no client keeps the old one', async () => {
    const id = await make('changing', [songsOf(albums[0].id)[0]]);
    const first = await app.inject({ method: 'GET', url: `/api/image/${id}?size=320` });
    expect(first.headers['cache-control']).toMatch(/no-cache/);
    const tag = String(first.headers.etag);
    expect((await app.inject({ method: 'GET', url: `/api/image/${id}?size=320`, headers: { 'if-none-match': tag } })).statusCode).toBe(304);
    const before = await coverOf(id);
    await send('POST', `/api/playlists/${id}/tracks`, { trackIds: [songsOf(albums[1].id)[0], songsOf(albums[2].id)[0], songsOf(albums[3].id)[0]] });
    const after = await coverOf(id);
    expect(after).not.toBe(before);
    const again = await app.inject({ method: 'GET', url: `/api/image/${id}?size=320`, headers: { 'if-none-match': tag } });
    expect(again.statusCode).toBe(200);
    expect(String(again.headers.etag)).not.toBe(tag);
    // removing a song back to 3 albums: the first song's cover again
    await send('DELETE', `/api/playlists/${id}/tracks/3`);
    expect(await coverOf(id)).toBe(albums[0].cover_hash);
  });

  it('a picture the person uploaded wins over the grid', async () => {
    const ids = [songsOf(albums[0].id)[0], songsOf(albums[1].id)[0], songsOf(albums[2].id)[0], songsOf(albums[3].id)[0]];
    const id = await make('own picture', ids);
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const up = await app.inject({ method: 'POST', url: `/api/playlists/${id}/cover`, payload: png, headers: { authorization: `Bearer ${tok}`, 'content-type': 'image/png' } });
    expect(up.statusCode).toBe(200);
    expect(await coverOf(id)).toBe(up.json().cover);
  });
});
