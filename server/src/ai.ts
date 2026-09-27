// Generated playlists: describe a playlist, get 25 songs from this library,
// 20 of them songs the listener has never played and 5 they know.
//
// The model is llama.cpp's server running Qwen3.5-9B on the machine's GPU,
// inside this container (the Dockerfile builds it). It is started on the
// first request and stopped after LLM_IDLE_MIN minutes without one, so the
// 6 GB of VRAM go back to Jellyfin's transcoder and the other GPU tools.
//
// The model never invents the list on its own (a song it names from memory
// may not be here):
//   1. plan: request + listener profile -> the vibe in words, artists
//      (mostly ones they do not play), genres, specific songs, eras;
//   2. pool: those found in the library, plus Deezer's similar artists that
//      the library has, genres at random; played/liked songs marked known.
//      Nothing favours what they already play (that made the first version
//      all repeats);
//   3. rate: every candidate scored 0-10 against the vibe, 40 at a time
//      (the step that keeps a party song out of a late-night playlist);
//   4. choose: 5 known + 20 new by fit, capped per artist; 5. order.
// Suggested songs the library lacks are rated too; the clear fits are
// requested on Music Requests and join the playlist when they download.
import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DB } from './db.js';
import { playlistId } from './ids.js';
import { matchTrack } from './explore.js';
import { similarInLibrary } from './discover.js';
import { startJob, jobOut, type Job } from './jobs.js';

export type AiOptions = {
  llamaBin: string; modelPath: string; modelUrl: string;
  llmUrl?: string;           // an OpenAI-compatible server to use instead of starting one (development)
  musicRequestsUrl?: string; // songs it suggests that the library lacks are requested here
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
        ...(this.o.gpuLayers ? ['-ngl', this.o.gpuLayers] : []), '-c', String(this.o.ctx), '-np', '1', '--jinja', '--no-webui', '--reasoning-budget', '0'];
      const env = { ...process.env, LD_LIBRARY_PATH: [path.join(path.dirname(bin), 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
      const p = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = p; this.tail = [];
      const keep = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) { this.tail.push(l); if (this.tail.length > 40) this.tail.shift(); } };
      p.stdout!.on('data', keep); p.stderr!.on('data', keep);
      p.on('exit', (code) => { if (this.proc === p) { this.proc = null; this.o.log?.(`llm exited (${code})`); } });
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        if (!this.proc) {
          const why = this.tail.join('\n');
          throw new Error(/out of memory|cudaMalloc/i.test(why) ? 'Not enough free GPU memory right now (something else is using the GPU). Try again in a bit.' : `The model failed to start: ${this.tail.slice(-2).join(' | ')}`);
        }
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
    } catch (e: any) {
      if (/fetch failed|ECONNREFUSED|socket/i.test(String(e?.message || e))) throw new Error('The model stopped unexpectedly. Try again.');
      throw e;
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

// --- plan -> pool -> rate -> choose -> order ------------------------------------
const PlanSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 40 },
    vibe: { type: 'string', maxLength: 300 },
    artists: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    genres: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    songs: { type: 'array', maxItems: 50, items: { type: 'object', properties: { artist: { type: 'string' }, title: { type: 'string' } }, required: ['artist', 'title'] } },
    playlists: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    useHistory: { type: 'boolean' },
    yearFrom: { type: ['integer', 'null'] },
    yearTo: { type: ['integer', 'null'] },
  },
  required: ['title', 'vibe', 'artists', 'genres', 'songs', 'playlists', 'useHistory', 'yearFrom', 'yearTo'],
};
export type Plan = { title: string; vibe: string; artists: string[]; genres: string[]; songs: { artist: string; title: string }[]; playlists: string[]; useHistory: boolean; yearFrom: number | null; yearTo: number | null };

