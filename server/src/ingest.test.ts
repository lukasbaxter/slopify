import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { buildHead, headOf, headLength, openBytes } from './heads.js';
import { Ingest } from './ingest.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readAll = async (s: NodeJS.ReadableStream) => { const parts: Buffer[] = []; for await (const c of s) parts.push(c as Buffer); return Buffer.concat(parts); };
const copyTree = (from: string, to: string) => fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });

describe('heads', () => {
  it('head + rest reads back exactly the original bytes, for any range', async () => {
    const db = openDb(tmp('slopify-heads-'));
    const cache = tmp('slopify-cache-');
    const file = fs.readdirSync(path.join(MUSIC, 'The Fixture Band', 'Second Wind')).filter((f) => f.endsWith('.mp3')).map((f) => path.join(MUSIC, 'The Fixture Band', 'Second Wind', f))[0];
    const size = fs.statSync(file).size;
    const len = await headLength(file, size, 6000, 1);
    expect(len).toBeGreaterThan(0); expect(len).toBeLessThan(size);
    await buildHead(db, cache, 'abc123', file, size, 6000, 1);
    const head = headOf(db, cache, 'abc123', size)!;
    expect(head.bytes).toBe(len);
    const orig = fs.readFileSync(file);
    for (const [a, b] of [[0, size - 1], [0, 10], [len - 5, len + 5], [len, size - 1], [len + 100, len + 200]]) {
      expect((await readAll(openBytes(file, head, a, b))).equals(orig.subarray(a, b + 1))).toBe(true);
    }
    // the file changed size since: the head no longer counts
    expect(headOf(db, cache, 'abc123', size + 1)).toBeNull();
  });
});

describe('ingest', () => {
  const setup = () => {
    const incoming = tmp('slopify-in-'), nas = tmp('slopify-nas-'), cache = tmp('slopify-c-');
    copyTree(path.join(MUSIC, 'The Fixture Band'), path.join(incoming, 'The Fixture Band'));
    const db = openDb(tmp('slopify-idb-'));
    return { incoming, nas, cache, db };
  };

  it('copies to the NAS, indexes at the NAS path with heads, and keeps the SSD copy until deletion is on', async () => {
    const { incoming, nas, cache, db } = setup();
    const ing = new Ingest(db, { incomingDir: incoming, nasDir: nas, musicDir: nas, cacheDir: cache, headSeconds: 1, settleMs: 0, deleteAfter: false });
    const st = await ing.sweep();
    expect(st.errors).toEqual([]);
    const tracks = db.prepare('SELECT id, path, size FROM tracks').all() as any[];
    expect(tracks.length).toBeGreaterThan(0);
    for (const t of tracks) {
      expect(t.path.startsWith(nas)).toBe(true);
      expect(fs.statSync(t.path).size).toBe(t.size);
      expect(headOf(db, cache, t.id, t.size)).not.toBeNull();
    }
    expect(fs.existsSync(path.join(incoming, 'The Fixture Band'))).toBe(true);
    // a second sweep finds everything already there and copies nothing
    const again = await ing.sweep();
    expect(again.copied).toBe(0); expect(again.alreadyThere).toBe(st.files);
  });

  it('with deletion on, clears the SSD folder only after all of that; a hold file stops the sweep', async () => {
    const { incoming, nas, cache, db } = setup();
    const ing = new Ingest(db, { incomingDir: incoming, nasDir: nas, musicDir: nas, cacheDir: cache, headSeconds: 1, settleMs: 0, deleteAfter: true, deleteSettleMs: 0 });
    fs.writeFileSync(path.join(incoming, '.ingest-hold'), '');
    const held = await ing.sweep();
    expect(held.errors).toEqual(['on hold']); expect(held.copied).toBe(0);
    fs.unlinkSync(path.join(incoming, '.ingest-hold'));
    const st = await ing.sweep();
    expect(st.deletedDirs).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(incoming, 'The Fixture Band'))).toBe(false);
    const n = (db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n;
    expect(n).toBeGreaterThan(0);
  });

  // Only where the disk tells case apart (the server's SSD; not a Mac's APFS).
  it('names that differ only in case: the second song is renamed apart, a duplicate picture keeps its largest copy', async (ctx) => {
    const { incoming, nas, cache, db } = setup();
    const album = path.join(incoming, 'The Fixture Band', 'Second Wind');
    const song = fs.readdirSync(album).find((f) => f.endsWith('.mp3'))!;
    const before = fs.readdirSync(album).length;
    fs.copyFileSync(path.join(album, song), path.join(album, song.toUpperCase().replace('.MP3', '.mp3')));
    if (fs.readdirSync(album).length === before) ctx.skip();
    fs.writeFileSync(path.join(album, 'COVER.PNG'), 'x');
    const ing = new Ingest(db, { incomingDir: incoming, nasDir: nas, musicDir: nas, cacheDir: cache, headSeconds: 1, settleMs: 0, deleteAfter: false });
    const st = await ing.sweep();
    expect(st.errors).toEqual([]);
    expect(st.renamed).toBe(1);
    expect(fs.readdirSync(album).some((f) => / \(2\)\.mp3$/.test(f))).toBe(true);
    expect(fs.statSync(path.join(nas, 'The Fixture Band', 'Second Wind', 'cover.png')).size).toBeGreaterThan(1);
  });
});

