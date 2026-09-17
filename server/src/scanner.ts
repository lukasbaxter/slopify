// The library scanner: walks MUSIC_DIR, reads tags, hashes audio for ids,
// finds covers and .lrc sidecars, and keeps tracks/albums/artists in step.
// Incremental: a file whose path, mtime and size are unchanged is skipped.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { DB } from './db.js';
import { bumpLibraryVersion } from './db.js';
import { albumId, artistId, audioContentId, jellyfinAudioId, sortName } from './ids.js';
import { parseLrc, isSynced } from './lyrics.js';
import { storeArtwork } from './artwork.js';

export const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.wma', '.ape', '.wv']);
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'artwork'];
const COVER_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

export type ScanOptions = { musicDir: string; dataDir: string; jellyfinRoot?: string; onProgress?: (n: number) => void; log?: (m: string) => void };
export type ScanResult = { files: number; added: number; changed: number; removed: number; ms: number };

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

// Multi-artist credits: the tag's own list first, then "A; B", "A / B",
// "A feat. B" splits; a short whitelist keeps bands whose names contain the
// separators (config later).
const KEEP = new Set(['ac/dc', 'sam & dave', 'tyler, the creator', 'earth, wind & fire', 'simon & garfunkel', 'hall & oates', 'x ambassadors']);
export function splitArtists(list: string[] | undefined, single: string | undefined): string[] {
  const src = list && list.length ? list : single ? [single] : [];
  const out: string[] = [];
  for (const raw of src) {
    const s = raw.trim(); if (!s) continue;
    if (KEEP.has(s.toLowerCase())) { out.push(s); continue; }
    for (const part of s.split(/\s*(?:;|\/|,|\b(?:feat|ft|featuring|vs)\.?\s+|\s+x\s+(?=[A-Z]))\s*/i)) { const p = part.trim(); if (p && !out.includes(p)) out.push(p); }
  }
  return out.length ? out : ['Unknown Artist'];
}

async function findCover(dir: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(dir)) return cache.get(dir)!;
  let found: string | null = null;
  try {
    const names = await fs.readdir(dir);
    const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
    outer: for (const base of COVER_NAMES) for (const ext of COVER_EXT) { const hit = lower.get(base + ext); if (hit) { found = path.join(dir, hit); break outer; } }
  } catch { /* unreadable */ }
  cache.set(dir, found);
  return found;
}

