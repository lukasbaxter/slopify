import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import sharp from 'sharp';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { artistBannersPass } from './enrich.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-banner-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any; let tok = '';

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
}, 120000);
afterAll(async () => { await app.close(); });

describe('artist banners', () => {
  it("take the artist's wide photo from TheAudioDB, in two widths, sized by the request", async () => {
    const fanart = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 200, g: 40, b: 90 } } }).jpeg().toBuffer();
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      const name = new URL(url).searchParams.get('s');
      return { status: 200, json: async () => ({ artists: name === 'The Fixture Band' ? [{ strArtist: 'The Fixture Band', strArtistFanart: 'https://img/fanart.jpg' }] : null }) };
    }) as any;
    const r = await artistBannersPass(db, { dataDir: DATA, fetcher, bytes: async () => fanart, max: 50 });
    expect(r.found).toBe(1);
    expect(asked[0]).toContain('/json/123/search.php?s=');
    const artist = db.prepare("SELECT id, banner_hash FROM artists WHERE name = 'The Fixture Band'").get();
    expect(artist.banner_hash).toBeTruthy();
    // The artist page knows it has one, and the image comes in the asked width.
    const page = (await app.inject({ url: `/api/artists/${artist.id}`, headers: { authorization: `Bearer ${tok}` } })).json();
    expect(page.banner).toBe(artist.banner_hash);
    for (const [w, width] of [[640, 640], [1920, 1280], [0, 1280]]) {
      const res = await app.inject({ url: `/api/image/${artist.id}?kind=banner${w ? `&w=${w}` : ''}`, headers: { accept: 'image/webp' } });
      expect(res.statusCode).toBe(200);
      expect((await sharp(res.rawPayload).metadata()).width).toBe(width);
    }
    // Artists TheAudioDB does not know burn a try and keep their portrait banner.
    const other = db.prepare("SELECT banner_hash, banner_tries FROM artists WHERE name = 'Ada Lovelace'").get();
    expect(other).toMatchObject({ banner_hash: null, banner_tries: 1 });
  });
});
