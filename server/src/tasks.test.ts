import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { registerTasks, builtinTasks, isStudio, isDue, prevPoint, parseSchedule, remapTrackId, type TaskDef, type Schedule } from './tasks.js';
import { slskdFind } from './explore.js';

// The flac chore talks to slskd; the tests only care that it does not.
vi.mock('./explore.js', () => ({
  slskdFind: vi.fn(async () => null),
  slskdDownload: vi.fn(async () => false),
  slskdWait: vi.fn(async () => {}),
}));

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
    const def: TaskDef = { id: 't1', name: 'T1', description: 'd', schedule: { mode: 'off' }, run: () => new Promise((r) => { resolve = r; }) };
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
      { id: 'a', name: 'A', description: '', schedule: { mode: 'interval', hours: 1 }, run: async () => { ran.push('a'); return 'ok'; } },
      { id: 'b', name: 'B', description: '', schedule: { mode: 'interval', hours: 1 }, run: async () => { ran.push('b'); throw new Error('boom'); } },
      { id: 'c', name: 'C', description: '', schedule: { mode: 'off' }, run: async () => { ran.push('c'); return 'ok'; } },
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

  it('the tick is round-robin: when both are due at every tick, turns alternate instead of the first starving the second', async () => {
    const db = tmpdb('rr');
    let t = new Date('2026-10-03T12:00:00').getTime();
    const ran: string[] = [];
    const defs: TaskDef[] = ['a', 'b'].map((id) => ({ id, name: id, description: '', schedule: { mode: 'interval', hours: 1 } as Schedule, run: async () => { ran.push(id); return 'ok'; } }));
    const app = adminApp();
    const { tick } = registerTasks(app, db, defs, { now: () => t });
    const turn = async () => { tick(); await new Promise((r) => setTimeout(r, 20)); t += 2 * 3600e3; };
    await turn(); await turn(); await turn(); await turn();
    expect(ran).toEqual(['a', 'b', 'a', 'b']);
    await app.close();
  });

  it('corrupt kv rows degrade to never-ran and the default schedule instead of crashing the tick', async () => {
    const db = tmpdb('corrupt');
    const put = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)');
    put.run('task:x1', '{not json');
    put.run('task:x1:sched', 'also not json');
    const ran: string[] = [];
    const def: TaskDef = { id: 'x1', name: 'X1', description: '', schedule: { mode: 'interval', hours: 1 }, run: async () => { ran.push('x1'); return 'ok'; } };
    const app = adminApp();
    const { tick } = registerTasks(app, db, [def]);
    const t = (await app.inject({ url: '/api/admin/tasks' })).json().tasks[0];
    expect(t.last).toBeNull();
    expect(t.schedule).toEqual({ mode: 'interval', hours: 1 });
    expect(() => tick()).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual(['x1']); // never-ran means due
    await app.close();
  });
});

