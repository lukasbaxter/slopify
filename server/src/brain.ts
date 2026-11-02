// The brain: a recommender that runs on its own GPU box (brain/ in this repo)
// and learns from this server's listening. Two directions, one shared secret
// (BRAIN_KEY):
//  - the brain reads from here: the catalog, plays, how each play went
//    (play_events), likes and dislikes, and each song's audio (stream.ts),
//    all under /api/brain/* with the key in X-Brain-Key;
//  - Slopify asks it what to play next (brainNext). An unset, slow or down
//    brain is never an error: every caller has its own mix to fall back to.
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import { config } from './config.js';
import { taskSettings, type TaskDef, type TaskSetting } from './tasks.js';
import { checkSongs } from './damage.js';

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const isBrain = (got: string, key = config.brain.key) => !!key && !!got && same(got, key);

// Before the routes that use it (stream.ts serves the audio).
export function registerBrainAuth(app: FastifyInstance, key = config.brain.key) {
  app.decorate('requireBrain', async (req: FastifyRequest, reply: FastifyReply) => {
    const got = String(req.headers['x-brain-key'] || '');
    if (!isBrain(got, key)) return reply.code(401).send({ error: 'unauthorized' });
  });
}

const page = (q: any, max: number) => ({ after: Math.max(0, Number(q.after) || 0), limit: Math.min(max, Math.max(1, Number(q.limit) || max)) });

// The household's rules for the brain, edited in Settings > Admin > Tasks >
// Brain like any task's knobs; the brain reads them (GET /api/brain/settings)
// every 30 s. Heavy work = listening to new songs and retraining; answering
// what plays next is never held.
export const BRAIN_SETTINGS: TaskSetting[] = [
  { key: 'enabled', label: 'Use it for what plays next', type: 'toggle', default: true,
    help: "Smart shuffle, autoplay when the queue ends, song radio and the speakers. Off: Slopify's own mixes; the brain keeps learning." },
  { key: 'power', label: 'GPU power', type: 'select', default: 'normal',
    help: 'For listening to new songs and retraining.',
    options: [
      { value: 'full', label: 'Full: no breaks' },
      { value: 'normal', label: 'Normal: 10 min on, 10 off' },
      { value: 'light', label: 'Light: 5 min on, 15 off' },
      { value: 'cpu', label: "Don't use the GPU (slow)" },
    ] },
  { key: 'fromHour', label: 'Heavy work from', type: 'number', min: 0, max: 23, unit: ':00', default: 0 },
  { key: 'toHour', label: 'Heavy work until', type: 'number', min: 0, max: 23, unit: ':00', default: 0,
    help: 'The same hour twice means any time. 1 and 7: only overnight.' },
  { key: 'pauseListening', label: 'Pause while anyone is listening', type: 'toggle', default: false,
    help: 'It reads each new song from your library once. Turn on if your disks are slow.' },
  { key: 'otherGb', label: 'Pause when other programs use more GPU memory than', type: 'number', min: 0, max: 256, unit: 'GB', default: 0,
    help: '0: never. Games, Ollama, other AI apps.' },
  { key: 'pauseEncoding', label: 'Pause while the GPU encodes video', type: 'toggle', default: false,
    help: 'Jellyfin, Plex or Immich transcoding. NVIDIA cards only.' },
  { key: 'location', label: 'Where you listen', type: 'text', default: '', placeholder: 'Victoria, BC', maxLength: 100,
    help: 'A city, for the weather. Looked up once on Open-Meteo. Empty: none.' },
];
const BRAIN_DEF = { id: 'brain', settings: BRAIN_SETTINGS };
export const brainRules = (db: DB) => taskSettings(db, BRAIN_DEF);

