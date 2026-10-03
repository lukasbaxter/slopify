// Scheduled tasks, the way Jellyfin has them: one place in the admin
// dashboard that lists every recurring chore - scan the library, fetch
// lyrics and artwork, cut song heads, discover new music, fill in
// discographies - with when it last ran, what it did, and a Run now button.
// Everything ships in the image; a task that is missing its dependency
// (no Lidarr, heads off) says so instead of failing. Last runs live in kv,
// so the dashboard remembers across restarts.
//
// Every task carries a schedule the admin can change in place: every N
// hours, daily at a time, weekly on a day, on file change (tasks that watch
// a folder), or off. Defaults ship with each task; changes persist in kv.
// The scheduler is a minute tick, and scheduled runs go one at a time -
// most of these walk the same NAS - while Run now starts at once.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseFile } from 'music-metadata';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { buildHead, headPath } from './heads.js';
import { songPath } from './songcache.js';
import { releaseInLibrary } from './discover.js';
import { slskdFind, slskdDownload, slskdWait } from './explore.js';
import type { Lidarr } from './lidarr.js';

export type Schedule =
  | { mode: 'off' }
  | { mode: 'interval'; hours: number }
  | { mode: 'daily'; at: string }                 // 'HH:MM', server-local time
  | { mode: 'weekly'; day: number; at: string }   // 0 = Sunday
  | { mode: 'watch' };                            // on file change, for tasks that watch a folder

export type TaskCtx = { step: (text: string, progress?: number | null) => void; log: (m: string) => void };
export type TaskDef = { id: string; name: string; description: string; schedule: Schedule; watchDir?: string; run: (ctx: TaskCtx) => Promise<string> };
type LastRun = { started: number; ended: number; ok: boolean; summary?: string; error?: string };

const kvGet = (db: DB, k: string) => (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any)?.v as string | undefined;
const kvSet = (db: DB, k: string, v: string) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);

// A schedule from the wire: the shape checked, or null when it is not one.
export function parseSchedule(x: any, canWatch: boolean): Schedule | null {
  const at = (s: any) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  if (!x || typeof x !== 'object') return null;
  if (x.mode === 'off') return { mode: 'off' };
  if (x.mode === 'watch') return canWatch ? { mode: 'watch' } : null;
  if (x.mode === 'interval') { const h = Number(x.hours); return h >= 0.25 && h <= 24 * 30 ? { mode: 'interval', hours: h } : null; }
  if (x.mode === 'daily') return at(x.at) ? { mode: 'daily', at: x.at } : null;
  if (x.mode === 'weekly') { const d = Number(x.day); return Number.isInteger(d) && d >= 0 && d <= 6 && at(x.at) ? { mode: 'weekly', day: d, at: x.at } : null; }
  return null;
}

// The most recent point this daily/weekly schedule should have fired, in
// server-local time. A task is due when its last start predates that point,
// so a point missed while the server was down is caught up at boot.
export function prevPoint(s: Schedule, now: number): number | null {
  if (s.mode !== 'daily' && s.mode !== 'weekly') return null;
  const [h, m] = s.at.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (s.mode === 'weekly') d.setDate(d.getDate() - ((d.getDay() - s.day + 7) % 7));
  let t = d.getTime();
  if (t > now) t -= (s.mode === 'weekly' ? 7 : 1) * 86400000;
  return t;
}

export function isDue(s: Schedule, last: LastRun | null, now: number): boolean {
  // Interval counts from when the last run ENDED (when known): a chore that
  // runs longer than its interval would otherwise be due again the moment
  // it finishes, and nothing else would ever get a turn.
  if (s.mode === 'interval') return !last || now - (last.ended || last.started) >= s.hours * 3600 * 1000;
  if (s.mode === 'daily' || s.mode === 'weekly') { const p = prevPoint(s, now)!; return !last || last.started < p; }
  return false; // off and watch never fire from the clock
}

const nextRun = (s: Schedule, last: LastRun | null, now: number): number | null => {
  if (s.mode === 'off' || s.mode === 'watch') return null;
  if (isDue(s, last, now)) return now;
  if (s.mode === 'interval') return (last!.ended || last!.started) + s.hours * 3600 * 1000;
  return prevPoint(s, now)! + (s.mode === 'weekly' ? 7 : 1) * 86400000;
};

