// Lyrics lined up with the vocals, on the GPU. The "Sync lyrics" task feeds
// each song and its lyric lines to aligner/align.py (Whisper, with Demucs
// isolating the vocals first) which finds when each known line is sung -
// forced alignment, so nothing is transcribed and nothing is invented.
//
// What is done with the answer was settled on real songs: the aligner is a
// good referee and a poor author.
//  - Plain lyrics get its timing when the song aligns confidently; single
//    low-confidence lines are placed between their confident neighbours.
//  - Synced lyrics are never rewritten line by line (a repeated chorus
//    fools the aligner, where the human-made file is right). They are
//    VERIFIED when the aligner agrees, and SHIFTED as a whole when it agrees
//    on a consistent offset - the real-world failure, a file timed to
//    another version or intro. Anything inconsistent is left alone.
// Every decision lands in lyric_align with the original kept for undo.
//
// The card is shared (Jellyfin, Immich, the toolbox): the power setting
// works in bursts with rests between them, unloads the model while resting,
// and the lower levels pause outright while anything is encoding on the GPU.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import type { LyricLine } from './lyrics.js';
import type { TaskDef, TaskCtx } from './tasks.js';

export type AlignedLine = { start: number | null; end: number | null; prob: number | null };
export type Verdict =
  | { state: 'verified'; shiftMs: 0 }
  | { state: 'corrected'; shiftMs: number; lines: LyricLine[] }
  | { state: 'synced'; lines: LyricLine[] }
  | { state: 'unsure'; reason: string };

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
  if (agree < 0.7) return { state: 'unsure', reason: `lines disagree (${Math.round(agree * 100)}% consistent)` };
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
const NEEDS_MB = 4600;   // measured peak for turbo + Demucs on a 4060, with headroom
const SQUEEZED_MB = 600; // free VRAM below this while we hold the model: someone else needs it

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

// --- the task ---------------------------------------------------------------

