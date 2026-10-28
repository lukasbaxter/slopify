import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { removeStaleGuests } from './demo.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-demo-'));
let app: Awaited<ReturnType<typeof buildServer>>;
let admin = '';
const as = (tok: string) => ({ authorization: `Bearer ${tok}` });

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: DATA, demo: true });
  admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin demo password' }, headers: as(admin) });
  const db = (app as any).db;
  db.prepare("INSERT INTO albums (id, name, artist, dir, added_at, sort_name) VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Album', 'Artist', '/x', 0, 'album')").run();
  db.prepare("INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/x/1.flac', 0, 1, 'Song', 'Artist', '[]', '[]', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Album', 'Artist', 0)").run();
  await app.inject({ method: 'PUT', url: '/api/likes/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', headers: as(admin) });
  const pl = (await app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Mix' }, headers: as(admin) })).json();
  await app.inject({ method: 'POST', url: `/api/playlists/${pl.id}/tracks`, payload: { trackIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] }, headers: as(admin) });
}, 60000);
afterAll(async () => { await app.close(); });

const guest = async () => (await app.inject({ method: 'POST', url: '/api/auth/demo', payload: { device: 'test' } })).json();

describe('demo mode', () => {
  it('signs a visitor in as a guest of their own, with a copy of the admin\'s playlists and likes', async () => {
    const g = await guest();
    expect(g.user.name).toMatch(/^Guest [0-9a-f]{6}$/);
    const pls = (await app.inject({ url: '/api/playlists', headers: as(g.token) })).json();
    const list = pls.items ?? pls.playlists ?? pls;
    expect(list.map((p: any) => p.name)).toContain('Mix');
    const db = (app as any).db;
    expect(db.prepare('SELECT COUNT(*) n FROM likes WHERE user_id = ?').get(g.user.id).n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM playlist_tracks x JOIN playlists p ON p.id = x.playlist_id WHERE p.user_id = ?').get(g.user.id).n).toBe(1);
  });

  it('two visitors are two accounts', async () => {
    const [a, b] = [await guest(), await guest()];
    expect(a.user.id).not.toBe(b.user.id);
  });

  it('a guest can like and edit playlists, but not change the server', async () => {
    const g = await guest();
    expect((await app.inject({ method: 'DELETE', url: '/api/likes/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', headers: as(g.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Mine' }, headers: as(g.token) })).statusCode).toBe(200);
    for (const [method, url] of [['POST', '/api/admin/scan'], ['POST', '/api/auth/password'], ['POST', '/api/invites'], ['DELETE', `/api/users/${g.user.id}`], ['PUT', '/api/admin/tasks/scan/schedule'], ['POST', '/api/import/spotify']] as const) {
      const r = await app.inject({ method, url, payload: {}, headers: as(g.token) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error).toBe('Not available in the demo');
    }
    // The admin's own likes are untouched by the guest's unlike.
    expect((app as any).db.prepare("SELECT COUNT(*) n FROM likes l JOIN users u ON u.id = l.user_id WHERE u.name = 'admin'").get().n).toBe(1);
  });

  it('a guest sees only themselves in the account list', async () => {
    const g = await guest();
    const users = (await app.inject({ url: '/api/users', headers: as(g.token) })).json().users;
    expect(users.map((u: any) => u.id)).toEqual([g.user.id]);
  });

  it('the admin is not a guest', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/invites', payload: {}, headers: as(admin) })).statusCode).not.toBe(403);
  });

  it('guests idle for a day are removed with everything of theirs', async () => {
    const g = await guest();
    const db = (app as any).db;
    expect(removeStaleGuests(db, Date.now() + 25 * 3600000)).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(g.user.id).n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM playlists WHERE user_id = ?').get(g.user.id).n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM users WHERE name = 'admin'").get().n).toBe(1);
  });
});

describe('without demo mode', () => {
  it('there is no guest sign-in, and asking is not an error', async () => {
    const plain = await buildServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-nodemo-')), musicDir: DATA });
    expect((await plain.inject({ method: 'POST', url: '/api/auth/demo' })).statusCode).toBe(204);
    expect((plain as any).db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(1);
    await plain.close();
  });
});
