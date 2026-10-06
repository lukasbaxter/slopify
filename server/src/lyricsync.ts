// Lyrics for one song at a time, on the GPU, when someone asks for them:
// "Sync Lyrics" in a track's menu queues the song, and the Sync lyrics task
// works through the queue. The lyrics exist somewhere; the job is to find
// them and line them up with this recording.
//  1. Lyrics in hand: line them up with the vocals (forced alignment, the
//     words are known and only their timing is searched for).
//  2. None, or plain ones that will not line up: look further - LrcLib
//     (fresh, not its month-old "not found"), NetEase (time-synced), Genius
//     (plain). Each candidate is lined up with the vocals before it is kept,
//     which is also the proof that it is this song; nothing is ever invented.
//
// What is done with an alignment was settled on real songs: the aligner is a
// good referee and a poor author. Plain lyrics take its timing when the song
// aligns confidently; synced lyrics are never rewritten line by line (a
// repeated chorus fools it where the human-made file is right) but are
// VERIFIED, or SHIFTED as a whole when it agrees on a consistent offset - the
// real failure, a file timed to another version or intro.
// Every change lands in lyric_align with the original kept, for undo.
//
// The card is shared (Jellyfin, Immich, the toolbox): GPU power works in
// bursts with the model unloaded between them, and the lower levels wait
// while anything encodes on the GPU.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { parseLrc, type LyricLine } from './lyrics.js';
import { lrclibLookup } from './enrich.js';
import { fromNetease, fromGenius, titleVariants, type Candidate, type Fetch } from './lyricsources.js';
import type { TaskDef, TaskCtx } from './tasks.js';

export type AlignedLine = { start: number | null; end: number | null; prob: number | null };
export type Verdict =
  | { state: 'verified'; shiftMs: 0 }
  | { state: 'corrected'; shiftMs: number; lines: LyricLine[] }
  | { state: 'synced'; lines: LyricLine[] }
  | { state: 'unsure'; reason: string; agree?: number };

const WORD = /[\p{L}\p{N}]/u;
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Synced lyrics: does the existing timing hold up against the vocals?
export function judgeSynced(orig: LyricLine[], aligned: AlignedLine[], score: number): Verdict {
  if (score < 0.5) return { state: 'unsure', reason: `low alignment score ${score.toFixed(2)}` };
  const d: number[] = [];
  orig.forEach((o, i) => { const a = aligned[i]; if (o.start != null && a?.start != null && (a.prob ?? 0) >= 0.6) d.push(a.start - o.start); });
  const worded = orig.filter((l) => WORD.test(l.text)).length;
  if (d.length < Math.max(6, worded * 0.4)) return { state: 'unsure', reason: `only ${d.length} confident lines` };
  const m = median(d);
  const agree = d.filter((x) => Math.abs(x - m) <= 500).length / d.length;
  if (agree < 0.7) return { state: 'unsure', reason: `lines disagree (${Math.round(agree * 100)}% consistent)`, agree };
  if (Math.abs(m) < 400) return { state: 'verified', shiftMs: 0 };
  const shift = Math.round(m / 10) * 10;
  return { state: 'corrected', shiftMs: shift, lines: orig.map((l) => (l.start == null ? l : { ...l, start: Math.max(0, l.start + shift) })) };
}