export type LyricSyncOptions = {
  db: DB; cacheDir: string; saveToLibrary: boolean;
  python: string; script: string; model: string;
  gpu?: () => Promise<GpuStatus>; // injectable for tests
  pollMs?: number;                 // how often a paused run looks again
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

export function lyricSyncTask(app: FastifyInstance, o: LyricSyncOptions): TaskDef {
  const db = o.db;
  const gpu = o.gpu ?? gpuStatus;
  const record = db.prepare(`INSERT INTO lyric_align (track_id, state, score, shift_ms, lang, lyrics_at, original, original_kind, original_source, error, checked_at)
    VALUES (@track_id, @state, @score, @shift_ms, @lang, @lyrics_at, @original, @original_kind, @original_source, @error, @checked_at)
    ON CONFLICT(track_id) DO UPDATE SET state=excluded.state, score=excluded.score, shift_ms=excluded.shift_ms, lang=excluded.lang,
      lyrics_at=excluded.lyrics_at, original=COALESCE(excluded.original, lyric_align.original),
      original_kind=COALESCE(excluded.original_kind, lyric_align.original_kind), original_source=COALESCE(excluded.original_source, lyric_align.original_source),
      error=excluded.error, checked_at=excluded.checked_at`);

  // The new lines go beside the song too (the scanner reads that .lrc). A
  // sidecar that came with the music is kept once as <name>.orig.lrc.
  const writeSidecar = async (audio: string, lines: LyricLine[], originalSource: string) => {
    const lrc = audio.replace(/\.[^.]+$/, '.lrc');
    const orig = audio.replace(/\.[^.]+$/, '.orig.lrc');
    try {
      if (originalSource === 'sidecar' && fs.existsSync(lrc) && !fs.existsSync(orig)) await fsp.copyFile(lrc, orig);
      const tmp = path.join(path.dirname(lrc), `.slopify-${path.basename(lrc)}.tmp`);
      await fsp.writeFile(tmp, toLrc(lines));
      await fsp.rename(tmp, lrc);
    } catch (e: any) { app.log.warn(`lyricsync sidecar ${lrc}: ${e.message}`); }
  };

  const run = async (ctx: TaskCtx): Promise<string> => {
    if (!fs.existsSync(o.python) || !fs.existsSync(o.script)) return 'needs the GPU image (ghcr.io/lukasbaxter/slopify:gpu) - see the README';
    const kinds = [ctx.setting('plain') && 'plain', ctx.setting('verify') && 'synced'].filter(Boolean) as string[];
    if (!kinds.length) return 'nothing to do: both plain and synced lyrics are switched off';
    const ids = (db.prepare(`SELECT l.track_id id FROM lyrics l JOIN tracks t ON t.id = l.track_id
        LEFT JOIN lyric_align a ON a.track_id = l.track_id
        LEFT JOIN (SELECT track_id, COUNT(*) n FROM plays GROUP BY track_id) p ON p.track_id = l.track_id
        WHERE l.kind IN (${kinds.map(() => '?').join(',')})
          AND (a.track_id IS NULL OR a.lyrics_at != l.fetched_at OR (a.state = 'failed' AND a.checked_at < ?) OR (a.state = 'off' AND ?))
        ORDER BY CASE l.kind WHEN 'plain' THEN 0 ELSE 1 END, COALESCE(p.n, 0) DESC, t.added_at DESC`)
      .all(...kinds, Date.now() - 30 * 86400e3, ctx.setting('correct') ? 1 : 0) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return 'every song with lyrics has been checked';

    const deadline = Date.now() + ctx.setting<number>('maxMinutes') * 60e3;
    const tally = { synced: 0, verified: 0, corrected: 0, unsure: 0, failed: 0 };
    const summary = (why: string) => `${why}: ${tally.synced} timed, ${tally.verified} verified, ${tally.corrected} corrected, ${tally.unsure} unsure, ${tally.failed} failed (${ids.length - done} still to check)`;
    let aligner: Aligner | null = null;
    let isolate: boolean | null = null;
    let burstStart = 0;
    let done = 0;
    const unload = () => { aligner?.close(); aligner = null; };
    try {
      for (const id of ids) {
        if (Date.now() > deadline) return summary('Stopped at the time limit');
        const power = (POWER[ctx.setting<Power>('power')] ? ctx.setting<Power>('power') : 'normal') as Power;
        const p = POWER[power];
        // Rest between bursts, with the model unloaded.
        if (aligner && Date.now() - burstStart > p.workMs) {
          unload();
          ctx.step(`Resting (${power} power) until ${hhmm(Date.now() + p.restMs)}`, done / ids.length);
          await sleep(p.restMs);
        }
        // Share the card: stand aside for encoders (lower levels) and for anyone short of memory.
        for (let waited = 0; ; waited++) {
          const g = await gpu();
          const encoding = POWER[ctx.setting<Power>('power')]?.yieldToEncoders && g && g.encoders > 0;
          const squeezed = g && (aligner ? g.freeMb < SQUEEZED_MB : g.freeMb < NEEDS_MB);
          if (!encoding && !squeezed) break;
          if (Date.now() > deadline) return summary('Stopped at the time limit');
          unload();
          ctx.step(encoding ? 'Paused: the GPU is encoding video (Jellyfin or Immich)' : `Paused: the GPU is busy (${g!.freeMb} MB free)`, done / ids.length);
          await sleep(o.pollMs ?? 60e3);
        }
        const wantIsolate = Boolean(ctx.setting('isolate'));
        if (aligner && isolate !== wantIsolate) unload();
        if (!aligner) {
          ctx.step('Loading the aligner', done / ids.length);
          const a = new Aligner(o.python, o.script, {
            ALIGN_MODEL: o.model, ALIGN_SEPARATE: wantIsolate ? '1' : '0',
            XDG_CACHE_HOME: path.join(o.cacheDir, 'models'), TORCH_HOME: path.join(o.cacheDir, 'models', 'torch'),
          });
          const info = await a.ready;
          if (!info.ready) { a.close(); throw new Error(info.error || 'the aligner could not start'); }
          aligner = a; isolate = wantIsolate; burstStart = Date.now();
        }

        const row = db.prepare('SELECT t.path, t.title, t.artist, t.duration_ms, l.kind, l.lines, l.source, l.fetched_at FROM tracks t JOIN lyrics l ON l.track_id = t.id WHERE t.id = ?').get(id) as any;
        done++;
        if (!row) continue;
        ctx.step(`${row.artist} – ${row.title} · ${done.toLocaleString()} of ${ids.length.toLocaleString()}`, (done - 1) / ids.length);
        const lines = JSON.parse(row.lines) as LyricLine[];
        const res = await aligner.request({ path: row.path, lines: lines.map((l) => l.text) });
        const now = Date.now();
        const base = { track_id: id, score: res.score ?? null, shift_ms: null as number | null, lang: res.lang ?? null, lyrics_at: row.fetched_at, original: null as string | null, original_kind: null as string | null, original_source: null as string | null, error: null as string | null, checked_at: now };
        if (!res.ok) { tally.failed++; record.run({ ...base, state: 'failed', error: String(res.error || 'unknown').slice(0, 300) }); continue; }
        const v = row.kind === 'plain' ? timePlain(lines, res.lines, res.score, row.duration_ms) : judgeSynced(lines, res.lines, res.score);
        const change = v.state === 'synced' || (v.state === 'corrected' && ctx.setting('correct'));
        if (v.state === 'corrected' && !ctx.setting('correct')) { tally.unsure++; record.run({ ...base, state: 'off', shift_ms: v.shiftMs, error: `off by ${v.shiftMs} ms (fixing is switched off)` }); continue; }
        if (change) {
          const next = (v as any).lines as LyricLine[];
          db.transaction(() => {
            db.prepare("UPDATE lyrics SET kind = 'synced', lines = ?, source = 'aligned', fetched_at = ? WHERE track_id = ?").run(JSON.stringify(next), now, id);
            record.run({ ...base, state: v.state, shift_ms: v.state === 'corrected' ? v.shiftMs : null, lyrics_at: now, original: row.lines, original_kind: row.kind, original_source: row.source });
          })();
          if (o.saveToLibrary) await writeSidecar(row.path, next, row.source);
          tally[v.state as 'synced' | 'corrected']++;
        } else {
          tally[v.state as 'verified' | 'unsure']++;
          record.run({ ...base, state: v.state, error: v.state === 'unsure' ? v.reason : null });
        }
      }
      return summary('Done');
    } finally { unload(); }
  };

  return {
    id: 'lyricsync', name: 'Sync lyrics', schedule: { mode: 'daily', at: '01:00' },
    description: 'Lines lyrics up with the vocals on the GPU: times plain lyrics, checks synced ones and fixes the ones that are off',
    settings: [
      { key: 'power', label: 'GPU power', type: 'select', default: 'normal',
        help: 'Works in bursts with rests between them. Light and Normal also pause while Jellyfin or Immich is encoding on the card.',
        options: (Object.keys(POWER) as Power[]).map((k) => ({ value: k, label: POWER[k].label })) },
      { key: 'plain', label: 'Add timing to plain lyrics', type: 'toggle', default: true },
      { key: 'verify', label: 'Check synced lyrics', type: 'toggle', default: true },
      { key: 'correct', label: 'Fix synced lyrics that are off', type: 'toggle', default: true, help: 'Shifts the whole file when it is consistently early or late. Lines are never rewritten one by one.' },
      { key: 'isolate', label: 'Isolate the vocals first', type: 'toggle', default: true, help: 'Slower, noticeably more accurate on busy mixes.' },
      { key: 'maxMinutes', label: 'Stop after', type: 'number', min: 10, max: 720, unit: 'min', default: 360 },
    ],
    run,
  };
}

// Everything the aligner changed, put back as it was.
export function registerLyricSyncAdmin(app: FastifyInstance, db: DB, o: { saveToLibrary: boolean }) {
  const admin = { preHandler: (app as any).requireAdmin };
  app.get('/api/admin/lyricsync', admin, async () => ({
    states: db.prepare('SELECT state, COUNT(*) n FROM lyric_align GROUP BY state').all(),
    pending: (db.prepare(`SELECT COUNT(*) n FROM lyrics l LEFT JOIN lyric_align a ON a.track_id = l.track_id WHERE l.kind IN ('plain','synced') AND (a.track_id IS NULL OR a.lyrics_at != l.fetched_at)`).get() as any).n,
  }));
  app.post('/api/admin/lyricsync/undo', admin, async () => {
    const rows = db.prepare(`SELECT a.track_id, a.original, a.original_kind, a.original_source, t.path FROM lyric_align a JOIN tracks t ON t.id = a.track_id WHERE a.state IN ('synced','corrected') AND a.original IS NOT NULL`).all() as any[];
    for (const r of rows) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare('UPDATE lyrics SET kind = ?, lines = ?, source = ?, fetched_at = ? WHERE track_id = ?').run(r.original_kind, r.original, r.original_source, now, r.track_id);
        db.prepare("UPDATE lyric_align SET state = 'undone', lyrics_at = ?, checked_at = ? WHERE track_id = ?").run(now, now, r.track_id);
      })();
      if (o.saveToLibrary) {
        const lrc = r.path.replace(/\.[^.]+$/, '.lrc'); const orig = r.path.replace(/\.[^.]+$/, '.orig.lrc');
        try {
          if (fs.existsSync(orig)) await fsp.rename(orig, lrc);
          else if (r.original_kind === 'synced') await fsp.writeFile(lrc, toLrc(JSON.parse(r.original)));
          else await fsp.writeFile(lrc, (JSON.parse(r.original) as LyricLine[]).map((l) => l.text).join('\n') + '\n');
        } catch (e: any) { app.log.warn(`lyricsync undo ${lrc}: ${e.message}`); }
      }
    }
    return { restored: rows.length };
  });
}
