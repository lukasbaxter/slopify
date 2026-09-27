// Generated playlists: describe a playlist, get 25 songs from this library,
// 20 of them songs the listener has never played and 5 they know.
//
// Claude (Opus 5, through the Anthropic API; ANTHROPIC_API_KEY) does the
// judging:
//   1. plan: request + listener profile -> the vibe in words, artists
//      (mostly ones they do not play), genres, eras; beside it two calls
//      for specific songs (one close to their taste, one beyond it);
//   2. pick: those found in the library, plus Deezer's similar artists that
//      the library has, genres at random (played/liked songs marked known),
//      numbered -> Claude picks 20 new + 5 known in listening order, and
//      which suggested songs the library lacks are worth fetching.
// Whatever it gets wrong (a bad number, the wrong mix) is fixed from the
// pool, so the answer is always 25 real tracks. Suggested songs the library
// lacks are requested on Music Requests and join the playlist when they
// download.
import type { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { DB } from './db.js';
import { playlistId } from './ids.js';
import { matchTrack } from './explore.js';
import { similarInLibrary } from './discover.js';
import { startJob, jobOut, type Job } from './jobs.js';

export type AiOptions = {
  apiKey?: string;
  model: string;
  musicRequestsUrl?: string; // songs it suggests that the library lacks are requested here
  log?: (m: string) => void;
};

const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SIZE = 25;
export const KNOWN_SHARE = 0.2;
// Every artist credited on a track, normalized ("The Weeknd, Daft Punk" -> both).
const credits = (r: { artist: string; artists?: string }) => {
  let a: string[] = []; try { a = JSON.parse(r.artists || '[]'); } catch { /* old row */ }
  return [...new Set((a.length ? a : [r.artist]).map(norm).filter(Boolean))];
};

// --- Claude ---------------------------------------------------------------------
// One structured call: a system prompt, one user message, JSON back in the
// given schema. Low effort (the judgement is easy for Opus, the wait is
// not); a declined request is re-run on Anthropic's default fallback model.
export type Ask = <T>(system: string, user: string, schema: object, maxTokens: number) => Promise<T>;

export function claudeAsk(apiKey: string, model: string, log?: (m: string) => void): Ask {
  const client = new Anthropic({ apiKey });
  return async <T>(system: string, user: string, schema: object, maxTokens: number) => {
    const t0 = Date.now();
    const r = await client.beta.messages.create({
      model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: schema as any } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const u = r.usage as any;
    log?.(`claude ${model}: ${Date.now() - t0} ms, in ${u.input_tokens} (+${u.cache_read_input_tokens || 0} cached), out ${u.output_tokens}, stop ${r.stop_reason}`);
    if (r.stop_reason === 'refusal') throw new Error('Claude declined this request');
    if (r.stop_reason === 'max_tokens') throw new Error('Claude ran out of room for the answer');
    const text = r.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Claude sent no answer');
    return JSON.parse(text.text) as T;
  };
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

// --- plan -> pool -> pick ---------------------------------------------------------
// Schemas in the subset structured outputs accept: every property required,
// no extra properties, no numeric bounds (counts are enforced in code).
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const strs = { type: 'array', items: { type: 'string' } };
const PlanSchema = obj({
  title: { type: 'string' }, vibe: { type: 'string' }, artists: strs, genres: strs,
  playlists: strs, useHistory: { type: 'boolean' },
  yearFrom: { type: 'integer' }, yearTo: { type: 'integer' },
});
const SongsSchema = obj({ songs: { type: 'array', items: obj({ artist: { type: 'string' }, title: { type: 'string' } }) } });
export type Plan = { title: string; vibe: string; artists: string[]; genres: string[]; songs: { artist: string; title: string }[]; playlists: string[]; useHistory: boolean; yearFrom: number | null; yearTo: number | null };

const PLAN_SYSTEM = `You plan playlists for a personal music server. The playlist can only contain songs from the listener's own library, so your plan is used to search that library. Most of the playlist (80%) must be songs the listener has NOT played before: discovery that still fits their taste.
Given the request and the listener's profile, answer with:
- title: a short playlist name (2 to 5 words, no quotes, no emoji).
- vibe: one or two sentences on exactly what the songs should feel like: mood, energy, tempo, setting, and what does NOT belong.
- artists: up to 30 real artists whose music fits the vibe. At most a third from their profile (only ones that truly fit); the rest artists they do not play much but would likely enjoy.
- genres: up to 8 genre names as music libraries tag them (e.g. "R&B", "Hip Hop", "Indie Pop", "House").
- playlists: names of the listener's own playlists (exactly as listed) the request refers to; empty if none.
- useHistory: true only when the request is about their own favourites (e.g. "my favourites", "what I have been playing").
- yearFrom / yearTo: only when the request names an era (e.g. "90s" = 1990 and 1999), otherwise 0.
If the request names artists, include them.`;

// Specific songs come from two calls running beside the plan (three short
// answers at once instead of one long one: Claude's writing speed is the
// wait): one close to what they play, one from artists they do not.
const SONGS_SYSTEM = (angle: string) => `You suggest songs for a playlist on a personal music server. Name up to 20 specific real songs (artist + exact title) that fit the request closely. Never repeat a title. ${angle}
If the request names songs, include them.`;
const SONG_ANGLES = [
  'Use artists from the listener profile, or artists very close to them, favouring deeper cuts over the biggest hits.',
  'Use artists who are NOT in the listener profile but whom this listener would likely enjoy.',
];

const PickSchema = obj({ title: { type: 'string' }, picks: { type: 'array', items: { type: 'integer' } }, request: { type: 'array', items: { type: 'integer' } } });
const PICK_SYSTEM = (known: number) => `You build a playlist from songs the listener owns. Pick exactly ${SIZE} numbers from the Songs list: exactly ${SIZE - known} marked NEW (never played) and exactly ${known} marked KNOWN.
Be strict about the vibe: mood, energy, tempo and setting. A song does not fit just because the artist or genre is related (a hype party song does not belong on a calm playlist, an instrumental does not belong on a sing-along one). Better a less famous song that fits than a famous one that does not.
Unless the request is about one or two artists, use at most 2 songs by the same artist.
Give the picks in listening order: an inviting opener, songs with a similar feel next to each other, energy that flows, a satisfying closer.
"request": numbers from the Missing list (songs the library lacks) that fit the vibe clearly enough to download, best first, at most 8; empty if none fit well.
title: a short playlist name (2 to 5 words, no quotes, no emoji).`;

type Cand = { row: Row; known: boolean; src: number };

// Candidates from everything the plan points at, without favouring what they
// already play: the model's named songs, the planned artists (a random
// spread of their tracks), artists similar to those (Deezer, library only:
// mostly never played), their genres at random, and any playlist of theirs
// the request names. `known` = played or liked before.
// The planned artists that this library has.
function seedArtists(db: DB, names: string[]) {
  const byNorm = new Map((db.prepare('SELECT id, name FROM artists').all() as { id: string; name: string }[]).map((a) => [norm(a.name), a]));
  return names.map((n) => byNorm.get(norm(n))).filter(Boolean) as { id: string; name: string }[];
}

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
  const seeds = seedArtists(db, plan.artists);
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
  // What Claude sees: up to 150 new and 50 known, best sources first.
  return Object.assign([...out.filter((c) => !c.known).slice(0, 150), ...out.filter((c) => c.known).slice(0, 50)], { missing });
}

const line = (r: Row) => {
  const g = (JSON.parse(r.genres || '[]') as string[]).slice(0, 2).join('/');
  const bits = [r.year, g].filter(Boolean).join(', ');
  return `${r.artist} - ${r.title}${bits ? ` (${bits})` : ''}`;
};

// Claude's picks made valid: real numbers, no repeats, the 5/20 mix, at most
// 2 per artist among the new (3 overall) unless the plan is about one or two
// artists; the rest filled from the pool's best sources. Order kept.
export function finalize(pool: Cand[], picks: number[], plan: Pick<Plan, 'artists'>) {
  const few = plan.artists.length > 0 && plan.artists.length <= 2;
  const wantKnown = Math.min(Math.round(SIZE * KNOWN_SHARE), pool.filter((c) => c.known).length);
  const wantNew = SIZE - wantKnown;
  const per = new Map<string, number>(); const out: Cand[] = []; const used = new Set<Cand>();
  let nNew = 0, nKnown = 0;
  const take = (c: Cand | undefined, capNew: number, capAll: number, mix = true) => {
    if (!c || used.has(c) || out.length >= SIZE) return;
    if (mix && (c.known ? nKnown >= wantKnown : nNew >= wantNew)) return;
    const cap = few ? SIZE : c.known ? capAll : capNew;
    if (credits(c.row).some((a) => (per.get(a) || 0) >= cap)) return;
    used.add(c); out.push(c); if (c.known) nKnown++; else nNew++;
    for (const a of credits(c.row)) per.set(a, (per.get(a) || 0) + 1);
  };
  for (const n of picks) take(pool[n - 1], 2, 3);
  for (const c of pool) take(c, 2, 3);
  for (const c of pool) take(c, SIZE, SIZE, false); // a small library: 25 songs beats the exact mix
  return out;
}

// --- progress the dialog can show ---------------------------------------------------
// Each step with a time estimate: how long it took on recent runs (kv
// ai_stage_ms, a moving average), else a first guess. The client shows the
// checklist, a bar and the time left, and counts down between polls.
const GUESS_MS: Record<string, number> = { plan: 12000, find: 3000, pick: 15000 };
type StageKey = 'plan' | 'find' | 'pick';
const LABELS: Record<StageKey, string> = {
  plan: 'Planning the vibe', find: 'Finding songs in your library', pick: 'Picking and ordering 25 songs',
};
export class Progress {
  private est: Record<string, number>;
  private stages: { key: StageKey; label: string; state: 'pending' | 'active' | 'done' | 'skipped'; ms: number; est: number; detail: string | null }[];
  private cur = -1; private t = 0; private frac = 0;
  private timer: NodeJS.Timeout;
  readonly took: Record<string, number> = {};
  extra: Record<string, unknown> = {};
  constructor(private job: Job, private db: DB | null) {
    let saved: Record<string, number> = {};
    try { saved = JSON.parse((db?.prepare("SELECT v FROM kv WHERE k = 'ai_claude_ms'").get() as any)?.v || '{}'); } catch { /* none yet */ }
    this.est = { ...GUESS_MS, ...saved };
    this.stages = (Object.keys(LABELS) as StageKey[]).map((key) => ({ key, label: LABELS[key], state: 'pending', ms: 0, est: this.est[key], detail: null }));
    // Re-published every second, so a step running past its estimate moves the
    // time left instead of sitting at zero; stops with the job.
    this.timer = setInterval(() => { if (this.job.state !== 'running') { clearInterval(this.timer); return; } this.publish(); }, 1000);
    this.timer.unref?.();
    this.publish();
  }
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
  finish() {
    this.finishCurrent(); this.cur = -1; clearInterval(this.timer); this.publish();
    const next = { ...this.est };
    for (const [k, ms] of Object.entries(this.took)) next[k] = Math.round(next[k] ? next[k] * 0.6 + ms * 0.4 : ms);
    try { this.db?.prepare("INSERT INTO kv (k, v) VALUES ('ai_claude_ms', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(next)); } catch { /* keep going */ }
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
    const active = this.cur >= 0 ? this.stages[this.cur] : null;
    if (active) this.job.step = `${active.label}${active.detail ? `: ${active.detail}` : ''}`;
    this.job.progress = total ? Math.min(0.99, doneMs / total) : null;
    this.job.info = { stages: live.map(({ key, label, state, detail }) => ({ key, label, state, detail })), leftMs: Math.round(Math.max(0, total - doneMs)), at: now, ...this.extra };
  }
}

export async function generatePlaylist(db: DB, ask: Ask, uid: string, prompt: string, job: Job, similar?: (a: { id: string; name: string }) => Promise<{ id: string; name: string }[]>,
  requestMissing?: (playlistId: string, songs: { artist: string; title: string }[]) => Promise<number>) {
  const pr = new Progress(job, db);
  pr.start('plan', 'reading your listening');
  const taste = tasteOf(db, uid);
  pr.set(null, 'deciding on artists, genres and songs');
  const user = `Listener profile:\n${profileText(taste)}\n\nRequest: ${prompt}`;
  const songCalls = Promise.all(SONG_ANGLES.map((angle) => ask<{ songs: Plan['songs'] }>(SONGS_SYSTEM(angle), user, SongsSchema, 4000).catch(() => ({ songs: [] as Plan['songs'] }))));
  const raw = await ask<Omit<Plan, 'songs'>>(PLAN_SYSTEM, user, PlanSchema, 4000);
  pr.extra.title = raw.title; pr.extra.vibe = raw.vibe;
  pr.set(null, 'choosing specific songs');
  // Deezer's similar artists for the planned ones, while the song lists are
  // still being written (buildPool then reads them from the cache).
  const warm = similar ? Promise.all(seedArtists(db, raw.artists || []).slice(0, 10).map((a) => similar(a).catch(() => []))) : null;
  const [lists] = await Promise.all([songCalls, warm]);
  const plan: Plan = { ...raw, yearFrom: raw.yearFrom || null, yearTo: raw.yearTo || null, artists: (raw.artists || []).slice(0, 30), songs: lists.flatMap((l) => l.songs || []).slice(0, 40) };

  pr.start('find');
  const pool = await buildPool(db, uid, plan, prompt, similar);
  if (!pool.length) throw new Error('Nothing in the library matched');
  pr.extra.found = pool.length; pr.extra.foundNew = pool.filter((c) => !c.known).length;

  pr.start('pick', `from ${pool.length} songs`);
  const miss = requestMissing ? pool.missing.slice(0, 40) : [];
  const wantKnown = Math.min(Math.round(SIZE * KNOWN_SHARE), pool.filter((c) => c.known).length);
  const pick = await ask<{ title: string; picks: number[]; request: number[] }>(PICK_SYSTEM(wantKnown),
    `Request: ${prompt}\nVibe: ${plan.vibe}\n\nSongs:\n${pool.map((c, j) => `${j + 1}. ${c.known ? 'KNOWN' : 'NEW'} ${line(c.row)}`).join('\n')}`
    + (miss.length ? `\n\nMissing:\n${miss.map((m, j) => `${j + 1}. ${m.artist} - ${m.title}`).join('\n')}` : ''),
    PickSchema, 8000);
  const tracks = finalize(pool, pick.picks || [], plan);

  const name = (pick.title || plan.title || 'Generated playlist').replace(/["“”]/g, '').trim().slice(0, 60) || 'Generated playlist';
  const id = playlistId(), now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid, name, now, now);
    tracks.forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t.row.id, now));
  })();
  // Missing songs it judged worth fetching: requested in the background, 2 per
  // artist at most; the playlist does not wait for Music Requests.
  const per = new Map<string, number>();
  const good = [...new Set(pick.request || [])].map((n) => miss[n - 1]).filter(Boolean)
    .filter((m) => { const k = norm(m.artist); per.set(k, (per.get(k) || 0) + 1); return per.get(k)! <= 2; }).slice(0, 8);
  if (requestMissing && good.length) void requestMissing(id, good).catch(() => 0);
  pr.finish();
  return { playlistId: id, name, count: tracks.length, poolSize: pool.length, requested: good.length, missing: pool.missing.length, known: tracks.filter((t) => t.known).length, tracks: tracks.map((t) => ({ id: t.row.id, known: t.known })) };
}

export function registerAi(app: FastifyInstance, db: DB, opts: AiOptions) {
  const auth = { preHandler: (app as any).requireUser };
  const log = (m: string) => app.log.warn(m);
  const similar = (a: { id: string; name: string }) => similarInLibrary(db, a, { log });
  const ask = opts.apiKey ? claudeAsk(opts.apiKey, opts.model, (m) => app.log.info(m)) : null;

  // Songs the model suggested that the library lacks: their releases are
  // requested on Music Requests (Soulseek), remembered in ai_pending, and
  // appended to the playlist by the scan that brings them in.
  const MR = opts.musicRequestsUrl;
  const requestMissing = async (playlistId: string, songs: { artist: string; title: string }[]) => {
    app.log.info(`ai request: ${songs.length} suggested songs to fetch${MR ? '' : ' (no MUSIC_REQUESTS_URL)'}`);
    if (!MR) return 0;
    let n = 0;
    await Promise.all(songs.slice(0, 8).map(async (s) => {
      try {
        const t = await (await fetch(`${MR}/api/track?${new URLSearchParams({ artist: s.artist, title: s.title })}`, { signal: AbortSignal.timeout(15000) })).json() as any;
        if (!t.release?.album_id) return;
        const r = await (await fetch(`${MR}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ album_id: t.release.album_id }), signal: AbortSignal.timeout(30000) })).json() as any;
        db.prepare('INSERT OR IGNORE INTO ai_pending (playlist_id, artist, title, release, requested) VALUES (?, ?, ?, ?, ?)').run(playlistId, s.artist, s.title, `${t.release.artist} - ${t.release.title}`, Date.now());
        n++; app.log.info(`ai request: ${s.artist} - ${s.title} -> ${t.release.artist} - ${t.release.title} (${r.status})`);
      } catch (e: any) { log(`ai request ${s.artist} - ${s.title}: ${e.message}`); }
    }));
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

  app.get('/api/ai/status', auth, async () => (ask ? { ok: true } : { ok: false, reason: 'Generated playlists need an Anthropic API key on the server (ANTHROPIC_API_KEY).' }));
  app.post('/api/ai/playlists', auth, async (req: any, reply) => {
    const b = z.object({ prompt: z.string().trim().min(3).max(1000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Describe the playlist' });
    if (!ask) return reply.code(503).send({ error: 'Generated playlists need an Anthropic API key on the server (ANTHROPIC_API_KEY).' });
    const job = startJob(req.user.id, 'ai-playlist', (j) => generatePlaylist(db, ask, req.user.id, b.data.prompt, j, similar, requestMissing));
    app.log.info({ uid: req.user.id, prompt: b.data.prompt }, 'ai playlist');
    return jobOut(job);
  });
  return { fillPending };
}
