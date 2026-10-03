// Whole songs cached on the SSD (CACHE_DIR/songs), next to the heads: when a
// song is about to play (it starts, or it is next in someone's queue) the full
// file is copied from the NAS, and every read after that is local. Played
// songs move to the top; past SONG_CACHE_GB the least recently played ones are
// deleted first. Heads are separate and never evicted, so a song that fell
// out still starts at SSD speed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DB } from './db.js';
import { sweepTmp } from './heads.js';

export function songPath(cacheDir: string, id: string) { return path.join(cacheDir, 'songs', id.slice(0, 2), id); }

export class SongCache {
  private inflight = new Map<string, Promise<void>>();
  private queue: { id: string; file: string; size: number }[] = [];
  private active = 0;
  private touched = new Map<string, number>();
  constructor(private db: DB, private cacheDir: string, private capBytes: number, private log: (m: string) => void = () => {}, private parallel = 2, private copyTimeoutMs = 120000) {
    if (this.enabled) sweepTmp(path.join(cacheDir, 'songs'), log); // crash-orphaned .tmp copies
  }
  get enabled() { return this.capBytes > 0; }

  // The local copy of this song, if it is complete; counts as a play for the order.
  get(id: string, size: number): string | null {
    if (!this.enabled) return null;
    const r = this.db.prepare('SELECT bytes FROM song_cache WHERE track_id = ?').get(id) as { bytes: number } | undefined;
    if (!r || r.bytes !== size) return null;
    const p = songPath(this.cacheDir, id);
    if (!fs.existsSync(p)) { this.db.prepare('DELETE FROM song_cache WHERE track_id = ?').run(id); return null; }
    const now = Date.now();
    if (now - (this.touched.get(id) ?? 0) > 60000) { this.touched.set(id, now); this.db.prepare('UPDATE song_cache SET last_used = ? WHERE track_id = ?').run(now, id); }
    return p;
  }

  // Fetch it from the NAS in the background (a few at a time); no-op if cached or on its way.
  want(id: string, file: string, size: number) {
    if (!this.enabled || size > this.capBytes / 2 || this.inflight.has(id) || this.get(id, size)) return;
    let done!: () => void;
    this.inflight.set(id, new Promise<void>((r) => { done = r; }));
    this.queue.push({ id, file, size });
    (this.queue.at(-1) as any).done = done;
    this.pump();
  }

  private pump() {
    while (this.active < this.parallel && this.queue.length) {
      const job = this.queue.shift()! as { id: string; file: string; size: number; done: () => void };
      this.active++;
      this.fetch(job).catch((e) => this.log(`song cache ${job.id}: ${e.message}`))
        .finally(() => { this.active--; this.inflight.delete(job.id); job.done(); this.pump(); });
    }
  }

  // A stream copy with a hard timeout: a wedged NAS mount must give the fetch
  // slot back (fs.promises.copyFile cannot be aborted). The timer rejects even
  // if the underlying read is stuck in the kernel; the streams are destroyed
  // best-effort and the .tmp cleaned up by the caller.
  private copy(from: string, to: string) {
    return new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(from);
      const ws = fs.createWriteStream(to);
      const timer = setTimeout(() => {
        const e = new Error(`copy timed out after ${Math.round(this.copyTimeoutMs / 1000)}s`);
        rs.destroy(e); ws.destroy(); reject(e);
      }, this.copyTimeoutMs);
      ws.on('finish', () => { clearTimeout(timer); resolve(); });
      rs.on('error', (e) => { clearTimeout(timer); ws.destroy(); reject(e); });
      ws.on('error', (e) => { clearTimeout(timer); rs.destroy(); reject(e); });
      rs.pipe(ws);
    });
  }

  private async fetch({ id, file, size }: { id: string; file: string; size: number }) {
    const dst = songPath(this.cacheDir, id);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp`;
    try {
      await this.copy(file, tmp);
      const got = (await fsp.stat(tmp)).size;
      if (got !== size) throw new Error(`copied ${got} of ${size} bytes`);
    } catch (e) { fsp.rm(tmp, { force: true }).catch(() => {}); throw e; } // best effort: a wedged mount may hold the handle
    await fsp.rename(tmp, dst);
    const now = Date.now();
    this.db.prepare('INSERT INTO song_cache (track_id, bytes, last_used, added) VALUES (?, ?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET bytes = excluded.bytes, last_used = excluded.last_used').run(id, size, now, now);
    await this.evict();
  }

  // Least recently played first, until under the limit.
  async evict() {
    let total = (this.db.prepare('SELECT COALESCE(SUM(bytes), 0) n FROM song_cache').get() as { n: number }).n;
    if (total <= this.capBytes) return 0;
    let n = 0;
    for (const r of this.db.prepare('SELECT track_id, bytes FROM song_cache ORDER BY last_used ASC').all() as { track_id: string; bytes: number }[]) {
      if (total <= this.capBytes) break;
      if (this.inflight.has(r.track_id)) continue;
      await fsp.rm(songPath(this.cacheDir, r.track_id), { force: true });
      this.db.prepare('DELETE FROM song_cache WHERE track_id = ?').run(r.track_id);
      total -= r.bytes; n++;
    }
    return n;
  }

  stats() {
    const r = this.db.prepare('SELECT COUNT(*) songs, COALESCE(SUM(bytes), 0) bytes FROM song_cache').get() as { songs: number; bytes: number };
    return { ...r, capBytes: this.capBytes, fetching: this.active + this.queue.length };
  }
}
