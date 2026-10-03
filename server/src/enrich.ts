// Enrichment: lyrics for every song, identity from the audio. A queue row
// per track; one worker; every external answer cached; resumable; visible
// on the admin page. Runs after each scan and on a timer for retries.
//
// Lyrics order: a fitting sidecar (the scanner stored it) > LrcLib by
// artist+title+album+DURATION (the answer timed for this recording) >
// LrcLib search filtered by duration within 3 s > plain lyrics. LrcLib's
// "instrumental" flag resolves a track as instrumental. Anything else is
// `missing` and retried: daily for a week, then weekly.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DB } from './db.js';
import { parseLrc, isSynced, type LyricLine } from './lyrics.js';
import { storeArtwork } from './artwork.js';

const run = promisify(execFile);
const UA = 'slopify/0.1 (https://github.com/lukasbaxter/slopify)';
const DAY = 86400000;

export type LrclibRecord = { id: number; trackName: string; artistName: string; albumName: string; duration: number; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null };
export type Fetcher = (url: string) => Promise<{ status: number; json: () => Promise<any> }>;

export async function fingerprint(file: string): Promise<{ duration: number; fingerprint: string } | null> {
  try { const { stdout } = await run('fpcalc', ['-json', file], { maxBuffer: 1 << 20 }); const j = JSON.parse(stdout); return { duration: j.duration, fingerprint: j.fingerprint }; }
  catch { return null; } // fpcalc missing or the file is not decodable: identity stays unchecked
}

async function cached<T>(db: DB, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const row = db.prepare('SELECT json, at FROM ext_cache WHERE k = ?').get(key) as any;
  if (row && Date.now() - row.at < ttlMs) return JSON.parse(row.json);
  const v = await load();
  db.prepare('INSERT INTO ext_cache (k, json, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET json = excluded.json, at = excluded.at').run(key, JSON.stringify(v), Date.now());
  return v;
}

// Pick the LrcLib record for a track: exact get by duration, else the search
// candidate closest in duration within 3 s, synced preferred.
export async function lrclibLookup(db: DB, fetcher: Fetcher, t: { title: string; artist: string; album: string; durationMs: number }): Promise<LrclibRecord | null> {
  const dur = Math.round(t.durationMs / 1000);
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const get = await cached(db, `lrclib:get:${t.artist}|${t.title}|${t.album}|${dur}`, 30 * DAY, async () => {
    const r = await fetcher(`https://lrclib.net/api/get?${q({ track_name: t.title, artist_name: t.artist, album_name: t.album, duration: String(dur) })}`);
    return r.status === 200 ? await r.json() : null;
  });
  if (get) return get as LrclibRecord;
  const list = await cached(db, `lrclib:search:${t.artist}|${t.title}`, 7 * DAY, async () => {
    const r = await fetcher(`https://lrclib.net/api/search?${q({ track_name: t.title, artist_name: t.artist })}`);
    return r.status === 200 ? await r.json() : [];
  }) as LrclibRecord[];
  const fit = list.filter((c) => Math.abs((c.duration || 0) - dur) <= 3).sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0) || Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur));
  return fit[0] ?? null;
}

export function storeLyricsFromRecord(db: DB, trackId: string, rec: LrclibRecord): 'synced' | 'plain' | 'instrumental' | null {
  if (rec.instrumental) { db.prepare(`INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, 'instrumental', '[]', 'lrclib', ?) ON CONFLICT(track_id) DO UPDATE SET kind = 'instrumental', lines = '[]', source = 'lrclib', fetched_at = excluded.fetched_at`).run(trackId, Date.now()); return 'instrumental'; }
  let lines: LyricLine[] = rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [];
  let kind: 'synced' | 'plain' = 'synced';
  if (!lines.length || !isSynced(lines)) { if (!rec.plainLyrics) return null; lines = rec.plainLyrics.split(/\r?\n/).filter((l) => l.trim()).map((text) => ({ start: null, text })); kind = 'plain'; }
  db.prepare(`INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, ?, ?, 'lrclib', ?) ON CONFLICT(track_id) DO UPDATE SET kind = excluded.kind, lines = excluded.lines, source = 'lrclib', fetched_at = excluded.fetched_at WHERE lyrics.kind != 'synced' OR lyrics.source != 'sidecar'`).run(trackId, kind, JSON.stringify(lines), Date.now());
  return kind;
}