export function registerTasks(app: FastifyInstance, db: DB, defs: TaskDef[], opts: { now?: () => number } = {}) {
  const admin = { preHandler: (app as any).requireAdmin };
  const now = opts.now ?? Date.now;
  const running = new Map<string, { started: number; step: string; progress: number | null }>();
  // kv holds JSON this process wrote, but a corrupt row (a crashed write, a
  // hand edit) must degrade to "never ran" / "default schedule", not take the
  // whole tick - and the task list API - down with it.
  const last = (id: string): LastRun | null => { try { return JSON.parse(kvGet(db, `task:${id}`) || 'null'); } catch { return null; } };
  const schedOf = (d: TaskDef): Schedule => {
    let raw: any = null;
    try { raw = JSON.parse(kvGet(db, `task:${d.id}:sched`) || 'null'); } catch { /* fall back to the default */ }
    return parseSchedule(raw, Boolean(d.watchDir)) ?? d.schedule;
  };

  const start = (def: TaskDef): boolean => {
    if (running.has(def.id)) return false;
    const state = { started: now(), step: 'Starting', progress: null as number | null };
    running.set(def.id, state);
    const ctx: TaskCtx = {
      step: (text, progress = null) => { state.step = text; state.progress = progress; },
      log: (m) => app.log.info(`task ${def.id}: ${m}`),
    };
    def.run(ctx)
      .then((summary) => kvSet(db, `task:${def.id}`, JSON.stringify({ started: state.started, ended: now(), ok: true, summary } satisfies LastRun)))
      .catch((e) => { app.log.error(`task ${def.id}: ${e.message}`); kvSet(db, `task:${def.id}`, JSON.stringify({ started: state.started, ended: now(), ok: false, error: e.message } satisfies LastRun)); })
      .finally(() => running.delete(def.id));
    return true;
  };

  // On file change: a watcher per task whose schedule says so. The task
  // starts two minutes after the first change, however many pile up behind
  // it - new files keep landing while an album copies in.
  const watchers = new Map<string, fs.FSWatcher>();
  const debounce = new Map<string, NodeJS.Timeout>();
  const syncWatchers = () => {
    for (const def of defs) {
      const want = Boolean(def.watchDir) && schedOf(def).mode === 'watch';
      const have = watchers.get(def.id);
      if (want && !have) {
        try {
          const w = fs.watch(def.watchDir!, { recursive: true }, () => {
            // Our own chores write into the watched folder too - enrich's
            // save-to-library drops .lrc sidecars and cover images there -
            // so events that arrive while a scan or enrich (or any task) is
            // busy are its own footsteps, not new music: ignore them, or
            // watch mode retriggers itself forever.
            if (running.size || (app as any).enrichRunning?.() || (app as any).scanning?.()) return;
            if (debounce.has(def.id)) return;
            debounce.set(def.id, setTimeout(() => {
              debounce.delete(def.id);
              // Same one-at-a-time gate as the clock: with something already
              // running, stand down - the next change re-arms the debounce.
              if (!running.size) start(def);
            }, 2 * 60 * 1000).unref());
          });
          w.on('error', (e) => {
            // A dead watcher (share unmounted, folder replaced) kept in the
            // map would block recreation forever: drop it so the next tick's
            // syncWatchers can try again.
            app.log.error(`task ${def.id} watch: ${e.message}; watcher dropped, will retry`);
            try { w.close(); } catch { /* already dead */ }
            watchers.delete(def.id);
          });
          watchers.set(def.id, w);
          app.log.info(`task ${def.id}: watching ${def.watchDir} for changes`);
        } catch (e: any) { app.log.error(`task ${def.id}: cannot watch ${def.watchDir}: ${e.message}`); }
      }
      if (!want && have) { have.close(); watchers.delete(def.id); const t = debounce.get(def.id); if (t) { clearTimeout(t); debounce.delete(def.id); } }
    }
  };
  if (process.env.NODE_ENV !== 'test') syncWatchers();
  app.addHook('onClose', async () => { for (const w of watchers.values()) w.close(); });

  // Scheduled runs: one task at a time. First tick a minute after boot, not
  // in it. The scan is round-robin from just past the last task started, so
  // a chore that takes longer than its interval cannot starve the ones
  // listed after it.
  let rr = -1;
  const tick = () => {
    if (process.env.NODE_ENV !== 'test') syncWatchers(); // recreate any watcher dropped by an error
    if (running.size || !defs.length) return;
    for (let i = 1; i <= defs.length; i++) {
      const idx = (rr + i) % defs.length;
      const def = defs[idx];
      if (!isDue(schedOf(def), last(def.id), now())) continue;
      rr = idx;
      start(def);
      return;
    }
  };
  if (process.env.NODE_ENV !== 'test') setInterval(tick, 60 * 1000).unref();

  const taskOut = (d: TaskDef) => {
    const s = schedOf(d);
    return {
      id: d.id, name: d.name, description: d.description,
      schedule: s, canWatch: Boolean(d.watchDir), next: nextRun(s, last(d.id), now()),
      running: running.get(d.id) ?? null, last: last(d.id),
    };
  };
  app.get('/api/admin/tasks', admin, async () => ({ tasks: defs.map(taskOut) }));
  app.post('/api/admin/tasks/:id/run', admin, async (req: any, reply) => {
    const def = defs.find((d) => d.id === req.params.id);
    if (!def) return reply.code(404).send({ error: 'no such task' });
    if (!start(def)) return reply.code(409).send({ error: 'already running' });
    return { started: true };
  });
  app.put('/api/admin/tasks/:id/schedule', admin, async (req: any, reply) => {
    const def = defs.find((d) => d.id === req.params.id);
    if (!def) return reply.code(404).send({ error: 'no such task' });
    const s = parseSchedule(req.body?.schedule, Boolean(def.watchDir));
    if (!s) return reply.code(400).send({ error: 'not a schedule' });
    kvSet(db, `task:${def.id}:sched`, JSON.stringify(s));
    syncWatchers();
    return taskOut(def);
  });
  return { tick, start, syncWatchers };
}