// Plain lyrics: confident alignment becomes their timing.
export function timePlain(orig: LyricLine[], aligned: AlignedLine[], score: number, durationMs: number): Verdict {
  if (score < 0.5) return { state: 'unsure', reason: `low alignment score ${score.toFixed(2)}` };
  const worded = orig.map((l, i) => (WORD.test(l.text) ? i : -1)).filter((i) => i >= 0);
  const good = worded.filter((i) => (aligned[i]?.prob ?? 0) >= 0.3).length;
  if (!worded.length || good / worded.length < 0.6) return { state: 'unsure', reason: `only ${good} of ${worded.length} lines aligned well` };
  // Keep confident, in-order starts; everything else is placed between them.
  const starts: (number | null)[] = orig.map((_, i) => { const a = aligned[i]; return a?.start != null && (a.prob ?? 0) >= 0.15 ? a.start : null; });
  let last = -1;
  for (let i = 0; i < starts.length; i++) { const s = starts[i]; if (s == null) continue; if (s < last) starts[i] = null; else last = s; }
  const known = starts.map((s, i) => (s == null ? -1 : i)).filter((i) => i >= 0);
  if (!known.length) return { state: 'unsure', reason: 'no usable line starts' };
  const end = Math.max(0, durationMs - 1000);
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] != null) continue;
    const prev = [...known].reverse().find((k) => k < i);
    const next = known.find((k) => k > i);
    if (prev != null && next != null) starts[i] = Math.round(starts[prev]! + ((starts[next]! - starts[prev]!) * (i - prev)) / (next - prev));
    else if (next != null) starts[i] = Math.max(0, starts[next]! - (next - i) * 1500);
    else starts[i] = Math.min(end, starts[prev!]! + (i - prev!) * 2000);
  }
  return { state: 'synced', lines: orig.map((l, i) => ({ start: starts[i], text: l.text })) };
}

