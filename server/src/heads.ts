// Heads: the first seconds of every song, kept on the SSD (CACHE_DIR/heads)
// while the full files live on the NAS (MUSIC_DIR). A head is a byte-exact
// prefix of the original file: everything before the audio (tags, cover art,
// FLAC seektable) plus HEAD_SECONDS of audio and a small margin. Every read
// of a song goes through openBytes(), which serves the head from the SSD and
// the rest from the NAS as one stream, so playback starts at SSD speed while
// the NAS catches up, and nothing downstream (range requests from speakers,
// ffmpeg for phones, downloads) knows the file is in two places.
//
// Formats without a simple layout (m4a, aiff, opus: a few dozen files) keep
// the whole file as their "head".
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { DB } from './db.js';

export const HEAD_MARGIN = { flac: 32768, mp3: 4096 } as const;
// Whole-file "heads" (m4a & co) are capped: past this the SSD win is gone and
// the cut would hold the file in memory or churn the cache.
export const HEAD_MAX_BYTES = 64 * 1024 * 1024;
let bigHeadWarned = false;

// Orphaned .tmp files (a crash mid-cut/mid-copy): swept once per directory,
// async and best-effort, only files older than a day (a cut may be running).
const sweptDirs = new Set<string>();
export function sweepTmp(dir: string, log: (m: string) => void = () => {}) {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  (async () => {
    const cutoff = Date.now() - 86400000;
    const walk = async (d: string) => {
      for (const ent of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.name.endsWith('.tmp') && ((await fsp.stat(p).catch(() => null))?.mtimeMs ?? Infinity) < cutoff) await fsp.rm(p, { force: true }).catch(() => {});
      }
    };
    await walk(dir);
  })().catch((e: any) => log(`tmp sweep ${dir}: ${e.message}`));
}

export function headsDir(cacheDir: string) { return path.join(cacheDir, 'heads'); }
export function headPath(cacheDir: string, id: string) { return path.join(headsDir(cacheDir), id.slice(0, 2), id); }

// Bytes before the audio starts: FLAC metadata blocks, or an ID3v2 tag.
export async function audioOffset(file: string): Promise<number> {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(10);
    await fh.read(b, 0, 10, 0);
    if (b.toString('latin1', 0, 4) === 'fLaC') {
      let off = 4; const h = Buffer.alloc(4);
      for (let i = 0; i < 1000; i++) {
        const { bytesRead } = await fh.read(h, 0, 4, off);
        if (bytesRead < 4) return off;
        const last = h[0] & 0x80, len = h.readUIntBE(1, 3);
        off += 4 + len;
        if (last) return off;
      }
      return off;
    }
    if (b.toString('latin1', 0, 3) === 'ID3') {
      const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
      return 10 + size + (b[5] & 0x10 ? 10 : 0);
    }
    return 0;
  } finally { await fh.close(); }
}

// How many bytes of this file make its head.
export async function headLength(file: string, size: number, durationMs: number, seconds: number): Promise<number> {
  const ext = path.extname(file).slice(1).toLowerCase();
  if ((ext !== 'flac' && ext !== 'mp3') || !(durationMs > 0)) return size;
  const off = await audioOffset(file);
  const rate = (size - off) / (durationMs / 1000);
  return Math.min(size, Math.ceil(off + seconds * rate + HEAD_MARGIN[ext]));
}

