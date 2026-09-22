// Streaming: the original file with byte ranges (lossless, seekable, what
// speakers and the desktop want) and HLS transcodes (AAC, 4 s segments) made
// by one ffmpeg per (track, profile) into /data/transcodes and reused by
// everyone after. The playlist is written as an EVENT playlist while ffmpeg
// runs and closed with ENDLIST when done.
//
// The first playlist answer waits for a few segments rather than one: an
// open playlist is "live" to iOS, which will not start within three target
// durations of its end and re-polls it only once per target duration, so a
// one-segment answer meant 4 s of audio and then a 4 s wait. Four segments
// (~200 ms more, AAC encodes at ~55x) give it runway, and by its first
// re-poll the whole track is done. Upcoming tracks are warmed in the
// background (the session tells us the queue), a nightly job pre-transcodes
// the hot set (likes, playlists, recent plays), and the cache is trimmed by
// age above a size cap.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { z } from 'zod';

export const PROFILES: Record<string, { bitrate: string }> = { 'aac-320': { bitrate: '320k' }, 'aac-160': { bitrate: '160k' }, 'aac-96': { bitrate: '96k' } };
const MIME: Record<string, string> = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape', '.wv': 'audio/x-wavpack' };

const running = new Map<string, Promise<void>>(); // key -> startable (RUNWAY segments or done)
const finishing = new Map<string, Promise<void>>(); // key -> ffmpeg exited (what a warm slot waits for)
const RUNWAY = 4;          // segments in the first playlist answer (16 s > three 4 s target durations)
const RUNWAY_WAIT = 1500;  // ms cap on waiting for them
const CACHE_CAP_GB = 60;   // /data/transcodes, oldest-used dirs go first

function transcodeDir(dataDir: string, id: string, profile: string) { return path.join(dataDir, 'transcodes', id, profile); }
const segmentCount = (txt: string) => (txt.match(/^s\d+\.ts\s*$/gm) || []).length;

