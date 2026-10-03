import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { ADDING_GRACE_MS, downloadOut, recordRequest, registerDownloads, STUCK_MS } from './downloads.js';
import type { AlbumState } from './lidarr.js';

const album = (o: Partial<AlbumState>): AlbumState => ({
  id: 1, album_id: 'mb1', artist: 'A', title: 'T', rtype: 'Album', year: '2020', image: null,
  total: 10, done: 0, monitored: true, hasFiles: false, queue: null, ...o,
});
const meta = (o: any = {}) => ({ source: 'request', note: null, created: Date.now(), mine: true, ...o });

const appWith = (db: any, lidarr: any, uid = 'u1') => {
  const app = Fastify();
  app.decorateRequest('user', undefined);
  app.addHook('onRequest', async (req: any) => { req.user = { id: uid }; });
  app.decorate('requireUser', async () => {});
  registerDownloads(app, db, { lidarr });
  return app;
};

describe('downloads', () => {
  it('states: torrent queue wins, files without a library album are adding, quiet too long is stuck', () => {
    const now = 10_000_000_000;
    const m = meta({ created: now - 60000 });
    expect(downloadOut(album({ queue: { state: 'downloading', detail: 'downloading', protocol: 'torrent' } }), m, null, now)).toMatchObject({ state: 'downloading', via: 'torrent' });
    expect(downloadOut(album({ queue: { state: 'failed', detail: 'no space' } }), m, null, now)).toMatchObject({ state: 'failed', reason: 'no space', via: 'download' });
    expect(downloadOut(album({ done: 10, hasFiles: true }), m, { id: 'al1' }, now)).toMatchObject({ state: 'done', libraryAlbumId: 'al1' });
    expect(downloadOut(album({ done: 10, hasFiles: true }), m, null, now).state).toBe('adding');
    // all files down but never matched to a library album: done after the
    // grace day, not "adding" forever
    expect(downloadOut(album({ done: 10, hasFiles: true }), meta({ created: now - ADDING_GRACE_MS - 1000 }), null, now)).toMatchObject({ state: 'done', libraryAlbumId: null });
    expect(downloadOut(album({ done: 4, hasFiles: true }), m, null, now)).toMatchObject({ state: 'downloading', done: 4, total: 10 });
    expect(downloadOut(album({ done: 4, hasFiles: true, monitored: false }), m, null, now)).toMatchObject({ state: 'failed', reason: 'no longer monitored in Lidarr' });
    expect(downloadOut(album({}), m, null, now).state).toBe('queued');
    expect(downloadOut(album({}), meta({ created: now - STUCK_MS - 1000 }), null, now).state).toBe('stuck');
    expect(downloadOut(album({ monitored: false }), m, null, now)).toMatchObject({ state: 'failed', reason: 'no longer monitored in Lidarr' });
  });

  it('lists only this account\'s requests; retry of a stuck one fires a Lidarr search under the same id', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl-')));
    const old = Date.now() - STUCK_MS - 60000;
    db.prepare('INSERT INTO my_requests (user_id, lidarr_id, album_id, artist, title, source, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 7, 'mb7', 'A', 'T', 'ai', '"Song" for Mix', old);
    recordRequest(db, 'u2', { id: 8, album_id: 'mb8' }, 'request');
    const calls: string[] = [];
    const lidarr: any = {
      enabled: true,
      albums: async (ids: number[]) => { calls.push(`albums ${ids.join(',')}`); return ids.filter((i) => i === 7).map((i) => album({ id: i, album_id: 'mb7' })); },
      retry: async (id: number) => { calls.push(`retry ${id}`); },
    };
    const app = appWith(db, lidarr);
    const list = (await app.inject({ method: 'GET', url: '/api/downloads' })).json();
    expect(list.items.map((x: any) => [x.id, x.state, x.note, x.mine])).toEqual([[7, 'stuck', '"Song" for Mix', true]]);
    const r = (await app.inject({ method: 'POST', url: '/api/downloads/7/retry' })).json();
    expect(r).toEqual({ ok: true, id: 7 });
    expect(calls).toContain('retry 7');
    expect((db.prepare("SELECT lidarr_id, source, note FROM my_requests WHERE user_id = 'u1'").all() as any[])).toEqual([{ lidarr_id: 7, source: 'ai', note: '"Song" for Mix' }]);
    // the retry restarted the stuck clock: created is fresh, so it shows queued again
    expect((db.prepare('SELECT created FROM my_requests WHERE lidarr_id = 7').get() as any).created).toBeGreaterThan(old);
    const after = (await app.inject({ method: 'GET', url: '/api/downloads' })).json();
    expect(after.items.map((x: any) => [x.id, x.state])).toEqual([[7, 'queued']]);
    await app.close();
  });

  it('meta survives past 2000 requests: the newest rows are kept, the first requester still wins', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl4-')));
    const ins = db.prepare('INSERT INTO my_requests (user_id, lidarr_id, album_id, artist, title, source, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const t0 = Date.now() - 10_000_000;
    for (let i = 0; i < 2100; i++) ins.run('u1', i, `mb${i}`, 'A', 'T', 'request', null, t0 + i * 1000);
    // another account asked for the newest album a bit earlier: its source and time win
    ins.run('u2', 2099, 'mb2099', 'A', 'T', 'ai', null, t0 + 2099 * 1000 - 500);
    const lidarr: any = { enabled: true, albums: async (ids: number[]) => ids.filter((i) => i === 2099).map(() => album({ id: 2099, album_id: 'mb2099' })) };
    const app = appWith(db, lidarr);
    const items = (await app.inject({ url: '/api/downloads' })).json().items;
    expect(items.find((x: any) => x.id === 2099)).toMatchObject({ source: 'ai', requested: t0 + 2099 * 1000 - 500, mine: true });
    await app.close();
  });

  it('a finished download links its library album; files Lidarr has that the library has not shown yet are "adding"', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl2-')));
    db.prepare("INSERT INTO artists (id, name, sort_name) VALUES ('ar', 'Porter Robinson', 'porter robinson')").run();
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al', 'Language', 'ar', 'Porter Robinson', '/m', 1, 0, 'language')").run();
    for (const [id, mb] of [[1, 'mb1'], [2, 'mb2']] as const) recordRequest(db, 'u1', { id, album_id: mb, artist: 'Porter Robinson', title: id === 1 ? 'Language' : 'Worlds' }, 'request');
    const lidarr: any = {
      enabled: true,
      albums: async () => [
        album({ id: 1, album_id: 'mb1', artist: 'Porter Robinson', title: 'Language', total: 1, done: 1, hasFiles: true }),
        album({ id: 2, album_id: 'mb2', artist: 'Porter Robinson', title: 'Worlds', total: 12, done: 12, hasFiles: true }),
      ],
    };
    const app = appWith(db, lidarr);
    const items = (await app.inject({ url: '/api/downloads' })).json().items;
    const by = Object.fromEntries(items.map((x: any) => [x.id, [x.state, x.libraryAlbumId]]));
    expect(by).toEqual({ 1: ['done', 'al'], 2: ['adding', null] });
    await app.close();
  });

  it('scope=all keeps this account\'s finished requests visible beside the live wanted list', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl3-')));
    recordRequest(db, 'u1', { id: 5, album_id: 'mb5', artist: 'X', title: 'Done one' }, 'request');
    const lidarr: any = {
      enabled: true,
      all: async () => [album({ id: 9, album_id: 'mb9', artist: 'Y', title: 'Someone elses' })],
      albums: async (ids: number[]) => ids.filter((i) => i === 5).map(() => album({ id: 5, album_id: 'mb5', artist: 'X', title: 'Done one', total: 3, done: 3, hasFiles: true })),
    };
    const app = appWith(db, lidarr);
    const items = (await app.inject({ url: '/api/downloads?scope=all' })).json().items;
    expect(items.map((x: any) => [x.id, x.state, x.mine]).sort()).toEqual([[5, 'adding', true], [9, 'queued', false]]);
    await app.close();
  });
});