export async function scanLibrary(db: DB, opts: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const scanId = Number(db.prepare('INSERT INTO scans (started) VALUES (?)').run(t0).lastInsertRowid);
  const known = new Map<string, { id: string; mtime: number; size: number }>();
  for (const r of db.prepare('SELECT id, path, mtime, size FROM tracks').all() as any[]) known.set(r.path, r);
  const seen = new Set<string>();
  const seenIds = new Set<string>(); // ids met under some path this scan (a renamed file keeps its id)
  const coverCache = new Map<string, string | null>();
  const coverHashByFile = new Map<string, string>();
  let files = 0, added = 0, changed = 0;

  const upsertTrack = db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, track_no, disc_no, year, genres, duration_ms, codec, bitrate, sample_rate, channels, jf_id, added_at)
    VALUES (@id, @path, @mtime, @size, @title, @artist, @artists, @artist_ids, @album_id, @album, @album_artist, @track_no, @disc_no, @year, @genres, @duration_ms, @codec, @bitrate, @sample_rate, @channels, @jf_id, @added_at)
    ON CONFLICT(id) DO UPDATE SET path=excluded.path, mtime=excluded.mtime, size=excluded.size, title=excluded.title, artist=excluded.artist, artists=excluded.artists, artist_ids=excluded.artist_ids,
      album_id=excluded.album_id, album=excluded.album, album_artist=excluded.album_artist, track_no=excluded.track_no, disc_no=excluded.disc_no, year=excluded.year, genres=excluded.genres,
      duration_ms=excluded.duration_ms, codec=excluded.codec, bitrate=excluded.bitrate, sample_rate=excluded.sample_rate, channels=excluded.channels, jf_id=excluded.jf_id`);
  const upsertAlbum = db.prepare(`INSERT INTO albums (id, name, artist_id, artist, year, dir, cover_hash, added_at, sort_name) VALUES (@id, @name, @artist_id, @artist, @year, @dir, @cover_hash, @added_at, @sort_name)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, artist_id=excluded.artist_id, artist=excluded.artist, year=COALESCE(excluded.year, albums.year), dir=excluded.dir, cover_hash=COALESCE(excluded.cover_hash, albums.cover_hash), sort_name=excluded.sort_name`);
  const upsertArtist = db.prepare(`INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_name=excluded.sort_name`);
  const upsertLyrics = db.prepare(`INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET kind=excluded.kind, lines=excluded.lines, source=excluded.source, fetched_at=excluded.fetched_at WHERE lyrics.source = 'sidecar' OR lyrics.source = 'none'`);
  const upsertArt = db.prepare(`INSERT OR IGNORE INTO artwork (hash, kind, src, width, height, created) VALUES (?, ?, ?, ?, ?, ?)`);

  for await (const file of walk(opts.musicDir)) {
    files++;
    if (files % 200 === 0) opts.onProgress?.(files);
    seen.add(file);
    let st;
    try { st = await fs.stat(file); } catch { continue; }
    const prev = known.get(file);
    if (prev && prev.mtime === Math.floor(st.mtimeMs) && prev.size === st.size) {
      // Unchanged file: only a new sidecar next to it can matter.
      seenIds.add(prev.id);
      await syncSidecar(db, prev.id, file, upsertLyrics);
      continue;
    }
    let meta;
    try { meta = await parseFile(file, { duration: true, skipCovers: false }); } catch (e: any) { log(`tags failed ${file}: ${e.message}`); continue; }
    let id: string;
    try { id = await audioContentId(file); } catch (e: any) { log(`hash failed ${file}: ${e.message}`); continue; }
    const c = meta.common;
    const dir = path.dirname(file);
    const title = (c.title || path.basename(file, path.extname(file))).trim();
    const artists = splitArtists(c.artists, c.artist);
    const albumArtist = (c.albumartist || artists[0]).trim();
    const album = (c.album || path.basename(dir)).trim();
    const alId = albumId(albumArtist, album);
    const artIds = artists.map(artistId);
    const now = Date.now();
    // cover: folder image first, else the embedded picture
    let coverHash: string | null = null;
    const coverFile = await findCover(dir, coverCache);
    try {
      if (coverFile) {
        if (!coverHashByFile.has(coverFile)) { const a = await storeArtwork(opts.dataDir, await fs.readFile(coverFile)); coverHashByFile.set(coverFile, a.hash); upsertArt.run(a.hash, 'album', coverFile, a.width, a.height, now); }
        coverHash = coverHashByFile.get(coverFile)!;
      } else if (c.picture?.length) {
        const a = await storeArtwork(opts.dataDir, Buffer.from(c.picture[0].data)); upsertArt.run(a.hash, 'album', file, a.width, a.height, now); coverHash = a.hash;
      }
    } catch (e: any) { log(`cover failed ${file}: ${e.message}`); }
    const rel = path.relative(opts.musicDir, file).split(path.sep).join('/');
    const jfId = jellyfinAudioId(path.posix.join(opts.jellyfinRoot ?? '/music', rel));
    const tx = db.transaction(() => {
      upsertArtist.run(artistId(albumArtist), albumArtist, sortName(albumArtist));
      artists.forEach((a, i) => upsertArtist.run(artIds[i], a, sortName(a)));
      upsertAlbum.run({ id: alId, name: album, artist_id: artistId(albumArtist), artist: albumArtist, year: c.year ?? null, dir, cover_hash: coverHash, added_at: now, sort_name: sortName(album) });
      upsertTrack.run({
        id, path: file, mtime: Math.floor(st.mtimeMs), size: st.size, title, artist: artists.join(', '), artists: JSON.stringify(artists), artist_ids: JSON.stringify(artIds),
        album_id: alId, album, album_artist: albumArtist, track_no: c.track?.no ?? null, disc_no: c.disk?.no ?? null, year: c.year ?? null,
        genres: JSON.stringify(c.genre ?? []), duration_ms: Math.round((meta.format.duration ?? 0) * 1000), codec: meta.format.codec ?? null,
        bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate) : null, sample_rate: meta.format.sampleRate ?? null, channels: meta.format.numberOfChannels ?? null,
        jf_id: jfId, added_at: prev ? (db.prepare('SELECT added_at FROM tracks WHERE id = ?').get(id) as any)?.added_at ?? now : now,
      });
    });
    // Same path, different audio (a re-rip): the old row goes first, or its
    // UNIQUE path would collide with the new id's row.
    if (prev && prev.id !== id) db.prepare('DELETE FROM tracks WHERE id = ?').run(prev.id);
    tx();
    seenIds.add(id);
    if (prev) changed++; else added++;
    await syncSidecar(db, id, file, upsertLyrics);
  }
  // Files that are gone (a renamed file is not gone: its id was met under the new path).
  let removed = 0;
  for (const [p, r] of known) if (!seen.has(p) && !seenIds.has(r.id)) { db.prepare('DELETE FROM tracks WHERE id = ?').run(r.id); removed++; }
  recount(db);
  bumpLibraryVersion(db);
  const ms = Date.now() - t0;
  db.prepare('UPDATE scans SET finished = ?, files = ?, added = ?, changed = ?, removed = ? WHERE id = ?').run(Date.now(), files, added, changed, removed, scanId);
  return { files, added, changed, removed, ms };
}

async function syncSidecar(db: DB, trackId: string, file: string, upsert: any) {
  const lrc = file.replace(/\.[^.]+$/, '.lrc');
  let text: string;
  try { text = await fs.readFile(lrc, 'utf8'); } catch { return; }
  const lines = parseLrc(text);
  if (!lines.length) return;
  upsert.run(trackId, isSynced(lines) ? 'synced' : 'plain', JSON.stringify(lines), 'sidecar', Date.now());
}

// Counts kept as columns so lists never aggregate live.
export function recount(db: DB) {
  db.exec(`
    UPDATE albums SET track_count = (SELECT COUNT(*) FROM tracks t WHERE t.album_id = albums.id), duration_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM tracks t WHERE t.album_id = albums.id);
    DELETE FROM albums WHERE track_count = 0;
    UPDATE artists SET track_count = (SELECT COUNT(*) FROM tracks t WHERE t.artist_ids LIKE '%"' || artists.id || '"%'), album_count = (SELECT COUNT(*) FROM albums a WHERE a.artist_id = artists.id);
    DELETE FROM artists WHERE track_count = 0 AND album_count = 0;
  `);
}
