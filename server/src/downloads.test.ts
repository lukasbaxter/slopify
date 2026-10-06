import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { ADDING_GRACE_MS, cleanStaging, downloadOut, givenUp, recordRequest, registerDownloads, STUCK_MS, watchDownloads } from './downloads.js';
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

  // The 2026-10-05 loop: "Piano Concerto No. 1" wanted, Soularr kept fetching
  // the near-identical "No. 4", Lidarr filed it there, 144 rounds in 2 days.
  it('watcher: downloads that keep landing in another album give the wanted one up, with the reason shown', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dlw-')));
    const t0 = 1_800_000_000_000;
    let monitored = true;
    const calls: string[] = [];
    const imports: any[] = [];
    const lidarr: any = {
      enabled: true,
      all: async () => (monitored ? [album({ id: 1, album_id: 'mb1', artistId: 9, title: 'Concerto No. 1', total: 6 })] : []),
      albums: async (ids: number[]) => ids.map((i) => album({ id: i, album_id: 'mb1', artistId: 9, title: 'Concerto No. 1', total: 6, monitored })),
      importsSince: async () => imports,
      unmonitor: async (id: number) => { calls.push(`unmonitor ${id}`); monitored = false; },
      retry: async (id: number) => { calls.push(`retry ${id}`); monitored = true; },
    };
    recordRequest(db, 'u1', { id: 1, album_id: 'mb1', artist: 'A', title: 'Concerto No. 1' }, 'request');
    await watchDownloads(db, lidarr, { giveUpMs: 12 * 3600e3, now: t0 });
    // one import into album 2 is not a pattern yet
    for (let i = 0; i < 6; i++) imports.push({ albumId: 2, album: 'Concerto No. 4', at: t0 + 10 * 60e3 + i * 1000 });
    expect((await watchDownloads(db, lidarr, { giveUpMs: 12 * 3600e3, now: t0 + STUCK_MS + 60e3 })).gaveUp).toEqual([]);
    // a second round is
    for (let i = 0; i < 6; i++) imports.push({ albumId: 2, album: 'Concerto No. 4', at: t0 + 21 * 60e3 + i * 1000 });
    const r = await watchDownloads(db, lidarr, { giveUpMs: 12 * 3600e3, now: t0 + STUCK_MS + 120e3 });
    expect(r.gaveUp).toEqual(['A - Concerto No. 1']);
    expect(calls).toEqual(['unmonitor 1']);
    expect(givenUp(db).has('mb1')).toBe(true);
    const app = appWith(db, lidarr);
    const it1 = (await app.inject({ url: '/api/downloads' })).json().items[0];
    expect(it1).toMatchObject({ state: 'failed', reason: 'downloads kept turning out to be a different album ("Concerto No. 4")' });
    expect(it1.finished).toBeGreaterThan(0);
    // still listed under Everyone after it left the wanted list
    expect((await app.inject({ url: '/api/downloads?scope=all' })).json().items.map((x: any) => x.id)).toEqual([1]);
    // Retry puts it back and forgets the verdict
    expect((await app.inject({ method: 'POST', url: '/api/downloads/1/retry' })).json()).toEqual({ ok: true, id: 1 });
    expect(givenUp(db).has('mb1')).toBe(false);
    await app.close();
  });

  it('watcher: imports into another wanted or requested album are not "wrong"', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dlw2-')));
    const t0 = 1_800_000_000_000;
    const imports = [0, 11, 22].map((m) => ({ albumId: 2, album: 'Other', at: t0 + m * 60e3 + 60e3 }));
    const lidarr: any = {
      enabled: true,
      all: async () => [album({ id: 1, album_id: 'mb1', artistId: 9 }), album({ id: 2, album_id: 'mb2', artistId: 9, done: 3 })],
      importsSince: async () => imports,
      unmonitor: async () => { throw new Error('must not give up'); },
    };
    await watchDownloads(db, lidarr, { giveUpMs: 12 * 3600e3, now: t0 });
    expect((await watchDownloads(db, lidarr, { giveUpMs: 12 * 3600e3, now: t0 + 3600e3 })).gaveUp).toEqual([]);
  });

  it('watcher: no new song for the give-up time takes it off the wanted list; a new song resets the clock', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dlw3-')));
    const t0 = 1_800_000_000_000; const H = 3600e3;
    let done = 0; let monitored = true; const calls: string[] = [];
    const lidarr: any = {
      enabled: true,
      all: async () => (monitored ? [album({ id: 5, album_id: 'mb5', done, total: 10 })] : []),
      importsSince: async () => [],
      unmonitor: async (id: number) => { calls.push(`unmonitor ${id}`); monitored = false; },
    };
    await watchDownloads(db, lidarr, { giveUpMs: 12 * H, now: t0 });
    done = 2;
    await watchDownloads(db, lidarr, { giveUpMs: 12 * H, now: t0 + 11 * H });
    expect((await watchDownloads(db, lidarr, { giveUpMs: 12 * H, now: t0 + 20 * H })).gaveUp).toEqual([]);
    const r = await watchDownloads(db, lidarr, { giveUpMs: 12 * H, now: t0 + 24 * H });
    expect(r.gaveUp).toEqual(['A - T']);
    expect((db.prepare('SELECT reason FROM download_watch WHERE lidarr_id = 5').get() as any).reason).toBe('stopped at 2 of 10 songs, nothing new for 13 hours');
    // a fresh request clears the verdict
    recordRequest(db, 'u1', { id: 5, album_id: 'mb5' }, 'request');
    expect(givenUp(db).size).toBe(0);
  });

  it('staging cleanup: spent and empty folders go, fresh downloads and failed imports stay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-stg-'));
    const now = Date.now();
    const mk = (rel: string, file: string | null, ageMs: number) => {
      const p = path.join(dir, rel); fs.mkdirSync(p, { recursive: true });
      const t = new Date(now - ageMs);
      if (file) { fs.writeFileSync(path.join(p, file), 'x'.repeat(10)); fs.utimesSync(path.join(p, file), t, t); }
      fs.utimesSync(p, t, t);
    };
    mk('Old Album (1994)', '01.flac', 3 * 86400e3);
    mk('Empty Single', null, 2 * 3600e3);
    mk('Just Emptied', null, 60e3);
    mk('In Progress', '01.flac', 60e3);
    mk('failed_imports/Band - Thing (2000)', '01.flac', 30 * 86400e3);
    const r = await cleanStaging(dir, { now });
    expect(r.removed).toBe(2);
    expect(r.bytes).toBe(10);
    expect(fs.readdirSync(dir).sort()).toEqual(['In Progress', 'Just Emptied', 'failed_imports']);
    expect(r.failed).toEqual([{ name: 'Band - Thing (2000)', bytes: 10 }]);
  });
});
