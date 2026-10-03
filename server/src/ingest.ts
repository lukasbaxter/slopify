// Ingest: music arrives on the SSD (INCOMING_DIR: downloader drops,
// slskd, anything copied in) and lives for good on the NAS (NAS_DIR, the same
// share MUSIC_DIR points at once the library is moved). A sweep, every
// INGEST_EVERY_MIN minutes and on demand (POST /api/admin/ingest), takes the
// folders that have settled (nothing written for INGEST_SETTLE_MIN), in
// batches:
//   1. copies each file to the same place on the NAS. Never deletes there;
//      skips a file already there with the same size and second; checks each
//      copy (size, first and last 64 KB);
//   2. indexes the batch from the SSD copies in one scanner pass, recorded at
//      MUSIC_DIR/<same relative path>, cutting every song's head;
//   3. with INGEST_DELETE=1, deletes a folder from the SSD once every file in
//      it is verified on the NAS and every song has its head.
// The NAS share ignores case: two names that differ only in case cannot both
// live there. A duplicate picture keeps its largest copy; a second song is
// renamed "<name> (2)" on the SSD first, so both survive.
//
// Written after the nightly rsync --delete mirror kept losing whole folders
// on that share (it deleted names it could not match byte for byte).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { AUDIO_EXT, scanLibrary } from './scanner.js';
import { headOf } from './heads.js';
import { bumpLibraryVersion } from './db.js';

export type IngestOptions = {
  incomingDir: string; nasDir: string; musicDir: string; cacheDir: string; headSeconds: number;
  headsEnabled?: boolean; // false: no heads cut while indexing, and none required before deleting
  settleMs: number; deleteAfter: boolean; batchDirs?: number; log?: (m: string) => void;
  // Copying early is harmless; deleting a folder a download is still writing to
  // is not (a stalled Soulseek album looks settled after 10 min): deletion waits longer.
  deleteSettleMs?: number;
};
export type IngestStats = {
  startedAt: number; finishedAt: number | null; dirs: number; files: number; copied: number; copiedBytes: number; alreadyThere: number;
  renamed: number; indexed: number; deletedDirs: number; kept: number; errors: string[]; current: string | null;
};

const isAudio = (f: string) => AUDIO_EXT.has(path.extname(f).toLowerCase());
// Leftovers of a Synology NAS the library once lived on: @eaDir index folders,
// sometimes flattened into folders named like the song or cover they indexed.
// Never copied; removed on the NAS where one blocks a real file.
const NAS_JUNK_DIRS = new Set(['@eaDir', '#recycle', '#snapshot', '.@__thumb']);
const isSynoFile = (name: string) => /^SYNO(INDEX|AUDIO|PHOTO|VIDEO)_/i.test(name) || name === 'Thumbs.db' || name === '.DS_Store';
async function onlySynoJunk(dir: string) {
  try { const names = await fsp.readdir(dir); return names.every(isSynoFile); } catch { return false; }
}
const secs = (ms: number) => Math.floor(ms / 1000);
const SAMPLE = 64 * 1024;

async function readAt(file: string, pos: number, len: number) {
  const fh = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, pos); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}
// Same size, same first and last 64 KB.
export async function sameFile(a: string, b: string, size: number) {
  const n = Math.min(SAMPLE, size);
  const [a1, b1] = await Promise.all([readAt(a, 0, n), readAt(b, 0, n)]);
  if (!a1.equals(b1)) return false;
  if (size <= SAMPLE) return true;
  const [a2, b2] = await Promise.all([readAt(a, size - n, n), readAt(b, size - n, n)]);
  return a2.equals(b2);
}

// Every folder under root with the files directly in it (dot names skipped).
async function folders(root: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const walk = async (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const files: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || NAS_JUNK_DIRS.has(e.name) || isSynoFile(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p); else if (e.isFile()) files.push(p);
    }
    if (files.length) out.set(dir, files);
  };
  await walk(root);
  return out;
}

export class Ingest {
  running: Promise<IngestStats> | null = null;
  last: IngestStats | null = null;
  constructor(private db: DB, private o: IngestOptions) {}
  private log(m: string) { this.o.log?.(m); }
  private nasPath(f: string) { return path.join(this.o.nasDir, path.relative(this.o.incomingDir, f)); }
  private finalPath(f: string) { return path.join(this.o.musicDir, path.relative(this.o.incomingDir, f)); }
  private heads() { return this.o.headsEnabled === false ? undefined : { cacheDir: this.o.cacheDir, seconds: this.o.headSeconds }; }