// Cut the head of `src` (a local copy is fastest) for track `id`. Idempotent.
export async function buildHead(db: DB, cacheDir: string, id: string, src: string, size: number, durationMs: number, seconds: number) {
  sweepTmp(headsDir(cacheDir));
  const len = await headLength(src, size, durationMs, seconds);
  if (len > HEAD_MAX_BYTES) {
    if (!bigHeadWarned) { bigHeadWarned = true; console.warn(`heads: skipping heads over ${HEAD_MAX_BYTES / 1024 / 1024} MB (first: ${src}, ${len} bytes); further skips are silent`); }
    return 0;
  }
  const dst = headPath(cacheDir, id);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; // two scans may cut the same head
  const fh = await fsp.open(src, 'r');
  try {
    const out = await fsp.open(tmp, 'w');
    try {
      const buf = Buffer.alloc(Math.min(len, 1 << 20)); // 1 MB chunks: a whole-file head never sits in RAM
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, len - got), got);
        if (!bytesRead) break;
        await out.write(buf, 0, bytesRead);
        got += bytesRead;
      }
      if (got !== len) throw new Error(`short read ${got}/${len}`);
    } finally { await out.close(); }
  } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; } finally { await fh.close(); }
  await fsp.rename(tmp, dst);
  db.prepare('INSERT INTO heads (track_id, bytes, size, created) VALUES (?, ?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET bytes = excluded.bytes, size = excluded.size, created = excluded.created')
    .run(id, len, size, Date.now());
  return len;
}

// Heads cut from another file with the same audio (a duplicate recording:
// one id, two files, and each scan can leave the row on the other one) no
// longer match the row: recut them from the file the row points at.
export async function reconcileHeads(db: DB, cacheDir: string, seconds: number, log: (m: string) => void = () => {}) {
  const rows = db.prepare('SELECT t.id, t.path, t.size, t.duration_ms FROM tracks t JOIN heads h ON h.track_id = t.id WHERE h.size != t.size').all() as { id: string; path: string; size: number; duration_ms: number }[];
  let n = 0;
  for (const r of rows) {
    try { await buildHead(db, cacheDir, r.id, r.path, r.size, r.duration_ms, seconds); n++; } catch (e: any) { log(`head recut failed ${r.path}: ${e.message}`); }
  }
  return n;
}

// The head for this track, if it matches the file the database knows.
export function headOf(db: DB, cacheDir: string, id: string, size: number): { path: string; bytes: number } | null {
  sweepTmp(headsDir(cacheDir)); // once per process: crash-orphaned .tmp cuts
  const h = db.prepare('SELECT bytes, size FROM heads WHERE track_id = ?').get(id) as { bytes: number; size: number } | undefined;
  if (!h || h.size !== size) return null;
  const p = headPath(cacheDir, id);
  return fs.existsSync(p) ? { path: p, bytes: h.bytes } : null;
}

// A byte range of a file; if the file is not there (a song the library
// lists at its NAS path that the ingest has not copied yet), the same range
// of `alt` (its copy in the SSD drop folder).
function openFile(file: string, start: number, end: number, alt?: string | null): Readable {
  if (!alt) return fs.createReadStream(file, { start, end });
  const out = new PassThrough();
  let inner = fs.createReadStream(file, { start, end });
  inner.on('error', (e: any) => {
    if (e?.code !== 'ENOENT') { out.destroy(e); return; }
    inner = fs.createReadStream(alt, { start, end });
    inner.on('error', (e2) => out.destroy(e2));
    inner.pipe(out);
  });
  inner.pipe(out);
  out.on('close', () => inner.destroy()); // a client abort must close the file, not just the wrapper
  return out;
}

// Bytes [start, end] of the song: from the head while it lasts, then from
// the full file. `file` is only opened when the range goes past the head.
export function openBytes(file: string, head: { path: string; bytes: number } | null, start: number, end: number, alt?: string | null): Readable {
  if (!head || start >= head.bytes) return openFile(file, start, end, alt);
  if (end < head.bytes) return fs.createReadStream(head.path, { start, end });
  const out = new PassThrough();
  const first = fs.createReadStream(head.path, { start, end: head.bytes - 1 });
  let rest: Readable | null = null;
  first.on('error', (e) => out.destroy(e));
  first.on('end', () => {
    if (out.destroyed) return;
    rest = openFile(file, head.bytes, end, alt);
    rest.on('error', (e) => out.destroy(e));
    rest.pipe(out);
  });
  first.pipe(out, { end: false });
  out.on('close', () => { first.destroy(); rest?.destroy(); }); // a client abort must close both files
  return out;
}
