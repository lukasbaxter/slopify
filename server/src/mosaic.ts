// A playlist's picture, Spotify's way: its own cover when someone uploaded
// one; else, when its songs (in playlist order) come from 4 or more albums
// with different covers, a 2x2 grid of the first 4 of those covers; else the
// first song's album cover. The grid is rendered once per set of 4 covers
// into /data/art/<hash>/ like any cover (hash = sha1 of the 4 cover hashes),
// so the same 4 covers are one picture however many playlists share them,
// and a playlist whose first covers change gets a new hash, a new picture.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { DB } from './db.js';
import { artDir, SIZES, toFileAtomic } from './artwork.js';

export type PlaylistCover = { hash: string | null; parts: string[] | null };

const covers = new WeakMap<DB, ReturnType<DB['prepare']>>();
const mosaicHash = (parts: string[]) => crypto.createHash('sha1').update(`mosaic\n${parts.join('\n')}`).digest('hex');

export function playlistCover(db: DB, playlistId: string, own?: string | null): PlaylistCover {
  if (own === undefined) {
    const p = db.prepare('SELECT cover_hash FROM playlists WHERE id = ?').get(playlistId) as { cover_hash: string | null } | undefined;
    if (!p) return { hash: null, parts: null };
    own = p.cover_hash;
  }
  if (own) return { hash: own, parts: null };
  // Walked in order and left as soon as 4 different covers are in hand: a
  // 10,000-song playlist reads a handful of rows, not all of them.
  let q = covers.get(db);
  if (!q) { q = db.prepare('SELECT a.cover_hash h FROM playlist_tracks x JOIN tracks t ON t.id = x.track_id JOIN albums a ON a.id = t.album_id WHERE x.playlist_id = ? AND a.cover_hash IS NOT NULL ORDER BY x.pos'); covers.set(db, q); }
  const rows = q.iterate(playlistId) as IterableIterator<{ h: string }>;
  const seen: string[] = [];
  for (const r of rows) {
    if (!seen.includes(r.h)) seen.push(r.h);
    if (seen.length === 4) break; // for-of closes the statement
  }
  if (seen.length < 4) return { hash: seen[0] ?? null, parts: null };
  return { hash: mosaicHash(seen), parts: seen };
}

// Each size is the 4 covers' copies of half that size side by side (the 640
// grid from the 320 copies): no upscaling, and sharp only composites.
const rendering = new Map<string, Promise<boolean>>();
export function ensureMosaic(dataDir: string, hash: string, parts: string[]): Promise<boolean> {
  let job = rendering.get(hash);
  if (job) return job;
  job = (async () => {
    const dir = path.join(artDir(dataDir), hash);
    try { await fs.access(path.join(dir, 'done')); return true; } catch { /* render */ }
    await fs.mkdir(dir, { recursive: true });
    for (const s of SIZES) {
      const half = s / 2;
      const tiles = await Promise.all(parts.map(async (h) => {
        const src = path.join(artDir(dataDir), h, `${SIZES.find((x) => x >= half) ?? 640}.jpg`);
        return sharp(await fs.readFile(src), { failOn: 'none' }).resize(half, half, { fit: 'cover' }).toBuffer();
      }));
      const grid = sharp({ create: { width: s, height: s, channels: 3, background: '#282828' } })
        .composite(tiles.map((input, i) => ({ input, left: (i % 2) * half, top: Math.floor(i / 2) * half })));
      const flat = await grid.png().toBuffer();
      await Promise.all([
        toFileAtomic(sharp(flat).webp({ quality: 78 }), path.join(dir, `${s}.webp`)),
        toFileAtomic(sharp(flat).jpeg({ quality: 80, mozjpeg: true, progressive: false }), path.join(dir, `${s}.jpg`)),
      ]);
    }
    await fs.writeFile(path.join(dir, 'done'), JSON.stringify({ width: SIZES[SIZES.length - 1], height: SIZES[SIZES.length - 1], mosaic: parts }));
    return true;
  })().catch(() => false).finally(() => rendering.delete(hash));
  rendering.set(hash, job);
  return job;
}
