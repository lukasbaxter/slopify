import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { registerTasks, builtinTasks, isStudio, type TaskDef } from './tasks.js';

const adminApp = () => {
  const app = Fastify();
  app.decorate('requireAdmin', async () => {});
  return app;
};
const tmpdb = (tag: string) => openDb(fs.mkdtempSync(path.join(os.tmpdir(), `slopify-${tag}-`)));

describe('tasks framework', () => {
  it('lists tasks, runs one by hand, remembers the run across the API, and refuses a double start', async () => {
    const db = tmpdb('tasks');
    let resolve!: (v: string) => void;
    const def: TaskDef = { id: 't1', name: 'T1', description: 'd', everyH: 0, run: () => new Promise((r) => { resolve = r; }) };
    const app = adminApp();
    registerTasks(app, db, [def]);
    expect((await app.inject({ url: '/api/admin/tasks' })).json().tasks).toMatchObject([{ id: 't1', last: null, running: null }]);
    expect((await app.inject({ method: 'POST', url: '/api/admin/tasks/t1/run' })).json()).toEqual({ started: true });
    expect((await app.inject({ method: 'POST', url: '/api/admin/tasks/t1/run' })).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/admin/tasks' })).json().tasks[0].running).toBeTruthy();
    resolve('did 3 things');
    await new Promise((r) => setTimeout(r, 20));
    const t = (await app.inject({ url: '/api/admin/tasks' })).json().tasks[0];
    expect(t.running).toBeNull();
    expect(t.last).toMatchObject({ ok: true, summary: 'did 3 things' });
    expect((await app.inject({ method: 'POST', url: '/api/admin/tasks/nope/run' })).statusCode).toBe(404);
    await app.close();
  });

  it('the tick starts only due tasks, one at a time, and a failure is remembered as one', async () => {
    const db = tmpdb('tick');
    const ran: string[] = [];
    const defs: TaskDef[] = [
      { id: 'a', name: 'A', description: '', everyH: 1, run: async () => { ran.push('a'); return 'ok'; } },
      { id: 'b', name: 'B', description: '', everyH: 1, run: async () => { ran.push('b'); throw new Error('boom'); } },
      { id: 'c', name: 'C', description: '', everyH: 0, run: async () => { ran.push('c'); return 'ok'; } },
    ];
    const app = adminApp();
    const { tick } = registerTasks(app, db, defs);
    tick(); await new Promise((r) => setTimeout(r, 20)); // a runs, b waits its turn
    tick(); await new Promise((r) => setTimeout(r, 20));
    tick(); await new Promise((r) => setTimeout(r, 20)); // a and b not due again, c is manual-only
    expect(ran).toEqual(['a', 'b']);
    const by = Object.fromEntries((await app.inject({ url: '/api/admin/tasks' })).json().tasks.map((t: any) => [t.id, t.last]));
    expect(by.a).toMatchObject({ ok: true });
    expect(by.b).toMatchObject({ ok: false, error: 'boom' });
    expect(by.c).toBeNull();
    await app.close();
  });
});

describe('built-in chores', () => {
  const seed = (db: any) => {
    db.prepare("INSERT INTO users (id, name, pass_hash, role, created) VALUES ('u1', 'u', 'x', 'user', 0)").run();
    db.prepare("INSERT INTO artists (id, name, sort_name) VALUES ('ar', 'Tycho', 'tycho')").run();
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al', 'Dive', 'ar', 'Tycho', '/m', 1, 0, 'dive')").run();
    db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
      VALUES ('t1', '/m/01.flac', 0, 0, 'A Walk', 'Tycho', '["Tycho"]', '["ar"]', 'al', 'Dive', 'Tycho', 0)`).run();
    db.prepare("INSERT INTO plays (user_id, track_id, at) VALUES ('u1', 't1', ?)").run(Date.now());
  };
  const opts = (db: any, lidarr: any) => ({
    db, lidarr, cacheDir: '/tmp', headsEnabled: false, headSeconds: 3, pauseMs: 0,
    scanEveryH: 168, enrichEveryH: 1, wantedTarget: 25,
    discoveryEveryH: 168, discoveryPerRun: 5, backlogEveryH: 6, backlogPerRun: 10, backlogArtistsPerRun: 5, headsEveryH: 24,
  });
  const ctx = { step: () => {}, log: () => {} };

  it('isStudio: albums and 4+ track EPs, never secondary-typed variants', () => {
    expect(isStudio({ rtype: 'Album', secondary: [], total_tracks: 10 })).toBe(true);
    expect(isStudio({ rtype: 'EP', secondary: [], total_tracks: 5 })).toBe(true);
    expect(isStudio({ rtype: 'EP', secondary: [], total_tracks: 2 })).toBe(false);
    expect(isStudio({ rtype: 'Single', secondary: [], total_tracks: 1 })).toBe(false);
    expect(isStudio({ rtype: 'Album', secondary: ['Live'], total_tracks: 10 })).toBe(false);
  });

  it('backlog queues only the missing studio releases of played artists and remembers finished artists', async () => {
    const db = tmpdb('backlog');
    seed(db);
    const requested: string[] = [];
    const lidarr: any = {
      enabled: true,
      wantedCount: async () => 0,
      statuses: async () => new Map([['mb-wanted-already', { status: 'queued', updated: 0 }]]),
      discography: async () => ({ artist: { name: 'Tycho', image: null }, releases: [
        { album_id: 'mb-dive', artist: 'Tycho', title: 'Dive', rtype: 'Album', year: '2011', date: '2011', image: null, total_tracks: 10, secondary: [] },
        { album_id: 'mb-epoch', artist: 'Tycho', title: 'Epoch', rtype: 'Album', year: '2016', date: '2016', image: null, total_tracks: 11, secondary: [] },
        { album_id: 'mb-live', artist: 'Tycho', title: 'Live Set', rtype: 'Album', year: '2017', date: '2017', image: null, total_tracks: 9, secondary: ['Live'] },
        { album_id: 'mb-single', artist: 'Tycho', title: 'Easy', rtype: 'Single', year: '2020', date: '2020', image: null, total_tracks: 1, secondary: [] },
        { album_id: 'mb-wanted-already', artist: 'Tycho', title: 'Simulcast', rtype: 'Album', year: '2020', date: '2020', image: null, total_tracks: 10, secondary: [] },
      ] }),
      request: async (fid: string) => { requested.push(fid); return { id: 1, album_id: fid, artist: 'Tycho', title: fid, status: 'queued' }; },
    };
    const backlog = builtinTasks(adminApp() as any, opts(db, lidarr)).find((t) => t.id === 'backlog')!;
    expect(await backlog.run(ctx)).toContain('1 albums queued');
    expect(requested).toEqual(['mb-epoch']); // Dive is on the shelf, Live/Single/already-wanted skipped
    expect(await backlog.run(ctx)).toContain('0 artists'); // done for 14 days
  });

  it('discovery and backlog stand down when the wanted list is at target, and without Lidarr', async () => {
    const db = tmpdb('room');
    seed(db);
    const full: any = { enabled: true, wantedCount: async () => 25, statuses: async () => new Map() };
    const tasks = builtinTasks(adminApp() as any, opts(db, full));
    expect(await tasks.find((t) => t.id === 'backlog')!.run(ctx)).toContain('full');
    expect(await tasks.find((t) => t.id === 'discovery')!.run(ctx)).toContain('full');
    const none = builtinTasks(adminApp() as any, opts(db, { enabled: false }));
    expect(await none.find((t) => t.id === 'discovery')!.run(ctx)).toContain('not configured');
  });

  it('the heads chore says so when heads are off', async () => {
    const db = tmpdb('heads');
    const heads = builtinTasks(adminApp() as any, opts(db, { enabled: false })).find((t) => t.id === 'heads')!;
    expect(await heads.run(ctx)).toContain('HEADS=0');
  });
});
