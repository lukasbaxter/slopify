// Generated playlists: describe a playlist, get 25 songs from this library.
//
// The model is llama.cpp's server running Qwen3.5-9B on the machine's GPU,
// inside this container (the Dockerfile builds it). It is started on the
// first request and stopped after LLM_IDLE_MIN minutes without one, so the
// 6 GB of VRAM go back to Jellyfin's transcoder and the other GPU tools.
//
// The model never invents the list on its own: a song it names from memory
// may not be here. Two calls instead:
//   1. plan: the request + the listener's profile (most played artists,
//      liked artists, playlist names, genres) -> artists, genres, eras,
//      specific songs and playlists of theirs that fit;
//   2. pick: those turned into real library tracks (plus their own plays and
//      likes as tie-breakers), numbered -> the model picks and orders 25.
// Whatever it gets wrong (a number out of range, too few picks, one artist
// ten times) is fixed from the scored pool, so the answer is always 25 real
// tracks.
import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DB } from './db.js';
import { playlistId } from './ids.js';
import { matchTrack } from './explore.js';
import { startJob, jobOut, type Job } from './jobs.js';

export type AiOptions = {
  llamaBin: string; modelPath: string; modelUrl: string;
  llmUrl?: string;           // an OpenAI-compatible server to use instead of starting one (development)
  port: number; idleMs: number; gpuLayers: string; ctx: number;
  log?: (m: string) => void;
};

const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SIZE = 25;
// Every artist credited on a track, normalized ("The Weeknd, Daft Punk" -> both).
const credits = (r: { artist: string; artists?: string }) => {
  let a: string[] = []; try { a = JSON.parse(r.artists || '[]'); } catch { /* old row */ }
  return [...new Set((a.length ? a : [r.artist]).map(norm).filter(Boolean))];
};