const PLAN_SYSTEM = `You plan playlists for a personal music server. The playlist can only contain songs from the listener's own library, so your plan is used to search that library. Most of the playlist (80%) must be songs the listener has NOT played before, so the plan is about discovery that still fits their taste.
Given the request and the listener's profile, answer with:
- title: a short playlist name (2 to 5 words, no quotes, no emoji).
- vibe: one or two sentences on exactly what the songs should feel like: mood, energy, tempo, setting, and what does NOT belong.
- artists: up to 30 real artists whose music fits the vibe. At most a third from their profile (only ones that truly fit); the rest should be artists they do not play much but would likely enjoy.
- genres: up to 8 genre names that fit, as music libraries tag them (e.g. "R&B", "Hip Hop", "Indie Pop", "House").
- songs: up to 50 specific real songs (artist + exact title) that fit the vibe closely. Every song different, never repeat a title. Favour deeper cuts over the biggest hits.
- playlists: names of the listener's own playlists (exactly as listed) the request refers to; empty if none.
- useHistory: true only when the request is about their own favourites (e.g. "my favourites", "what I have been playing").
- yearFrom / yearTo: only when the request names an era (e.g. "90s" = 1990 to 1999), otherwise null.
If the request names artists or songs, include them.`;

const RATE_SYSTEM = `You judge whether songs fit a playlist. For every numbered song, give a score from 0 to 10 for how well it fits the playlist's vibe: mood, energy, tempo and setting.
Be strict and use the whole range: most songs in the list will NOT fit, and should get 5 or less. 9-10: exactly the vibe, a song you would put on this playlist yourself. 7-8: fits well. 5-6: could pass. 3-4: same genre but a different energy or mood. 0-2: does not belong.
A song does not fit just because the artist or genre is related: a hype party song does not fit a calm playlist, an instrumental ambient track does not fit a sing-along one.
Answer with one score per song, in the order given.`;

const ORDER_SYSTEM = `Put these playlist songs in the best listening order: a strong, inviting opener, songs with a similar feel next to each other, energy that flows instead of jumping around, a satisfying closer. Answer with every number exactly once.`;

type Cand = { row: Row; known: boolean; src: number; fit?: number };
export const KNOWN_SHARE = 0.2;

