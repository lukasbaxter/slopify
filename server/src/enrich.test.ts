import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { enrichPass, enrichStatus, artistImagesPass, albumCoversPass, artistDirOf, type Fetcher } from './enrich.js';

// saveToLibrary writes artist.jpg/cover.jpg INTO the library, so these tests
// run on their own copy of the fixtures: the shared ones stay pristine for
// the next run (this used to fail every second `vitest run`).
const FIXTURES = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const MUSIC = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-enrich-lib-'));
fs.cpSync(FIXTURES, MUSIC, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-enrich-'));

// A fake LrcLib: exact get answers for "River" titles with synced lyrics,
// search finds a plain-only candidate within 3 s for "Signal" titles, marks
// "Static" titles instrumental, and knows nothing about the rest.
const calls: string[] = [];
const fetcher: Fetcher = async (url) => {
  calls.push(url);
  const u = new URL(url); const title = u.searchParams.get('track_name') || ''; const dur = Number(u.searchParams.get('duration') || 0);
  if (u.pathname.endsWith('/get')) {
    if (/river/i.test(title)) return { status: 200, json: async () => ({ id: 1, trackName: title, artistName: 'x', albumName: 'y', duration: dur, instrumental: false, plainLyrics: 'a\nb', syncedLyrics: '[00:00.50] a\n[00:02.00] b' }) };
    if (/static/i.test(title)) return { status: 200, json: async () => ({ id: 2, trackName: title, artistName: 'x', albumName: 'y', duration: dur, instrumental: true, plainLyrics: null, syncedLyrics: null }) };
    return { status: 404, json: async () => ({}) };
  }
  if (/signal/i.test(title)) return { status: 200, json: async () => [{ id: 3, trackName: title, artistName: 'x', albumName: 'y', duration: 999, instrumental: false, plainLyrics: 'far', syncedLyrics: null }, { id: 4, trackName: title, artistName: 'x', albumName: 'y', duration: 7, instrumental: false, plainLyrics: 'plain words', syncedLyrics: null }] };
  return { status: 200, json: async () => [] };
};

describe('enrichment: lyrics for every song', () => {
  const db = openDb(DATA);
  beforeAll(async () => { await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA }); }, 120000);
  it('resolves sidecar, synced, plain and instrumental; queues the rest with retries', async () => {
    const before = (db.prepare("SELECT COUNT(*) n FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id)").get() as any).n;
    expect(before).toBe(8);
    const r = await enrichPass(db, { fetcher });
    expect(r.done + r.missing + r.instrumental).toBe(8);
    const st = enrichStatus(db);
    expect(st.lyrics.done + (st.lyrics.missing || 0)).toBe(30);
    expect(st.kinds.synced).toBeGreaterThanOrEqual(22);
    if (r.instrumental) expect(st.kinds.instrumental).toBe(r.instrumental);
    const missing = st.missing;
    for (const m of missing) { expect(m.lyrics_tries).toBe(1); expect(m.lyrics_next).toBeGreaterThan(Date.now() + 80000000); }
  });
  it('does not ask twice (answers are cached) and retries only when due', async () => {
    const n = calls.length;
    const r = await enrichPass(db, { fetcher });
    expect(r.done + r.missing + r.instrumental).toBe(0);
    expect(calls.length).toBe(n);
  });
  it('a sidecar never loses to a fetched answer', () => {
    const side = (db.prepare("SELECT COUNT(*) n FROM lyrics WHERE source = 'sidecar'").get() as any).n;
    expect(side).toBe(22);
  });
});

describe('fetched extras land in the library (saveToLibrary)', () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-savelib-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-savedata-'));
  const db = openDb(data);
  beforeAll(async () => {
    fs.cpSync(MUSIC, lib, { recursive: true });
    // the pre-made sidecars would mark everything done: only fetched answers matter here
    for (const f of fs.readdirSync(lib, { recursive: true }) as string[]) if (f.endsWith('.lrc')) fs.rmSync(path.join(lib, f));
    await scanLibrary(db, { musicDir: lib, dataDir: data });
  }, 120000);

  it('a fetched lyric is written as the .lrc beside the song', async () => {
    await enrichPass(db, { fetcher, musicDir: lib, saveToLibrary: true });
    const river = db.prepare("SELECT path FROM tracks WHERE title LIKE '%River%' LIMIT 1").get() as any;
    const lrc = river.path.replace(/\.[^.]+$/, '.lrc');
    expect(fs.readFileSync(lrc, 'utf8')).toContain('[00:00.50] a');
    // tracks LrcLib knows nothing about got no file
    const silent = db.prepare("SELECT t.path FROM tracks t JOIN enrich e ON e.track_id = t.id WHERE e.lyrics_state = 'missing' LIMIT 1").get() as any;
    if (silent) expect(fs.existsSync(silent.path.replace(/\.[^.]+$/, '.lrc'))).toBe(false);
  });

  it('an artist.jpg already in the artist folder is used without asking Deezer', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 9, g: 99, b: 9 } } }).png({ compressionLevel: 0 }).toBuffer();
    expect(png.length).toBeGreaterThan(2000);
    const artist = db.prepare('SELECT a.id, a.name FROM artists a JOIN albums al ON al.artist_id = a.id LIMIT 1').get() as any;
    const dir = artistDirOf(db, artist.id, lib)!;
    expect(dir).toBeTruthy();
    fs.writeFileSync(path.join(dir, 'artist.jpg'), png);
    const deezer: Fetcher = async () => { throw new Error('no deezer answer'); };
    const r = await artistImagesPass(db, { fetcher: deezer, dataDir: data, musicDir: lib, saveToLibrary: true, max: 50 });
    expect(r.found).toBe(1); // only the artist whose folder holds a picture
    const row = db.prepare('SELECT image_hash FROM artists WHERE id = ?').get(artist.id) as any;
    expect(row.image_hash).toBeTruthy();
    expect((db.prepare('SELECT src FROM artwork WHERE hash = ?').get(row.image_hash) as any).src).toBe(path.join(dir, 'artist.jpg'));
  });

  it('a Deezer album cover is saved as cover.jpg in the album folder and recorded', async () => {
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 0, b: 0 } } }).jpeg().toBuffer();
    const al = db.prepare('SELECT id, name, artist, dir FROM albums LIMIT 1').get() as any;
    db.prepare('UPDATE albums SET cover_hash = NULL WHERE id = ?').run(al.id);
    const deezer: Fetcher = async () => ({ status: 200, json: async () => ({ data: [{ title: al.name, artist: { name: al.artist }, cover_xl: 'https://cdn.example/cover.jpg' }] }) });
    const r = await albumCoversPass(db, { fetcher: deezer, bytes: async () => Buffer.concat([jpg, Buffer.alloc(Math.max(0, 2001 - jpg.length))]), dataDir: data, musicDir: lib, saveToLibrary: true, max: 50 });
    expect(r.found).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(al.dir, 'cover.jpg'))).toBe(true);
    const row = db.prepare('SELECT cover_hash FROM albums WHERE id = ?').get(al.id) as any;
    expect(row.cover_hash).toBeTruthy();
    expect((db.prepare('SELECT src FROM artwork WHERE hash = ?').get(row.cover_hash) as any).src).toBe(path.join(al.dir, 'cover.jpg'));
  });
});
