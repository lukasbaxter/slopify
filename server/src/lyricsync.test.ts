import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { judgeSynced, timePlain, toLrc, lyricSyncTask, registerLyricSyncAdmin, type AlignedLine } from './lyricsync.js';
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

describe('the Sync lyrics task', () => {
  const setup = (env: Record<string, string>, settings: Record<string, any> = {}, gpu?: () => Promise<any>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-lyricsync-'));
    const db = openDb(dir);
    db.prepare("INSERT INTO artists (id, name, sort_name) VALUES ('ar', 'A', 'a')").run();
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al', 'B', 'ar', 'A', ?, 3, 0, 'b')").run(dir);
    const add = (id: string, file: string, kind: string, lines: LyricLine[], source = 'lrclib') => {
      const p = path.join(dir, file); fs.writeFileSync(p, 'x');
      db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, duration_ms, added_at)
        VALUES (?, ?, 0, 0, ?, 'A', '["A"]', '["ar"]', 'al', 'B', 'A', 200000, 0)`).run(id, p, id);
      db.prepare('INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, ?, ?, ?, 1)').run(id, kind, JSON.stringify(lines), source);
      return p;
    };
    const sPath = add('s1', 'synced.flac', 'synced', synced([10000, 13000, 16000, 19000, 22000, 25000, 28000, 31000]), 'sidecar');
    fs.writeFileSync(sPath.replace('.flac', '.lrc'), 'their own file\n');
    add('p1', 'plain.flac', 'plain', ['a', 'b', 'c', 'd'].map((text) => ({ start: null, text })));
    add('x1', 'broken.flac', 'plain', [{ start: null, text: 'words' }]);
    add('i1', 'inst.flac', 'instrumental', []);
    Object.assign(process.env, { FAKE_STARTS: JSON.stringify({ [sPath]: [10000, 13000, 16000, 19000, 22000, 25000, 28000, 31000] }), ...env });
    const app = Fastify();
    app.decorate('requireAdmin', async () => {});
    const task = lyricSyncTask(app, { db, cacheDir: dir, saveToLibrary: true, python: process.execPath, script: FAKE, model: 'fake', gpu: gpu ?? (async () => ({ freeMb: 8000, totalMb: 8188, encoders: 0 })), pollMs: 5 });
    const steps: string[] = [];
    const ctx = { step: (t: string) => { steps.push(t); }, log: () => {}, setting: (k: string) => (k in settings ? settings[k] : (task as TaskDef).settings!.find((x) => x.key === k)!.default) };
    return { db, task, ctx, steps, app, sPath };
  };

  it('times plain lyrics, shifts an offset synced file (keeping the original sidecar), records failures, then has nothing left', async () => {
    const { db, task, ctx, steps, sPath } = setup({ FAKE_SHIFT: '1500' }, { power: 'full' });
    const summary = await task.run(ctx as any);
    expect(summary).toMatch(/2 timed|1 timed/);
    const lyr = Object.fromEntries((db.prepare('SELECT track_id, kind, source, lines FROM lyrics').all() as any[]).map((r) => [r.track_id, r]));
    expect(lyr.p1).toMatchObject({ kind: 'synced', source: 'aligned' });
    expect(JSON.parse(lyr.p1.lines).map((l: LyricLine) => l.start)).toEqual([0, 3000, 6000, 9000]);
    expect(lyr.s1.source).toBe('aligned');
    expect(JSON.parse(lyr.s1.lines)[0].start).toBe(11500);
    expect(lyr.i1.kind).toBe('instrumental'); // never touched
    const states = Object.fromEntries((db.prepare('SELECT track_id, state FROM lyric_align').all() as any[]).map((r) => [r.track_id, r.state]));
    expect(states).toEqual({ p1: 'synced', s1: 'corrected', x1: 'failed' });
    expect(fs.readFileSync(sPath.replace('.flac', '.orig.lrc'), 'utf8')).toBe('their own file\n');
    expect(fs.readFileSync(sPath.replace('.flac', '.lrc'), 'utf8')).toMatch(/^\[00:11\.50\]line 0/);
    expect(steps.some((s) => / · 1 of 3$/.test(s))).toBe(true); // progress names the song and the count
    expect(await task.run(ctx as any)).toBe('every song with lyrics has been checked');
  });

  it('undo puts back every change, the original sidecar included', async () => {
    const { db, task, ctx, app, sPath } = setup({ FAKE_SHIFT: '1500' }, { power: 'full' });
    await task.run(ctx as any);
    registerLyricSyncAdmin(app, db, { saveToLibrary: true });
    expect((await app.inject({ method: 'POST', url: '/api/admin/lyricsync/undo' })).json()).toEqual({ restored: 2 });
    const s1 = db.prepare("SELECT kind, source, lines FROM lyrics WHERE track_id = 's1'").get() as any;
    expect(s1).toMatchObject({ kind: 'synced', source: 'sidecar' });
    expect(JSON.parse(s1.lines)[0].start).toBe(10000);
    expect(fs.readFileSync(sPath.replace('.flac', '.lrc'), 'utf8')).toBe('their own file\n');
    expect((db.prepare("SELECT kind FROM lyrics WHERE track_id = 'p1'").get() as any).kind).toBe('plain');
    expect(await task.run(ctx as any)).toBe('every song with lyrics has been checked'); // undone stays undone
  });

  it('with fixing switched off, an off file is reported and left as it was', async () => {
    const { db, task, ctx } = setup({ FAKE_SHIFT: '1500' }, { power: 'full', correct: false, plain: false });
    await task.run(ctx as any);
    expect((db.prepare("SELECT source FROM lyrics WHERE track_id = 's1'").get() as any).source).toBe('sidecar');
    expect((db.prepare("SELECT state, shift_ms FROM lyric_align WHERE track_id = 's1'").get() as any)).toEqual({ state: 'off', shift_ms: 1500 });
  });

  it('on Normal power it waits while the GPU is encoding (Jellyfin), then carries on', async () => {
    let calls = 0;
    const gpu = async () => ({ freeMb: 8000, totalMb: 8188, encoders: calls++ < 2 ? 1 : 0 });
    const { task, ctx, steps } = setup({ FAKE_SHIFT: '0' }, { power: 'normal' }, gpu);
    await task.run(ctx as any);
    expect(steps.filter((s) => s.startsWith('Paused: the GPU is encoding')).length).toBe(2);
  });

  it('stands down on an image without the aligner', async () => {
    const app = Fastify();
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-lyricsync-none-')));
    const task = lyricSyncTask(app, { db, cacheDir: '/tmp', saveToLibrary: false, python: '/nope/python', script: '/nope/align.py', model: 'turbo' });
    expect(await task.run({ step: () => {}, log: () => {}, setting: () => true } as any)).toMatch(/needs the GPU image/);
  });
});
