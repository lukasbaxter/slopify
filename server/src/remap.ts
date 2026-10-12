// A song whose file was replaced (a re-rip, an MP3 swapped for its FLAC) gets
// a new id: ids are the hash of the decoded audio. Everything a listener did
// with the old one (likes, playlist spots, plays, lyrics) moves to the new id,
// or the playlist shows a blank row and the like is gone.
import fs from 'node:fs';
import type { DB } from './db.js';
import { headPath } from './heads.js';
import { songPath } from './songcache.js';

export function remapTrackId(db: DB, oldId: string, newId: string, cacheDir?: string) {
  if (!newId || oldId === newId) return;
  for (const t of ['likes', 'playlist_tracks', 'plays', 'lyrics']) db.prepare(`UPDATE OR IGNORE ${t} SET track_id = ? WHERE track_id = ?`).run(newId, oldId);
  // What is left was already there for the new id (a like on both), or
  // belongs to the old bytes (timing, enrichment, the cached copies).
  for (const t of ['likes', 'playlist_tracks', 'plays', 'lyrics', 'heads', 'song_cache', 'lyric_align', 'lyric_jobs', 'enrich']) db.prepare(`DELETE FROM ${t} WHERE track_id = ?`).run(oldId);
  // The head AND the whole-song copy belong to the old bytes: dropping only
  // their rows would leave the files stranded on the SSD forever.
  if (cacheDir) {
    try { fs.rmSync(headPath(cacheDir, oldId), { force: true }); } catch { /* cache orphan */ }
    try { fs.rmSync(songPath(cacheDir, oldId), { force: true }); } catch { /* cache orphan */ }
  }
}

type Song = { id: string; title: string; artist: string; album_id: string; duration_ms: number };

// The one track that is clearly the same song: same album and title within
// 5 s, else same artist and title within 3 s. Two candidates = no answer.
function only(rows: { id: string }[]) { return rows.length === 1 ? rows[0].id : null; }
export function findReplacement(db: DB, s: Song, exclude: Set<string>): string | null {
  const pick = (sql: string, ...args: unknown[]) => only((db.prepare(sql).all(...args) as { id: string }[]).filter((r) => r.id !== s.id && !exclude.has(r.id)));
  return pick('SELECT id FROM tracks WHERE album_id = ? AND lower(title) = lower(?) AND abs(duration_ms - ?) <= 5000', s.album_id, s.title, s.duration_ms)
    ?? pick('SELECT id FROM tracks WHERE lower(title) = lower(?) AND lower(artist) = lower(?) AND abs(duration_ms - ?) <= 3000', s.title, s.artist, s.duration_ms);
}

const referenced = (db: DB, id: string) => ['likes', 'playlist_tracks', 'plays'].some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE track_id = ? LIMIT 1`).get(id));

// A track about to leave the library: hand its traces to the replacement if
// it is already here, else remember it (only if anyone used it) so the
// replacement can take them when it lands. Returns the id it went to.
export function retireTrack(db: DB, id: string, exclude: Set<string>, cacheDir?: string): string | null {
  const s = db.prepare('SELECT id, title, artist, album_id, duration_ms FROM tracks WHERE id = ?').get(id) as Song | undefined;
  if (!s) return null;
  const to = findReplacement(db, s, exclude);
  if (to) remapTrackId(db, id, to, cacheDir);
  else if (referenced(db, id)) {
    db.prepare(`INSERT INTO gone_tracks (id, title, artist, album_id, duration_ms, removed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET removed_at = excluded.removed_at`).run(s.id, s.title, s.artist, s.album_id, s.duration_ms, Date.now());
  }
  return to;
}

// A track just added: is it the replacement of one that left earlier? Same
// rules, from the other side. Forgotten after 180 days.
export function adoptGone(db: DB, newId: string, cacheDir?: string): string | null {
  const t = db.prepare('SELECT id, title, artist, album_id, duration_ms FROM tracks WHERE id = ?').get(newId) as Song | undefined;
  if (!t) return null;
  const pick = (sql: string, ...args: unknown[]) => only(db.prepare(sql).all(...args) as { id: string }[]);
  const old = pick('SELECT id FROM gone_tracks WHERE album_id = ? AND lower(title) = lower(?) AND abs(duration_ms - ?) <= 5000', t.album_id, t.title, t.duration_ms)
    ?? pick('SELECT id FROM gone_tracks WHERE lower(title) = lower(?) AND lower(artist) = lower(?) AND abs(duration_ms - ?) <= 3000', t.title, t.artist, t.duration_ms);
  if (!old) return null;
  // Not if the candidate is just as plausibly another track already here.
  const g = db.prepare('SELECT id, title, artist, album_id, duration_ms FROM gone_tracks WHERE id = ?').get(old) as Song;
  if (findReplacement(db, g, new Set()) !== newId) return null;
  remapTrackId(db, old, newId, cacheDir);
  db.prepare('DELETE FROM gone_tracks WHERE id = ?').run(old);
  return old;
}

export function pruneGone(db: DB) {
  db.prepare('DELETE FROM gone_tracks WHERE removed_at < ?').run(Date.now() - 180 * 86400000);
}