export const toLrc = (lines: LyricLine[]) => lines.map((l) => {
  const ms = Math.max(0, l.start ?? 0); const m = Math.floor(ms / 60000); const s = (ms % 60000) / 1000;
  return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]${l.text}`;
}).join('\n') + '\n';

// --- the GPU ----------------------------------------------------------------

export type GpuStatus = { freeMb: number; totalMb: number; encoders: number } | null;
export function gpuStatus(): Promise<GpuStatus> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free,memory.total,encoder.stats.sessionCount', '--format=csv,noheader,nounits'], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const [free, total, enc] = String(out).trim().split('\n')[0].split(',').map((x) => Number(x.trim()));
      resolve(Number.isFinite(free) ? { freeMb: free, totalMb: total, encoders: Number.isFinite(enc) ? enc : 0 } : null);
    });
  });
}

// Bursts of work with rests between them (the model is unloaded while
// resting, so the VRAM really goes back). Light and Normal also stand aside
// while anything encodes on the card - that is Jellyfin or Immich transcoding.
export const POWER = {
  light: { label: 'Light (about a quarter of the time)', workMs: 5 * 60e3, restMs: 15 * 60e3, yieldToEncoders: true },
  normal: { label: 'Normal (about half the time)', workMs: 10 * 60e3, restMs: 10 * 60e3, yieldToEncoders: true },
  high: { label: 'High (about 80% of the time)', workMs: 20 * 60e3, restMs: 5 * 60e3, yieldToEncoders: false },
  full: { label: 'Full GPU', workMs: Infinity, restMs: 0, yieldToEncoders: false },
} as const;
type Power = keyof typeof POWER;
const ALIGN_NEEDS_MB = 3800; // turbo (fp16) + Demucs, measured on a 4060, with headroom
const SQUEEZED_MB = 600;     // free VRAM below this while we hold the model: someone else needs it

class Aligner {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private stderr: string[] = [];
  readonly ready: Promise<any>;
  constructor(python: string, script: string, env: Record<string, string>) {
    this.proc = spawn(python, [script], { env: { ...process.env, ...env, PYTHONUNBUFFERED: '1' } });
    this.proc.stderr.on('data', (b) => { this.stderr.push(String(b)); if (this.stderr.length > 40) this.stderr.shift(); });
    const rl = readline.createInterface({ input: this.proc.stdout });
    let readyResolve!: (v: any) => void;
    // The first load downloads the model (~1.6 GB) into the cache.
    this.ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('the aligner did not start within 15 minutes')), 15 * 60e3);
      readyResolve = (v) => { clearTimeout(t); res(v); };
      this.proc.on('exit', (code) => { clearTimeout(t); rej(new Error(`the aligner exited (${code}): ${this.stderr.join('').trim().split('\n').slice(-3).join(' | ')}`)); });
    });
    this.ready.catch(() => {});
    rl.on('line', (line) => {
      let msg: any; try { msg = JSON.parse(line); } catch { return; }
      if ('ready' in msg) { readyResolve(msg); return; }
      const p = this.pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg);
    });
    this.proc.on('exit', () => { for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'the aligner stopped' }); } this.pending.clear(); });
  }
  request(body: Record<string, unknown>, timeoutMs = 5 * 60e3): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'timed out' }); this.close(); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(JSON.stringify({ id, ...body }) + '\n');
    });
  }
  close() { try { this.proc.stdin.end(); this.proc.kill('SIGTERM'); } catch { /* gone */ } }
}


// --- the queue and the task ---------------------------------------------------

export type LyricSyncOptions = {
  db: DB; cacheDir: string; saveToLibrary: boolean;
  python: string; script: string; model: string;
  gpu?: () => Promise<GpuStatus>;               // injectable for tests
  lrclib?: Parameters<typeof lrclibLookup>[1]; // injectable for tests
  web?: Fetch;                                  // NetEase / Genius, injectable for tests
  pollMs?: number;                              // how often a paused run looks again
  gpuWaitMs?: number;                           // the longest a song waits for the card
};
// Waiting for the card has an end: past it the waiting songs are answered
// ("the GPU was busy") and the run stops, instead of waiting forever.
const GPU_WAIT_MS = 30 * 60e3;
class GpuBusy extends Error {}
type Outcome = { ok: boolean; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const secs = (ms: number) => `${(Math.abs(ms) / 1000).toFixed(1).replace(/\.0$/, '')} s`;
const SOURCE_NAME: Record<string, string> = { lrclib: 'LrcLib', netease: 'NetEase', genius: 'Genius' };

export function lyricSyncTask(app: FastifyInstance, o: LyricSyncOptions): TaskDef {
  const db = o.db;
  const gpu = o.gpu ?? gpuStatus;
  const lrclib = o.lrclib ?? ((url: string) => fetch(url, { headers: { 'User-Agent': 'slopify/0.1 (https://github.com/lukasbaxter/slopify)' } }) as any);
  const record = db.prepare(`INSERT INTO lyric_align (track_id, state, score, shift_ms, lang, lyrics_at, original, original_kind, original_source, error, checked_at)
    VALUES (@track_id, @state, @score, @shift_ms, @lang, @lyrics_at, @original, @original_kind, @original_source, @error, @checked_at)
    ON CONFLICT(track_id) DO UPDATE SET state=excluded.state, score=excluded.score, shift_ms=excluded.shift_ms, lang=excluded.lang,
      lyrics_at=excluded.lyrics_at, original=COALESCE(excluded.original, lyric_align.original),
      original_kind=COALESCE(excluded.original_kind, lyric_align.original_kind), original_source=COALESCE(excluded.original_source, lyric_align.original_source),
      error=excluded.error, checked_at=excluded.checked_at`);
  const lyricsOf = (id: string) => db.prepare('SELECT kind, lines, source, fetched_at FROM lyrics WHERE track_id = ?').get(id) as any;

  // New timing goes beside the song too (the scanner reads that .lrc). A
  // sidecar that came with the music is kept once as <name>.orig.lrc.
  const writeSidecar = async (audio: string, lines: LyricLine[], originalSource: string | null) => {
    if (!o.saveToLibrary) return;
    const lrc = audio.replace(/\.[^.]+$/, '.lrc');
    const orig = audio.replace(/\.[^.]+$/, '.orig.lrc');
    try {
      if (originalSource === 'sidecar' && fs.existsSync(lrc) && !fs.existsSync(orig)) await fsp.copyFile(lrc, orig);
      const tmp = path.join(path.dirname(lrc), `.slopify-${path.basename(lrc)}.tmp`);
      await fsp.writeFile(tmp, toLrc(lines));
      await fsp.rename(tmp, lrc);
    } catch (e: any) { app.log.warn(`lyricsync sidecar ${lrc}: ${e.message}`); }
  };
  // Put new lyrics in place, keeping what was there (or nothing) for undo.
  const replace = (id: string, prev: any, next: LyricLine[], source: string, state: string, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, 'synced', ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET kind = 'synced', lines = excluded.lines, source = excluded.source, fetched_at = excluded.fetched_at`).run(id, JSON.stringify(next), source, now);
      db.prepare("UPDATE enrich SET lyrics_state = 'done', updated = ? WHERE track_id = ?").run(now, id);
      record.run({ track_id: id, state, score: null, shift_ms: null, lang: null, lyrics_at: now, original: prev?.lines ?? null, original_kind: prev?.kind ?? null, original_source: prev?.source ?? null, error: null, checked_at: now, ...extra });
    })();
  };

  let aligner: Aligner | null = null;
  let mode: string | null = null;
  let burstStart = 0;
  const unload = () => { aligner?.close(); aligner = null; mode = null; };
  // Share the card: rest between bursts, stand aside for encoders (lower
  // power levels) and for anyone short of memory.
  const makeRoom = async (ctx: TaskCtx): Promise<void> => {
    const power = (POWER[ctx.setting<Power>('power')] ? ctx.setting<Power>('power') : 'normal') as Power;
    if (aligner && Date.now() - burstStart > POWER[power].workMs) {
      unload();
      ctx.step(`Resting (${power} GPU power) until ${hhmm(Date.now() + POWER[power].restMs)}`);
      await sleep(POWER[power].restMs);
    }
    const waitFrom = Date.now();
    for (;;) {
      const g = await gpu();
      const encoding = POWER[ctx.setting<Power>('power')]?.yieldToEncoders && g && g.encoders > 0;
      const squeezed = g && (aligner ? g.freeMb < SQUEEZED_MB : g.freeMb < ALIGN_NEEDS_MB);
      if (!encoding && !squeezed) return;
      unload();
      if (Date.now() - waitFrom >= (o.gpuWaitMs ?? GPU_WAIT_MS)) throw new GpuBusy(encoding ? 'the GPU was busy with Jellyfin or Immich' : `the GPU was short of memory (${g!.freeMb} MB free)`);
      ctx.step(encoding ? 'Waiting: the GPU is busy with Jellyfin or Immich' : `Waiting for GPU memory (${g!.freeMb} MB free)`);
      await sleep(o.pollMs ?? 60e3);
    }
  };
  const alignWith = async (ctx: TaskCtx, path_: string, lines: LyricLine[]) => {
    await makeRoom(ctx);
    const isolate = Boolean(ctx.setting('isolate'));
    const key = `align:${isolate ? 1 : 0}`;
    if (!aligner || mode !== key) {
      unload();
      ctx.step('Starting the aligner');
      const a = new Aligner(o.python, o.script, {
        ALIGN_MODEL: o.model, ALIGN_SEPARATE: isolate ? '1' : '0', PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
        XDG_CACHE_HOME: path.join(o.cacheDir, 'models'), TORCH_HOME: path.join(o.cacheDir, 'models', 'torch'),
      });
      const info = await a.ready;
      if (!info.ready) { a.close(); throw new Error(info.error || 'the aligner could not start'); }
      aligner = a; mode = key; burstStart = Date.now();
    }
    ctx.step('Lining the lyrics up with the vocals');
    return aligner!.request({ path: path_, lines: lines.map((l) => l.text) });
  };

  const syncOne = async (ctx: TaskCtx, id: string): Promise<Outcome> => {
    const t = db.prepare('SELECT path, title, artist, artists, album, duration_ms FROM tracks WHERE id = ?').get(id) as any;
    if (!t) return { ok: false, message: 'That song is no longer in the library' };
    const prev = lyricsOf(id);
    const usable = (r: any) => r && r.kind !== 'instrumental' && (JSON.parse(r.lines || '[]') as LyricLine[]).length > 0;
    const artists: string[] = JSON.parse(t.artists || '[]');
    const artist = artists[0] || t.artist;

    // 1. Lyrics in hand: line them up.
    let plainTried = false;
    let otherVersion: { lines: LyricLine[]; res: any } | null = null;
    if (usable(prev)) {
      const lines = JSON.parse(prev.lines) as LyricLine[];
      const res = await alignWith(ctx, t.path, lines);
      const now = Date.now();
      const base = { track_id: id, score: res.score ?? null, shift_ms: null as number | null, lang: res.lang ?? null, lyrics_at: prev.fetched_at, original: null, original_kind: null, original_source: null, error: null as string | null, checked_at: now };
      if (!res.ok) { record.run({ ...base, state: 'failed', error: String(res.error || 'unknown').slice(0, 300) }); return { ok: false, message: `Couldn't line up the lyrics: ${res.error}` }; }
      const v = prev.kind === 'plain' ? timePlain(lines, res.lines, res.score, t.duration_ms) : judgeSynced(lines, res.lines, res.score);
      if (v.state === 'synced') { replace(id, prev, v.lines, 'aligned', 'synced', { score: res.score, lang: res.lang ?? null }); await writeSidecar(t.path, v.lines, prev.source); return { ok: true, message: 'Synced the lyrics' }; }
      if (v.state === 'corrected' && ctx.setting('correct')) {
        replace(id, prev, v.lines, 'aligned', 'corrected', { score: res.score, shift_ms: v.shiftMs, lang: res.lang ?? null });
        await writeSidecar(t.path, v.lines, prev.source);
        return { ok: true, message: `Moved the lyrics ${secs(v.shiftMs)} ${v.shiftMs > 0 ? 'later' : 'earlier'}` };
      }
      if (v.state === 'corrected') { record.run({ ...base, state: 'off', shift_ms: v.shiftMs, error: `off by ${v.shiftMs} ms (fixing is switched off)` }); return { ok: true, message: `The lyrics are ${secs(v.shiftMs)} ${v.shiftMs > 0 ? 'early' : 'late'}; fixing is switched off` }; }
      if (v.state === 'verified') { record.run({ ...base, state: 'verified' }); return { ok: true, message: 'Already in sync' }; }
      record.run({ ...base, state: 'unsure', error: v.reason });
      if (prev.kind === 'plain') plainTried = true; // maybe a synced copy elsewhere will line up
      else {
        // Synced but unsure. Half the lines agreeing is a human-made file the
        // aligner is fooled on (repeated chants): it stays. Almost none
        // agreeing, or lines past the end of the song, is a file timed to
        // another version (Lights "Up We Go": the 5:39 piano version's file on
        // the 2:51 album cut). Look for this version's file, else re-time.
        const lastStart = Math.max(...lines.map((l) => l.start ?? 0));
        const wrongVersion = (res.score ?? 0) >= 0.5 && ((v.agree ?? 1) < 0.3 || lastStart > t.duration_ms + 2000);
        if (!wrongVersion) return { ok: true, message: "Couldn't confirm the timing; left it as it was" };
        otherVersion = { lines, res };
      }
    }

    // 2. Look further, and keep the first copy that lines up with this song.
    const candidates: (() => Promise<Candidate | null>)[] = [];
    if (!usable(prev) || otherVersion) {
      candidates.push(async () => {
        ctx.step('Looking for lyrics on LrcLib');
        for (const [a, title] of [...new Set([artist, t.artist])].flatMap((x) => titleVariants(t.title).map((v) => [x, v] as const))) {
          const rec = await lrclibLookup(db, lrclib, { title, artist: a, album: t.album, durationMs: t.duration_ms }, { fresh: true }).catch(() => null);
          if (rec && !rec.instrumental) {
            const lines = rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [];
            if (lines.some((l) => l.start != null)) return { source: 'lrclib', kind: 'synced', lines, title: rec.trackName, artist: rec.artistName } as any;
            if (rec.plainLyrics) return { source: 'lrclib', kind: 'plain', lines: rec.plainLyrics.split(/\r?\n/).filter((x) => x.trim()).map((text) => ({ start: null, text })), title: rec.trackName, artist: rec.artistName } as any;
          }
        }
        return null;
      });
    }
    candidates.push(async () => { ctx.step('Looking for lyrics on NetEase'); return fromNetease({ artist, title: t.title, durationMs: t.duration_ms }, o.web).catch(() => null); });
    if (!plainTried && !otherVersion) candidates.push(async () => { ctx.step('Looking for lyrics on Genius'); return fromGenius({ artist, title: t.title }, o.web).catch(() => null); });

    const found: string[] = [];
    for (const next of candidates) {
      const c = await next();
      if (!c) continue;
      found.push(SOURCE_NAME[c.source] || c.source);
      const res = await alignWith(ctx, t.path, c.lines);
      if (!res.ok) continue;
      const from = SOURCE_NAME[c.source] || c.source;
      if (c.kind === 'synced') {
        // A human-timed file for this exact recording: kept when the words are
        // really there (a good score), shifted when it is consistently off.
        if ((res.score ?? 0) < 0.5) continue;
        const v = judgeSynced(c.lines, res.lines, res.score);
        if (otherVersion && v.state === 'unsure') continue; // the same wrong version again
        if (v.state === 'corrected' && ctx.setting('correct')) {
          replace(id, prev, v.lines, 'aligned', 'corrected', { score: res.score, shift_ms: v.shiftMs, lang: res.lang ?? null });
          await writeSidecar(t.path, v.lines, prev?.source ?? null);
          return { ok: true, message: `Found synced lyrics on ${from} and moved them ${secs(v.shiftMs)} ${v.shiftMs > 0 ? 'later' : 'earlier'}` };
        }
        replace(id, prev, c.lines, c.source, 'found', { score: res.score, lang: res.lang ?? null });
        await writeSidecar(t.path, c.lines, prev?.source ?? null);
        return { ok: true, message: `Found synced lyrics on ${from}` };
      }
      const v = timePlain(c.lines, res.lines, res.score, t.duration_ms);
      if (v.state !== 'synced') continue;
      replace(id, prev, v.lines, 'aligned', 'synced', { score: res.score, lang: res.lang ?? null });
      await writeSidecar(t.path, v.lines, prev?.source ?? null);
      return { ok: true, message: `Found lyrics on ${from} and synced them` };
    }
    if (otherVersion) {
      // No copy timed for this version anywhere: the words are right, so time
      // them to this recording from the alignment already made.
      const v = timePlain(otherVersion.lines.map((l) => ({ start: null, text: l.text })), otherVersion.res.lines, otherVersion.res.score, t.duration_ms);
      if (v.state !== 'synced') return { ok: true, message: "These lyrics are timed for another version of the song, and couldn't be re-timed confidently" };
      replace(id, prev, v.lines, 'aligned', 'retimed', { score: otherVersion.res.score, lang: otherVersion.res.lang ?? null });
      await writeSidecar(t.path, v.lines, prev.source);
      return { ok: true, message: 'These lyrics were timed for another version of the song; re-synced them to this one' };
    }
    if (plainTried) return { ok: true, message: "Couldn't line these lyrics up confidently; left them as they were" };
    if (found.length) return { ok: true, message: `Found lyrics on ${found.join(' and ')}, but they don't match this recording` };
    return { ok: true, message: "Couldn't find lyrics for this song anywhere" };
  };

  const run = async (ctx: TaskCtx): Promise<string> => {
    if (!fs.existsSync(o.python) || !fs.existsSync(o.script)) {
      db.prepare("UPDATE lyric_jobs SET state = 'failed', result = ?, step = NULL, finished = ? WHERE state IN ('queued','running')").run('This server cannot sync lyrics (it needs the GPU image)', Date.now());
      return 'needs the GPU image (ghcr.io/lukasbaxter/slopify:gpu) - see the README';
    }
    let done = 0;
    try {
      for (;;) {
        const job = db.prepare(`SELECT j.track_id id, t.artist, t.title FROM lyric_jobs j JOIN tracks t ON t.id = j.track_id WHERE j.state = 'queued' ORDER BY j.requested LIMIT 1`).get() as any;
        if (!job) break;
        db.prepare("UPDATE lyric_jobs SET state = 'running', step = 'Starting' WHERE track_id = ?").run(job.id);
        // Every stage shows twice: on the task's row, and on the song's job
        // (the app shows it to whoever asked).
        const jobCtx: TaskCtx = {
          ...ctx,
          step: (text, progress) => {
            const left = (db.prepare("SELECT COUNT(*) n FROM lyric_jobs WHERE state = 'queued'").get() as any).n;
            ctx.step(`${job.artist} – ${job.title} · ${text}${left ? ` · ${left} more queued` : ''}`, progress);
            db.prepare('UPDATE lyric_jobs SET step = ? WHERE track_id = ?').run(text, job.id);
          },
        };
        let out: Outcome;
        try { out = await syncOne(jobCtx, job.id); }
        catch (e: any) {
          unload();
          if (e instanceof GpuBusy) {
            // Everyone still waiting gets the same answer; nothing is left queued.
            const msg = `Couldn't sync: ${e.message} for ${Math.round((o.gpuWaitMs ?? GPU_WAIT_MS) / 60e3)} minutes. Try again later.`;
            db.prepare("UPDATE lyric_jobs SET state = 'failed', result = ?, step = NULL, finished = ? WHERE state IN ('queued','running')").run(msg, Date.now());
            return `stopped: ${e.message}`;
          }
          out = { ok: false, message: `Couldn't sync: ${e.message}` };
        }
        db.prepare('UPDATE lyric_jobs SET state = ?, result = ?, step = NULL, finished = ? WHERE track_id = ?').run(out.ok ? 'done' : 'failed', out.message, Date.now(), job.id);
        done++;
      }
      return done ? `${done} song${done === 1 ? '' : 's'} synced` : 'Nothing queued: use Sync Lyrics on a song';
    } finally { unload(); }
  };

  return {
    id: 'lyricsync', name: 'Sync lyrics', schedule: { mode: 'off' }, alongside: true,
    description: 'Works through the songs you pick with Sync Lyrics: finds their lyrics (LrcLib, NetEase, Genius) and lines them up with the vocals',
    settings: [
      { key: 'power', label: 'GPU power', type: 'select', default: 'normal',
        help: 'Works in bursts with rests between them. Light and Normal also wait while Jellyfin or Immich is encoding on the card.',
        options: (Object.keys(POWER) as Power[]).map((k) => ({ value: k, label: POWER[k].label })) },
      { key: 'correct', label: 'Fix synced lyrics that are off', type: 'toggle', default: true, help: 'Shifts the whole file when it is consistently early or late. Lines are never rewritten one by one.' },
      { key: 'isolate', label: 'Isolate the vocals first', type: 'toggle', default: true, help: 'Slower, noticeably more accurate on busy mixes.' },
    ],
    run,
  };
}

