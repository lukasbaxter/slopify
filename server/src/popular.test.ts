import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { popularOrder } from './discover.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-popular-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any;

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
}, 120000);
afterAll(async () => { await app.close(); });

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;

describe("an artist page's Popular", () => {
  it("leads with what the world plays most, then this server's plays, then titles", async () => {
    const artist = db.prepare("SELECT id, name FROM artists WHERE name = 'The Fixture Band'").get();
    const rows = db.prepare('SELECT id, title FROM tracks WHERE artist_ids LIKE ? ORDER BY title').all(`%"${artist.id}"%`) as { id: string; title: string }[];
    // Titles that appear once (a title on two albums is one Popular row).
    const once = rows.filter((r) => rows.filter((x) => x.title === r.title).length === 1);
    expect(once.length).toBeGreaterThan(2);
    const [a, b, c] = [once[once.length - 1], once[1], once[0]];
    // Deezer's top tracks: the last title alphabetically, then the second (with a feature credit).
    const fetcher = (async (url: string) => (url.includes('/search/artist')
      ? ok({ data: [{ id: 77, name: 'The Fixture Band' }] })
      : ok({ data: [{ title: a.title }, { title: `${b.title} (feat. Someone)` }, { title: 'Not In This Library' }] }))) as any;
    // One play of the first title alphabetically: it leads the rest.
    db.prepare('INSERT INTO plays (user_id, track_id, at) VALUES (?, ?, ?)').run('u1', c.id, Date.now());
    const order = await popularOrder(db, artist, { fetcher });
    expect(order.slice(0, 3)).toEqual([a.id, b.id, c.id]);
    expect(new Set(order).size).toBe(rows.length); // every song is still listed, after the Popular ones
  });
  it('without Deezer it is plays alone', async () => {
    const artist = db.prepare("SELECT id, name FROM artists WHERE name = 'Ada Lovelace'").get();
    const failing = (async () => { throw new Error('offline'); }) as any;
    const order = await popularOrder(db, artist, { fetcher: failing });
    expect(order.length).toBeGreaterThan(0);
  });
});