// Starts (or joins) the transcode and resolves once the playlist is startable.
// `nice` runs ffmpeg at low priority: warms must never slow a foreground start.
async function ensureHls(dataDir: string, id: string, file: string, profile: string, log: (m: string) => void, nice = false): Promise<string> {
  const dir = transcodeDir(dataDir, id, profile);
  const index = path.join(dir, 'index.m3u8');
  const done = path.join(dir, 'done');
  if (fs.existsSync(done)) return index;
  const key = `${id}:${profile}`;
  if (!running.has(key)) {
    const p = (async () => {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      const args = ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', PROFILES[profile].bitrate, '-ac', '2',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file+independent_segments', '-hls_segment_filename', path.join(dir, 's%04d.ts'), index];
      const ff = nice ? spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }) : spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err += d; });
      const exit = new Promise<void>((resolve, reject) => { ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 300)}`)))); ff.on('error', reject); });
      let finished = false;
      finishing.set(key, exit.then(() => { finished = true; return fsp.writeFile(done, '1'); }).catch((e) => { finished = true; log(`hls ${key}: ${e.message}`); }).finally(() => { running.delete(key); finishing.delete(key); }));
      const t0 = Date.now();
      let first = 0;
      while (Date.now() - t0 < 30000) {
        if (finished) { if (ff.exitCode === 0) return; throw new Error('transcode failed'); }
        try {
          const n = segmentCount(await fsp.readFile(index, 'utf8'));
          if (n && !first) first = Date.now();
          if (n >= RUNWAY || (first && Date.now() - first > RUNWAY_WAIT)) return;
        } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('transcode did not start');
    })();
    running.set(key, p);
  }
  await running.get(key)!;
  return index;
}

// --- background warming -------------------------------------------------------
// A small queue of (track, profile) pairs transcoded at low priority, two at a
// time; foreground playlist requests never wait on it (they call ensureHls
// directly and simply join a warm already running for the same key).
const WARM_CONCURRENCY = 2;
const warmQueue: { id: string; profile: string }[] = [];
let warmActive = 0;
function pumpWarm(dataDir: string, trackFile: (id: string) => string | undefined, log: (m: string) => void) {
  while (warmActive < WARM_CONCURRENCY && warmQueue.length) {
    const { id, profile } = warmQueue.shift()!;
    const file = trackFile(id);
    if (!file || !fs.existsSync(file) || fs.existsSync(path.join(transcodeDir(dataDir, id, profile), 'done'))) continue;
    warmActive++;
    // The slot is held until ffmpeg exits, not just until the track is startable.
    ensureHls(dataDir, id, file, profile, log, true).then(() => finishing.get(`${id}:${profile}`)).catch((e) => log(`warm ${id}:${profile}: ${e.message}`))
      .finally(() => { warmActive--; pumpWarm(dataDir, trackFile, log); });
  }
}

export function registerStream(app: FastifyInstance, db: DB, dataDir: string) {
  const auth = { preHandler: (app as any).requireUser };
  const trackFile = (id: string) => (db.prepare('SELECT path FROM tracks WHERE id = ?').get(id) as any)?.path as string | undefined;
  const log = (m: string) => app.log.warn(m);
  // The profile each account last streamed at: what its upcoming tracks are warmed in.
  const lastProfile = new Map<string, string>();
  const warm = (uid: string | null, ids: string[], profile?: string) => {
    const prof = profile && PROFILES[profile] ? profile : (uid && lastProfile.get(uid)) || 'aac-320';
    for (const id of ids.slice(0, 10)) {
      if (typeof id !== 'string' || warmQueue.some((w) => w.id === id && w.profile === prof)) continue;
      if (running.has(`${id}:${prof}`) || fs.existsSync(path.join(transcodeDir(dataDir, id, prof), 'done'))) continue;
      warmQueue.push({ id, profile: prof });
    }
    pumpWarm(dataDir, trackFile, log);
  };
  app.decorate('warmTracks', warm);

  // Original file, byte ranges honoured by @fastify/static-free code (ranges by hand: it is 20 lines).
  app.get('/api/stream/:id', auth, async (req, reply) => {
    const id = (req.params as any).id as string;
    const file = trackFile(id);
    if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: 'no such track' });
    const st = fs.statSync(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    reply.header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, max-age=3600').type(type);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : st.size - 1;
      if (!range[1] && range[2]) { start = st.size - Number(range[2]); end = st.size - 1; }
      // BluOS asks for bytes=N-SIZE (one past the end) when it seeks; RFC 9110
      // says to clamp, and a 416 here killed every seek on the Node.
      end = Math.min(end, st.size - 1);
      if (start >= st.size || start > end) return reply.code(416).header('Content-Range', `bytes */${st.size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${st.size}`).header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(file, { start, end }));
    }
    reply.header('Content-Length', st.size);
    return reply.send(fs.createReadStream(file));
  });

  // One progressive transcode, started at `startAt` seconds: what a browser
  // without HLS plays at a reduced quality (it seeks by asking for a new
  // stream), and what the visualizer decodes on a device that is mirroring.
  app.get('/api/stream/:id/mp3', auth, async (req, reply) => {
    const id = (req.params as any).id as string;
    const file = trackFile(id);
    if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: 'no such track' });
    const q = req.query as any;
    const kbps = Math.min(320, Math.max(64, Math.round((Number(q.bitrate) || 320000) / 1000)));
    const startAt = Math.max(0, Number(q.startAt) || 0);
    const ff = spawn('ffmpeg', ['-v', 'error', '-nostdin', ...(startAt ? ['-ss', String(startAt)] : []), '-i', file, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-ac', '2', '-f', 'mp3', '-id3v2_version', '0', '-write_xing', '0', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    reply.raw.on('close', () => { try { ff.kill('SIGKILL'); } catch { /* gone */ } });
    reply.header('Cache-Control', 'no-store').header('Accept-Ranges', 'none').type('audio/mpeg');
    return reply.send(ff.stdout);
  });

  // Save to disk: the original file with its real name, or a transcode.
  const DL: Record<string, { args: string[]; mime: string; ext: string }> = {
    flac: { args: ['-c:a', 'flac'], mime: 'audio/flac', ext: 'flac' },
    mp3: { args: ['-c:a', 'libmp3lame', '-b:a', '320k'], mime: 'audio/mpeg', ext: 'mp3' },
    aac: { args: ['-c:a', 'aac', '-b:a', '256k', '-f', 'adts'], mime: 'audio/aac', ext: 'aac' },
    ogg: { args: ['-c:a', 'libvorbis', '-b:a', '320k', '-f', 'ogg'], mime: 'audio/ogg', ext: 'ogg' },
  };
  app.get('/api/download/:id', auth, async (req, reply) => {
    const id = (req.params as any).id as string;
    const t = db.prepare('SELECT path, title, artist FROM tracks WHERE id = ?').get(id) as any;
    if (!t || !fs.existsSync(t.path)) return reply.code(404).send({ error: 'no such track' });
    const q = req.query as any;
    const safe = (x: string) => String(x || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
    const base = safe(q.name) || safe(`${t.artist} - ${t.title}`);
    const fmt = String(q.fmt || 'original');
    const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    if (fmt === 'original' || !DL[fmt]) {
      const ext = path.extname(t.path).toLowerCase();
      reply.header('Content-Disposition', disposition(`${base}${ext}`)).header('Content-Length', fs.statSync(t.path).size).type(MIME[ext] || 'application/octet-stream');
      return reply.send(fs.createReadStream(t.path));
    }
    const d = DL[fmt];
    const ff = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', t.path, '-map', '0:a:0', '-vn', ...d.args, ...(d.args.includes('-f') ? [] : ['-f', d.ext]), 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    reply.raw.on('close', () => { try { ff.kill('SIGKILL'); } catch { /* gone */ } });
    reply.header('Content-Disposition', disposition(`${base}.${d.ext}`)).type(d.mime);
    return reply.send(ff.stdout);
  });

  // A phone pulls 40-60 segments per track in a burst: keep the HLS routes out
  // of the per-IP rate limit (which, behind nginx, is one bucket for everyone).
  const hls = { ...auth, config: { rateLimit: false } };
  app.get('/api/stream/:id/hls/:profile/index.m3u8', hls, async (req, reply) => {
    const { id, profile } = req.params as any;
    if (!PROFILES[profile]) return reply.code(404).send({ error: 'no such profile' });
    const file = trackFile(id);
    if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: 'no such track' });
    lastProfile.set(req.user!.id, profile);
    let index: string;
    try { index = await ensureHls(dataDir, id, file, profile, log); } catch (e: any) { return reply.code(503).send({ error: e.message }); }
    // Segment URIs carry the token, since <audio> cannot send headers.
    const tok = (req.query as any).token ? `?token=${encodeURIComponent((req.query as any).token)}` : '';
    let body = (await fsp.readFile(index, 'utf8')).replace(/^(s\d+\.ts)$/gm, `$1${tok}`);
    // Still open (ffmpeg writing): pin the start, or iOS picks the live edge.
    // Apple's players want a small positive offset rather than 0.
    if (!/#EXT-X-ENDLIST/.test(body)) body = body.replace(/^(#EXT-X-VERSION:\d+\n)/m, '$1#EXT-X-START:TIME-OFFSET=0.01,PRECISE=YES\n');
    else fsp.utimes(path.join(path.dirname(index), 'done'), new Date(), new Date()).catch(() => {}); // last-used, for eviction
    reply.header('Cache-Control', 'no-store').type('application/vnd.apple.mpegurl');
    return body;
  });
  app.get('/api/stream/:id/hls/:profile/:seg', hls, async (req, reply) => {
    const { id, profile, seg } = req.params as any;
    if (!PROFILES[profile] || !/^s\d{4}\.ts$/.test(seg)) return reply.code(404).send();
    const p = path.join(transcodeDir(dataDir, id, profile), seg);
    // A segment ffmpeg has not written yet: wait briefly rather than 404 (players would stall).
    for (let i = 0; i < 200 && !fs.existsSync(p); i++) await new Promise((r) => setTimeout(r, 50));
    if (!fs.existsSync(p)) return reply.code(404).send();
    const size = (await fsp.stat(p)).size;
    // Immutable once written; a fetch() of it lands in the browser's disk
    // cache, which the native HLS loader on iOS reads (it never writes it).
    reply.header('Cache-Control', 'private, max-age=604800, immutable').header('Content-Length', String(size)).type('video/mp2t');
    return reply.send(fs.createReadStream(p));
  });
  // The client's own warm: the next few queue items at the profile it plays.
  const Warm = z.object({ ids: z.array(z.string()).max(10), profile: z.string().optional() });
  app.post('/api/stream/warm', hls, async (req, reply) => {
    const b = Warm.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'ids required' });
    warm(req.user!.id, b.data.ids, b.data.profile);
    return { ok: true, queued: warmQueue.length, active: warmActive };
  });

  // --- nightly: the hot set pre-transcoded, the cache trimmed --------------------
  // Likes, playlist members and the last 30 days of plays for every account,
  // at aac-320 (what phones default to), through the warm queue so it never
  // competes with someone pressing play. Then the oldest-used transcodes go
  // until the directory is under CACHE_CAP_GB.
  const hotSet = () => {
    const ids = new Set<string>();
    for (const r of db.prepare('SELECT DISTINCT track_id FROM likes').all() as any[]) ids.add(r.track_id);
    for (const r of db.prepare('SELECT DISTINCT track_id FROM playlist_tracks').all() as any[]) ids.add(r.track_id);
    for (const r of db.prepare('SELECT DISTINCT track_id FROM plays WHERE at > ?').all(Date.now() - 30 * 86400000) as any[]) ids.add(r.track_id);
    return [...ids];
  };
  const trimCache = async () => {
    const root = path.join(dataDir, 'transcodes');
    const dirs: { dir: string; used: number; size: number }[] = [];
    let total = 0;
    for (const id of await fsp.readdir(root).catch(() => [] as string[])) {
      for (const prof of await fsp.readdir(path.join(root, id)).catch(() => [] as string[])) {
        const dir = path.join(root, id, prof);
        const used = await fsp.stat(path.join(dir, 'done')).then((s) => s.mtimeMs).catch(() => 0);
        if (!used) continue; // in progress
        let size = 0;
        for (const f of await fsp.readdir(dir).catch(() => [] as string[])) size += await fsp.stat(path.join(dir, f)).then((s) => s.size).catch(() => 0);
        dirs.push({ dir, used, size }); total += size;
      }
    }
    const cap = CACHE_CAP_GB * 1024 ** 3;
    let removed = 0;
    for (const d of dirs.sort((a, b) => a.used - b.used)) {
      if (total <= cap) break;
      await fsp.rm(d.dir, { recursive: true, force: true }).catch(() => {});
      total -= d.size; removed++;
    }
    return { total, removed };
  };
  const nightly = async () => {
    const ids = hotSet().filter((id) => !fs.existsSync(path.join(transcodeDir(dataDir, id, 'aac-320'), 'done')));
    app.log.info(`transcodes: warming ${ids.length} hot tracks`);
    for (let i = 0; i < ids.length; i += 10) { warm(null, ids.slice(i, i + 10), 'aac-320'); while (warmQueue.length > 4) await new Promise((r) => setTimeout(r, 2000)); }
    const t = await trimCache();
    app.log.info(`transcodes: ${(t.total / 1024 ** 3).toFixed(1)} GB after trim, ${t.removed} removed`);
  };
  app.decorate('transcodeNightly', nightly);
  if (process.env.NODE_ENV !== 'test') {
    const tick = () => {
      const h = new Date().getHours();
      const stamp = new Date().toISOString().slice(0, 10);
      const last = (db.prepare('SELECT v FROM kv WHERE k = ?').get('transcodes:nightly') as any)?.v;
      if (h >= 3 && h < 6 && last !== stamp) {
        db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('transcodes:nightly', stamp);
        nightly().catch((e) => log(`nightly transcodes: ${e.message}`));
      }
    };
    const timer = setInterval(tick, 60000); timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
}