// Sync Lyrics from a track's menu: queue the song, kick the task, and let the
// client follow its job. Also the admin's totals and the undo.
export function registerLyricSync(app: FastifyInstance, db: DB, o: { saveToLibrary: boolean }) {
  const auth = { preHandler: (app as any).requireUser };
  const admin = { preHandler: (app as any).requireAdmin };
  const kick = () => (app as any).startTask?.('lyricsync');
  // A restart mid-song: that song goes back in line, and the line resumes.
  db.prepare("UPDATE lyric_jobs SET state = 'queued', step = NULL WHERE state = 'running'").run();
  if (process.env.NODE_ENV !== 'test' && (db.prepare("SELECT 1 FROM lyric_jobs WHERE state = 'queued' LIMIT 1").get())) setTimeout(kick, 30e3).unref();

  const ahead = (j: any) => (j.state === 'queued'
    ? (db.prepare("SELECT COUNT(*) n FROM lyric_jobs WHERE (state = 'running') OR (state = 'queued' AND requested < ?)").get(j.requested) as any).n : 0);
  const jobOut = (j: any) => j && ({ trackId: j.track_id, title: j.title ?? null, state: j.state, step: j.step ?? null, ahead: ahead(j), result: j.result ?? null, requested: j.requested, finished: j.finished ?? null });
  const SELECT = 'SELECT j.*, t.title FROM lyric_jobs j LEFT JOIN tracks t ON t.id = j.track_id';
  app.post('/api/lyrics/:id/sync', auth, async (req: any, reply) => {
    const id = String(req.params.id);
    if (!db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id)) return reply.code(404).send({ error: 'no such song' });
    const cur = db.prepare('SELECT * FROM lyric_jobs WHERE track_id = ?').get(id) as any;
    const active = Boolean(cur && (cur.state === 'queued' || cur.state === 'running'));
    if (!active) {
      db.prepare(`INSERT INTO lyric_jobs (track_id, user_id, state, step, result, requested, finished) VALUES (?, ?, 'queued', NULL, NULL, ?, NULL)
        ON CONFLICT(track_id) DO UPDATE SET user_id = excluded.user_id, state = 'queued', step = NULL, result = NULL, requested = excluded.requested, finished = NULL`).run(id, req.user?.id ?? null, Date.now());
    }
    kick();
    return { ...jobOut(db.prepare(`${SELECT} WHERE j.track_id = ?`).get(id)), already: active };
  });
  // ?ids= the jobs a client is following; ?mine=1 this account's unfinished
  // ones (a reloaded app picks them back up).
  app.get('/api/lyrics/sync', auth, async (req: any) => {
    if (req.query?.mine) return { jobs: (db.prepare(`${SELECT} WHERE j.user_id = ? AND j.state IN ('queued','running') ORDER BY j.state = 'running' DESC, j.requested`).all(req.user?.id ?? null) as any[]).map(jobOut) };
    const ids = String(req.query?.ids || '').split(',').filter(Boolean).slice(0, 100);
    if (!ids.length) return { jobs: [] };
    return { jobs: (db.prepare(`${SELECT} WHERE j.track_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[]).map(jobOut) };
  });

  app.get('/api/admin/lyricsync', admin, async () => ({
    states: db.prepare('SELECT state, COUNT(*) n FROM lyric_align GROUP BY state').all(),
    queued: (db.prepare("SELECT COUNT(*) n FROM lyric_jobs WHERE state IN ('queued','running')").get() as any).n,
  }));
  // Everything the aligner changed, put back as it was.
  app.post('/api/admin/lyricsync/undo', admin, async () => {
    const rows = db.prepare(`SELECT a.track_id, a.state, a.original, a.original_kind, a.original_source, t.path, l.lines current
      FROM lyric_align a JOIN tracks t ON t.id = a.track_id LEFT JOIN lyrics l ON l.track_id = a.track_id
      WHERE a.state IN ('synced','corrected','found','retimed')`).all() as any[];
    for (const r of rows) {
      const now = Date.now();
      db.transaction(() => {
        if (r.original != null) db.prepare('UPDATE lyrics SET kind = ?, lines = ?, source = ?, fetched_at = ? WHERE track_id = ?').run(r.original_kind, r.original, r.original_source, now, r.track_id);
        else db.prepare('DELETE FROM lyrics WHERE track_id = ?').run(r.track_id); // found from nothing: back to nothing
        db.prepare("UPDATE lyric_align SET state = 'undone', lyrics_at = ?, checked_at = ? WHERE track_id = ?").run(now, now, r.track_id);
      })();
      if (!o.saveToLibrary) continue;
      const lrc = r.path.replace(/\.[^.]+$/, '.lrc'); const orig = r.path.replace(/\.[^.]+$/, '.orig.lrc');
      try {
        if (fs.existsSync(orig)) await fsp.rename(orig, lrc);
        else if (r.original != null && r.original_kind === 'synced') await fsp.writeFile(lrc, toLrc(JSON.parse(r.original)));
        else if (r.original != null && r.original_kind === 'plain') await fsp.writeFile(lrc, (JSON.parse(r.original) as LyricLine[]).map((l) => l.text).join('\n') + '\n');
        else if (r.current && fs.existsSync(lrc) && fs.readFileSync(lrc, 'utf8') === toLrc(JSON.parse(r.current))) await fsp.rm(lrc); // ours, from nothing
      } catch (e: any) { app.log.warn(`lyricsync undo ${lrc}: ${e.message}`); }
    }
    return { restored: rows.length };
  });
}
