// Streaming: the original file with byte ranges (lossless, seekable, what
// speakers and the desktop want) and HLS transcodes (AAC, 4 s segments) made
// by one ffmpeg per (track, profile) into /data/transcodes and reused by
// everyone after. The playlist is written as an EVENT playlist while ffmpeg
// runs and closed with ENDLIST when done, so players start after the first
// segment.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';

export const PROFILES: Record<string, { bitrate: string }> = { 'aac-320': { bitrate: '320k' }, 'aac-160': { bitrate: '160k' }, 'aac-96': { bitrate: '96k' } };
const MIME: Record<string, string> = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape', '.wv': 'audio/x-wavpack' };

const running = new Map<string, Promise<void>>(); // key -> first segment ready

function transcodeDir(dataDir: string, id: string, profile: string) { return path.join(dataDir, 'transcodes', id, profile); }

async function ensureHls(dataDir: string, id: string, file: string, profile: string, log: (m: string) => void): Promise<string> {
  const dir = transcodeDir(dataDir, id, profile);
  const index = path.join(dir, 'index.m3u8');
  const done = path.join(dir, 'done');
  if (fs.existsSync(done)) return index;
  const key = `${id}:${profile}`;
  if (!running.has(key)) {
    const p = (async () => {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      const ff = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', PROFILES[profile].bitrate, '-ac', '2',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file+independent_segments', '-hls_segment_filename', path.join(dir, 's%04d.ts'), index], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err += d; });
      const exit = new Promise<void>((resolve, reject) => { ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 300)}`)))); ff.on('error', reject); });
      exit.then(() => fsp.writeFile(done, '1')).catch((e) => log(`hls ${key}: ${e.message}`)).finally(() => running.delete(key));
      // first segment ready = playlist exists with one entry
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        try { const txt = await fsp.readFile(index, 'utf8'); if (/\.ts\s*$/m.test(txt)) return; } catch { /* not yet */ }
        if (ff.exitCode !== null && ff.exitCode !== 0) throw new Error('transcode failed');
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('transcode did not start');
    })();
    running.set(key, p);
  }
  await running.get(key)!;
  return index;
}

export function registerStream(app: FastifyInstance, db: DB, dataDir: string) {
  const auth = { preHandler: (app as any).requireUser };
  const trackFile = (id: string) => (db.prepare('SELECT path FROM tracks WHERE id = ?').get(id) as any)?.path as string | undefined;

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

  app.get('/api/stream/:id/hls/:profile/index.m3u8', auth, async (req, reply) => {
    const { id, profile } = req.params as any;
    if (!PROFILES[profile]) return reply.code(404).send({ error: 'no such profile' });
    const file = trackFile(id);
    if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: 'no such track' });
    let index: string;
    try { index = await ensureHls(dataDir, id, file, profile, (m) => app.log.warn(m)); } catch (e: any) { return reply.code(503).send({ error: e.message }); }
    // Segment URIs carry the token, since <audio> cannot send headers.
    const tok = (req.query as any).token ? `?token=${encodeURIComponent((req.query as any).token)}` : '';
    // While ffmpeg is still writing, the playlist has no ENDLIST and players
    // treat it as live: iOS starts at the live edge minus three target
    // durations, so a phone on a slow link (several segments already written
    // by the time it fetches the playlist) began songs 4-20 s in. EXT-X-START
    // pins the start to 0; harmless once the playlist is closed.
    const body = (await fsp.readFile(index, 'utf8')).replace(/^(s\d+\.ts)$/gm, `$1${tok}`)
      .replace(/^(#EXT-X-VERSION:\d+\n)/m, '$1#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
    reply.header('Cache-Control', 'no-store').type('application/vnd.apple.mpegurl');
    return body;
  });
  app.get('/api/stream/:id/hls/:profile/:seg', auth, async (req, reply) => {
    const { id, profile, seg } = req.params as any;
    if (!PROFILES[profile] || !/^s\d{4}\.ts$/.test(seg)) return reply.code(404).send();
    const p = path.join(transcodeDir(dataDir, id, profile), seg);
    // A segment ffmpeg has not written yet: wait briefly rather than 404 (players would stall).
    for (let i = 0; i < 100 && !fs.existsSync(p); i++) await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('Cache-Control', 'private, max-age=86400').type('video/mp2t');
    return reply.send(fs.createReadStream(p));
  });
}
