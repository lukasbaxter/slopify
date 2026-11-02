// Generated playlists: describe a playlist, get 25 songs from this library,
// 20 of them songs the listener has never played and 5 they know.
//
// The brain (brain.ts) does it: CLAP compares the words with every song's
// audio, leaning toward this listener's taste, and the closest songs make
// the playlist, with the same new/known mix and per-artist caps as before.
// Nothing leaves the server: no outside AI is asked.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { playlistId } from './ids.js';
import { matchTrack } from './explore.js';
import { startJob, jobOut, type Job } from './jobs.js';
import { brainOn, brainSearch, type SoundHit } from './brain.js';

const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SIZE = 25;
export const KNOWN_SHARE = 0.2;
// Every artist credited on a track, normalized ("The Weeknd, Daft Punk" -> both).
const credits = (r: { artist: string; artists?: string }) => {
  let a: string[] = []; try { a = JSON.parse(r.artists || '[]'); } catch { /* old row */ }
  return [...new Set((a.length ? a : [r.artist]).map(norm).filter(Boolean))];
};

type Row = { id: string; title: string; artist: string; artists: string; artist_ids: string; album: string; year: number | null; genres: string };

// --- plan -> pool -> pick ---------------------------------------------------------
export type Plan = { title: string; vibe: string; artists: string[]; genres: string[]; songs: { artist: string; title: string }[]; playlists: string[]; useHistory: boolean; yearFrom: number | null; yearTo: number | null };

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

export async function buildPool(db: DB, uid: string, plan: Plan, prompt = '', similar?: (a: { id: string; name: string }) => Promise<{ id: string; name: string }[]>, sound: SoundHit[] = []) {
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

  // 4b. songs that sound like the request (the brain: CLAP compares the
  // words with each song's audio, leaning toward this listener's taste)
  for (const h of sound) add(byId.get(h.id) as Row, 2);

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
  // Up to 150 new and 50 known, best sources first.
  return Object.assign([...out.filter((c) => !c.known).slice(0, 150), ...out.filter((c) => c.known).slice(0, 50)], { missing });
}

// The picks made valid: real numbers, no repeats, the 5/20 mix, at most
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
  skip(key: StageKey) { const s = this.stages.find((x) => x.key === key); if (s && s.state === 'pending') { s.state = 'skipped'; this.publish(); } }
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

export type Search = (text: string, n: number) => Promise<SoundHit[]>;
// A new playlist, or (Regenerate) new songs in one the person already has:
// same id, cover and place in their library; the name too, unless it is
// still the one the last generation gave it. Songs the last one sent for
// stop being added to it.
export function savePlaylist(db: DB, uid: string, name: string, trackIds: string[], prompt: string, into?: string) {
  const now = Date.now();
  if (into) {
    const p = db.prepare('SELECT name, ai_name FROM playlists WHERE id = ? AND user_id = ?').get(into, uid) as { name: string; ai_name: string | null } | undefined;
    if (!p) throw new Error('That playlist is gone');
    const keepName = p.ai_name != null && p.name !== p.ai_name;
    db.transaction(() => {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(into);
      db.prepare('DELETE FROM ai_pending WHERE playlist_id = ?').run(into);
      trackIds.forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(into, i, t, now));
      db.prepare('UPDATE playlists SET name = ?, ai_name = ?, ai_prompt = ?, updated = ? WHERE id = ?').run(keepName ? p.name : name, name, prompt, now, into);
    })();
    return { id: into, name: keepName ? p.name : name };
  }
  const id = playlistId();
  db.transaction(() => {
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated, ai_prompt, ai_name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, uid, name, now, now, prompt, name);
    trackIds.forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t, now));
  })();
  return { id, name };
}

// Songs that sound like the request, leaning toward the listener's taste,
// in that order, 20 new / 5 known, the request itself as the name.
export async function soundPlaylist(db: DB, search: Search, uid: string, prompt: string, job: Job, into?: string) {
  const pr = new Progress(job, db);
  pr.skip('plan');
  pr.start('find', 'listening for songs that sound like it');
  const sound = await search(prompt, 300);
  const plan: Plan = { title: '', vibe: prompt, artists: [], genres: [], songs: [], playlists: [], useHistory: false, yearFrom: null, yearTo: null };
  const pool = await buildPool(db, uid, plan, prompt, undefined, sound);
  if (!pool.length) throw new Error('Nothing in the library sounds like that yet');
  pr.extra.found = pool.length; pr.extra.foundNew = pool.filter((c) => !c.known).length; pr.extra.bySound = sound.length;
  pr.start('pick', `from ${pool.length} songs`);
  const rank = new Map(sound.map((h, i) => [h.id, i]));
  const picks = pool.map((c, i) => [i + 1, rank.get(c.row.id) ?? 1e9] as const).sort((a, b) => a[1] - b[1]).map(([n]) => n);
  const tracks = finalize(pool, picks, plan);
  const saved = savePlaylist(db, uid, (prompt.charAt(0).toUpperCase() + prompt.slice(1)).replace(/["“”]/g, '').trim().slice(0, 60) || 'Generated playlist', tracks.map((t) => t.row.id), prompt, into);
  const id = saved.id, name = saved.name;
  pr.finish();
  return { playlistId: id, name, regenerated: !!into, count: tracks.length, poolSize: pool.length, requested: 0, missing: 0, known: tracks.filter((t) => t.known).length, tracks: tracks.map((t) => ({ id: t.row.id, known: t.known })), by: 'brain' };
}

export function registerAi(app: FastifyInstance, db: DB) {
  const auth = { preHandler: (app as any).requireUser };
  // Songs an earlier (Claude) playlist sent for still join it when they
  // download; nothing new is sent for.
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

  const searchFor = (uid: string): Search => (text, n) => brainSearch(db, { user: uid, text, n }, { log: (m) => app.log.info(m) });
  const NEED = 'Generated playlists need the brain (BRAIN_KEY) on the server.';
  app.get('/api/ai/status', auth, async () => (brainOn(db) ? { ok: true, by: 'brain' } : { ok: false, reason: NEED }));
  app.post('/api/ai/playlists', auth, async (req: any, reply) => {
    const b = z.object({ prompt: z.string().trim().min(3).max(1000), playlistId: z.string().max(64).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Describe the playlist' });
    // Regenerate: new songs in this playlist, not a new one.
    const into = b.data.playlistId;
    if (into && !db.prepare('SELECT 1 FROM playlists WHERE id = ? AND user_id = ?').get(into, req.user.id)) return reply.code(404).send({ error: 'no such playlist' });
    if (!brainOn(db)) return reply.code(503).send({ error: NEED });
    const job = startJob(req.user.id, 'ai-playlist', (j) => soundPlaylist(db, searchFor(req.user.id), req.user.id, b.data.prompt, j, into));
    app.log.info({ uid: req.user.id, prompt: b.data.prompt }, 'ai playlist');
    return jobOut(job);
  });
  return { fillPending };
}