export type EnrichOptions = {
  fetcher?: Fetcher; log?: (m: string) => void; max?: number; acoustidKey?: string; dataDir?: string; bytes?: (url: string) => Promise<Buffer | null>;
  // With saveToLibrary, everything fetched lands in the library too (lyrics
  // as .lrc beside the song, pictures as artist.jpg / cover.jpg in their
  // folders), so it is never fetched again - by this install or any other.
  musicDir?: string; saveToLibrary?: boolean;
};

// Never clobbers: an existing file wins, whatever is in it.
async function writeNew(file: string, data: Buffer | string, log: (m: string) => void): Promise<boolean> {
  try { await fsp.writeFile(file, data, { flag: 'wx' }); return true; }
  catch (e: any) { if (e.code === 'EEXIST') return true; log(`library write ${file}: ${e.message}`); return false; }
}

// One pass: every track without resolved lyrics whose retry time has come.
export async function enrichPass(db: DB, opts: EnrichOptions = {}): Promise<{ done: number; missing: number; instrumental: number }> {
  const fetcher: Fetcher = opts.fetcher ?? ((url) => fetch(url, { headers: { 'User-Agent': UA } }));
  const log = opts.log ?? (() => {});
  // Rows for tracks the scanner added; tracks with a sidecar are done already.
  db.exec(`INSERT OR IGNORE INTO enrich (track_id, lyrics_state, updated) SELECT t.id, CASE WHEN l.track_id IS NULL THEN 'pending' ELSE 'done' END, 0 FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id`);
  db.exec(`UPDATE enrich SET lyrics_state = 'done' WHERE lyrics_state != 'done' AND track_id IN (SELECT track_id FROM lyrics)`);
  const due = db.prepare(`SELECT e.track_id, t.title, t.artist, t.artists, t.album, t.duration_ms, t.path, e.lyrics_tries FROM enrich e JOIN tracks t ON t.id = e.track_id WHERE e.lyrics_state IN ('pending', 'missing') AND e.lyrics_next <= ? ORDER BY e.lyrics_next, t.added_at DESC LIMIT ?`).all(Date.now(), opts.max ?? 500) as any[];
  const stats = { done: 0, missing: 0, instrumental: 0 };
  for (const row of due) {
    const artists: string[] = JSON.parse(row.artists || '[]');
    let rec: LrclibRecord | null = null;
    try {
      // main artist first, then the joined credit
      for (const artist of [...new Set([artists[0] || row.artist, row.artist])]) { rec = await lrclibLookup(db, fetcher, { title: row.title, artist, album: row.album, durationMs: row.duration_ms }); if (rec) break; }
    } catch (e: any) { log(`lrclib ${row.title}: ${e.message}`); }
    const kind = rec ? storeLyricsFromRecord(db, row.track_id, rec) : null;
    // The answer goes beside the song too, as the .lrc the scanner reads.
    if (opts.saveToLibrary && rec && (kind === 'synced' || kind === 'plain')) {
      const text = kind === 'synced' ? rec.syncedLyrics : rec.plainLyrics;
      if (text) await writeNew(row.path.replace(/\.[^.]+$/, '.lrc'), text, log);
    }
    if (kind) { db.prepare(`UPDATE enrich SET lyrics_state = 'done', updated = ? WHERE track_id = ?`).run(Date.now(), row.track_id); if (kind === 'instrumental') stats.instrumental++; else stats.done++; }
    else { const tries = row.lyrics_tries + 1; const next = Date.now() + (tries <= 7 ? DAY : 7 * DAY); db.prepare(`UPDATE enrich SET lyrics_state = 'missing', lyrics_tries = ?, lyrics_next = ?, updated = ? WHERE track_id = ?`).run(tries, next, Date.now(), row.track_id); stats.missing++; }
    await new Promise((r) => setTimeout(r, opts.fetcher ? 0 : 250)); // be polite to LrcLib
  }
  return stats;
}

