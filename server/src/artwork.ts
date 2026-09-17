// Artwork rendered once into /data/art/<hash>/<size>.webp|jpg at scan and
// served as immutable files. The hash is of the source bytes, so the same
// cover shared by an album's tracks is stored once.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const SIZES = [64, 160, 320, 640] as const;
export type ArtSize = (typeof SIZES)[number];

export function artDir(dataDir: string) { return path.join(dataDir, 'art'); }

// `banner`: also a wide crop (artist pages) at banner.webp|jpg.
export async function storeArtwork(dataDir: string, bytes: Buffer, opts: { banner?: boolean } = {}): Promise<{ hash: string; width: number; height: number }> {
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  const dir = path.join(artDir(dataDir), hash);
  const done = path.join(dir, 'done');
  const bannerFile = path.join(dir, 'banner.webp');
  try {
    await fs.access(done); const meta = JSON.parse(await fs.readFile(done, 'utf8'));
    if (!opts.banner) return { hash, ...meta };
    try { await fs.access(bannerFile); return { hash, ...meta }; } catch { await renderBanner(bytes, dir); return { hash, ...meta }; }
  } catch { /* render */ }
  await fs.mkdir(dir, { recursive: true });
  const img = sharp(bytes, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  await Promise.all(SIZES.flatMap((s) => [
    img.clone().resize(s, s, { fit: 'cover' }).webp({ quality: 78 }).toFile(path.join(dir, `${s}.webp`)),
    img.clone().resize(s, s, { fit: 'cover' }).jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(dir, `${s}.jpg`)),
  ]));
  if (opts.banner) await renderBanner(bytes, dir);
  await fs.writeFile(done, JSON.stringify({ width, height }));
  return { hash, width, height };
}
async function renderBanner(bytes: Buffer, dir: string) {
  const img = sharp(bytes, { failOn: 'none' }).rotate();
  await Promise.all([
    img.clone().resize(1600, 560, { fit: 'cover', position: sharp.strategy.attention }).webp({ quality: 74 }).toFile(path.join(dir, 'banner.webp')),
    img.clone().resize(1600, 560, { fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 78, mozjpeg: true }).toFile(path.join(dir, 'banner.jpg')),
  ]);
}

export function artPath(dataDir: string, hash: string, size: ArtSize, format: 'webp' | 'jpg') {
  return path.join(artDir(dataDir), hash, `${size}.${format}`);
}
export function nearestSize(n: number): ArtSize { return SIZES.find((s) => s >= n) ?? 640; }
