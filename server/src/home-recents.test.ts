import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';

// Home's 8 shortcuts (owner, 11-14): they showed the albums of whatever
// played last, autoplay included. They are the latest album, playlist and
// artist the listener PICKED and played a song from; a song picked by itself
// counts as its album (a single is its own album).
const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-recents-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any; let tok = '';
const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}` } });
const send = (url: string, payload: any) => app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${tok}` } });

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
}, 120000);
afterAll(async () => { await app.close(); });

describe("Home's shortcuts", () => {
  it('are what was picked and played from, newest first, never what autoplay went on to', async () => {
    const albums = db.prepare('SELECT id, name, artist_id FROM albums ORDER BY name').all() as { id: string, name: string, artist_id: string }[];
    expect(albums.length).toBeGreaterThan(2);
    const [a, b, c] = albums;
    const of = (al: { id: string }) => (db.prepare('SELECT id FROM tracks WHERE album_id = ? ORDER BY track_no').all(al.id) as { id: string }[]).map((r) => r.id);
    const [ta, tb, tc] = [of(a), of(b), of(c)];
    const pl = (await send('/api/playlists', { name: 'Evening', trackIds: [tb[0]] })).json().id as string;
    const t0 = Date.now() - 600000;
    const play = (trackId: string, n: number, more: any = {}) => send('/api/plays', { trackId, at: t0 + n * 70000, client: 'web', ...more });

    // History from before plays said where they came from: it fills in underneath.
    db.prepare('INSERT INTO plays (user_id, track_id, at) SELECT user_id, ?, ? FROM tokens LIMIT 1').run(tc[0], t0 - 86400000);

    await play(ta[0], 1, { ctx: a.id });               // album A, picked
    await play(tb[0], 2, { ctx: a.id });               // autoplay after A ran out: not a pick
    await play(tb[0], 3, { ctx: pl });                 // the playlist
    await play(tc[0], 4, { ctx: pl });                 // autoplay past the playlist's end
    await play(ta[1], 5, { ctx: `artist:${a.artist_id}` }); // the artist's page
    await play(tc[0], 6);                              // a mix / radio: no context, not picked
    await play(tb[1], 7, { picked: true });            // one song from search: its album
    await play(ta[0], 8, { ctx: 'liked' });            // Liked Songs has its own tile

    const recents = (await get('/api/home')).json().recents as any[];
    expect(recents.map((r) => `${r.kind}:${r.id}`)).toEqual([
      `album:${b.id}`, `artist:${a.artist_id}`, `playlist:${pl}`, `album:${a.id}`, `album:${c.id}`,
    ]);
    expect(recents[2].name).toBe('Evening');
    expect(recents[1].name).toBeTruthy();
  });
});