// --- the built-in chores -----------------------------------------------------

export type ChoreOptions = {
  db: DB; lidarr?: Lidarr; cacheDir: string; musicDir: string;
  headsEnabled: boolean; headSeconds: number; pauseMs: number;
  enrichEveryH: number;
  wantedTarget: number;
  discoveryPerRun: number;
  backlogEveryH: number; backlogPerRun: number; backlogArtistsPerRun: number;
  flacPerRun: number;
  slskdUrl?: string; slskdKey?: string; slskdDownloadsDir?: string;
  fetcher?: typeof fetch;
};

// A file replaced is a new track id (ids are the audio's own hash): carry
// the listener's traces over and drop what belonged to the old bytes.
export function remapTrackId(db: DB, oldId: string, newId: string, cacheDir?: string) {
  if (!newId || oldId === newId) return;
  for (const t of ['likes', 'playlist_tracks', 'plays', 'lyrics']) db.prepare(`UPDATE OR IGNORE ${t} SET track_id = ? WHERE track_id = ?`).run(newId, oldId);
  for (const t of ['likes', 'playlist_tracks', 'plays', 'lyrics', 'heads', 'song_cache']) db.prepare(`DELETE FROM ${t} WHERE track_id = ?`).run(oldId);
  // The head AND the whole-song copy belong to the old bytes: dropping only
  // their rows would leave the files stranded on the SSD forever.
  if (cacheDir) {
    try { fs.rmSync(headPath(cacheDir, oldId), { force: true }); } catch { /* cache orphan */ }
    try { fs.rmSync(songPath(cacheDir, oldId), { force: true }); } catch { /* cache orphan */ }
  }
}

const ff = (args: string[]) => new Promise<boolean>((resolve) => {
  const p = spawn('ffmpeg', ['-nostdin', '-v', 'error', ...args]);
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve(code === 0 && !err.trim()));
  p.on('error', () => resolve(false));
});