  // One sweep at a time. only: folders (relative to INCOMING_DIR) to take now,
  // settled or not; settleMs: a shorter settle time for this sweep.
  sweep(opts: { only?: string[]; settleMs?: number } = {}): Promise<IngestStats> {
    // A request for particular folders while a sweep runs (an album just
    // landed during a long sweep) waits for it and then runs on its own.
    if (this.running && opts.only?.length) return this.running.catch(() => null).then(() => this.sweep(opts));
    if (this.running) return this.running;
    this.running = this.run(opts.only, opts.settleMs ?? this.o.settleMs).finally(() => { this.running = null; });
    return this.running;
  }
  // Another tool reorganising the SSD folder can hold sweeps off with this file.
  holdFile() { return path.join(this.o.incomingDir, '.ingest-hold'); }

  private async run(only: string[] | undefined, settleMs: number): Promise<IngestStats> {
    const st: IngestStats = { startedAt: Date.now(), finishedAt: null, dirs: 0, files: 0, copied: 0, copiedBytes: 0, alreadyThere: 0, renamed: 0, indexed: 0, deletedDirs: 0, kept: 0, errors: [], current: null };
    this.last = st;
    if (!fs.existsSync(this.o.incomingDir)) { st.finishedAt = Date.now(); return st; }
    if (fs.existsSync(this.holdFile())) { this.log(`ingest: on hold (${this.holdFile()} exists)`); st.errors.push('on hold'); st.finishedAt = Date.now(); return st; }
    const all = await folders(this.o.incomingDir);
    const wanted = only?.map((d) => path.resolve(this.o.incomingDir, d));
    const now = Date.now();
    const ready: [string, string[]][] = [];
    for (const [dir, files] of all) {
      if (wanted && !wanted.some((w) => dir === w || dir.startsWith(w + path.sep))) continue;
      if (!wanted) {
        // settled: nothing in the folder written recently
        let newest = 0;
        for (const f of files) { try { newest = Math.max(newest, (await fsp.stat(f)).mtimeMs); } catch { /* gone */ } }
        if (now - newest < settleMs) continue;
      }
      ready.push([dir, files]);
    }
    const B = this.o.batchDirs ?? 100;
    for (let i = 0; i < ready.length; i += B) {
      const batch = ready.slice(i, i + B);
      const toIndex: string[] = []; const ok = new Map<string, string[]>();
      for (const [dir, files] of batch) {
        st.current = path.relative(this.o.incomingDir, dir) || '.';
        try {
          const kept = await this.copyFolder(dir, files, st); ok.set(dir, kept);
          const fresh = new Set(this.fresh);
          for (const f of kept.filter(isAudio)) if (fresh.has(f) || await this.needsIndex(f)) toIndex.push(f);
        }
        catch (e: any) { st.errors.push(`${st.current}: ${e.message}`); this.log(`ingest ${st.current}: ${e.message}`); }
        st.dirs++;
      }
      if (toIndex.length) {
        const r = await scanLibrary(this.db, {
          musicDir: this.o.incomingDir, dataDir: this.o.cacheDir, files: toIndex,
          recordAs: (f) => this.finalPath(f), heads: this.heads(),
          log: (m) => this.log(m),
        });
        st.indexed += r.added + r.changed;
      }
      if (this.o.deleteAfter) for (const [dir, files] of ok) await this.maybeDelete(dir, files, st);
      this.log(`ingest: ${Math.min(i + B, ready.length)} of ${ready.length} folders, ${st.copied} copied (${(st.copiedBytes / 1e9).toFixed(1)} GB), ${st.alreadyThere} already there, ${st.deletedDirs} cleared from the SSD, ${st.errors.length} errors`);
    }
    if (st.indexed) bumpLibraryVersion(this.db);
    st.current = null; st.finishedAt = Date.now();
    return st;
  }

