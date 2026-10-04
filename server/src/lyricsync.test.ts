import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { judgeSynced, timePlain, toLrc, lyricSyncTask, registerLyricSync, type AlignedLine } from './lyricsync.js';
import type { LyricLine } from './lyrics.js';
import type { TaskDef } from './tasks.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-aligner.mjs');
const synced = (starts: number[]): LyricLine[] => starts.map((s, i) => ({ start: s, text: `line ${i}` }));
const aligned = (starts: (number | null)[], prob = 0.9): AlignedLine[] => starts.map((s) => ({ start: s, end: null, prob }));

describe('judging synced lyrics', () => {
  const orig = synced([10000, 13000, 16000, 19000, 22000, 25000, 28000, 31000, 34000, 37000]);
  it('agreement within a few hundred ms is verified, never rewritten', () => {
    expect(judgeSynced(orig, aligned(orig.map((l) => l.start! - 150)), 0.8)).toEqual({ state: 'verified', shiftMs: 0 });
  });
  it('a consistent offset shifts the whole file by it', () => {
    const v = judgeSynced(orig, aligned(orig.map((l) => l.start! + 1830)), 0.8);
    expect(v.state).toBe('corrected');
    if (v.state === 'corrected') { expect(v.shiftMs).toBe(1830); expect(v.lines[0].start).toBe(11830); expect(v.lines[0].text).toBe('line 0'); }
  });
  it('a block of disagreeing lines (a repeated chorus fooling the aligner) is left alone', () => {
    const a = orig.map((l, i) => (i < 4 ? l.start! - 30000 : l.start!));
    expect(judgeSynced(orig, aligned(a), 0.8).state).toBe('unsure');
  });
  it('a low score (a vocoder, a wrong version) is left alone', () => {
    expect(judgeSynced(orig, aligned(orig.map((l) => l.start! + 5000)), 0.32).state).toBe('unsure');
  });
});

describe('timing plain lyrics', () => {
  const plain: LyricLine[] = ['one', 'two', '♪', 'three', 'four', 'five'].map((text) => ({ start: null, text }));
  it('takes confident starts and places the rest between their neighbours', () => {
    const a: AlignedLine[] = [
      { start: 1000, end: null, prob: 0.9 }, { start: 4000, end: null, prob: 0.8 }, { start: null, end: null, prob: null },
      { start: 9000, end: null, prob: 0.05 }, { start: 10000, end: null, prob: 0.9 }, { start: 13000, end: null, prob: 0.9 },
    ];
    const v = timePlain(plain, a, 0.8, 200000);
    expect(v.state).toBe('synced');
    if (v.state === 'synced') expect(v.lines.map((l) => l.start)).toEqual([1000, 4000, 6000, 8000, 10000, 13000]);
  });
  it('out-of-order starts are dropped and re-placed, keeping the lines in order', () => {
    const v = timePlain(plain, aligned([1000, 4000, null, 2000, 10000, 13000]), 0.8, 200000);
    expect(v.state).toBe('synced');
    if (v.state === 'synced') { const s = v.lines.map((l) => l.start!); expect([...s].sort((x, y) => x - y)).toEqual(s); }
  });
  it('a weak alignment stays plain', () => {
    expect(timePlain(plain, aligned([1000, 4000, null, 9000, 10000, 13000]), 0.08, 200000).state).toBe('unsure');
    expect(timePlain(plain, aligned([1000, null, null, null, null, 13000], 0.9).map((x, i) => (i % 2 ? { ...x, prob: 0.1 } : x)), 0.8, 200000).state).toBe('unsure');
  });
});

it('writes LRC timestamps the way players read them', () => {
  expect(toLrc([{ start: 61500, text: 'hi' }, { start: 5, text: 'yo' }])).toBe('[01:01.50]hi\n[00:00.01]yo\n');
});