// Candidates from everything the plan points at, without favouring what they
// already play: the model's named songs, the planned artists (a random
// spread of their tracks), artists similar to those (Deezer, library only:
// mostly never played), their genres at random, and any playlist of theirs
// the request names. `known` = played or liked before.
export async function buildPool(db: DB, uid: string, plan: Plan, prompt = '', similar?: (a: { id: string; name: string }) => Promise<{ id: string; name: string }[]>) {
  const plays = new Map((db.prepare('SELECT track_id, COUNT(*) n FROM plays WHERE user_id = ? GROUP BY track_id').all(uid) as any[]).map((r) => [r.track_id as string, r.n as number]));
  const liked = new Set((db.prepare('SELECT track_id FROM likes WHERE user_id = ?').all(uid) as any[]).map((r) => r.track_id as string));
  const prefs = JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid) as any)?.json ?? '{}');
  const disliked = new Set(Object.keys(prefs.dislikes || {}));
  const pool = new Map<string, Cand>();
  // Versions nobody means unless they ask: instrumentals, sped-up and slowed
  // edits, karaoke, skits, interludes, holiday songs.
  const ODD = /\b(instrumental|karaoke|a ?cappella|sped[ -]?up|slowed|nightcore|skit|interlude|intro|outro|commentary|christmas|xmas|holiday|jingle|santa|snow(man)?|drummer boy)\b/i;
  const LIVE = /[([][^)\]]*\b(live|soundcheck|demo)\b/i; // "(live)", "(Walmart Soundcheck version)"; not "Live Your Life"
  const asked = ODD.test(prompt) || ODD.test(plan.vibe);
  const askedLive = /\blive\b/i.test(prompt);
  const add = (r: Row | undefined, src: number) => {
    if (!r || disliked.has(r.id)) return;
    if (!asked && (ODD.test(r.title) || ODD.test(r.album))) return;
    if (!askedLive && (LIVE.test(r.title) || LIVE.test(r.album))) return;
    if (plan.yearFrom && r.year && r.year < plan.yearFrom) return;
    if (plan.yearTo && r.year && r.year > plan.yearTo) return;
    const c = pool.get(r.id);
    if (c) c.src = Math.max(c.src, src); else pool.set(r.id, { row: r, known: plays.has(r.id) || liked.has(r.id), src });
  };
  const SEL = 'SELECT id, title, artist, artists, artist_ids, album, year, genres FROM tracks';
  const byId = db.prepare(`${SEL} WHERE id = ?`);
  const shuffle = <T>(xs: T[]) => { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };
  const artistTracks = (aid: string, n: number, src: number) => {
    const rows = shuffle(db.prepare(`${SEL} WHERE artist_ids LIKE ?`).all(`%"${aid}"%`) as Row[]);
    // a few they know, mostly ones they do not
    const known = rows.filter((r) => plays.has(r.id) || liked.has(r.id)).slice(0, 2);
    const fresh = rows.filter((r) => !plays.has(r.id) && !liked.has(r.id)).slice(0, n);
    for (const r of [...fresh, ...known]) add(r, src);
  };

  // 1. songs it named, found here (the rest can be requested)
  const missing: { artist: string; title: string }[] = [];
  for (const s of plan.songs) { const id = matchTrack(db, { title: s.title, artist: s.artist }); if (id) add(byId.get(id) as Row, 3); else if (!ODD.test(s.title) || asked) missing.push(s); }

  // 2. their playlists the request names
  const pls = db.prepare('SELECT id, name FROM playlists WHERE user_id = ?').all(uid) as { id: string; name: string }[];
  const wanted = new Set(plan.playlists.map(norm)); const req = norm(prompt);
  for (const p of pls) {
    const n = norm(p.name);
    if (!n || !(wanted.has(n) || (n.length >= 3 && ` ${req} `.includes(` ${n} `)))) continue;
    for (const r of db.prepare(`SELECT t.id, t.title, t.artist, t.artists, t.artist_ids, t.album, t.year, t.genres FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id WHERE x.playlist_id = ? ORDER BY RANDOM() LIMIT 40`).all(p.id) as Row[]) add(r, 2);
  }

  // 3. the planned artists, and 4. artists similar to them
  const artistByNorm = new Map((db.prepare('SELECT id, name FROM artists').all() as { id: string; name: string }[]).map((a) => [norm(a.name), a]));
  const seeds = plan.artists.map((n) => artistByNorm.get(norm(n))).filter(Boolean) as { id: string; name: string }[];
  for (const a of seeds) artistTracks(a.id, 5, 2);
  if (similar) {
    const seen = new Set(seeds.map((a) => a.id));
    const lists = await Promise.all(seeds.slice(0, 10).map((a) => similar(a).catch(() => [])));
    for (const list of lists) for (const a of list.slice(0, 6)) { if (seen.has(a.id)) continue; seen.add(a.id); artistTracks(a.id, 3, 1); }
  }

  // 5. genres, at random
  const genreNames = (db.prepare(`SELECT DISTINCT j.value AS g FROM tracks, json_each(tracks.genres) j`).all() as any[]).map((r) => String(r.g));
  const gWanted = plan.genres.map(norm).filter(Boolean);
  const gHit = genreNames.filter((g) => { const n = norm(g); return n && gWanted.some((w) => n === w || ` ${n} `.includes(` ${w} `)); });
  for (const g of shuffle(gHit).slice(0, 30)) for (const r of db.prepare(`${SEL} WHERE genres LIKE ? ORDER BY RANDOM() LIMIT 8`).all(`%${JSON.stringify(g)}%`) as Row[]) add(r, 1);

  // 6. their favourites when the request is about them
  if (plan.useHistory) {
    const top = db.prepare(`SELECT track_id FROM plays WHERE user_id = ? AND at > ? GROUP BY track_id ORDER BY COUNT(*) DESC LIMIT 60`).all(uid, Date.now() - 180 * 86400000) as any[];
    for (const r of top) add(byId.get(r.track_id) as Row, 2);
  }

  // One copy of each song (same recording on the album and a compilation,
  // or credited "The Weeknd" once and "The Weeknd, Daft Punk" once).
  const seen = new Set<string>(); const out: Cand[] = [];
  for (const c of shuffle([...pool.values()]).sort((a, b) => b.src - a.src)) {
    const t = norm(c.row.title); const keys = credits(c.row).map((a) => `${a}|${t}`);
    if (keys.some((k) => seen.has(k))) continue; keys.forEach((k) => seen.add(k)); out.push(c);
  }
  // What gets rated: up to 150 new and 50 known, best sources first.
  return Object.assign([...out.filter((c) => !c.known).slice(0, 150), ...out.filter((c) => c.known).slice(0, 50)], { missing });
}