const hrs = (s: number) => (s >= 5400 ? `about ${Math.round(s / 3600)} h` : `about ${Math.max(1, Math.round(s / 60))} min`);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
// The brain's status in one line for its task row.
export function brainLine(st: any, err: string | null): string {
  if (err) return `Can't reach it: ${err}`;
  if (!st) return 'Connecting…';
  if (st.slopify_error) return `It can't reach this server: set SLOPIFY_URL on the brain (${st.slopify_error})`;
  const parts: string[] = [];
  const n = (x: number) => x.toLocaleString('en-US');
  if (st.left > 0) parts.push(`Heard ${n(st.heard)} of ${n(st.songs)} songs${st.eta_s && !st.paused ? `, ${hrs(st.eta_s)} to go` : ''}`);
  else parts.push(`Heard all ${n(st.heard)} songs`);
  if (st.paused) parts.push(st.paused.charAt(0).toUpperCase() + st.paused.slice(1));
  else if (st.phase === 'training') parts.push('Training');
  const m = st.last_train?.metrics, b = st.last_train?.baselines?.old_mix;
  if (m && b) parts.push(`Next song in its top 10: ${pct(m['hit@10'])} (old mix ${pct(b['hit@10'])})`);
  if (st.place_error) parts.push(`Location: ${st.place_error}`);
  else if (st.weather_now && st.place) parts.push(`${st.weather_now} in ${st.place}`);
  if (st.undecodable) parts.push(`${n(st.undecodable)} won't decode`);
  return parts.join(' · ');
}