describe('ingest while a sweep runs', () => {
  it('a request for particular folders waits for the running sweep, then runs itself', async () => {
    const incoming = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-in2-')), nas = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-nas2-')), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-c2-'));
    fs.cpSync(path.join(MUSIC, 'The Fixture Band'), path.join(incoming, 'The Fixture Band'), { recursive: true, preserveTimestamps: true });
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-idb2-')));
    // settleMs huge: the background sweep takes nothing; the folder request ignores settling
    const ing = new Ingest(db, { incomingDir: incoming, nasDir: nas, musicDir: nas, cacheDir: cache, headSeconds: 1, settleMs: 1e12, deleteAfter: false });
    const bg = ing.sweep();
    const mine = ing.sweep({ only: ['The Fixture Band'], settleMs: 0 });
    expect((await bg).copied).toBe(0);
    expect((await mine).copied).toBeGreaterThan(0);
  });
});

describe('ingest and Synology leftovers', () => {
  it('never copies @eaDir or SYNO index folders, and clears one that blocks a real file on the NAS', async () => {
    const incoming = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-in3-')), nas = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-nas3-')), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-c3-'));
    const album = path.join(incoming, 'The Fixture Band');
    fs.cpSync(path.join(MUSIC, 'The Fixture Band'), album, { recursive: true, preserveTimestamps: true });
    const sub = path.join(album, 'Second Wind');
    fs.mkdirSync(path.join(sub, '@eaDir', 'x.flac'), { recursive: true }); fs.writeFileSync(path.join(sub, '@eaDir', 'x.flac', 'SYNOINDEX_MEDIA_INFO'), 'i');
    fs.mkdirSync(path.join(sub, 'Junk.flac')); fs.writeFileSync(path.join(sub, 'Junk.flac', 'SYNOINDEX_MEDIA_INFO'), 'i');
    const song = fs.readdirSync(sub).find((f) => f.endsWith('.mp3'))!;
    const blocker = path.join(nas, 'The Fixture Band', 'Second Wind', song);
    fs.mkdirSync(blocker, { recursive: true }); fs.writeFileSync(path.join(blocker, 'SYNOAUDIO_01APIC_03.jpg'), 'i');
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-idb3-')));
    const st = await new Ingest(db, { incomingDir: incoming, nasDir: nas, musicDir: nas, cacheDir: cache, headSeconds: 1, settleMs: 0, deleteAfter: false }).sweep();
    expect(st.errors).toEqual([]);
    expect(fs.statSync(blocker).isFile()).toBe(true);
    expect(fs.existsSync(path.join(nas, 'The Fixture Band', 'Second Wind', '@eaDir'))).toBe(false);
    expect(fs.existsSync(path.join(nas, 'The Fixture Band', 'Second Wind', 'Junk.flac'))).toBe(false);
  });
});

describe('ingest deletion waits', () => {
  it('copies a folder written a minute ago but does not delete it yet', async () => {
    const incoming = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-in4-')), nas = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-nas4-')), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-c4-'));
    fs.cpSync(path.join(MUSIC, 'The Fixture Band'), path.join(incoming, 'The Fixture Band'), { recursive: true }); // fresh mtimes
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-idb4-')));
    const st = await new Ingest(db, { incomingDir: incoming, nasDir: nas, musicDir: nas, cacheDir: cache, headSeconds: 1, settleMs: 0, deleteAfter: true }).sweep();
    expect(st.copied).toBeGreaterThan(0);
    expect(st.deletedDirs).toBe(0);
    expect(fs.existsSync(path.join(incoming, 'The Fixture Band'))).toBe(true);
  });
});