  // Copy one folder's files to the NAS; returns the SSD files that now have a verified twin there.
  private async copyFolder(dir: string, files: string[], st: IngestStats): Promise<string[]> {
    // Names that differ only in case: one picture kept, songs renamed apart.
    const byFold = new Map<string, string[]>();
    for (const f of files) { const k = path.basename(f).toLowerCase(); byFold.set(k, [...(byFold.get(k) || []), f]); }
    const list: string[] = [];
    for (const group of byFold.values()) {
      if (group.length === 1) { list.push(group[0]); continue; }
      if (!group.some(isAudio)) {
        const sizes = await Promise.all(group.map(async (f) => (await fsp.stat(f)).size));
        list.push(group[sizes.indexOf(Math.max(...sizes))]);
        continue;
      }
      list.push(group[0]);
      for (let k = 1; k < group.length; k++) {
        const f = group[k]; const ext = path.extname(f);
        const to = path.join(dir, `${path.basename(f, ext)} (${k + 1})${ext}`);
        await fsp.rename(f, to); st.renamed++; list.push(to);
        this.log(`ingest: renamed ${path.relative(this.o.incomingDir, f)} -> ${path.basename(to)} (case clash on the NAS)`);
      }
    }
    // Files this ingest already verified on the NAS and that have not changed
    // since: nothing to do, no NAS access at all (a sweep every 10 minutes over
    // the whole SSD must not touch the NAS for what it already knows).
    const known = this.db.prepare('SELECT size, mtime FROM ingested WHERE rel = ?');
    const mark = this.db.prepare('INSERT INTO ingested (rel, size, mtime, at) VALUES (?, ?, ?, ?) ON CONFLICT(rel) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, at = excluded.at');
    const kept: string[] = []; const pending: { f: string; s: fs.Stats; rel: string }[] = [];
    for (const f of list) {
      st.files++;
      const s = await fsp.stat(f);
      const rel = path.relative(this.o.incomingDir, f);
      const r = known.get(rel) as { size: number; mtime: number } | undefined;
      if (r && r.size === s.size && r.mtime === secs(s.mtimeMs)) { st.alreadyThere++; kept.push(f); continue; }
      pending.push({ f, s, rel });
    }
    this.fresh = [];
    if (!pending.length) return kept;
    // The rest: one listing of the NAS folder (names matched ignoring case, as the share does).
    const nasDir = path.dirname(this.nasPath(pending[0].f));
    const there = new Map<string, string>();
    try { for (const e of await fsp.readdir(nasDir)) there.set(e.toLowerCase(), e); } catch { /* folder not there yet */ }
    for (const { f, s, rel } of pending) {
      const name = there.get(path.basename(f).toLowerCase());
      const dst = name ? path.join(nasDir, name) : this.nasPath(f);
      let t: fs.Stats | null = null;
      if (name) { try { t = await fsp.stat(dst); } catch { /* gone meanwhile */ } }
      // A Synology index folder sitting where this file goes: remove it (only
      // ever a folder of SYNO* index files); anything else in the way is an error.
      if (t?.isDirectory()) {
        if (!(await onlySynoJunk(dst))) throw new Error(`a folder is in the way on the NAS: ${path.basename(dst)}`);
        await fsp.rm(dst, { recursive: true, force: true });
        this.log(`ingest: removed a Synology index folder in the way on the NAS: ${path.relative(this.o.nasDir, dst)}`);
        t = null;
      }
      if (t && t.size === s.size && secs(t.mtimeMs) === secs(s.mtimeMs)) {
        st.alreadyThere++; kept.push(f); mark.run(rel, s.size, secs(s.mtimeMs), Date.now()); continue;
      }
      const target = this.nasPath(f);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const tmp = path.join(path.dirname(target), `.slopify-${process.pid}-${path.basename(target)}`);
      await fsp.copyFile(f, tmp);
      await fsp.utimes(tmp, s.atime, s.mtime);
      await fsp.rename(tmp, target);
      const now = await fsp.stat(target);
      if (now.size !== s.size || !(await sameFile(f, target, s.size))) throw new Error(`copy of ${path.basename(f)} did not verify`);
      mark.run(rel, s.size, secs(s.mtimeMs), Date.now());
      st.copied++; st.copiedBytes += s.size; kept.push(f); this.fresh.push(f);
    }
    return kept;
  }
  private fresh: string[] = [];

  // Not in the library at its NAS path with this size, or without a head.
  private async needsIndex(f: string) {
    const t = this.db.prepare('SELECT id, size FROM tracks WHERE path = ?').get(this.finalPath(f)) as { id: string; size: number } | undefined;
    if (!t) return true;
    const size = (await fsp.stat(f)).size;
    return t.size !== size || (!!this.heads() && !headOf(this.db, this.o.cacheDir, t.id, t.size));
  }

