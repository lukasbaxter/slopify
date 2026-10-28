// Artwork rendered once into /data/art/<hash>/<size>.webp|jpg at scan and
// served as immutable files. The hash is of the source bytes, so the same
// cover shared by an album's tracks is stored once.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';

export const SIZES = [64, 160, 320, 640] as const;
export type ArtSize = (typeof SIZES)[number];

export function artDir(dataDir: string) { return path.join(dataDir, 'art'); }

// The size variants are served as immutable: write to a tmp name and rename,
// so a crash mid-render never leaves a truncated file at the served path.
// (sharp's format comes from .webp()/.jpeg(), not the extension.)
async function toFileAtomic(img: Sharp, dst: string) {
  const tmp = `${dst}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { await img.toFile(tmp); await fs.rename(tmp, dst); } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
}

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
    toFileAtomic(img.clone().resize(s, s, { fit: 'cover' }).webp({ quality: 78 }), path.join(dir, `${s}.webp`)),
    toFileAtomic(img.clone().resize(s, s, { fit: 'cover' }).jpeg({ quality: 80, mozjpeg: true, progressive: false }), path.join(dir, `${s}.jpg`)), // baseline: ffmpeg embeds it (zip, FLAC upgrade)
  ]));
  if (opts.banner) await renderBanner(bytes, dir);
  await fs.writeFile(done, JSON.stringify({ width, height }));
  return { hash, width, height };
}
async function renderBanner(bytes: Buffer, dir: string) {
  const img = sharp(bytes, { failOn: 'none' }).rotate();
  await Promise.all([
    toFileAtomic(img.clone().resize(1600, 560, { fit: 'cover', position: sharp.strategy.attention }).webp({ quality: 74 }), path.join(dir, 'banner.webp')),
    toFileAtomic(img.clone().resize(1600, 560, { fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 78, mozjpeg: true }), path.join(dir, 'banner.jpg')),
  ]);
}

// A wide artist photo (fanart) for the artist page: two widths, so a phone on
// mobile data downloads a quarter of what a big screen gets.
export const BANNER_WIDTHS = [640, 1280] as const;
export async function storeBanner(dataDir: string, bytes: Buffer): Promise<{ hash: string; width: number; height: number }> {
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  const dir = path.join(artDir(dataDir), hash);
  const img = sharp(bytes, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  try { await fs.access(path.join(dir, 'banner-1280.webp')); return { hash, width, height }; } catch { /* render */ }
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(BANNER_WIDTHS.flatMap((w) => {
    const crop = () => img.clone().resize(w, Math.round(w * 0.35), { fit: 'cover', position: sharp.strategy.attention });
    return [
      toFileAtomic(crop().webp({ quality: 80 }), path.join(dir, `banner-${w}.webp`)),
      toFileAtomic(crop().jpeg({ quality: 82, mozjpeg: true }), path.join(dir, `banner-${w}.jpg`)),
    ];
  }));
  return { hash, width, height };
}

// The big copies (the TV's full-screen cover, the desktop's now playing) are
// made the first time one is asked for, from the original, never larger than
// it, and kept beside the small ones: rendering 13k covers this big at scan
// would be hours of work and gigabytes for pictures few are ever shown at.
export const BIG_SIZES = [1280, 1920] as const;
export type BigSize = (typeof BIG_SIZES)[number];
export function nearestBig(n: number): BigSize { return BIG_SIZES.find((s) => s >= n) ?? 1920; }
const rendering = new Map<string, Promise<boolean>>();
// `original` returns the source bytes (or null); they must still hash to
// `hash`, so a cover file replaced since the scan never shows under the old id.
export function renderBig(dataDir: string, hash: string, size: BigSize, original: () => Promise<Buffer | null>): Promise<boolean> {
  const key = `${hash}/${size}`;
  let job = rendering.get(key);
  if (!job) {
    job = (async () => {
      const bytes = await original().catch(() => null);
      if (!bytes || crypto.createHash('sha1').update(bytes).digest('hex') !== hash) return false;
      const dir = path.join(artDir(dataDir), hash);
      await fs.mkdir(dir, { recursive: true });
      const img = sharp(bytes, { failOn: 'none' }).rotate().resize(size, size, { fit: 'cover', withoutEnlargement: true });
      await Promise.all([
        toFileAtomic(img.clone().webp({ quality: 82 }), path.join(dir, `${size}.webp`)),
        toFileAtomic(img.clone().jpeg({ quality: 85, mozjpeg: true }), path.join(dir, `${size}.jpg`)),
      ]);
      return true;
    })().catch(() => false).finally(() => rendering.delete(key));
    rendering.set(key, job);
  }
  return job;
}

export function artPath(dataDir: string, hash: string, size: ArtSize, format: 'webp' | 'jpg') {
  return path.join(artDir(dataDir), hash, `${size}.${format}`);
}
export function nearestSize(n: number): ArtSize { return SIZES.find((s) => s >= n) ?? 640; }
