import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import sharp from 'sharp';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';

// The TV's full-screen cover asks for 1920 px, more than the stored copies
// (640 at most): the server makes the big copy from the original, never
// larger than it, and falls back to 640 when the original is gone.
const FIX = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const MUSIC = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-artbig-music-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-artbig-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any;
const square = (n: number, r: number) => sharp({ create: { width: n, height: n, channels: 3, background: { r, g: 90, b: 140 } } }).jpeg().toBuffer();
const album = (name: string) => db.prepare('SELECT id FROM albums WHERE name = ?').get(name).id as string;
const widthOf = async (id: string, size: number, accept = 'image/webp') => {
  const res = await app.inject({ url: `/api/image/${id}?size=${size}`, headers: { accept } });
  expect(res.statusCode).toBe(200);
  return (await sharp(res.rawPayload).metadata()).width;
};

beforeAll(async () => {
  fs.cpSync(FIX, MUSIC, { recursive: true });
  const dir = (a: string, b: string) => path.join(MUSIC, a, b);
  fs.rmSync(path.join(dir('Ada Lovelace', 'Analytical'), 'cover.png'), { force: true });
  fs.writeFileSync(path.join(dir('Ada Lovelace', 'Analytical'), 'cover.jpg'), await square(2400, 10));
  for (const f of fs.readdirSync(dir('The Fixture Band', 'First Light'))) if (/\.(png|jpe?g)$/i.test(f)) fs.rmSync(path.join(dir('The Fixture Band', 'First Light'), f));
  fs.writeFileSync(path.join(dir('The Fixture Band', 'First Light'), 'cover.jpg'), await square(800, 60));
  for (const f of fs.readdirSync(dir('The Fixture Band', 'Second Wind'))) if (/\.(png|jpe?g)$/i.test(f)) fs.rmSync(path.join(dir('The Fixture Band', 'Second Wind'), f));
  fs.writeFileSync(path.join(dir('The Fixture Band', 'Second Wind'), 'cover.jpg'), await square(2000, 120));
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
}, 120000);
afterAll(async () => { await app.close(); });

describe('big covers', () => {
  it('are made from the original at the asked size, and kept', async () => {
    const id = album('Analytical');
    expect(await widthOf(id, 1920)).toBe(1920);
    expect(await widthOf(id, 1000)).toBe(1280);
    expect(await widthOf(id, 1920, 'image/jpeg')).toBe(1920);
    const hash = db.prepare('SELECT cover_hash FROM albums WHERE id = ?').get(id).cover_hash;
    expect(fs.existsSync(path.join(DATA, 'art', hash, '1920.webp'))).toBe(true);
    // Up to 640 is still the stored copy.
    expect(await widthOf(id, 640)).toBe(640);
  });
  it('are never larger than the original', async () => {
    expect(await widthOf(album('First Light'), 1920)).toBe(800);
  });
  it('fall back to the 640 copy when the original is gone', async () => {
    fs.rmSync(path.join(MUSIC, 'The Fixture Band', 'Second Wind', 'cover.jpg'));
    expect(await widthOf(album('Second Wind'), 1920)).toBe(640);
  });
});