  // Delete the SSD folder only when every file is on the NAS and every song is indexed at its NAS path with a head.
  private async maybeDelete(dir: string, kept: string[], st: IngestStats) {
    const rel = path.relative(this.o.incomingDir, dir) || '.';
    let files: string[];
    try { files = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => path.join(dir, e.name)); } catch { return; }
    const wait = this.o.deleteSettleMs ?? 60 * 60000;
    let newest = 0;
    for (const f of files) { try { newest = Math.max(newest, (await fsp.stat(f)).mtimeMs); } catch { /* gone */ } }
    if (Date.now() - newest < wait) { st.kept++; return; } // still settling: copied now, deleted on a later sweep
    const keptSet = new Set(kept);
    // A duplicate picture that was not copied still counts as covered by its twin.
    const covered = (f: string) => keptSet.has(f) || (!isAudio(f) && kept.some((k) => path.basename(k).toLowerCase() === path.basename(f).toLowerCase()));
    // Look at the NAS again right before deleting (the record may be old).
    const nasDir = path.dirname(this.nasPath(files[0] ?? dir));
    const onNas = new Map<string, number>();
    try { for (const e of await fsp.readdir(nasDir)) { try { const s = await fsp.stat(path.join(nasDir, e)); if (s.isFile()) onNas.set(e.toLowerCase(), s.size); } catch { /* gone */ } } } catch { st.kept++; return; }
    for (const f of files) {
      if (!covered(f)) { st.kept++; return; }
      if (keptSet.has(f)) {
        const size = (await fsp.stat(f)).size;
        if (onNas.get(path.basename(f).toLowerCase()) !== size) { st.kept++; this.log(`ingest: keeping ${rel} on the SSD (${path.basename(f)} is not on the NAS right now)`); return; }
      }
      if (!isAudio(f)) continue;
      const s = await fsp.stat(f);
      const t = this.db.prepare('SELECT id, size FROM tracks WHERE path = ?').get(this.finalPath(f)) as { id: string; size: number } | undefined;
      if (!t || t.size !== s.size || (this.heads() && !headOf(this.db, this.o.cacheDir, t.id, t.size))) { st.kept++; this.log(`ingest: keeping ${rel} on the SSD (${path.basename(f)} is not in the library${this.heads() ? ' with a head' : ''})`); return; }
    }
    for (const f of files) await fsp.unlink(f);
    // empty folders up to (not including) the incoming root
    let d = dir;
    while (d !== this.o.incomingDir && d.startsWith(this.o.incomingDir)) {
      try { await fsp.rmdir(d); } catch { break; }
      d = path.dirname(d);
    }
    st.deletedDirs++;
  }
}

export type IngestConfig = { incomingDir: string; nasDir: string; everyMin: number; settleMin: number; deleteAfter: boolean; deleteSettleMin: number };

export function registerIngest(app: FastifyInstance, db: DB, o: IngestConfig & { musicDir: string; cacheDir: string; headSeconds: number; headsEnabled?: boolean }) {
  if (!o.incomingDir) return null;
  const ing = new Ingest(db, { incomingDir: path.resolve(o.incomingDir), nasDir: path.resolve(o.nasDir), musicDir: path.resolve(o.musicDir), cacheDir: o.cacheDir, headSeconds: o.headSeconds, headsEnabled: o.headsEnabled, settleMs: o.settleMin * 60000, deleteAfter: o.deleteAfter, deleteSettleMs: o.deleteSettleMin * 60000, log: (m) => app.log.info(m) });
  const admin = { preHandler: (app as any).requireAdmin };
  const after = () => (app as any).runAfterScan?.();
  // Downloaders: {dirs: [relative folders]} when an album has landed (awaited);
  // without dirs, a sweep of everything settled (started, not awaited).
  app.post('/api/admin/ingest', admin, async (req: any) => {
    const dirs = Array.isArray(req.body?.dirs) ? req.body.dirs.map(String) : null;
    if (dirs?.length) { const r = await ing.sweep({ only: dirs, settleMs: 0 }); after(); return r; }
    void ing.sweep().then(after);
    return { started: true };
  });
  app.get('/api/admin/ingest', admin, async () => ({ running: !!ing.running, deleteAfter: o.deleteAfter, hold: fs.existsSync(ing.holdFile()), last: ing.last }));
  return ing;
}