// --- the model process ---------------------------------------------------------
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export class Llm {
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private busy = 0;
  private tail: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private o: AiOptions) {}

  available(): { ok: boolean; reason?: string } {
    if (this.o.llmUrl) return { ok: true };
    if (!fs.existsSync(this.o.llamaBin)) return { ok: false, reason: 'This server was built without the local model.' };
    return { ok: true };
  }
  get loaded() { return !!this.o.llmUrl || !!this.proc; }
  private base() { return this.o.llmUrl || `http://127.0.0.1:${this.o.port}`; }

  // One request at a time: the server runs one slot, and a second playlist
  // waiting behind the first is better than both at half speed.
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private async download(step: (s: string, p?: number) => void) {
    if (fs.existsSync(this.o.modelPath)) return;
    fs.mkdirSync(path.dirname(this.o.modelPath), { recursive: true });
    const part = `${this.o.modelPath}.part`;
    const r = await fetch(this.o.modelUrl);
    if (!r.ok || !r.body) throw new Error(`model download: HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(part);
    let got = 0, last = 0;
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
      if (total && Date.now() - last > 500) { last = Date.now(); step(`Downloading the model (first time only): ${(got / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`, got / total); }
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    fs.renameSync(part, this.o.modelPath);
  }

  async ensure(step: (s: string, p?: number) => void) {
    if (this.o.llmUrl || this.proc) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.download(step);
      step('Loading the model onto the GPU');
      const bin = this.o.llamaBin;
      const args = ['-m', this.o.modelPath, '--host', '127.0.0.1', '--port', String(this.o.port),
        '-ngl', this.o.gpuLayers, '-c', String(this.o.ctx), '-np', '1', '--jinja', '--no-webui', '--reasoning-budget', '0'];
      const env = { ...process.env, LD_LIBRARY_PATH: [path.join(path.dirname(bin), 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
      const p = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = p; this.tail = [];
      const keep = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) { this.tail.push(l); if (this.tail.length > 40) this.tail.shift(); } };
      p.stdout!.on('data', keep); p.stderr!.on('data', keep);
      p.on('exit', (code) => { if (this.proc === p) { this.proc = null; this.o.log?.(`llm exited (${code})`); } });
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        if (!this.proc) throw new Error(`The model failed to start: ${this.tail.slice(-3).join(' | ')}`);
        try { const r = await fetch(`${this.base()}/health`); if (r.ok) { this.o.log?.(`llm ready in ${Date.now() - t0} ms`); return; } } catch { /* not listening yet */ }
        await new Promise((res) => setTimeout(res, 500));
      }
      this.stop(); throw new Error('The model took too long to load');
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  stop() { if (this.proc) { this.proc.kill('SIGTERM'); this.proc = null; } }
  private armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.busy && this.proc) { this.o.log?.('llm idle, stopping'); this.stop(); } }, this.o.idleMs);
    this.idle.unref?.();
  }

  async json<T>(messages: Msg[], schema: object, opts: { temperature?: number; maxTokens?: number } = {}): Promise<T> {
    this.busy++;
    try {
      const r = await fetch(`${this.base()}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages, temperature: opts.temperature ?? 0.7, top_p: 0.8, max_tokens: opts.maxTokens ?? 2000,
          response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } },
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!r.ok) throw new Error(`model: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      const j = await r.json() as any;
      const text = String(j.choices?.[0]?.message?.content || '').replace(/^[\s\S]*<\/think>/, '').trim();
      return JSON.parse(text) as T;
    } finally { this.busy--; this.armIdle(); }
  }
}

// --- what the listener is like ---------------------------------------------------
type Row = { id: string; title: string; artist: string; artists: string; artist_ids: string; album: string; year: number | null; genres: string };

export function tasteOf(db: DB, uid: string) {
  const since = (days: number) => Date.now() - days * 86400000;
  const topArtists = (from: number, n: number) => (db.prepare(`SELECT t.artist AS name, COUNT(*) AS n FROM plays p JOIN tracks t ON t.id = p.track_id
      WHERE p.user_id = ? AND p.at >= ? GROUP BY t.artist ORDER BY n DESC LIMIT ?`).all(uid, from, n) as any[]);
  const likedArtists = db.prepare(`SELECT t.artist AS name, COUNT(*) AS n FROM likes l JOIN tracks t ON t.id = l.track_id
      WHERE l.user_id = ? GROUP BY t.artist ORDER BY n DESC LIMIT 30`).all(uid) as any[];
  const genres = new Map<string, number>();
  for (const r of db.prepare(`SELECT t.genres FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? AND p.at >= ?
      UNION ALL SELECT t.genres FROM likes l JOIN tracks t ON t.id = l.track_id WHERE l.user_id = ?`).all(uid, since(365), uid) as any[]) {
    for (const g of JSON.parse(r.genres || '[]') as string[]) if (g.trim()) genres.set(g, (genres.get(g) || 0) + 1);
  }
  const playlists = db.prepare(`SELECT id, name FROM playlists WHERE user_id = ? ORDER BY updated DESC LIMIT 80`).all(uid) as { id: string; name: string }[];
  return {
    allTime: topArtists(0, 40), lately: topArtists(since(30), 15), likedArtists,
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([g]) => g),
    playlists,
  };
}

function profileText(t: ReturnType<typeof tasteOf>) {
  const list = (xs: any[]) => xs.map((x) => `${x.name} (${x.n})`).join(', ') || 'none yet';
  return [
    `Most played artists, all time: ${list(t.allTime)}`,
    `Most played in the last 30 days: ${list(t.lately)}`,
    `Artists with the most liked songs: ${list(t.likedArtists)}`,
    `Genres they play most: ${t.genres.join(', ') || 'unknown'}`,
    `Their playlists: ${t.playlists.map((p) => `"${p.name}"`).join(', ') || 'none'}`,
  ].join('\n');
}

// --- plan -> pool -> pick -------------------------------------------------------
const PlanSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 40 },
    artists: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    genres: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    songs: { type: 'array', maxItems: 40, items: { type: 'object', properties: { artist: { type: 'string' }, title: { type: 'string' } }, required: ['artist', 'title'] } },
    playlists: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    useHistory: { type: 'boolean' },
    yearFrom: { type: ['integer', 'null'] },
    yearTo: { type: ['integer', 'null'] },
  },
  required: ['title', 'artists', 'genres', 'songs', 'playlists', 'useHistory', 'yearFrom', 'yearTo'],
};
type Plan = { title: string; artists: string[]; genres: string[]; songs: { artist: string; title: string }[]; playlists: string[]; useHistory: boolean; yearFrom: number | null; yearTo: number | null };

const PLAN_SYSTEM = `You plan playlists for a personal music server. The playlist can only contain songs from the listener's own library, so your plan is used to search that library.
Given the request and the listener's profile, answer with:
- title: a short playlist name (2 to 5 words, no quotes, no emoji).
- artists: up to 30 real artists whose music fits the request. Use artists from their profile only when they really fit the request; add others that fit it well.
- genres: up to 8 genre names that fit, as music libraries tag them (e.g. "R&B", "Hip Hop", "Indie Pop", "House").
- songs: up to 40 specific real songs (artist + exact title) that fit the request. Every song different: never repeat a title.
- playlists: names of the listener's own playlists (exactly as listed) the request refers to or that clearly fit it; empty if none.
- useHistory: true when the request is about their own taste or favourites (e.g. "my favourites", "songs I love", "what I have been playing").
- yearFrom / yearTo: only when the request names an era (e.g. "90s" = 1990 to 1999), otherwise null.
If the request names artists or songs, include them.`;

const PICK_SYSTEM = `You pick songs for a playlist from a numbered list of songs the listener owns. Choose exactly ${SIZE} different numbers that best fit the request, and order them so the playlist flows well (a strong opener, related songs near each other, a good closer).
Unless the request is about one or two artists, use at most 3 songs by the same artist.
Songs marked "liked" or with plays are songs the listener already enjoys: prefer them when they fit equally well, but the request comes first.
Also give the playlist a short title (2 to 5 words, no quotes, no emoji).`;

type Cand = { row: Row; score: number; base: number };

export function buildPool(db: DB, uid: string, plan: Plan, extraText = '') {
  const plays = new Map((db.prepare('SELECT track_id, COUNT(*) n FROM plays WHERE user_id = ? GROUP BY track_id').all(uid) as any[]).map((r) => [r.track_id as string, r.n as number]));
  const liked = new Set((db.prepare('SELECT track_id FROM likes WHERE user_id = ?').all(uid) as any[]).map((r) => r.track_id as string));
  const prefs = JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid) as any)?.json ?? '{}');
  const disliked = new Set(Object.keys(prefs.dislikes || {}));
  const own = (id: string) => (liked.has(id) ? 2 : 0) + Math.min(3, Math.log2(1 + (plays.get(id) || 0)));
  const pool = new Map<string, Cand>();
  const add = (r: Row | undefined, score: number) => {
    if (!r || disliked.has(r.id)) return;
    if (plan.yearFrom && r.year && r.year < plan.yearFrom) return;
    if (plan.yearTo && r.year && r.year > plan.yearTo) return;
    const c = pool.get(r.id);
    if (c) { c.score += score / 2; c.base += score / 2; } else pool.set(r.id, { row: r, score: score + own(r.id), base: score });
  };
  const SEL = 'SELECT id, title, artist, artists, artist_ids, album, year, genres FROM tracks';
  const byId = db.prepare(`${SEL} WHERE id = ?`);

  // 1. songs it named, found here
  for (const s of plan.songs) { const id = matchTrack(db, { title: s.title, artist: s.artist }); if (id) add(byId.get(id) as Row, 10); }

  // 2. their playlists it pointed at (by name, or named in the request itself)
  const pls = db.prepare('SELECT id, name FROM playlists WHERE user_id = ?').all(uid) as { id: string; name: string }[];
  const wanted = new Set(plan.playlists.map(norm));
  const req = norm(extraText);
  for (const p of pls) {
    const n = norm(p.name);
    if (!n || !(wanted.has(n) || (n.length >= 3 && ` ${req} `.includes(` ${n} `)))) continue;
    for (const r of db.prepare(`SELECT t.id, t.title, t.artist, t.artists, t.artist_ids, t.album, t.year, t.genres FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id WHERE x.playlist_id = ? ORDER BY x.pos LIMIT 80`).all(p.id) as Row[]) add(r, 6);
  }

  // 3. artists: their own favourites of each first, then the rest at random
  const artistRows = db.prepare('SELECT id, name FROM artists').all() as { id: string; name: string }[];
  const artistByNorm = new Map(artistRows.map((a) => [norm(a.name), a.id]));
  for (const name of plan.artists) {
    const aid = artistByNorm.get(norm(name)); if (!aid) continue;
    const rows = db.prepare(`${SEL} WHERE artist_ids LIKE ?`).all(`%"${aid}"%`) as Row[];
    rows.sort((a, b) => own(b.id) - own(a.id) || Math.random() - 0.5);
    for (const r of rows.slice(0, 12)) add(r, 5);
  }

  // 4. genres: every library genre whose name contains one it asked for
  const genreNames = (db.prepare(`SELECT DISTINCT j.value AS g FROM tracks, json_each(tracks.genres) j`).all() as any[]).map((r) => String(r.g));
  const gWanted = plan.genres.map(norm).filter(Boolean);
  const gHit = genreNames.filter((g) => { const n = norm(g); return n && gWanted.some((w) => n === w || ` ${n} `.includes(` ${w} `)); });
  for (const g of gHit.slice(0, 40)) {
    const rows = db.prepare(`${SEL} WHERE genres LIKE ? ORDER BY RANDOM() LIMIT 300`).all(`%${JSON.stringify(g)}%`) as Row[];
    const mine = rows.filter((r) => own(r.id) > 0).slice(0, 15), rest = rows.filter((r) => own(r.id) === 0).slice(0, 10);
    for (const r of [...mine, ...rest]) add(r, 3);
  }

  // 5. their own favourites when the request is about them (or nothing else hit)
  if (plan.useHistory || pool.size < 60) {
    const top = db.prepare(`SELECT track_id FROM plays WHERE user_id = ? AND at > ? GROUP BY track_id ORDER BY COUNT(*) DESC LIMIT 60`).all(uid, Date.now() - 180 * 86400000) as any[];
    const lk = db.prepare(`SELECT track_id FROM likes WHERE user_id = ? ORDER BY at DESC LIMIT 60`).all(uid) as any[];
    for (const r of [...top, ...lk]) add(byId.get(r.track_id) as Row, plan.useHistory ? 4 : 1);
  }
  if (pool.size < 40) for (const r of db.prepare(`${SEL} ORDER BY RANDOM() LIMIT 60`).all() as Row[]) add(r, 0);

  // One copy of each song (the same recording sits on the album and on a compilation).
  // Keyed by every credited artist, so "Starboy" and "Starboy (live)" by The
  // Weeknd and by "The Weeknd, Daft Punk" are one song.
  const seen = new Set<string>(); const out: Cand[] = [];
  for (const c of [...pool.values()].sort((a, b) => b.score - a.score || Math.random() - 0.5)) {
    const t = norm(c.row.title); const keys = credits(c.row).map((a) => `${a}|${t}`);
    if (keys.some((k) => seen.has(k))) continue; keys.forEach((k) => seen.add(k)); out.push(c);
    if (out.length >= 200) break;
  }
  return { pool: out, plays, liked };
}

function poolText(pool: Cand[], plays: Map<string, number>, liked: Set<string>) {
  return pool.map((c, i) => {
    const r = c.row; const g = (JSON.parse(r.genres || '[]') as string[]).slice(0, 2).join('/');
    const bits = [r.year, g].filter(Boolean).join(', ');
    const mine = [liked.has(r.id) ? 'liked' : '', plays.get(r.id) ? `${plays.get(r.id)} plays` : ''].filter(Boolean).join(', ');
    return `${i + 1}. ${r.artist} - ${r.title}${bits ? ` (${bits})` : ''}${mine ? ` [${mine}]` : ''}`;
  }).join('\n');
}

// Turn the model's picks into exactly SIZE tracks: valid, unique, at most 3
// per artist (unless the plan is about one or two artists), topped up from
// the pool's best.
export function finalize(pool: (Omit<Cand, 'base'> & { base?: number })[], picks: number[], plan: Pick<Plan, 'artists'>) {
  const cap = plan.artists.length && plan.artists.length <= 2 ? SIZE : 3;
  const out: Row[] = []; const per = new Map<string, number>(); const used = new Set<number>();
  const take = (i: number, capped = true) => {
    const c = pool[i]; if (!c || used.has(i)) return;
    const as = credits(c.row); if (capped && as.some((a) => (per.get(a) || 0) >= cap)) return;
    used.add(i); for (const a of as) per.set(a, (per.get(a) || 0) + 1); out.push(c.row);
  };
  for (const n of picks) { if (out.length >= SIZE) break; take(n - 1); }
  // Top-up: what fits the request best, not what they play most.
  const byFit = pool.map((c, i) => [c.base ?? c.score, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (const i of byFit) { if (out.length >= SIZE) break; take(i); }
  // A small library can run out of artists: 25 songs beats a fair spread.
  for (const i of byFit) { if (out.length >= SIZE) break; take(i, false); }
  return out;
}

export async function generatePlaylist(db: DB, llm: Llm, uid: string, prompt: string, job: Job) {
  const step = (s: string, p?: number) => { job.step = s; job.progress = p ?? null; };
  await llm.ensure(step);
  step('Reading your listening');
  const taste = tasteOf(db, uid);
  step('Thinking about what fits');
  const plan = await llm.json<Plan>([
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: `Listener profile:\n${profileText(taste)}\n\nRequest: ${prompt}` },
  ], PlanSchema, { temperature: 0.6, maxTokens: 2500 });
  step('Finding songs in your library');
  const { pool, plays, liked } = buildPool(db, uid, plan, prompt);
  if (!pool.length) throw new Error('Nothing in the library matched');
  step('Picking 25 songs');
  const pick = await llm.json<{ title: string; picks: number[] }>([
    { role: 'system', content: PICK_SYSTEM },
    { role: 'user', content: `Request: ${prompt}\n\nSongs:\n${poolText(pool, plays, liked)}` },
  ], {
    type: 'object',
    properties: { title: { type: 'string', maxLength: 40 }, picks: { type: 'array', items: { type: 'integer', minimum: 1, maximum: pool.length }, minItems: SIZE, maxItems: SIZE } },
    required: ['title', 'picks'],
  }, { temperature: 0.5, maxTokens: 400 });
  const tracks = finalize(pool, pick.picks || [], plan);
  const name = (pick.title || plan.title || 'Generated playlist').replace(/["“”]/g, '').trim().slice(0, 60) || 'Generated playlist';
  const id = playlistId(), now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid, name, now, now);
    tracks.forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t.id, now));
  })();
  return { playlistId: id, name, count: tracks.length, poolSize: pool.length };
}

export function registerAi(app: FastifyInstance, db: DB, opts: AiOptions) {
  const llm = new Llm({ ...opts, log: opts.log ?? ((m) => app.log.info(m)) });
  app.addHook('onClose', async () => llm.stop());
  const auth = { preHandler: (app as any).requireUser };
  app.get('/api/ai/status', auth, async () => ({ ...llm.available(), loaded: llm.loaded }));
  app.post('/api/ai/playlists', auth, async (req: any, reply) => {
    const b = z.object({ prompt: z.string().trim().min(3).max(1000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Describe the playlist' });
    const av = llm.available(); if (!av.ok) return reply.code(503).send({ error: av.reason });
    const job = startJob(req.user.id, 'ai-playlist', (j) => { j.step = 'Waiting for the model'; return llm.run(() => generatePlaylist(db, llm, req.user.id, b.data.prompt, j)); });
    app.log.info({ uid: req.user.id, prompt: b.data.prompt }, 'ai playlist');
    return jobOut(job);
  });
  return llm;
}