describe('schedules', () => {
  it('daily and weekly fire once per point, catching up a point missed while down', () => {
    const daily: Schedule = { mode: 'daily', at: '04:00' };
    const at = (d: string) => new Date(d).getTime();
    const now = at('2026-10-03T13:00:00');
    expect(prevPoint(daily, now)).toBe(at('2026-10-03T04:00:00'));
    expect(prevPoint(daily, at('2026-10-03T02:00:00'))).toBe(at('2026-10-02T04:00:00'));
    expect(isDue(daily, null, now)).toBe(true); // never run: catch up
    expect(isDue(daily, { started: at('2026-10-03T04:01:00'), ended: 0, ok: true }, now)).toBe(false);
    expect(isDue(daily, { started: at('2026-10-02T04:01:00'), ended: 0, ok: true }, now)).toBe(true); // missed today's point
    const weekly: Schedule = { mode: 'weekly', day: 0, at: '06:00' }; // Sunday
    expect(new Date(prevPoint(weekly, now)!).getDay()).toBe(0);
    expect(isDue({ mode: 'interval', hours: 2 }, { started: now - 3 * 3600e3, ended: 0, ok: true }, now)).toBe(true);
    expect(isDue({ mode: 'interval', hours: 2 }, { started: now - 1 * 3600e3, ended: 0, ok: true }, now)).toBe(false);
    // Interval counts from the END of the last run: a 4-hour chore on a
    // 2-hour interval is not due again the moment it finishes.
    expect(isDue({ mode: 'interval', hours: 2 }, { started: now - 5 * 3600e3, ended: now - 1 * 3600e3, ok: true }, now)).toBe(false);
    expect(isDue({ mode: 'interval', hours: 2 }, { started: now - 5 * 3600e3, ended: now - 3 * 3600e3, ok: true }, now)).toBe(true);
    expect(isDue({ mode: 'off' }, null, now)).toBe(false);
    expect(isDue({ mode: 'watch' }, null, now)).toBe(false);
  });

  it('parseSchedule takes only real schedules, and watch only where a folder is watched', () => {
    expect(parseSchedule({ mode: 'daily', at: '23:30' }, false)).toEqual({ mode: 'daily', at: '23:30' });
    expect(parseSchedule({ mode: 'daily', at: '25:00' }, false)).toBeNull();
    expect(parseSchedule({ mode: 'interval', hours: 0.1 }, false)).toBeNull();
    expect(parseSchedule({ mode: 'weekly', day: 7, at: '04:00' }, false)).toBeNull();
    expect(parseSchedule({ mode: 'watch' }, true)).toEqual({ mode: 'watch' });
    expect(parseSchedule({ mode: 'watch' }, false)).toBeNull();
  });

  it('the schedule endpoint persists a change and reports it with the next run', async () => {
    const db = tmpdb('sched');
    const def: TaskDef = { id: 's1', name: 'S1', description: '', schedule: { mode: 'interval', hours: 6 }, watchDir: '/tmp', run: async () => 'ok' };
    const app = adminApp();
    registerTasks(app, db, [def]);
    let t = (await app.inject({ url: '/api/admin/tasks' })).json().tasks[0];
    expect(t).toMatchObject({ schedule: { mode: 'interval', hours: 6 }, canWatch: true });
    expect((await app.inject({ method: 'PUT', url: '/api/admin/tasks/s1/schedule', payload: { schedule: { mode: 'daily', at: '03:15' } } })).json().schedule).toEqual({ mode: 'daily', at: '03:15' });
    t = (await app.inject({ url: '/api/admin/tasks' })).json().tasks[0];
    expect(t.schedule).toEqual({ mode: 'daily', at: '03:15' }); // survives via kv
    expect(typeof t.next).toBe('number');
    expect((await app.inject({ method: 'PUT', url: '/api/admin/tasks/s1/schedule', payload: { schedule: { mode: 'nope' } } })).statusCode).toBe(400);
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
    db, lidarr, cacheDir: '/tmp', musicDir: '/tmp', headsEnabled: false, headSeconds: 3, pauseMs: 0,
    enrichEveryH: 1, wantedTarget: 25, discoveryPerRun: 5, backlogEveryH: 6, backlogPerRun: 10, backlogArtistsPerRun: 5, flacPerRun: 40,
  });
  // A run context serving the task's declared setting defaults.
  const ctxOf = (t: TaskDef) => ({ step: () => {}, log: () => {}, setting: (k: string) => t.settings?.find((x) => x.key === k)?.default as any });

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
    expect(await backlog.run(ctxOf(backlog))).toContain('1 albums queued');
    expect(requested).toEqual(['mb-epoch']); // Dive is on the shelf, Live/Single/already-wanted skipped
    expect(await backlog.run(ctxOf(backlog))).toContain('0 artists'); // done for 14 days
  });

  it('discovery and backlog stand down when the wanted list is at target, and without Lidarr', async () => {
    const db = tmpdb('room');
    seed(db);
    const full: any = { enabled: true, wantedCount: async () => 25, statuses: async () => new Map() };
    const tasks = builtinTasks(adminApp() as any, opts(db, full));
    expect(await tasks.find((t) => t.id === 'backlog')!.run(ctxOf(tasks.find((t) => t.id === 'backlog')!))).toContain('full');
    expect(await tasks.find((t) => t.id === 'discovery')!.run(ctxOf(tasks.find((t) => t.id === 'discovery')!))).toContain('full');
    const none = builtinTasks(adminApp() as any, opts(db, { enabled: false }));
    expect(await none.find((t) => t.id === 'discovery')!.run(ctxOf(none.find((t) => t.id === 'discovery')!))).toContain('not configured');
  });

  it('a replaced file keeps the listener\'s traces: likes, playlists, plays and lyrics move to the new id', () => {
    const db = tmpdb('remap');
    seed(db);
    db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
      VALUES ('t-new', '/m/01-new.flac', 0, 0, 'A Walk', 'Tycho', '["Tycho"]', '["ar"]', 'al', 'Dive', 'Tycho', 0)`).run();
    db.prepare("INSERT INTO likes (user_id, track_id, at) VALUES ('u1', 't1', 1)").run();
    db.prepare("INSERT INTO playlists (id, user_id, name, created, updated) VALUES ('pl1', 'u1', 'P', 0, 0)").run();
    db.prepare("INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES ('pl1', 0, 't1', 0)").run();
    db.prepare("INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES ('t1', 'synced', '[]', 'lrclib', 0)").run();
    db.prepare("INSERT INTO heads (track_id, bytes, size, created) VALUES ('t1', 10, 100, 0)").run();
    remapTrackId(db, 't1', 't-new');
    expect((db.prepare("SELECT track_id FROM likes WHERE user_id='u1'").get() as any).track_id).toBe('t-new');
    expect((db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id='pl1'").get() as any).track_id).toBe('t-new');
    expect((db.prepare("SELECT COUNT(*) n FROM plays WHERE track_id='t-new'").get() as any).n).toBe(1);
    expect((db.prepare("SELECT track_id FROM lyrics").get() as any).track_id).toBe('t-new');
    expect((db.prepare("SELECT COUNT(*) n FROM heads WHERE track_id='t1'").get() as any).n).toBe(0);
  });

  it('the flac chore stands down without slskd', async () => {
    const db = tmpdb('flacoff');
    const flac = builtinTasks(adminApp() as any, opts(db, { enabled: false })).find((t) => t.id === 'flac')!;
    expect(await flac.run(ctxOf(flac))).toContain('slskd is not configured');
  });

  // slskd configured but every call mocked dead: these runs must never reach it.
  const slskdOpts = (db: any, musicDir: string) => ({
    ...opts(db, { enabled: false }), musicDir,
    slskdUrl: 'http://slskd', slskdKey: 'k', slskdDownloadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl-')),
  });

  it('flac never overwrites an existing library file: dest present means skip, no search spent, and the skip key carries the duration', async () => {
    const db = tmpdb('flacdest');
    seed(db);
    const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-music-'));
    fs.mkdirSync(path.join(musicDir, 'al'));
    fs.writeFileSync(path.join(musicDir, 'al', '01.flac'), 'already here');
    db.prepare("UPDATE tracks SET codec = 'MPEG 1 Layer 3', duration_ms = 123456, path = ? WHERE id = 't1'").run(path.join(musicDir, 'al', '01.mp3'));
    const flac = builtinTasks(adminApp() as any, slskdOpts(db, musicDir)).find((t) => t.id === 'flac')!;
    const summary = await flac.run(ctxOf(flac));
    expect(summary).toContain('1 blocked by an existing file');
    expect(vi.mocked(slskdFind)).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(musicDir, 'al', '01.flac'), 'utf8')).toBe('already here');
    const skip = JSON.parse((db.prepare("SELECT v FROM kv WHERE k = 'task:flac:skip'").get() as any).v);
    expect(Object.keys(skip)).toEqual(['tycho | a walk | 123']);
  });

  it('a journaled replacement left by a crash is settled at the next run: folder scanned, traces remapped, lyrics restored', async () => {
    const db = tmpdb('flacjournal');
    seed(db);
    db.prepare("UPDATE tracks SET codec = 'MPEG 1 Layer 3', duration_ms = 200000 WHERE id = 't1'").run();
    db.prepare("INSERT INTO likes (user_id, track_id, at) VALUES ('u1', 't1', 1)").run();
    db.prepare("INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES ('t1', 'synced', '[\"la\"]', 'lrclib', 7)").run();
    const entry = { oldId: 't1', newPath: '/m/01.flac', rel: '', lyrics: { kind: 'synced', lines: '["la"]', source: 'lrclib', fetched_at: 7 } };
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('task:flac:journal', JSON.stringify([entry]));
    const app = adminApp();
    const scanned: string[][] = [];
    // A folder scan of the real thing deletes the old row (the lyrics
    // cascade with it) and admits the new file under its new id.
    app.decorate('scanFolders', async (rel: string[]) => {
      scanned.push(rel);
      db.prepare("DELETE FROM tracks WHERE id = 't1'").run();
      db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at, codec)
        VALUES ('t-new', '/m/01.flac', 0, 0, 'A Walk', 'Tycho', '["Tycho"]', '["ar"]', 'al', 'Dive', 'Tycho', 0, 'FLAC')`).run();
    });
    const flac = builtinTasks(app as any, slskdOpts(db, '/m')).find((t) => t.id === 'flac')!;
    const summary = await flac.run(ctxOf(flac));
    expect(summary).toContain('recovered from the journal');
    expect(scanned).toEqual([['']]); // the library-root case rides through as rel ''
    expect((db.prepare("SELECT track_id FROM likes WHERE user_id = 'u1'").get() as any).track_id).toBe('t-new');
    expect(db.prepare("SELECT kind, lines, source FROM lyrics WHERE track_id = 't-new'").get()).toEqual({ kind: 'synced', lines: '["la"]', source: 'lrclib' });
    expect(JSON.parse((db.prepare("SELECT v FROM kv WHERE k = 'task:flac:journal'").get() as any).v)).toEqual([]);
    expect(vi.mocked(slskdFind)).not.toHaveBeenCalled(); // nothing lossy left after recovery
  });

  it('a journal entry whose folder scan keeps failing stays journaled and the run says so', async () => {
    const db = tmpdb('flacjournal2');
    seed(db);
    const entry = { oldId: 't1', newPath: '/m/al/01.flac', rel: 'al', lyrics: null };
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('task:flac:journal', JSON.stringify([entry]));
    const app = adminApp();
    let calls = 0;
    app.decorate('scanFolders', async () => { calls++; throw new Error('NAS asleep'); });
    const flac = builtinTasks(app as any, slskdOpts(db, '/m')).find((t) => t.id === 'flac')!;
    const summary = await flac.run(ctxOf(flac));
    expect(summary).toContain('folder scans failed, kept journaled for recovery');
    expect(calls).toBe(2); // one retry, then give up until next run
    expect(JSON.parse((db.prepare("SELECT v FROM kv WHERE k = 'task:flac:journal'").get() as any).v)).toEqual([entry]);
  }, 10000);

  it('the heads chore says so when heads are off', async () => {
    const db = tmpdb('heads');
    const heads = builtinTasks(adminApp() as any, opts(db, { enabled: false })).find((t) => t.id === 'heads')!;
    expect(await heads.run(ctxOf(heads))).toContain('HEADS=0');
  });
});
