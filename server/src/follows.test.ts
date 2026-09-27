import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-follow-'));
let app: Awaited<ReturnType<typeof buildServer>>; let tok = ''; let db: any;
const send = (method: any, url: string) => app.inject({ method, url, headers: { authorization: `Bearer ${tok}` } });

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
}, 120000);
afterAll(async () => { await app.close(); });

describe('artists: follow, Daily Mix, picture', () => {
  it('Follow on an artist is a follow, not a liked song, and the artist page knows it', async () => {
    const a = db.prepare("SELECT id FROM artists WHERE name = 'The Fixture Band'").get();
    expect((await send('PUT', `/api/likes/${a.id}`)).json()).toMatchObject({ ok: true, artist: true });
    expect(Object.keys((await send('GET', '/api/likes')).json().at)).not.toContain(a.id);
    expect((await send('GET', '/api/likes/artists')).json().items.map((x: any) => x.id)).toEqual([a.id]);
    expect((await send('GET', `/api/artists/${a.id}`)).json().followed).toBe(true);
    await send('DELETE', `/api/likes/${a.id}`);
    expect((await send('GET', '/api/likes/artists')).json().items).toEqual([]);
  });

  it('a Daily Mix seeded by an artist has songs, the artist first', async () => {
    const a = db.prepare("SELECT id FROM artists WHERE name = 'The Fixture Band'").get();
    const items = (await send('GET', `/api/tracks/${a.id}/mix?limit=20`)).json().items;
    expect(items.length).toBeGreaterThan(3);
    expect(items[0].artistIds).toContain(a.id);
    expect(new Set(items.map((t: any) => t.id)).size).toBe(items.length);
  });

  it('an artist without a portrait gets the cover of one of their albums, not a 404', async () => {
    const a = db.prepare("SELECT id FROM artists WHERE name = 'The Fixture Band'").get();
    db.prepare('UPDATE artists SET image_hash = NULL WHERE id = ?').run(a.id);
    const r = await app.inject({ method: 'GET', url: `/api/image/${a.id}?size=320` });
    expect(r.statusCode).toBe(200);
  });
});

describe('heads of duplicate recordings', () => {
  it('a head that no longer matches its row is recut from the row\'s file', async () => {
    const { buildHead, headOf, reconcileHeads } = await import('./heads.js');
    const t = db.prepare('SELECT id, path, size, duration_ms FROM tracks LIMIT 1').get();
    await buildHead(db, DATA, t.id, t.path, t.size, t.duration_ms, 1);
    db.prepare('UPDATE heads SET size = size + 7 WHERE track_id = ?').run(t.id); // as if cut from the other copy
    expect(headOf(db, DATA, t.id, t.size)).toBeNull();
    expect(await reconcileHeads(db, DATA, 1)).toBe(1);
    expect(headOf(db, DATA, t.id, t.size)).not.toBeNull();
  });
});

describe('"A & B" credits', () => {
  it('splits collaborations, keeps bands and duos', async () => {
    const { splitAmpersand } = await import('./scanner.js');
    const known = new Map([['tiesto', 'Tiësto'], ['ava max', 'Ava Max'], ['elton john', 'Elton John'], ['camo', 'Camo'], ['kool', 'Kool']]);
    const solo = new Map([['tiesto', 200], ['ava max', 60], ['elton john', 445], ['camo', 2], ['kool', 1]]);
    const alone = new Map([['Camo & Krooked', 166], ['Elton John & Leon Russell', 16]]);
    const st = { known, solo, alone };
    expect(splitAmpersand('Tiesto & Ava Max', st)).toEqual(['Tiësto', 'Ava Max']);
    expect(splitAmpersand('Elton John & Leon Russell', st)).toEqual(['Elton John', 'Leon Russell']);
    expect(splitAmpersand('Camo & Krooked', st)).toEqual(['Camo & Krooked']);
    expect(splitAmpersand('Kool & The Gang', st)).toEqual(['Kool & The Gang']);
    expect(splitAmpersand('Mumford & Sons', st)).toEqual(['Mumford & Sons']);
    expect(splitAmpersand('Above & Beyond', st)).toEqual(['Above & Beyond']);
    expect(splitAmpersand('Simon & Garfunkel', st)).toEqual(['Simon & Garfunkel']);
  });
});
