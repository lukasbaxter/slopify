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

export function registerBrain(app: FastifyInstance, db: DB) {
  const auth = { preHandler: (app as any).requireBrain };
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
  if (!url || !key) return null;
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
