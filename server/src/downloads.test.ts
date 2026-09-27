import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { downloadOut, recordRequest, registerDownloads, STUCK_MS } from './downloads.js';

const row = (o: any) => ({ id: 1, album_id: 'a1', artist: 'A', title: 'T', rtype: 'Album', year: '2020', image: null, total_tracks: 10, status: 'queued', tracks_added: 0, tracks_done: 0, created: 1000, updated: 1000, started: null, progress_at: null, log: '', queue_pos: 3, ...o });

describe('downloads', () => {
  it('state: downloading with a recent song is downloading, silent too long is stuck; failed carries the reason', () => {
    const now = 10_000_000_000;
    expect(downloadOut(row({ status: 'downloading', tracks_done: 4, started: (now - 60000) / 1000, progress_at: (now - 5000) / 1000 }), now)).toMatchObject({ state: 'downloading', done: 4, total: 10 });
    expect(downloadOut(row({ status: 'downloading', started: (now - STUCK_MS - 60000) / 1000, progress_at: (now - STUCK_MS - 1000) / 1000 }), now).state).toBe('stuck');
    expect(downloadOut(row({ status: 'failed', log: 'failed: No search results' }), now)).toMatchObject({ state: 'failed', reason: 'No search results' });
    expect(downloadOut(row({ status: 'done', tracks_added: 9 }), now)).toMatchObject({ state: 'done', done: 9 });
    expect(downloadOut(row({}), now)).toMatchObject({ state: 'queued', queuePos: 3 });
  });

  it('lists only this account\'s requests, and a retry of a failed one records the new request in its place', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl-')));
    recordRequest(db, 'u1', { id: 7, album_id: 'a7', artist: 'A', title: 'T' }, 'ai', '"Song" for Mix');
    recordRequest(db, 'u2', { id: 8, album_id: 'a8' }, 'request');
    const calls: string[] = [];
    const fetcher: any = async (url: string, init?: any) => {
      calls.push(`${init?.method || 'GET'} ${url.replace('http://mr', '')}`);
      if (url.includes('/api/requests?ids=7')) return { ok: true, json: async () => ({ requests: [row({ id: 7, album_id: 'a7', status: 'failed', log: 'failed: No search results' })] }) };
      if (url.endsWith('/api/request')) return { ok: true, json: async () => ({ status: 'queued', id: 9 }) };
      throw new Error(`unexpected ${url}`);
    };
    const app = Fastify();
    app.decorateRequest('user', undefined);
    app.addHook('onRequest', async (req: any) => { req.user = { id: 'u1' }; });
    app.decorate('requireUser', async () => {});
    registerDownloads(app, db, { musicRequestsUrl: 'http://mr', fetcher });
    const list = (await app.inject({ method: 'GET', url: '/api/downloads' })).json();
    expect(list.items.map((x: any) => [x.id, x.state, x.note])).toEqual([[7, 'failed', '"Song" for Mix']]);
    expect(calls[0]).toBe('GET /api/requests?ids=7');
    const r = (await app.inject({ method: 'POST', url: '/api/downloads/7/retry' })).json();
    expect(r).toEqual({ ok: true, id: 9 });
    expect((db.prepare("SELECT mr_id, source, note FROM my_requests WHERE user_id = 'u1'").all() as any[])).toEqual([{ mr_id: 9, source: 'ai', note: '"Song" for Mix' }]);
    await app.close();
  });

  it('a finished download links its library album; not there yet is "adding", long after is done-but-missing', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl2-')));
    db.prepare("INSERT INTO artists (id, name, sort_name) VALUES ('ar', 'Porter Robinson', 'porter robinson')").run();
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al', 'Language', 'ar', 'Porter Robinson', '/m', 1, 0, 'language')").run();
    for (const id of [1, 2, 3]) recordRequest(db, 'u1', { id, album_id: `a${id}` }, 'request');
    const now = Date.now() / 1000;
    const fetcher: any = async () => ({ ok: true, json: async () => ({ requests: [
      row({ id: 1, album_id: 'a1', artist: 'Porter Robinson', title: 'Language', status: 'done', tracks_added: 1, updated: now - 30 }),
      row({ id: 2, album_id: 'a2', artist: 'Porter Robinson', title: 'Worlds', status: 'done', updated: now - 30 }),
      row({ id: 3, album_id: 'a3', artist: 'Porter Robinson', title: 'Nurture', status: 'done', updated: now - 3600 }),
    ] }) });
    const app = Fastify();
    app.decorateRequest('user', undefined);
    app.addHook('onRequest', async (req: any) => { req.user = { id: 'u1' }; });
    app.decorate('requireUser', async () => {});
    registerDownloads(app, db, { musicRequestsUrl: 'http://mr', fetcher });
    const items = (await app.inject({ url: '/api/downloads' })).json().items;
    const by = Object.fromEntries(items.map((x: any) => [x.title, [x.state, x.libraryAlbumId]]));
    expect(by).toEqual({ Language: ['done', 'al'], Worlds: ['adding', null], Nurture: ['done', null] });
  });
});

describe('downloads via torrent', () => {
  it('a torrent request shows as downloading with where it is, never stuck', () => {
    const now = 10_000_000_000;
    const d = downloadOut(row({ status: 'torrent', log: 'torrent: downloading 45% (2 peers)', started: (now - STUCK_MS * 3) / 1000, progress_at: (now - STUCK_MS * 2) / 1000 }), now);
    expect(d).toMatchObject({ state: 'downloading', via: 'torrent', detail: 'downloading 45% (2 peers)' });
    expect(downloadOut(row({ status: 'torrent', log: '' }), now).detail).toBe('searching torrents');
  });
});