// The Brain task: its row says what the brain is doing, Run now (and the
// schedule, nightly by default) retrains, its menu holds the rules.
export function brainTask(app: FastifyInstance, db?: DB, opts: { url?: string; key?: string; fetcher?: typeof fetch; pollMs?: number; cacheDir?: string } = {}): TaskDef | null {
  const url = opts.url ?? config.brain.url, key = opts.key ?? config.brain.key;
  if (!url || !key) return null;
  const f = opts.fetcher ?? fetch;
  let st: any = null, err: string | null = null;
  // Songs the brain could not hear: each checked here once (damage.ts), the
  // wrong lengths and false alarms handed back to it, the damaged ones to
  // Upgrade to FLAC.
  let reviewing = false, reviewedAt = -1;
  const review = async () => {
    if (!db || reviewing || !st?.undecodable || st.undecodable === reviewedAt) return;
    reviewing = true;
    try {
      const r = await f(`${url}/undecodable`, { headers: { 'X-Brain-Key': key }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      const items = ((await r.json()) as any).items as { id: string }[] || [];
      const done = new Set((db.prepare('SELECT track_id FROM song_checks').all() as any[]).map((x) => x.track_id));
      const todo = items.map((x) => x.id).filter((id) => /^[0-9a-f]{32}$/.test(id) && !done.has(id));
      if (todo.length) {
        const c = await checkSongs(db, todo, { cacheDir: opts.cacheDir, log: (m) => app.log.info(m) });
        app.log.info(`song checks: ${c.fine.length} fine, ${c.length.length} wrong length (fixed), ${c.damaged.length} damaged, ${c.empty.length} not songs (removed), ${c.missing.length} missing`);
        // All of them: a damaged song's first seconds still say how it sounds.
        const again = [...c.fine, ...c.length, ...c.damaged];
        if (again.length) await f(`${url}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Brain-Key': key }, body: JSON.stringify({ ids: again }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (c.damaged.length) (app as any).startTask?.('flac');
      }
      reviewedAt = st.undecodable;
    } catch (e: any) { app.log.warn(`song checks: ${e.message}`); }
    finally { reviewing = false; }
  };
  const status = async () => {
    try {
      const r = await f(`${url}/status`, { headers: { 'X-Brain-Key': key }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(r.status === 401 ? 'BRAIN_KEY is not the same on both' : `HTTP ${r.status}`);
      st = await r.json(); err = null;
      void review();
    } catch (e: any) { err = e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message; }
    return st;
  };
  if (process.env.NODE_ENV !== 'test') { void status(); setInterval(status, opts.pollMs ?? 60_000).unref(); }
  return {
    id: 'brain', name: 'Brain', schedule: { mode: 'daily', at: '04:00' }, alongside: true,
    description: 'The recommender on your GPU box: learns how everyone listens and how each song sounds, and picks what plays next. Run now retrains it.',
    settings: BRAIN_SETTINGS,
    info: () => brainLine(st, err),
    run: async (ctx) => {
      const before = (await status())?.last_train?.trained_at ?? 0;
      if (err) throw new Error(err);
      const r = await f(`${url}/train`, { method: 'POST', headers: { 'X-Brain-Key': key }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ctx.step('Training');
      for (let i = 0; i < 360; i++) {   // 30 min at most
        await new Promise((res) => setTimeout(res, 5000));
        const s = await status();
        const lt = s?.last_train;
        if (lt?.trained_at > before) {
          const m = lt.metrics, b = lt.baselines?.old_mix;
          return m && b ? `next song in its top 10 ${pct(m['hit@10'])} of the time (old mix ${pct(b['hit@10'])})` : 'retrained';
        }
        ctx.step(s?.phase === 'training' ? 'Training' : 'Waiting for the brain to start');
      }
      throw new Error('the brain did not finish training in 30 min');
    },
  };
}

export function registerBrain(app: FastifyInstance, db: DB) {
  const auth = { preHandler: (app as any).requireBrain };
  // Audio going out to anyone (speakers included): "someone is listening"
  // for the brain's pause rule, alongside the session's own reports.
  let lastStream = 0;
  app.addHook('onRequest', async (req) => { if (req.url.startsWith('/api/stream/')) lastStream = Date.now(); });
  app.get('/api/brain/settings', auth, async () => ({
    settings: brainRules(db),
    tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    listening: ((app as any).listeningNow?.() ?? 0) > 0 || Date.now() - lastStream < 120_000,
  }));
  // Pages by rowid: the brain keeps the last one it saw and asks for what is new.
  app.get('/api/brain/catalog', auth, async (req) => {
    const { after, limit } = page(req.query, 5000);
    const items = db.prepare(`SELECT rowid AS seq, id, title, artist, artist_ids, album, album_id, album_artist, genres, year, duration_ms, added_at, loudness
      FROM tracks WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(after, limit);
    return { items, total: (db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n };
  });
  // The ids that exist now (a catalog page cannot say what was removed).
  app.get('/api/brain/ids', auth, async () => ({ ids: (db.prepare('SELECT id FROM tracks').all() as any[]).map((r) => r.id) }));
  app.get('/api/brain/plays', auth, async (req) => {
    const { after, limit } = page(req.query, 50000);
    return { items: db.prepare('SELECT rowid AS seq, user_id, track_id, at, client FROM plays WHERE rowid > ? ORDER BY rowid LIMIT ?').all(after, limit) };
  });
  app.get('/api/brain/events', auth, async (req) => {
    const { after, limit } = page(req.query, 50000);
    return { items: db.prepare('SELECT id AS seq, user_id, track_id, at, ms_played, end_ms, duration_ms, reason, shuffle, client FROM play_events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit) };
  });
  // Taste, whole: small enough to send every time.
  app.get('/api/brain/taste', auth, async () => {
    const likes = db.prepare('SELECT user_id, track_id, at FROM likes').all();
    const dislikes: { user_id: string; track_id: string }[] = [];
    for (const r of db.prepare('SELECT user_id, json FROM prefs').all() as any[]) {
      try { for (const id of Object.keys(JSON.parse(r.json).dislikes || {})) dislikes.push({ user_id: r.user_id, track_id: id }); } catch { /* bad prefs row */ }
    }
    return { likes, dislikes, users: (db.prepare('SELECT id FROM users').all() as any[]).map((u) => u.id) };
  });
}

export type BrainAsk = {
  user: string;
  // continue: the queue ran out (autoplay); smart: smart shuffle's additions;
  // radio: a song's radio; now: Home's "right now" mix.
  mode: 'continue' | 'smart' | 'radio' | 'now';
  seeds: string[]; n: number; exclude?: string[]; client?: string;
};

// What the user did lately, newest last: the brain's session context.
export function recentOf(db: DB, uid: string, n = 30) {
  const ev = db.prepare('SELECT track_id AS id, at, ms_played AS ms, reason FROM play_events WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(uid, n) as any[];
  if (ev.length >= 5) return ev.reverse();
  return (db.prepare('SELECT track_id AS id, at FROM plays WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(uid, n) as any[]).reverse();
}

export function dislikedOf(db: DB, uid: string): string[] {
  try { return Object.keys(JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid) as any)?.json ?? '{}').dislikes || {}); } catch { return []; }
}

// Track ids from the brain, only ones this library has, in its order; null
// when there is no brain or it did not answer in time.
export async function brainNext(db: DB, ask: BrainAsk, opts: { url?: string; key?: string; timeoutMs?: number; fetcher?: typeof fetch; log?: (m: string) => void } = {}): Promise<string[] | null> {
  const url = opts.url ?? config.brain.url, key = opts.key ?? config.brain.key;
  if (!url || !key || !brainRules(db).enabled) return null;
  const f = opts.fetcher ?? fetch;
  const t0 = Date.now();
  try {
    const r = await f(`${url}/recommend`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Brain-Key': key },
      body: JSON.stringify({ ...ask, exclude: [...new Set([...(ask.exclude || []), ...dislikedOf(db, ask.user)])], recent: recentOf(db, ask.user), now: Date.now() }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? config.brain.timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { items?: unknown };
    const ids = Array.isArray(j.items) ? j.items.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)) : [];
    if (!ids.length) return null;
    const have = new Set((db.prepare(`SELECT id FROM tracks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[]).map((x) => x.id));
    const out = ids.filter((id) => have.has(id));
    opts.log?.(`brain ${ask.mode}: ${out.length} in ${Date.now() - t0} ms`);
    return out.length ? out : null;
  } catch (e: any) {
    opts.log?.(`brain ${ask.mode}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}, own mix instead`);
    return null;
  }
}

// Songs that sound like the words, for generated playlists (ai.ts): the
// brain compares them with every song's audio and leans toward the
// listener's taste. [] when there is no brain or it does not answer; the
// first search after a while loads the audio model, so it gets longer.
export type SoundHit = { id: string; sound: number };
export async function brainSearch(db: DB, ask: { user: string; text: string; n?: number; exclude?: string[] },
  opts: { url?: string; key?: string; timeoutMs?: number; fetcher?: typeof fetch; log?: (m: string) => void } = {}): Promise<SoundHit[]> {
  const url = opts.url ?? config.brain.url, key = opts.key ?? config.brain.key;
  if (!url || !key || !brainRules(db).enabled) return [];
  const f = opts.fetcher ?? fetch;
  const t0 = Date.now();
  try {
    const r = await f(`${url}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Brain-Key': key },
      body: JSON.stringify({ ...ask, exclude: [...new Set([...(ask.exclude || []), ...dislikedOf(db, ask.user)])], recent: recentOf(db, ask.user), now: Date.now() }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { items?: any[] };
    const hits = (Array.isArray(j.items) ? j.items : []).filter((x) => x && typeof x.id === 'string' && /^[0-9a-f]{32}$/.test(x.id))
      .map((x) => ({ id: x.id as string, sound: Number(x.sound) || 0 }));
    if (!hits.length) return [];
    const have = new Set((db.prepare(`SELECT id FROM tracks WHERE id IN (${hits.map(() => '?').join(',')})`).all(...hits.map((h) => h.id)) as any[]).map((x) => x.id));
    const out = hits.filter((h) => have.has(h.id));
    opts.log?.(`brain search: ${out.length} in ${Date.now() - t0} ms`);
    return out;
  } catch (e: any) {
    opts.log?.(`brain search: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    return [];
  }
}
export const brainOn = (db: DB) => Boolean(config.brain.url && config.brain.key && brainRules(db).enabled);