const line = (r: Row) => {
  const g = (JSON.parse(r.genres || '[]') as string[]).slice(0, 2).join('/');
  const bits = [r.year, g].filter(Boolean).join(', ');
  return `${r.artist} - ${r.title}${bits ? ` (${bits})` : ''}`;
};

// Pick SIZE: KNOWN_SHARE of them songs they know, the rest new; best fit
// first, fit 6+ unless there is nothing better; at most 2 per artist among
// the new ones and 3 overall (unless the plan is about one or two artists).
export function choose(pool: Cand[], plan: Pick<Plan, 'artists'>) {
  const few = plan.artists.length > 0 && plan.artists.length <= 2;
  const per = new Map<string, number>(); const out: Cand[] = []; const used = new Set<Cand>();
  const room = (c: Cand, cap: number) => credits(c.row).every((a) => (per.get(a) || 0) < cap);
  const take = (c: Cand) => { used.add(c); out.push(c); for (const a of credits(c.row)) per.set(a, (per.get(a) || 0) + 1); };
  const ranked = (known: boolean) => pool.filter((c) => c.known === known).sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0) || b.src - a.src);
  const wantKnown = Math.round(SIZE * KNOWN_SHARE);
  const fill = (list: Cand[], n: number, minFit: number, cap: number) => { for (const c of list) { if (n <= 0) break; if (used.has(c) || (c.fit ?? 0) < minFit || !room(c, cap)) continue; take(c); n--; } };
  const cap = (n: number) => (few ? SIZE : n);
  fill(ranked(true), wantKnown, 6, cap(3));
  fill(ranked(false), SIZE - out.length, 6, cap(2));
  // Not enough good new songs: good known ones, then the best of the rest.
  fill(ranked(true), SIZE - out.length, 6, cap(3));
  fill([...ranked(false), ...ranked(true)].sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0)), SIZE - out.length, 0, cap(3));
  fill([...ranked(false), ...ranked(true)], SIZE - out.length, 0, SIZE);
  return out;
}