// A candidate FLAC is only a replacement once it IS a flac, runs the same
// length as what it replaces, and decodes front to back without an error.
export async function verifyFlac(file: string, durationMs: number): Promise<boolean> {
  try {
    const m = await parseFile(file, { duration: true });
    if (!/flac/i.test(m.format.codec || m.format.container || '')) return false;
    if (Math.abs((m.format.duration ?? 0) * 1000 - durationMs) > 3000) return false;
  } catch { return false; }
  return ff(['-i', file, '-f', 'null', '-']);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Studio releases worth shelving whole: albums, and EPs with real weight.
// Anything with a secondary type (Live, Remix, Compilation, Demo, ...) is a
// variant of something else, not backlog.
export const isStudio = (r: { rtype: string; secondary?: string[]; total_tracks: number }) =>
  !(r.secondary || []).length && (r.rtype === 'Album' || (r.rtype === 'EP' && r.total_tracks >= 4));

// How many more albums the wanted list can take before background chores
// would make a person's own request wait in line. Two runs that check this
// at once (a manual Run now beside a scheduled one) can each see the same
// headroom and jointly overshoot wantedTarget; the loops re-check every few
// requests to keep that overshoot small rather than lock around Lidarr.
async function room(lidarr: Lidarr, target: number): Promise<number> {
  return target - (await lidarr.wantedCount());
}

export function builtinTasks(app: FastifyInstance, o: ChoreOptions): TaskDef[] {
  const db = o.db;
  const f = o.fetcher ?? fetch;
  // Deezer answers rate limits with a 200 whose body is {error: ...}; read
  // as data that looks like an empty result and the run quietly does
  // nothing. Surface it as the failure it is (flagged, so the caller can
  // abort the whole run instead of grinding through more refusals), and
  // space calls out to stay under their quota in the first place.
  let deezerLast = 0;
  const deezer = async (p: string) => {
    const wait = deezerLast + 500 - Date.now();
    if (wait > 0) await sleep(wait);
    deezerLast = Date.now();
    const r = await f(`https://api.deezer.com${p}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`deezer ${r.status}`);
    const j = await r.json() as any;
    if (j && typeof j === 'object' && j.error) {
      const e: any = new Error(`deezer refused: ${j.error.message || j.error.type || j.error.code || 'error body'}`);
      e.deezer = true;
      throw e;
    }
    return j;
  };
  const topPlayedArtists = (sinceMs: number, limit: number) => db.prepare(`
    SELECT a.id, a.name, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id
    JOIN albums al ON al.id = t.album_id JOIN artists a ON a.id = al.artist_id
    WHERE p.at > ? GROUP BY a.id ORDER BY n DESC LIMIT ?`).all(Date.now() - sinceMs, limit) as { id: string; name: string }[];

  const scan: TaskDef = {
    id: 'scan', name: 'Scan library', schedule: { mode: 'daily', at: '04:00' }, watchDir: o.musicDir,
    description: 'Walk the music folder for new, changed and removed files',
    run: async (ctx) => {
      ctx.step('Walking the library');
      const r = await (app as any).runScanAwaited();
      return `${r.files} files, ${r.added} added, ${r.changed} changed, ${r.removed} removed`;
    },
  };

  const enrich: TaskDef = {
    id: 'enrich', name: 'Fetch lyrics & artwork', schedule: { mode: 'interval', hours: o.enrichEveryH },
    description: 'Lyrics, artist pictures and album covers for whatever is still missing',
    run: async (ctx) => {
      if ((app as any).enrichRunning?.()) return 'already running (a scan started it)';
      ctx.step('Fetching');
      await (app as any).runEnrich();
      return 'pass finished';
    },
  };

  const heads: TaskDef = {
    id: 'heads', name: 'Cut song heads', schedule: { mode: 'daily', at: '05:00' },
    description: 'Mirror the first seconds of every song to the cache so playback starts at SSD speed',
    run: async (ctx) => {
      if (!o.headsEnabled) return 'heads are off (HEADS=0)';
      // A file ffmpeg cannot cut today cannot cut it tomorrow either (a
      // truncated rip, an unreadable codec): remember failures for a week
      // so the daily pass is not mostly re-failing the same files.
      const bad = (() => { try { return JSON.parse(kvGet(db, 'task:heads:failed') || '{}') as Record<string, number>; } catch { return {}; } })();
      for (const k of Object.keys(bad)) if (Date.now() - bad[k] > 7 * 86400000) delete bad[k];
      const rows = db.prepare('SELECT t.id, t.path, t.size, t.duration_ms FROM tracks t LEFT JOIN heads h ON h.track_id = t.id WHERE h.track_id IS NULL').all() as any[];
      if (!rows.length) return 'every song has one';
      let done = 0, failed = 0, skipped = 0;
      const samples: string[] = [];
      for (const r of rows) {
        if (bad[r.path]) { skipped++; continue; }
        try { await buildHead(db, o.cacheDir, r.id, r.path, r.size, r.duration_ms, o.headSeconds); done++; }
        catch (e: any) { failed++; bad[r.path] = Date.now(); if (samples.length < 3) samples.push(r.path); if (failed <= 5) ctx.log(`${r.path}: ${e.message}`); }
        if ((done + failed) % 50 === 0) { ctx.step(`${(done + failed).toLocaleString()} of ${rows.length.toLocaleString()}`, (done + failed) / rows.length); kvSet(db, 'task:heads:failed', JSON.stringify(bad)); }
        if (o.pauseMs) await sleep(o.pauseMs);
      }
      kvSet(db, 'task:heads:failed', JSON.stringify(bad));
      return `${done.toLocaleString()} heads cut${failed ? `, ${failed} failed (e.g. ${samples.join(', ')})` : ''}${skipped ? `, ${skipped} skipped as recently failed` : ''}`;
    },
  };

  // New artists, found from what actually gets played: Deezer's related
  // artists for the most played ones, their best album queued in Lidarr.
  const discovery: TaskDef = {
    id: 'discovery', name: 'Discover new music', schedule: { mode: 'weekly', day: 0, at: '06:00' },
    description: 'Queue an album each from artists similar to the most played ones that the library lacks',
    run: async (ctx) => {
      const lidarr = o.lidarr;
      if (!lidarr?.enabled) return 'Lidarr is not configured';
      const cap = Math.min(await room(lidarr, o.wantedTarget), o.discoveryPerRun);
      if (cap <= 0) return 'the wanted list is full, nothing added';
      const seen = new Map<string, number>(Object.entries(JSON.parse(kvGet(db, 'task:discovery:seen') || '{}')));
      for (const [k, t] of seen) if (Date.now() - t > 90 * 86400000) seen.delete(k);
      const haveArtist = db.prepare('SELECT 1 FROM artists WHERE name = ? COLLATE NOCASE');
      let n = 0, full = false;
      for (const top of topPlayedArtists(180 * 86400000, 30)) {
        if (n >= cap || full) break;
        ctx.step(`Around ${top.name}`, n / cap);
        try {
          const s = await deezer(`/search/artist?q=${encodeURIComponent(top.name)}&limit=3`);
          const dz = (s.data || []).find((x: any) => norm(x.name) === norm(top.name));
          if (!dz) continue;
          const rel = await deezer(`/artist/${dz.id}/related?limit=10`);
          for (const cand of rel.data || []) {
            if (n >= cap) break;
            if (haveArtist.get(cand.name) || seen.has(norm(cand.name))) continue;
            const albums = await deezer(`/artist/${cand.id}/albums?limit=15`);
            const best = (albums.data || []).find((a: any) => a.record_type === 'album');
            if (!best) { seen.set(norm(cand.name), Date.now()); continue; }
            const found = await lidarr.search(`${cand.name} ${best.title}`);
            // Only now was the candidate really evaluated: marked seen any
            // earlier, a thrown Deezer/Lidarr call would bury it for 90 days
            // without it ever having had its chance.
            seen.set(norm(cand.name), Date.now());
            const hit = found.find((r) => norm(r.artist) === norm(cand.name) && norm(r.title) === norm(best.title)) || found.find((r) => norm(r.artist) === norm(cand.name));
            if (!hit || releaseInLibrary(db, hit.artist, hit.title)) continue;
            const req = await lidarr.request(hit.album_id);
            if (req.status === 'queued') {
              n++; ctx.log(`${hit.artist} - ${hit.title} (similar to ${top.name})`);
              // See room(): a concurrent run may be filling the list too.
              if (n % 5 === 0 && (await room(lidarr, o.wantedTarget)) <= 0) { full = true; break; }
            }
          }
        } catch (e: any) {
          if (e.deezer) { kvSet(db, 'task:discovery:seen', JSON.stringify(Object.fromEntries(seen))); throw new Error(`${e.message}; stopped after ${n} queued`); }
          ctx.log(`${top.name}: ${e.message}`);
        }
      }
      kvSet(db, 'task:discovery:seen', JSON.stringify(Object.fromEntries(seen)));
      return n ? `${n} albums queued from artists similar to what gets played` : 'nothing new worth queueing';
    },
  };

  // The shelf behind the plays: walk artists by play count and queue their
  // missing studio albums and real EPs, a few artists per run, never
  // flooding the wanted list past what a person's own request can jump.
  const backlog: TaskDef = {
    id: 'backlog', name: 'Fill in discographies', schedule: { mode: 'interval', hours: o.backlogEveryH },
    description: 'Queue missing studio albums and EPs of the most played artists, a few at a time',
    run: async (ctx) => {
      const lidarr = o.lidarr;
      if (!lidarr?.enabled) return 'Lidarr is not configured';
      const cap = Math.min(await room(lidarr, o.wantedTarget), o.backlogPerRun);
      if (cap <= 0) return 'the wanted list is full, nothing added';
      const done = JSON.parse(kvGet(db, 'task:backlog:done') || '{}') as Record<string, number>;
      const pending = await lidarr.statuses();
      let n = 0, artists = 0, full = false;
      for (const a of topPlayedArtists(10 * 365 * 86400000, 500)) {
        if (artists >= o.backlogArtistsPerRun || n >= cap || full) break;
        if (done[a.id] && Date.now() - done[a.id] < 14 * 86400000) continue;
        ctx.step(a.name, n / cap);
        let complete = true;
        try {
          const d = await lidarr.discography(a.name);
          for (const r of d.releases) {
            if (!isStudio(r) || pending.has(r.album_id) || releaseInLibrary(db, r.artist || a.name, r.title)) continue;
            if (n >= cap || full) { complete = false; break; } // resume this artist next run
            const req = await lidarr.request(r.album_id);
            if (req.status === 'queued') {
              n++; ctx.log(`${a.name} - ${r.title}`);
              // See room(): a concurrent run may be filling the list too.
              if (n % 5 === 0 && (await room(lidarr, o.wantedTarget)) <= 0) full = true;
            }
          }
        } catch (e: any) { ctx.log(`${a.name}: ${e.message}`); complete = false; }
        artists++;
        if (complete) done[a.id] = Date.now();
      }
      kvSet(db, 'task:backlog:done', JSON.stringify(done));
      return n ? `${n} albums queued across ${artists} artists` : `nothing missing for the ${artists} artists checked`;
    },
  };

  // Lossy tracks replaced with verified FLAC from Soulseek, most played
  // first. Searches are paced (the Soulseek server allows roughly nine a
  // minute per account) and every candidate must prove itself before the
  // old file goes: same length, full decode, retagged with the library's
  // own tags so the album stays whole.
  const flac: TaskDef = {
    id: 'flac', name: 'Upgrade to FLAC', schedule: { mode: 'interval', hours: 1 },
    description: 'Replace lossy tracks with a verified FLAC from Soulseek, most played first',
    run: async (ctx) => {
      if (!o.slskdUrl || !o.slskdKey || !o.slskdDownloadsDir) return 'slskd is not configured (SLSKD_URL / SLSKD_API_KEY / SLSKD_DOWNLOADS_DIR)';
      const sopts = { slskdUrl: o.slskdUrl, slskdKey: o.slskdKey };
      const exists = (p: string) => fsp.stat(p).then(() => true, () => false);
      // Each replacement is journaled in kv BEFORE the library changes: a
      // crash between "new file in place" and "listener's traces remapped"
      // leaves an entry behind, and the next run settles it first. The
      // lyrics row rides along because the folder scan deletes the old
      // track row (the lyrics cascade with it) before the remap can move it.
      type JEntry = { oldId: string; newPath: string; rel: string; lyrics: { kind: string; lines: string; source: string; fetched_at: number } | null };
      const journal: JEntry[] = (() => { try { return JSON.parse(kvGet(db, 'task:flac:journal') || '[]'); } catch { return []; } })();
      const saveJournal = () => kvSet(db, 'task:flac:journal', JSON.stringify(journal));
      let scanFailed = 0;
      // Scan the entry's folder (one retry: the NAS drops a beat sometimes),
      // then remap the old id's traces onto whatever id now owns the path.
      // False means the entry stays journaled for the next run; it is never
      // silently dropped while the old file is already gone.
      const settle = async (e: JEntry): Promise<boolean> => {
        const scanFolders = (app as any).scanFolders as ((rel: string[]) => Promise<any>) | undefined;
        if (!scanFolders) return false;
        let scanned = false;
        for (let attempt = 0; attempt < 2 && !scanned; attempt++) {
          try { await scanFolders([e.rel]); scanned = true; }
          catch (err: any) { ctx.log(`scan ${e.rel || '(library root)'}: ${err.message}`); if (!attempt) await sleep(2000); }
        }
        if (!scanned) return false;
        const row = db.prepare('SELECT id FROM tracks WHERE path = ?').get(e.newPath) as any;
        if (row) {
          remapTrackId(db, e.oldId, row.id, o.cacheDir);
          if (e.lyrics && !db.prepare('SELECT 1 FROM lyrics WHERE track_id = ?').get(row.id))
            db.prepare('INSERT OR IGNORE INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, ?, ?, ?, ?)').run(row.id, e.lyrics.kind, e.lyrics.lines, e.lyrics.source, e.lyrics.fetched_at);
        } else ctx.log(`${e.newPath}: scanned but not in the library; dropping its journal entry`);
        return true;
      };
      // First, anything a crashed run left half-done.
      let recovered = 0;
      for (let i = journal.length - 1; i >= 0; i--) {
        if (await settle(journal[i])) { journal.splice(i, 1); recovered++; } else scanFailed++;
      }
      saveJournal();
      const skip: Record<string, number> = (() => { try { return JSON.parse(kvGet(db, 'task:flac:skip') || '{}'); } catch { return {}; } })();
      for (const k of Object.keys(skip)) if (Date.now() - skip[k] > 30 * 86400000) delete skip[k];
      // Persisted after every failure, not at the end: a crash mid-run must
      // not re-spend the search budget on the same dead ends tomorrow.
      const noteSkip = (key: string) => { skip[key] = Date.now(); kvSet(db, 'task:flac:skip', JSON.stringify(skip)); };
      const rows = db.prepare(`SELECT t.id, t.path, t.title, t.artist, t.album, t.album_artist, t.track_no, t.disc_no, t.year, t.duration_ms,
          COALESCE(p.n, 0) + 5 * COALESCE(l.n, 0) AS score
        FROM tracks t
        LEFT JOIN (SELECT track_id, COUNT(*) n FROM plays GROUP BY track_id) p ON p.track_id = t.id
        LEFT JOIN (SELECT track_id, COUNT(*) n FROM likes GROUP BY track_id) l ON l.track_id = t.id
        WHERE t.codec LIKE 'MPEG%' OR t.codec LIKE '%AAC%' OR t.codec LIKE '%Opus%'
        ORDER BY score DESC, t.added_at DESC LIMIT 3000`).all() as any[];
      const note = `${recovered ? `; ${recovered} recovered from the journal` : ''}${scanFailed ? `; ${scanFailed} folder scans failed, kept journaled for recovery` : ''}`;
      if (!rows.length) return `nothing lossy left${note}`;
      let done = 0, failed = 0, tried = 0, blocked = 0;
      const plannedDests = new Set<string>();
      for (const t of rows) {
        if (done >= o.flacPerRun || tried >= o.flacPerRun * 2) break;
        // The duration is part of the key: a failed search for the radio
        // edit must not block the album version (same artist and title)
        // for the next 30 days.
        const key = `${t.artist} | ${t.title} | ${Math.round(t.duration_ms / 1000)}`.toLowerCase();
        if (skip[key]) continue;
        const dest = t.path.replace(/\.[^.]+$/, '.flac');
        // Never overwrite a library file: a dest that exists (or that an
        // earlier row of this very run claims - 01.mp3 and 01.m4a both map
        // to 01.flac) is someone's music, not this task's to replace.
        if (plannedDests.has(dest)) continue;
        plannedDests.add(dest);
        if (dest !== t.path && await exists(dest)) { ctx.log(`${dest}: already exists, not overwriting`); noteSkip(key); blocked++; continue; }
        if (tried) await sleep(8000); // stay under the account's search budget
        tried++;
        ctx.step(`${t.artist} - ${t.title}`, done / o.flacPerRun);
        let src: string | undefined, tmp: string | undefined;
        try {
          const dlStart = Date.now();
          const file = await slskdFind(sopts, { artist: t.artist, title: t.title }, { formats: ['flac'], durationS: Math.round(t.duration_ms / 1000) });
          if (!file || !(await slskdDownload(sopts, file))) { noteSkip(key); failed++; continue; }
          await slskdWait(sopts, [file], 10 * 60 * 1000);
          // Find the download in slskd's staging folder. Basename+size alone
          // could pick up a file Soularr just fetched for Lidarr, so only
          // files written since this download started count, and a candidate
          // sitting under the remote share's own folder name wins. Residual
          // risk: a same-named, same-sized file landing in that window is
          // still stolen - small, and it would verify as the same audio.
          const parts = String(file.filename).split(/[\\/]/);
          const base = parts.pop()!;
          const remoteDir = parts.pop() ?? '';
          const cands: string[] = [];
          for (const e of await fsp.readdir(o.slskdDownloadsDir, { recursive: true }) as unknown as string[]) {
            const p = path.join(o.slskdDownloadsDir, String(e));
            if (path.basename(p) !== base) continue;
            try {
              const st = await fsp.stat(p);
              if (!st.isFile() || st.size !== file.size || st.mtimeMs < dlStart - 60000) continue;
              cands.push(p);
            } catch { /* raced away */ }
          }
          src = cands.find((p) => path.basename(path.dirname(p)) === remoteDir) ?? cands[0];
          if (!src || !(await verifyFlac(src, t.duration_ms))) { noteSkip(key); failed++; continue; }
          // The tmp lives beside dest (same filesystem for the rename) as a
          // dotfile with a non-audio extension, so a scan that catches the
          // folder mid-upgrade cannot admit it as a ghost track.
          tmp = path.join(path.dirname(dest), `.up-${path.basename(dest)}.tmp`);
          const meta = ['-metadata', `title=${t.title}`, '-metadata', `artist=${t.artist}`, '-metadata', `album=${t.album}`, '-metadata', `albumartist=${t.album_artist}`];
          if (t.track_no) meta.push('-metadata', `track=${t.track_no}`);
          if (t.disc_no) meta.push('-metadata', `disc=${t.disc_no}`);
          if (t.year) meta.push('-metadata', `date=${t.year}`);
          if (!(await ff(['-y', '-i', src, '-map', '0:a:0', '-c:a', 'copy', '-map_metadata', '-1', ...meta, tmp]))) { noteSkip(key); failed++; continue; }
          if (dest !== t.path && await exists(dest)) { ctx.log(`${dest}: appeared mid-upgrade, not overwriting`); noteSkip(key); blocked++; continue; }
          const lyr = db.prepare('SELECT kind, lines, source, fetched_at FROM lyrics WHERE track_id = ?').get(t.id) as JEntry['lyrics'] ?? null;
          const entry: JEntry = { oldId: t.id, newPath: dest, rel: path.relative(o.musicDir, path.dirname(dest)), lyrics: lyr };
          journal.push(entry); saveJournal(); // durable before the library changes
          await fsp.rename(tmp, dest);
          tmp = undefined;
          if (dest !== t.path) await fsp.rm(t.path, { force: true }); // the verified FLAC stands in its place
          done++;
          ctx.log(`${t.artist} - ${t.title}: FLAC from ${file.username}`);
          // Settle right away - scan the folder, remap the traces - so a
          // crash loses at most the one journaled replacement in flight,
          // not a whole run's worth deferred to the end.
          if (await settle(entry)) { const i = journal.indexOf(entry); if (i >= 0) journal.splice(i, 1); saveJournal(); }
          else { scanFailed++; saveJournal(); }
        } catch (e: any) { ctx.log(`${t.artist} - ${t.title}: ${e.message}`); noteSkip(key); failed++; }
        finally {
          if (tmp) await fsp.rm(tmp, { force: true }).catch(() => { /* never leave a tmp behind */ });
          if (src) await fsp.rm(src, { force: true }).catch(() => { /* staging copy is spent either way */ });
        }
      }
      kvSet(db, 'task:flac:skip', JSON.stringify(skip));
      return `${done} upgraded, ${failed} of ${tried} tried had no good FLAC${blocked ? `, ${blocked} blocked by an existing file` : ''}${recovered ? `, ${recovered} recovered from the journal` : ''}${scanFailed ? `, ${scanFailed} folder scans failed, kept journaled for recovery` : ''}`;
    },
  };

  return [scan, enrich, heads, discovery, backlog, flac];
}