describe('Sync Lyrics on a song', () => {
  const synced8 = [10000, 13000, 16000, 19000, 22000, 25000, 28000, 31000];
  const LRC = ['[00:05.00]one line here', '[00:09.00]two line here', '[00:13.00]three line here', '[00:17.00]four line here', '[00:21.00]five line here'].join('\n');
  // LrcLib that knows only `lrclib` titles (plain), 404 for the rest.
  const lrclibWith = (has: Record<string, string>) => async (url: string) => {
    const title = new URL(url).searchParams.get('track_name') || '';
    if (url.includes('/api/get')) return has[title] ? { status: 200, json: async () => ({ id: 1, trackName: title, artistName: 'A', albumName: 'B', duration: 200, instrumental: false, plainLyrics: has[title], syncedLyrics: null }) } : { status: 404, json: async () => null };
    return { status: 200, json: async () => [] };
  };
  // NetEase knows `ne*` titles (synced); Genius knows `genius*` and `wrong*` (plain).
  const web = async (url: string) => {
    const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => body });
    const u = new URL(url);
    if (u.hostname === 'music.163.com' && u.pathname.includes('/search/')) {
      const q = u.searchParams.get('s') || ''; const title = q.replace(/^A /, '');
      return ok({ result: { songs: title.startsWith('ne') ? [{ id: 7, name: title, duration: 200000, artists: [{ name: 'A' }] }] : [] } });
    }
    if (u.hostname === 'music.163.com') return ok({ lrc: { lyric: LRC } });
    if (u.pathname.startsWith('/api/search')) {
      const title = (u.searchParams.get('q') || '').replace(/^A /, '');
      return ok({ response: { sections: [{ type: 'song', hits: /^(genius|wrong)/.test(title) ? [{ result: { title, artist_names: 'A', primary_artist: { name: 'A' }, url: `https://genius.com/${title}` } }] : [] }] } });
    }
    return ok('<div data-lyrics-container="true">[Verse 1]<br/>first sung line<br/>second sung line<br/>third sung line<br/>fourth sung line</div>');
  };
  const setup = (opts: { env?: Record<string, string>; settings?: Record<string, any>; gpu?: () => Promise<any>; python?: string } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-lyricsync-'));
    const db = openDb(dir);
    db.prepare("INSERT INTO artists (id, name, sort_name) VALUES ('ar', 'A', 'a')").run();
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al', 'B', 'ar', 'A', ?, 9, 0, 'b')").run(dir);
    const add = (id: string, lyr?: { kind: string; lines: LyricLine[]; source?: string }) => {
      const p = path.join(dir, `${id}.flac`); fs.writeFileSync(p, 'x');
      db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, duration_ms, added_at)
        VALUES (?, ?, 0, 0, ?, 'A', '["A"]', '["ar"]', 'al', 'B', 'A', 200000, 0)`).run(id, p, id);
      if (lyr) db.prepare('INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, ?, ?, ?, 1)').run(id, lyr.kind, JSON.stringify(lyr.lines), lyr.source ?? 'lrclib');
      return p;
    };
    const paths = {
      off: add('off', { kind: 'synced', lines: synced(synced8), source: 'sidecar' }),
      plain: add('plain', { kind: 'plain', lines: ['a', 'b', 'c', 'd'].map((text) => ({ start: null, text })) }),
      lrclibsong: add('lrclibsong'),
      nesong: add('nesong'),
      geniussong: add('geniussong'),
      wrongsong: add('wrongsong'),
      nowhere: add('nowhere'),
      broken: add('broken', { kind: 'plain', lines: [{ start: null, text: 'words' }] }),
    };
    fs.writeFileSync(paths.off.replace('.flac', '.lrc'), 'their own file\n');
    Object.assign(process.env, { FAKE_SHIFT: '0', FAKE_STARTS: JSON.stringify({ [paths.off]: synced8 }), ...(opts.env || {}) });
    const app = Fastify();
    app.decorateRequest('user', undefined);
    app.addHook('onRequest', async (req: any) => { req.user = { id: 'u1' }; });
    app.decorate('requireUser', async () => {});
    app.decorate('requireAdmin', async () => {});
    const task = lyricSyncTask(app, {
      db, cacheDir: dir, saveToLibrary: true, python: opts.python ?? process.execPath, script: FAKE, model: 'fake', pollMs: 5,
      gpu: opts.gpu ?? (async () => ({ freeMb: 8000, totalMb: 8188, encoders: 0 })),
      lrclib: lrclibWith({ lrclibsong: 'one\ntwo\nthree\nfour' }) as any, web: web as any,
    });
    registerLyricSync(app, db, { saveToLibrary: true });
    const steps: string[] = [];
    const settings = { power: 'full', ...(opts.settings || {}) };
    const ctx = { step: (t: string) => { steps.push(t); }, log: () => {}, setting: (k: string) => (k in settings ? (settings as any)[k] : (task as TaskDef).settings!.find((x) => x.key === k)!.default) };
    const ask = async (id: string) => (await app.inject({ method: 'POST', url: `/api/lyrics/${id}/sync` })).json();
    const jobs = async (...ids: string[]) => Object.fromEntries(((await app.inject({ url: `/api/lyrics/sync?ids=${ids.join(',')}` })).json().jobs as any[]).map((j) => [j.trackId, j]));
    const lyr = (id: string) => db.prepare('SELECT kind, source, lines FROM lyrics WHERE track_id = ?').get(id) as any;
    return { db, task, ctx, steps, app, paths, ask, jobs, lyr };
  };

  it('syncs what is there, and finds what is not (LrcLib, NetEase, Genius) - only keeping a copy that lines up', async () => {
    const { task, ctx, ask, jobs, lyr, paths, steps } = setup({ env: { FAKE_SHIFT: '1500' } });
    const ids = ['plain', 'off', 'lrclibsong', 'nesong', 'geniussong', 'wrongsong', 'nowhere', 'broken'];
    for (const id of ids) await ask(id);
    expect(await task.run(ctx as any)).toBe('8 songs synced');
    const j = await jobs(...ids);
    expect(j.plain.result).toBe('Synced the lyrics');
    expect(lyr('plain')).toMatchObject({ kind: 'synced', source: 'aligned' });
    expect(j.off.result).toBe('Moved the lyrics 1.5 s later');
    expect(fs.readFileSync(paths.off.replace('.flac', '.orig.lrc'), 'utf8')).toBe('their own file\n');
    expect(j.lrclibsong.result).toBe('Found lyrics on LrcLib and synced them');
    expect(j.nesong.result).toBe('Found synced lyrics on NetEase');
    expect(lyr('nesong')).toMatchObject({ kind: 'synced', source: 'netease' });
    expect(JSON.parse(lyr('nesong').lines)[0]).toEqual({ start: 5000, text: 'one line here' }); // human timing kept as it was
    expect(j.geniussong.result).toBe('Found lyrics on Genius and synced them');
    expect(JSON.parse(lyr('geniussong').lines).map((l: LyricLine) => l.text)).toEqual(['first sung line', 'second sung line', 'third sung line', 'fourth sung line']);
    expect(j.wrongsong.result).toBe("Found lyrics on Genius, but they don't match this recording");
    expect(lyr('wrongsong')).toBeUndefined(); // nothing kept, nothing invented
    expect(j.nowhere.result).toBe("Couldn't find lyrics for this song anywhere");
    expect(j.broken.state).toBe('failed');
    for (const want of ['Looking for lyrics on NetEase', 'Looking for lyrics on Genius', 'Lining the lyrics up with the vocals']) expect(steps.some((s) => s.includes(want))).toBe(true);
    expect(await task.run(ctx as any)).toBe('Nothing queued: use Sync Lyrics on a song');
  });

  it('a waiting song says how many are ahead of it; a running one says what it is doing; ?mine=1 lists them after a reload', async () => {
    const { db, app, ask } = setup();
    await ask('plain'); await ask('off');
    db.prepare("UPDATE lyric_jobs SET state = 'running', step = 'Lining the lyrics up with the vocals' WHERE track_id = 'plain'").run();
    const mine = (await app.inject({ url: '/api/lyrics/sync?mine=1' })).json().jobs;
    expect(mine.map((j: any) => [j.trackId, j.state, j.step, j.ahead])).toEqual([['plain', 'running', 'Lining the lyrics up with the vocals', 0], ['off', 'queued', null, 1]]);
    expect(mine[0].title).toBe('plain');
  });

  it('asking twice while it waits is one job; lyrics already in step are left alone', async () => {
    const { task, ctx, ask, jobs, lyr } = setup();
    expect((await ask('off')).already).toBe(false);
    expect((await ask('off')).already).toBe(true);
    await task.run(ctx as any);
    expect((await jobs('off')).off).toMatchObject({ state: 'done', result: 'Already in sync', step: null });
    expect(lyr('off').source).toBe('sidecar');
  });

  it('with fixing switched off it reports how far off the file is and changes nothing', async () => {
    const { task, ctx, ask, jobs, lyr } = setup({ env: { FAKE_SHIFT: '-2000' }, settings: { correct: false } });
    await ask('off'); await task.run(ctx as any);
    expect((await jobs('off')).off.result).toBe('The lyrics are 2 s late; fixing is switched off');
    expect(lyr('off').source).toBe('sidecar');
  });

  it('undo puts back every change: originals restored, found lyrics removed with their .lrc', async () => {
    const { task, ctx, ask, app, lyr, paths } = setup({ env: { FAKE_SHIFT: '1500' } });
    for (const id of ['plain', 'off', 'nesong']) await ask(id);
    await task.run(ctx as any);
    expect((await app.inject({ method: 'POST', url: '/api/admin/lyricsync/undo' })).json()).toEqual({ restored: 3 });
    expect(lyr('off')).toMatchObject({ kind: 'synced', source: 'sidecar' });
    expect(fs.readFileSync(paths.off.replace('.flac', '.lrc'), 'utf8')).toBe('their own file\n');
    expect(lyr('plain').kind).toBe('plain');
    expect(lyr('nesong')).toBeUndefined();
    expect(fs.existsSync(paths.nesong.replace('.flac', '.lrc'))).toBe(false);
  });

  it('on Normal power it waits while the GPU is encoding (Jellyfin), and the song says so', async () => {
    let calls = 0;
    const { task, ctx, ask, steps, jobs } = setup({ settings: { power: 'normal' }, gpu: async () => ({ freeMb: 8000, totalMb: 8188, encoders: calls++ < 2 ? 1 : 0 }) });
    await ask('plain'); await task.run(ctx as any);
    expect(steps.filter((s) => s.includes('Waiting: the GPU is busy with Jellyfin or Immich')).length).toBe(2);
    expect((await jobs('plain')).plain.state).toBe('done');
  });

  it('a server without the GPU image answers every waiting song instead of leaving it queued', async () => {
    const { task, ctx, ask, jobs } = setup({ python: '/nope/python' });
    await ask('plain');
    expect(await task.run(ctx as any)).toMatch(/needs the GPU image/);
    expect((await jobs('plain')).plain).toMatchObject({ state: 'failed', result: 'This server cannot sync lyrics (it needs the GPU image)' });
  });
});
