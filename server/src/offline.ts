// A playlist as one zip, for listening with no connection (a plane): every
// song as AAC 256 kbps .m4a with its tags and album cover, numbered in
// playlist order, plus an .m3u8. Plays in VLC or the Files app, and imports
// into Apple Music. Streamed as it goes: a few songs transcode ahead into a
// temp dir while the ones before are sent, so the download starts in seconds.
// No zip64 (fflate), so a playlist must stay under 4 GB.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { Zip, ZipPassThrough } from 'fflate';
import type { DB } from './db.js';
import { artPath } from './artwork.js';
import { spawnFf, type Src } from './stream.js';

const KBPS = 256;
const AHEAD = 3;
const MAX_BYTES = 3.8e9;

// eslint-disable-next-line no-control-regex -- control chars are not allowed in file names
const safe = (s: string, n = 100) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, n);

export function registerOffline(app: FastifyInstance, db: DB, cacheDir: string, srcOf: (id: string, want?: boolean) => Src | undefined) {
  const auth = { preHandler: (app as any).requireUser, config: { rateLimit: false } };
  app.get('/api/playlists/:id/zip', auth, async (req, reply) => {
    const pl = db.prepare('SELECT id, name FROM playlists WHERE id = ? AND user_id = ?').get((req.params as any).id, req.user!.id) as any;
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });
    const tracks = db.prepare(`SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.track_no, t.disc_no, t.year, t.duration_ms, a.cover_hash
      FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id JOIN albums a ON a.id = t.album_id WHERE x.playlist_id = ? ORDER BY x.pos`).all(pl.id) as any[];
    if (!tracks.length) return reply.code(400).send({ error: 'playlist is empty' });
    const est = tracks.reduce((n, t) => n + (t.duration_ms / 1000) * KBPS * 125, 0);
    if (est > MAX_BYTES) return reply.code(413).send({ error: `about ${(est / 1e9).toFixed(1)} GB, over the 4 GB a zip can hold: split the playlist` });

    const folder = safe(pl.name) || 'Playlist';
    const tmp = path.join(cacheDir, 'tmp', `zip-${crypto.randomBytes(6).toString('hex')}`);
    await fsp.mkdir(tmp, { recursive: true });
    const procs = new Set<ChildProcess>();
    const pad = String(tracks.length).length < 2 ? 2 : String(tracks.length).length;
    const nameOf = (t: any, i: number) => `${String(i + 1).padStart(pad, '0')} - ${safe(t.artist, 60)} - ${safe(t.title, 80)}.m4a`;

    // One song to a temp .m4a; resolves to its path, or null when it fails
    // (a missing or corrupt source is skipped, not the whole download).
    const encode = (t: any, i: number) => new Promise<string | null>((resolve) => {
      const src = srcOf(t.id, false);
      if (!src) return resolve(null);
      const out = path.join(tmp, `${i}.m4a`);
      const cover = t.cover_hash ? artPath(cacheDir, t.cover_hash, 640, 'jpg') : null;
      const withCover = !!cover && fs.existsSync(cover);
      const meta = (k: string, v: any) => (v == null || v === '' ? [] : ['-metadata', `${k}=${v}`]);
      const ff = spawnFf([], src, [
        ...(withCover ? ['-i', cover!] : []),
        '-map', '0:a:0', ...(withCover ? ['-map', '1:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic'] : []),
        '-c:a', 'aac', '-b:a', `${KBPS}k`, '-ac', '2', '-map_metadata', '-1',
        ...meta('title', t.title), ...meta('artist', t.artist), ...meta('album', t.album), ...meta('album_artist', t.album_artist),
        ...meta('track', t.track_no), ...meta('disc', t.disc_no), ...meta('date', t.year),
        '-movflags', '+faststart', '-f', 'ipod', '-y', out,
      ], 'ignore', true);
      procs.add(ff);
      let err = '';
      ff.stderr!.on('data', (d) => { if (err.length < 2000) err += d; });
      ff.on('error', (e) => { procs.delete(ff); req.log.warn(`zip ${t.id}: ${e.message}`); resolve(null); });
      ff.on('close', (code) => { procs.delete(ff); if (code === 0) resolve(out); else { req.log.warn(`zip ${t.id}: ffmpeg ${code} ${err.trim()}`); resolve(null); } });
    });

    async function* body() {
      const chunks: Uint8Array[] = [];
      let failed: Error | null = null;
      const zip = new Zip((e, c) => { if (e) failed = e; else chunks.push(c); });
      const drain = function* () { while (chunks.length) yield chunks.shift()!; };
      const jobs: Promise<string | null>[] = [];
      const start = (i: number) => { if (i < tracks.length && !jobs[i]) jobs[i] = encode(tracks[i], i); };
      const m3u = ['#EXTM3U'];
      try {
        for (let i = 0; i < AHEAD; i++) start(i);
        for (let i = 0; i < tracks.length; i++) {
          for (let k = 1; k <= AHEAD; k++) start(i + k);
          const file = await jobs[i];
          if (!file) continue;
          const name = nameOf(tracks[i], i);
          const entry = new ZipPassThrough(`${folder}/${name}`);
          zip.add(entry);
          for await (const c of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
            entry.push(c as Buffer);
            if (failed) throw failed;
            yield* drain();
          }
          entry.push(new Uint8Array(0), true);
          yield* drain();
          await fsp.rm(file, { force: true });
          m3u.push(`#EXTINF:${Math.round(tracks[i].duration_ms / 1000)},${tracks[i].artist} - ${tracks[i].title}`, name);
        }
        const list = new ZipPassThrough(`${folder}/${folder}.m3u8`);
        zip.add(list);
        list.push(new TextEncoder().encode(m3u.join('\n') + '\n'), true);
        zip.end();
        if (failed) throw failed;
        yield* drain();
      } finally {
        for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
        await Promise.allSettled(jobs);
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }

    const disposition = (n: string) => `attachment; filename="${n.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(n)}`;
    reply.header('Content-Disposition', disposition(`${folder}.zip`)).header('Cache-Control', 'no-store').type('application/zip');
    return reply.send(Readable.from(body()));
  });
}