// --- progress the dialog can show ---------------------------------------------------
// Each step with a time estimate: how long it took on recent runs (kv
// ai_stage_ms, a moving average), else a first guess. Rating scales with
// the number of 40-song batches. The client shows the checklist, a bar and
// the time left, and counts down between polls.
const GUESS_MS: Record<string, number> = { model: 9000, plan: 18000, find: 4000, rateBatch: 4500, order: 5000, request: 12000 };
type StageKey = 'model' | 'plan' | 'find' | 'rate' | 'order' | 'request';
const LABELS: Record<StageKey, string> = {
  model: 'Starting the model', plan: 'Planning the vibe', find: 'Finding songs in your library',
  rate: 'Checking each song fits', order: 'Putting them in order', request: 'Requesting songs you do not have',
};
export class Progress {
  private est: Record<string, number>;
  private stages: { key: StageKey; label: string; state: 'pending' | 'active' | 'done' | 'skipped'; ms: number; est: number; detail: string | null }[];
  private cur = -1; private t = 0; private frac = 0;
  readonly took: Record<string, number> = {};
  extra: Record<string, unknown> = {};
  constructor(private job: Job, private db: DB | null, modelLoaded: boolean) {
    let saved: Record<string, number> = {};
    try { saved = JSON.parse((db?.prepare("SELECT v FROM kv WHERE k = 'ai_stage_ms'").get() as any)?.v || '{}'); } catch { /* none yet */ }
    this.est = { ...GUESS_MS, ...saved };
    this.stages = (Object.keys(LABELS) as StageKey[]).map((key) => ({ key, label: LABELS[key], state: 'pending', ms: 0, est: key === 'rate' ? this.est.rateBatch * 5 : this.est[key], detail: null }));
    if (modelLoaded) this.skip('model');
    // Re-published every second, so a step running past its estimate moves the
    // time left instead of sitting at zero; stops with the job.
    this.timer = setInterval(() => { if (this.job.state !== 'running') { clearInterval(this.timer); return; } this.publish(); }, 1000);
    this.timer.unref?.();
  }
  private timer: NodeJS.Timeout;
  perBatch() { return this.est.rateBatch; }
  skip(key: StageKey) { const s = this.stages.find((x) => x.key === key)!; if (s.state === 'pending') s.state = 'skipped'; this.publish(); }
  estimate(key: StageKey, ms: number) { this.stages.find((x) => x.key === key)!.est = ms; this.publish(); }
  start(key: StageKey, detail: string | null = null) {
    this.finishCurrent();
    this.cur = this.stages.findIndex((x) => x.key === key); const s = this.stages[this.cur];
    s.state = 'active'; s.detail = detail; this.t = Date.now(); this.frac = 0; this.publish();
  }
  set(frac: number | null, detail?: string | null) { if (frac != null) this.frac = Math.max(0, Math.min(1, frac)); if (detail !== undefined && this.cur >= 0) this.stages[this.cur].detail = detail; this.publish(); }
  private finishCurrent() {
    if (this.cur < 0) return; const s = this.stages[this.cur];
    if (s.state === 'active') { s.state = 'done'; s.ms = Date.now() - this.t; this.took[s.key] = s.ms; }
  }
  // All done: fold this run's timings into the saved averages.
  finish(rateBatches: number) {
    this.finishCurrent(); this.cur = -1; clearInterval(this.timer); this.publish();
    const next = { ...this.est };
    for (const [k, ms] of Object.entries(this.took)) {
      const key = k === 'rate' ? 'rateBatch' : k; const v = k === 'rate' ? ms / Math.max(1, rateBatches) : ms;
      if (k === 'model' && ms > 60000) continue; // a first-time download is not a load
      next[key] = Math.round(next[key] ? next[key] * 0.6 + v * 0.4 : v);
    }
    try { this.db?.prepare("INSERT INTO kv (k, v) VALUES ('ai_stage_ms', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(next)); } catch { /* keep going */ }
  }
  private publish() {
    const live = this.stages.filter((s) => s.state !== 'skipped');
    const now = Date.now();
    let total = 0, doneMs = 0;
    for (const s of live) {
      const est = s.state === 'done' ? s.ms : s.state === 'active' ? Math.max(s.est, now - this.t) : s.est;
      total += est;
      if (s.state === 'done') doneMs += s.ms;
      else if (s.state === 'active') doneMs += Math.max(now - this.t, est * this.frac);
    }
    const left = Math.max(0, total - doneMs);
    const active = this.cur >= 0 ? this.stages[this.cur] : null;
    this.job.step = active ? `${active.label}${active.detail ? `: ${active.detail}` : ''}` : this.job.step;
    this.job.progress = total ? Math.min(0.99, doneMs / total) : null;
    this.job.info = { stages: live.map(({ key, label, state, detail }) => ({ key, label, state, detail })), leftMs: Math.round(left), at: now, ...this.extra };
  }
}

export async function generatePlaylist(db: DB, llm: Llm, uid: string, prompt: string, job: Job, similar?: (a: { id: string; name: string }) => Promise<{ id: string; name: string }[]>,
  requestMissing?: (playlistId: string, songs: { artist: string; title: string }[]) => Promise<number>) {
  const pr = new Progress(job, db, llm.loaded);
  if (!llm.loaded) pr.start('model');
  await llm.ensure((msg, frac) => pr.set(frac ?? null, msg.replace(/^Loading the model onto the GPU$/, 'loading onto the GPU')));
  pr.start('plan', 'reading your listening');
  const taste = tasteOf(db, uid);
  pr.set(null, 'deciding on artists, genres and songs');
  const plan = await llm.json<Plan>([
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: `Listener profile:\n${profileText(taste)}\n\nRequest: ${prompt}` },
  ], PlanSchema, { temperature: 0.6, maxTokens: 3000 });
  pr.extra.title = plan.title; pr.extra.vibe = plan.vibe;
  pr.start('find');
  const pool = await buildPool(db, uid, plan, prompt, similar);
  if (!pool.length) throw new Error('Nothing in the library matched');

  // Every candidate scored for fit, 40 at a time (a list that long is where
  // a small model stops paying attention to each line).
  const CHUNK = 40;
  const batches = Math.ceil(pool.length / CHUNK);
  pr.extra.found = pool.length; pr.extra.foundNew = pool.filter((c) => !c.known).length;
  pr.start('rate', `0 of ${pool.length} songs`);
  pr.estimate('rate', batches * pr.perBatch());
  for (let i = 0; i < pool.length; i += CHUNK) {
    pr.set(i / pool.length, `${i} of ${pool.length} songs`);
    const part = pool.slice(i, i + CHUNK);
    const r = await llm.json<{ scores: number[] }>([
      { role: 'system', content: RATE_SYSTEM },
      { role: 'user', content: `Playlist request: ${prompt}\nVibe: ${plan.vibe}\n\nSongs:\n${part.map((c, j) => `${j + 1}. ${line(c.row)}`).join('\n')}` },
    ], { type: 'object', properties: { scores: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 10 }, minItems: part.length, maxItems: part.length } }, required: ['scores'] },
    { temperature: 0, maxTokens: 400 });
    part.forEach((c, j) => { c.fit = Number(r.scores?.[j]) || 0; });
  }
  const chosen = choose(pool, plan);

  pr.start('order');
  let order: number[] = [];
  try {
    const r = await llm.json<{ order: number[] }>([
      { role: 'system', content: ORDER_SYSTEM },
      { role: 'user', content: `Playlist: ${plan.title}. ${plan.vibe}\n\nSongs:\n${chosen.map((c, j) => `${j + 1}. ${line(c.row)}`).join('\n')}` },
    ], { type: 'object', properties: { order: { type: 'array', items: { type: 'integer', minimum: 1, maximum: chosen.length }, minItems: chosen.length, maxItems: chosen.length } }, required: ['order'] },
    { temperature: 0.3, maxTokens: 300 });
    order = r.order || [];
  } catch { /* keep the fit order */ }
  const seen = new Set<number>(); const tracks: Cand[] = [];
  for (const n of order) if (n >= 1 && n <= chosen.length && !seen.has(n)) { seen.add(n); tracks.push(chosen[n - 1]); }
  chosen.forEach((c, j) => { if (!seen.has(j + 1)) tracks.push(c); });

  const name = (plan.title || 'Generated playlist').replace(/["“”]/g, '').trim().slice(0, 60) || 'Generated playlist';
  const id = playlistId(), now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid, name, now, now);
    tracks.forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t.row.id, now));
  })();
  // Suggestions the library lacks: rated like everything else; only clear
  // fits (8+) are requested, best first.
  let requested = 0, missingFits = 0, requestError: string | null = null;
  if (!requestMissing || !pool.missing.length) pr.skip('request');
  if (requestMissing && pool.missing.length) {
    try {
      const miss = pool.missing.slice(0, 40);
      pr.start('request', `checking ${miss.length} suggestions`);
      const r = await llm.json<{ scores: number[] }>([
        { role: 'system', content: RATE_SYSTEM },
        { role: 'user', content: `Playlist request: ${prompt}\nVibe: ${plan.vibe}\n\nSongs:\n${miss.map((m, j) => `${j + 1}. ${m.artist} - ${m.title}`).join('\n')}` },
      ], { type: 'object', properties: { scores: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 10 }, minItems: miss.length, maxItems: miss.length } }, required: ['scores'] },
      { temperature: 0, maxTokens: 400 });
      const good = miss.map((m, j) => ({ m, fit: Number(r.scores?.[j]) || 0 })).filter((x) => x.fit >= 8).sort((a, b) => b.fit - a.fit).map((x) => x.m)
        .filter(((per) => (m: { artist: string }) => { const k = norm(m.artist); per.set(k, (per.get(k) || 0) + 1); return per.get(k)! <= 2; })(new Map<string, number>()));
      missingFits = good.length;
      pr.set(0.5, good.length ? `looking up ${Math.min(8, good.length)} good fits` : 'none fit well enough');
      requested = await requestMissing(id, good);
    } catch (e: any) { requestError = e.message; }
  }
  pr.finish(batches);
  return { playlistId: id, name, count: tracks.length, poolSize: pool.length, requested, missing: pool.missing.length, missingFits, requestError, known: tracks.filter((t) => t.known).length, tracks: tracks.map((t) => ({ id: t.row.id, fit: t.fit ?? null, known: t.known })) };
}

