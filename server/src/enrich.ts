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
import type { DB } from './db.js';
import { parseLrc, isSynced, type LyricLine } from './lyrics.js';

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

export type EnrichOptions = { fetcher?: Fetcher; log?: (m: string) => void; max?: number; acoustidKey?: string };

// One pass: every track without resolved lyrics whose retry time has come.
export async function enrichPass(db: DB, opts: EnrichOptions = {}): Promise<{ done: number; missing: number; instrumental: number }> {
  const fetcher: Fetcher = opts.fetcher ?? ((url) => fetch(url, { headers: { 'User-Agent': UA } }));
  const log = opts.log ?? (() => {});
  // Rows for tracks the scanner added; tracks with a sidecar are done already.
  db.exec(`INSERT OR IGNORE INTO enrich (track_id, lyrics_state, updated) SELECT t.id, CASE WHEN l.track_id IS NULL THEN 'pending' ELSE 'done' END, 0 FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id`);
  db.exec(`UPDATE enrich SET lyrics_state = 'done' WHERE lyrics_state != 'done' AND track_id IN (SELECT track_id FROM lyrics)`);
  const due = db.prepare(`SELECT e.track_id, t.title, t.artist, t.artists, t.album, t.duration_ms, e.lyrics_tries FROM enrich e JOIN tracks t ON t.id = e.track_id WHERE e.lyrics_state IN ('pending', 'missing') AND e.lyrics_next <= ? ORDER BY e.lyrics_next, t.added_at DESC LIMIT ?`).all(Date.now(), opts.max ?? 500) as any[];
  const stats = { done: 0, missing: 0, instrumental: 0 };
  for (const row of due) {
    const artists: string[] = JSON.parse(row.artists || '[]');
    let rec: LrclibRecord | null = null;
    try {
      // main artist first, then the joined credit
      for (const artist of [...new Set([artists[0] || row.artist, row.artist])]) { rec = await lrclibLookup(db, fetcher, { title: row.title, artist, album: row.album, durationMs: row.duration_ms }); if (rec) break; }
    } catch (e: any) { log(`lrclib ${row.title}: ${e.message}`); }
    const kind = rec ? storeLyricsFromRecord(db, row.track_id, rec) : null;
    if (kind) { db.prepare(`UPDATE enrich SET lyrics_state = 'done', updated = ? WHERE track_id = ?`).run(Date.now(), row.track_id); if (kind === 'instrumental') stats.instrumental++; else stats.done++; }
    else { const tries = row.lyrics_tries + 1; const next = Date.now() + (tries <= 7 ? DAY : 7 * DAY); db.prepare(`UPDATE enrich SET lyrics_state = 'missing', lyrics_tries = ?, lyrics_next = ?, updated = ? WHERE track_id = ?`).run(tries, next, Date.now(), row.track_id); stats.missing++; }
    await new Promise((r) => setTimeout(r, opts.fetcher ? 0 : 250)); // be polite to LrcLib
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