const normName = (s: string) => s.normalize('NFKC').replace(/[\uFEFF\u200B]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

const upsertArt = (db: DB, hash: string, kind: string, src: string, w: number, h: number) =>
  db.prepare('INSERT OR IGNORE INTO artwork (hash, kind, src, width, height, created) VALUES (?, ?, ?, ?, ?, ?)').run(hash, kind, src, w, h, Date.now());

// The artist's own folder on the share: the parent most of their albums sit
// in, as long as it is a real folder inside the library (not its root).
export function artistDirOf(db: DB, artistId: string, musicDir: string): string | null {
  const dirs = db.prepare('SELECT dir FROM albums WHERE artist_id = ?').all(artistId) as { dir: string }[];
  const count = new Map<string, number>();
  for (const { dir } of dirs) { const p = path.dirname(dir); count.set(p, (count.get(p) ?? 0) + 1); }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const root = path.resolve(musicDir);
  return best && path.resolve(best) !== root && path.resolve(best).startsWith(root + path.sep) ? best : null;
}

const ARTIST_PICS = ['artist.jpg', 'artist.jpeg', 'artist.png', 'artist.webp'];
async function artistPicFrom(dir: string): Promise<{ file: string; buf: Buffer } | null> {
  for (const name of ARTIST_PICS) {
    try { const file = path.join(dir, name); const buf = await fsp.readFile(file); if (buf.length > 2000) return { file, buf }; } catch { /* next */ }
  }
  return null;
}

// Artist pictures (portrait + wide banner): Deezer's artist search, exact
// name match only, the 1000 px picture stored like a cover. Tried a few
// times over increasing gaps; artists Deezer does not know stay blank.
export async function artistImagesPass(db: DB, opts: EnrichOptions = {}): Promise<{ found: number; missing: number }> {
  const fetcher: Fetcher = opts.fetcher ?? ((url) => fetch(url, { headers: { 'User-Agent': UA } }));
  const bytes = opts.bytes ?? (async (url: string) => { const r = await fetch(url, { headers: { 'User-Agent': UA } }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; });
  const log = opts.log ?? (() => {});
  const dataDir = opts.dataDir; if (!dataDir) return { found: 0, missing: 0 };
  const due = db.prepare('SELECT id, name, image_tries FROM artists WHERE image_hash IS NULL AND image_tries < 4 ORDER BY track_count DESC LIMIT ?').all(opts.max ?? 300) as any[];
  const stats = { found: 0, missing: 0 };
  for (const a of due) {
    const dir = opts.musicDir ? artistDirOf(db, a.id, opts.musicDir) : null;
    let stored = false;
    // A picture already in the artist's folder wins: no network at all.
    if (dir) {
      try {
        const local = await artistPicFrom(dir);
        if (local) {
          const { hash, width, height } = await storeArtwork(dataDir, local.buf, { banner: true });
          upsertArt(db, hash, 'artist', local.file, width, height);
          db.prepare('UPDATE artists SET image_hash = ? WHERE id = ?').run(hash, a.id);
          stored = true;
        }
      } catch (e: any) { log(`artist pic ${a.name}: ${e.message}`); }
    }
    let url: string | null = null;
    if (!stored) {
      try {
        const list = await cached(db, `deezer:artist:${normName(a.name)}`, 30 * DAY, async () => {
          const r = await fetcher(`https://api.deezer.com/search/artist?q=${encodeURIComponent(a.name)}&limit=10`);
          return r.status === 200 ? ((await r.json()).data || []).map((d: any) => ({ name: d.name, picture: d.picture_xl || d.picture_big || null })) : [];
        }) as { name: string; picture: string | null }[];
        const hit = list.find((d) => normName(d.name) === normName(a.name) && d.picture && !/artist\/\/?\d*x\d*/.test(d.picture) && !/\/artist\/(1000x1000|500x500)-/.test(d.picture));
        url = hit?.picture ?? null;
      } catch (e: any) { log(`deezer ${a.name}: ${e.message}`); }
    }
    if (!stored && url) {
      try {
        const buf = await bytes(url);
        if (buf && buf.length > 2000) {
          const { hash, width, height } = await storeArtwork(dataDir, buf, { banner: true });
          // Into the library too, so the next pass (or install) never asks Deezer.
          let src = url;
          if (opts.saveToLibrary && dir) { const f = path.join(dir, 'artist.jpg'); if (await writeNew(f, buf, log)) src = f; }
          upsertArt(db, hash, 'artist', src, width, height);
          db.prepare('UPDATE artists SET image_hash = ? WHERE id = ?').run(hash, a.id);
          stored = true;
        }
      } catch (e: any) { log(`artist image ${a.name}: ${e.message}`); }
    }
    if (stored) stats.found++; else { db.prepare('UPDATE artists SET image_tries = image_tries + 1 WHERE id = ?').run(a.id); stats.missing++; }
    await new Promise((r) => setTimeout(r, opts.fetcher ? 0 : 120));
  }
  return stats;
}

// Covers for albums whose folder offered none: Deezer's album search, artist
// and album names matching exactly. The found cover is written into the
// album's folder as cover.jpg (the scanner's own convention), so from then
// on it is simply part of the library.
export async function albumCoversPass(db: DB, opts: EnrichOptions = {}): Promise<{ found: number; missing: number }> {
  const fetcher: Fetcher = opts.fetcher ?? ((url) => fetch(url, { headers: { 'User-Agent': UA } }));
  const bytes = opts.bytes ?? (async (url: string) => { const r = await fetch(url, { headers: { 'User-Agent': UA } }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; });
  const log = opts.log ?? (() => {});
  const dataDir = opts.dataDir; if (!dataDir) return { found: 0, missing: 0 };
  const due = db.prepare('SELECT id, name, artist, dir, cover_tries FROM albums WHERE cover_hash IS NULL AND cover_tries < 4 ORDER BY track_count DESC LIMIT ?').all(opts.max ?? 300) as any[];
  const stats = { found: 0, missing: 0 };
  const root = opts.musicDir ? path.resolve(opts.musicDir) : null;
  for (const al of due) {
    let url: string | null = null;
    try {
      const list = await cached(db, `deezer:album:${normName(al.artist)}|${normName(al.name)}`, 30 * DAY, async () => {
        const r = await fetcher(`https://api.deezer.com/search/album?q=${encodeURIComponent(`${al.artist} ${al.name}`)}&limit=10`);
        return r.status === 200 ? ((await r.json()).data || []).map((d: any) => ({ title: d.title, artist: d.artist?.name ?? '', cover: d.cover_xl || d.cover_big || null })) : [];
      }) as { title: string; artist: string; cover: string | null }[];
      const hit = list.find((d) => normName(d.title) === normName(al.name) && normName(d.artist) === normName(al.artist) && d.cover);
      url = hit?.cover ?? null;
    } catch (e: any) { log(`deezer album ${al.artist} - ${al.name}: ${e.message}`); }
    let stored = false;
    if (url) {
      try {
        const buf = await bytes(url);
        if (buf && buf.length > 2000) {
          const { hash, width, height } = await storeArtwork(dataDir, buf);
          let src = url;
          if (opts.saveToLibrary && root && path.resolve(al.dir).startsWith(root + path.sep)) {
            const f = path.join(al.dir, 'cover.jpg');
            if (await writeNew(f, buf, log)) src = f;
          }
          upsertArt(db, hash, 'album', src, width, height);
          db.prepare('UPDATE albums SET cover_hash = ? WHERE id = ?').run(hash, al.id);
          stored = true;
        }
      } catch (e: any) { log(`album cover ${al.artist} - ${al.name}: ${e.message}`); }
    }
    if (stored) stats.found++; else { db.prepare('UPDATE albums SET cover_tries = cover_tries + 1 WHERE id = ?').run(al.id); stats.missing++; }
    await new Promise((r) => setTimeout(r, opts.fetcher ? 0 : 120));
  }
  return stats;
}

export function enrichStatus(db: DB) {
  return {
    lyrics: Object.fromEntries((db.prepare('SELECT lyrics_state s, COUNT(*) n FROM enrich GROUP BY lyrics_state').all() as any[]).map((r) => [r.s, r.n])),
    kinds: Object.fromEntries((db.prepare('SELECT kind, COUNT(*) n FROM lyrics GROUP BY kind').all() as any[]).map((r) => [r.kind, r.n])),
    missing: (db.prepare(`SELECT t.id, t.title, t.artist, t.album, e.lyrics_tries, e.lyrics_next FROM enrich e JOIN tracks t ON t.id = e.track_id WHERE e.lyrics_state = 'missing' ORDER BY e.lyrics_next LIMIT 50`).all() as any[]),
  };
}
