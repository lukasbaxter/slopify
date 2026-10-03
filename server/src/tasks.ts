// Scheduled tasks, the way Jellyfin has them: one place in the admin
// dashboard that lists every recurring chore - scan the library, fetch
// lyrics and artwork, cut song heads, discover new music, fill in
// discographies - with when it last ran, what it did, and a Run now button.
// Everything ships in the image; intervals are env-tunable and a task that
// is missing its dependency (no Lidarr, heads off) says so instead of
// failing. Last runs live in kv, so the dashboard remembers across restarts.
//
// The scheduler is a minute tick: a task is due when everyH hours have
// passed since it last STARTED (0 = manual only). Scheduled runs go one at
// a time - most of these walk the same NAS - while Run now starts at once.
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { buildHead } from './heads.js';
import { releaseInLibrary } from './discover.js';
import type { Lidarr } from './lidarr.js';

export type TaskCtx = { step: (text: string, progress?: number | null) => void; log: (m: string) => void };
export type TaskDef = { id: string; name: string; description: string; everyH: number; run: (ctx: TaskCtx) => Promise<string> };
type LastRun = { started: number; ended: number; ok: boolean; summary?: string; error?: string };

const kvGet = (db: DB, k: string) => (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any)?.v as string | undefined;
const kvSet = (db: DB, k: string, v: string) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);

export function registerTasks(app: FastifyInstance, db: DB, defs: TaskDef[], opts: { now?: () => number } = {}) {
  const admin = { preHandler: (app as any).requireAdmin };
  const now = opts.now ?? Date.now;
  const running = new Map<string, { started: number; step: string; progress: number | null }>();
  const last = (id: string): LastRun | null => JSON.parse(kvGet(db, `task:${id}`) || 'null');

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

  // Scheduled runs: due when everyH has passed since the last start, one
  // task at a time. First tick a minute after boot, not in it.
  const tick = () => {
    if (running.size) return;
    for (const def of defs) {
      if (!def.everyH) continue;
      const l = last(def.id);
      if (l && now() - l.started < def.everyH * 3600 * 1000) continue;
      start(def);
      return;
    }
  };
  if (process.env.NODE_ENV !== 'test') setInterval(tick, 60 * 1000).unref();

  app.get('/api/admin/tasks', admin, async () => ({
    tasks: defs.map((d) => ({
      id: d.id, name: d.name, description: d.description, everyH: d.everyH,
      running: running.get(d.id) ?? null, last: last(d.id),
    })),
  }));
  app.post('/api/admin/tasks/:id/run', admin, async (req: any, reply) => {
    const def = defs.find((d) => d.id === req.params.id);
    if (!def) return reply.code(404).send({ error: 'no such task' });
    if (!start(def)) return reply.code(409).send({ error: 'already running' });
    return { started: true };
  });
  return { tick, start };
}

// --- the built-in chores -----------------------------------------------------