export function registerAi(app: FastifyInstance, db: DB, opts: AiOptions) {
  const llm = new Llm({ ...opts, log: opts.log ?? ((m) => app.log.info(m)) });
  app.addHook('onClose', async () => llm.stop());
  const auth = { preHandler: (app as any).requireUser };
  const log = (m: string) => app.log.warn(m);
  const similar = (a: { id: string; name: string }) => similarInLibrary(db, a, { log });

  // Songs the model suggested that the library lacks: their releases are
  // requested on Music Requests (Soulseek), remembered in ai_pending, and
  // appended to the playlist by the scan that brings them in.
  const MR = opts.musicRequestsUrl;
  const requestMissing = async (playlistId: string, songs: { artist: string; title: string }[]) => {
    app.log.info(`ai request: ${songs.length} suggested songs to fetch${MR ? '' : ' (no MUSIC_REQUESTS_URL)'}`);
    if (!MR) return 0;
    let n = 0;
    for (const s of songs.slice(0, 8)) {
      try {
        const t = await (await fetch(`${MR}/api/track?${new URLSearchParams({ artist: s.artist, title: s.title })}`, { signal: AbortSignal.timeout(15000) })).json() as any;
        if (!t.release?.album_id) continue;
        const r = await (await fetch(`${MR}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ album_id: t.release.album_id }), signal: AbortSignal.timeout(30000) })).json() as any;
        db.prepare('INSERT OR IGNORE INTO ai_pending (playlist_id, artist, title, release, requested) VALUES (?, ?, ?, ?, ?)').run(playlistId, s.artist, s.title, `${t.release.artist} - ${t.release.title}`, Date.now());
        n++; app.log.info(`ai request: ${s.artist} - ${s.title} -> ${t.release.artist} - ${t.release.title} (${r.status})`);
      } catch (e: any) { log(`ai request ${s.artist} - ${s.title}: ${e.message}`); }
    }
    return n;
  };
  const fillPending = () => {
    db.prepare('DELETE FROM ai_pending WHERE requested < ?').run(Date.now() - 21 * 86400000);
    for (const p of db.prepare('SELECT * FROM ai_pending').all() as any[]) {
      const id = matchTrack(db, { artist: p.artist, title: p.title }); if (!id) continue;
      db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(p.playlist_id, id)) {
          const pos = ((db.prepare('SELECT COALESCE(MAX(pos), -1) m FROM playlist_tracks WHERE playlist_id = ?').get(p.playlist_id) as any).m as number) + 1;
          db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(p.playlist_id, pos, id, Date.now());
          db.prepare('UPDATE playlists SET updated = ? WHERE id = ?').run(Date.now(), p.playlist_id);
        }
        db.prepare('DELETE FROM ai_pending WHERE playlist_id = ? AND artist = ? AND title = ?').run(p.playlist_id, p.artist, p.title);
      })();
      app.log.info(`ai request arrived: ${p.artist} - ${p.title}`);
    }
  };
  (app as any).afterScan?.(fillPending);

  app.get('/api/ai/status', auth, async () => ({ ...llm.available(), loaded: llm.loaded }));
  app.post('/api/ai/playlists', auth, async (req: any, reply) => {
    const b = z.object({ prompt: z.string().trim().min(3).max(1000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Describe the playlist' });
    const av = llm.available(); if (!av.ok) return reply.code(503).send({ error: av.reason });
    const job = startJob(req.user.id, 'ai-playlist', (j) => { j.step = 'Waiting for the model'; return llm.run(() => generatePlaylist(db, llm, req.user.id, b.data.prompt, j, similar, requestMissing)); });
    app.log.info({ uid: req.user.id, prompt: b.data.prompt }, 'ai playlist');
    return jobOut(job);
  });
  return Object.assign(llm, { fillPending });
}