export type ChoreOptions = {
  db: DB; lidarr?: Lidarr; cacheDir: string;
  headsEnabled: boolean; headSeconds: number; pauseMs: number;
  scanEveryH: number; enrichEveryH: number;
  wantedTarget: number;
  discoveryEveryH: number; discoveryPerRun: number;
  backlogEveryH: number; backlogPerRun: number; backlogArtistsPerRun: number;
  headsEveryH: number;
  fetcher?: typeof fetch;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Studio releases worth shelving whole: albums, and EPs with real weight.
// Anything with a secondary type (Live, Remix, Compilation, Demo, ...) is a
// variant of something else, not backlog.
export const isStudio = (r: { rtype: string; secondary?: string[]; total_tracks: number }) =>
  !(r.secondary || []).length && (r.rtype === 'Album' || (r.rtype === 'EP' && r.total_tracks >= 4));

// How many more albums the wanted list can take before background chores
// would make a person's own request wait in line.
async function room(lidarr: Lidarr, target: number): Promise<number> {
  return target - (await lidarr.wantedCount());
}

export function builtinTasks(app: FastifyInstance, o: ChoreOptions): TaskDef[] {
  const db = o.db;
  const f = o.fetcher ?? fetch;
  const deezer = (p: string) => f(`https://api.deezer.com${p}`, { signal: AbortSignal.timeout(10000) }).then(async (r) => { if (!r.ok) throw new Error(`deezer ${r.status}`); return r.json() as any; });
  const topPlayedArtists = (sinceMs: number, limit: number) => db.prepare(`
    SELECT a.id, a.name, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id
    JOIN albums al ON al.id = t.album_id JOIN artists a ON a.id = al.artist_id
    WHERE p.at > ? GROUP BY a.id ORDER BY n DESC LIMIT ?`).all(Date.now() - sinceMs, limit) as { id: string; name: string }[];

  const scan: TaskDef = {
    id: 'scan', name: 'Scan library', everyH: o.scanEveryH,
    description: 'Walk the music folder for new, changed and removed files',
    run: async (ctx) => {
      ctx.step('Walking the library');
      const r = await (app as any).runScanAwaited();
      return `${r.files} files, ${r.added} added, ${r.changed} changed, ${r.removed} removed`;
    },
  };

  const enrich: TaskDef = {
    id: 'enrich', name: 'Fetch lyrics & artwork', everyH: o.enrichEveryH,
    description: 'Lyrics, artist pictures and album covers for whatever is still missing',
    run: async (ctx) => {
      if ((app as any).enrichRunning?.()) return 'already running (a scan started it)';
      ctx.step('Fetching');
      await (app as any).runEnrich();
      return 'pass finished';
    },
  };

  const heads: TaskDef = {
    id: 'heads', name: 'Cut song heads', everyH: o.headsEveryH,
    description: 'Mirror the first seconds of every song to the cache so playback starts at SSD speed',
    run: async (ctx) => {
      if (!o.headsEnabled) return 'heads are off (HEADS=0)';
      const rows = db.prepare('SELECT t.id, t.path, t.size, t.duration_ms FROM tracks t LEFT JOIN heads h ON h.track_id = t.id WHERE h.track_id IS NULL').all() as any[];
      if (!rows.length) return 'every song has one';
      let done = 0, failed = 0;
      for (const r of rows) {
        try { await buildHead(db, o.cacheDir, r.id, r.path, r.size, r.duration_ms, o.headSeconds); done++; }
        catch (e: any) { failed++; if (failed <= 5) ctx.log(`${r.path}: ${e.message}`); }
        if ((done + failed) % 50 === 0) ctx.step(`${(done + failed).toLocaleString()} of ${rows.length.toLocaleString()}`, (done + failed) / rows.length);
        if (o.pauseMs) await sleep(o.pauseMs);
      }
      return `${done.toLocaleString()} heads cut${failed ? `, ${failed} failed` : ''}`;
    },
  };

  // New artists, found from what actually gets played: Deezer's related
  // artists for the most played ones, their best album queued in Lidarr.
  const discovery: TaskDef = {
    id: 'discovery', name: 'Discover new music', everyH: o.discoveryEveryH,
    description: 'Queue an album each from artists similar to the most played ones that the library lacks',
    run: async (ctx) => {
      const lidarr = o.lidarr;
      if (!lidarr?.enabled) return 'Lidarr is not configured';
      const cap = Math.min(await room(lidarr, o.wantedTarget), o.discoveryPerRun);
      if (cap <= 0) return 'the wanted list is full, nothing added';
      const seen = new Map<string, number>(Object.entries(JSON.parse(kvGet(db, 'task:discovery:seen') || '{}')));
      for (const [k, t] of seen) if (Date.now() - t > 90 * 86400000) seen.delete(k);
      const haveArtist = db.prepare('SELECT 1 FROM artists WHERE name = ? COLLATE NOCASE');
      let n = 0;
      for (const top of topPlayedArtists(180 * 86400000, 30)) {
        if (n >= cap) break;
        ctx.step(`Around ${top.name}`, n / cap);
        try {
          const s = await deezer(`/search/artist?q=${encodeURIComponent(top.name)}&limit=3`);
          const dz = (s.data || []).find((x: any) => norm(x.name) === norm(top.name));
          if (!dz) continue;
          const rel = await deezer(`/artist/${dz.id}/related?limit=10`);
          for (const cand of rel.data || []) {
            if (n >= cap) break;
            if (haveArtist.get(cand.name) || seen.has(norm(cand.name))) continue;
            seen.set(norm(cand.name), Date.now());
            const albums = await deezer(`/artist/${cand.id}/albums?limit=15`);
            const best = (albums.data || []).find((a: any) => a.record_type === 'album');
            if (!best) continue;
            const found = await lidarr.search(`${cand.name} ${best.title}`);
            const hit = found.find((r) => norm(r.artist) === norm(cand.name) && norm(r.title) === norm(best.title)) || found.find((r) => norm(r.artist) === norm(cand.name));
            if (!hit || releaseInLibrary(db, hit.artist, hit.title)) continue;
            const req = await lidarr.request(hit.album_id);
            if (req.status === 'queued') { n++; ctx.log(`${hit.artist} - ${hit.title} (similar to ${top.name})`); }
          }
        } catch (e: any) { ctx.log(`${top.name}: ${e.message}`); }
      }
      kvSet(db, 'task:discovery:seen', JSON.stringify(Object.fromEntries(seen)));
      return n ? `${n} albums queued from artists similar to what gets played` : 'nothing new worth queueing';
    },
  };

  // The shelf behind the plays: walk artists by play count and queue their
  // missing studio albums and real EPs, a few artists per run, never
  // flooding the wanted list past what a person's own request can jump.
  const backlog: TaskDef = {
    id: 'backlog', name: 'Fill in discographies', everyH: o.backlogEveryH,
    description: 'Queue missing studio albums and EPs of the most played artists, a few at a time',
    run: async (ctx) => {
      const lidarr = o.lidarr;
      if (!lidarr?.enabled) return 'Lidarr is not configured';
      const cap = Math.min(await room(lidarr, o.wantedTarget), o.backlogPerRun);
      if (cap <= 0) return 'the wanted list is full, nothing added';
      const done = JSON.parse(kvGet(db, 'task:backlog:done') || '{}') as Record<string, number>;
      const pending = await lidarr.statuses();
      let n = 0, artists = 0;
      for (const a of topPlayedArtists(10 * 365 * 86400000, 500)) {
        if (artists >= o.backlogArtistsPerRun || n >= cap) break;
        if (done[a.id] && Date.now() - done[a.id] < 14 * 86400000) continue;
        ctx.step(a.name, n / cap);
        let complete = true;
        try {
          const d = await lidarr.discography(a.name);
          for (const r of d.releases) {
            if (!isStudio(r) || pending.has(r.album_id) || releaseInLibrary(db, r.artist || a.name, r.title)) continue;
            if (n >= cap) { complete = false; break; } // resume this artist next run
            const req = await lidarr.request(r.album_id);
            if (req.status === 'queued') { n++; ctx.log(`${a.name} - ${r.title}`); }
          }
        } catch (e: any) { ctx.log(`${a.name}: ${e.message}`); complete = false; }
        artists++;
        if (complete) done[a.id] = Date.now();
      }
      kvSet(db, 'task:backlog:done', JSON.stringify(done));
      return n ? `${n} albums queued across ${artists} artists` : `nothing missing for the ${artists} artists checked`;
    },
  };

  return [scan, enrich, heads, discovery, backlog];
}
