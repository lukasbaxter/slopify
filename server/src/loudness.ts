// Volume normalization, Spotify-style: every song is measured once (EBU R128
// integrated loudness and true peak, one ffmpeg pass) and played back at a
// common loudness of -14 LUFS, Spotify's "Normal". Loud masters are turned
// down; quiet ones are turned up only as far as their peaks allow (true peak
// stays at or under -1 dBTP), so nothing is ever clipped and no limiter
// touches the music.
//
// An album played as an album keeps its own balance (album gain: one gain
// for every track, from the whole album's loudness), so a quiet interlude
// stays quiet next to the songs around it. Anything else (a playlist, a
// shuffle, a mix) levels track by track.
//
// Where the gain is applied: browsers and the desktop app scale the audio
// themselves (a Web Audio gain node, any stream, lossless included). iPhones
// cannot (no Web Audio there, and an element's volume is fixed at 1), so
// their AAC transcodes carry the gain baked in: a separate cache directory
// per gain value, e.g. transcodes/<id>/aac-320g-5.2.
import type { DB } from './db.js';
import type { Readable } from 'node:stream';

export const TARGET_LUFS = -14;
const PEAK_CEILING = -1;     // dBTP a boost may bring a peak up to
const MAX_CUT = -20, MAX_BOOST = 12;
const SILENT = -60;          // LUFS: below this a "song" is silence or a sound effect; leave it alone

export type Loudness = { loudness: number | null; peak: number | null };

// The gain (dB) that brings a song to the target, or null when it has not
// been measured. A cut is never limited; a boost stops where the true peak
// would pass the ceiling. One decimal: that is also the cache key.
export function gainDb(l: Loudness | null | undefined, target = TARGET_LUFS): number | null {
  if (!l || l.loudness == null || !Number.isFinite(l.loudness)) return null;
  if (l.loudness < SILENT) return 0;
  let g = target - l.loudness;
  if (g > 0 && l.peak != null && Number.isFinite(l.peak)) g = Math.max(0, Math.min(g, PEAK_CEILING - l.peak));
  g = Math.max(MAX_CUT, Math.min(MAX_BOOST, g));
  return Math.round(g * 10) / 10 || 0; // no -0
}

// An album's loudness from its tracks': the energy average weighted by
// length (what measuring the album as one long file would give, near
// enough), and the loudest peak of any of them.
export function albumLoudness(rows: { loudness: number | null; peak: number | null; durationMs: number }[]): Loudness {
  let energy = 0, ms = 0, peak: number | null = null;
  for (const r of rows) {
    if (r.loudness == null || !Number.isFinite(r.loudness) || r.loudness < SILENT) continue;
    const d = Math.max(1, r.durationMs || 0);
    energy += d * 10 ** (r.loudness / 10); ms += d;
    if (r.peak != null && Number.isFinite(r.peak)) peak = peak == null ? r.peak : Math.max(peak, r.peak);
  }
  if (!ms) return { loudness: null, peak: null };
  return { loudness: Math.round(10 * Math.log10(energy / ms) * 100) / 100, peak };
}

// ffmpeg's ebur128 summary (stderr at the end of the run):
//   Integrated loudness:
//     I:         -11.3 LUFS
//   True peak:
//     Peak:        0.4 dBFS
export function parseEbur128(stderr: string): Loudness | null {
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = /^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/m.exec(sum);
  if (!i) return null;
  const p = /^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/m.exec(sum);
  const num = (s: string | undefined) => (s == null ? null : s === '-inf' ? -Infinity : Number(s));
  const loudness = num(i[1]), peak = num(p?.[1]);
  return { loudness: loudness === -Infinity ? -70 : loudness, peak: peak === -Infinity ? -70 : peak };
}

// One song through ffmpeg: decode, measure, discard. `spawn` is stream.ts's
// spawnFf with the song's source already bound (local copy, head + NAS, or
// the file), so this reads exactly what playback reads. The summary is
// logged at info level (pre-input args), the per-frame lines only at verbose.
type Spawn = (pre: string[], post: string[]) => { stderr: Readable | null; on: (ev: string, fn: (...a: any[]) => void) => unknown; kill: (s?: NodeJS.Signals) => boolean };
export function measure(spawn: Spawn, timeoutMs = 120000): Promise<Loudness> {
  return new Promise((resolve, reject) => {
    const ff = spawn(['-v', 'info', '-hide_banner'], ['-map', '0:a:0', '-vn', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']);
    let err = '';
    ff.stderr?.on('data', (d: Buffer) => { err += d; if (err.length > 64 * 1024) err = err.slice(-16 * 1024); });
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    ff.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    ff.on('close', (code: number) => {
      clearTimeout(timer);
      const l = parseEbur128(err);
      if (l) resolve(l); else reject(new Error(`ffmpeg ${code}: ${err.replace(/\s+/g, ' ').slice(-200)}`));
    });
  });
}

// --- the database side --------------------------------------------------------

export function saveTrackLoudness(db: DB, id: string, l: Loudness | null) {
  db.prepare('UPDATE tracks SET loudness = ?, true_peak = ?, loudness_at = ? WHERE id = ?').run(l?.loudness ?? null, l?.peak ?? null, Date.now(), id);
}

// Recompute the album figures for these albums (all of them when none given).
export function refreshAlbumLoudness(db: DB, albumIds?: string[]) {
  const rows = (albumIds
    ? albumIds.flatMap((a) => db.prepare('SELECT album_id, loudness, true_peak, duration_ms FROM tracks WHERE album_id = ?').all(a))
    : db.prepare('SELECT album_id, loudness, true_peak, duration_ms FROM tracks WHERE loudness IS NOT NULL').all()) as any[];
  const by = new Map<string, any[]>();
  for (const r of rows) { const l = by.get(r.album_id); if (l) l.push(r); else by.set(r.album_id, [r]); }
  const set = db.prepare('UPDATE albums SET loudness = ?, true_peak = ? WHERE id = ?');
  db.transaction(() => {
    for (const [id, list] of by) {
      const a = albumLoudness(list.map((r) => ({ loudness: r.loudness, peak: r.true_peak, durationMs: r.duration_ms })));
      set.run(a.loudness, a.peak, id);
    }
  })();
  return by.size;
}

export type GainMode = 'track' | 'album';
// Both gains of one track, for the API rows and for checking a requested
// transcode variant against what the server itself would choose.
export function gainsOf(db: DB, id: string): { track: number | null; album: number | null } | null {
  const r = db.prepare('SELECT t.loudness, t.true_peak, a.loudness AS al, a.true_peak AS ap FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = ?').get(id) as any;
  if (!r) return null;
  return { track: gainDb({ loudness: r.loudness, peak: r.true_peak }), album: gainDb({ loudness: r.al, peak: r.ap }) };
}
// The gain to play a track at in this mode: album gain when asked for and
// known, else the track's own; null = not measured yet (play it as it is).
export function gainFor(db: DB, id: string, mode: GainMode): number | null {
  const g = gainsOf(db, id);
  if (!g) return null;
  return mode === 'album' ? (g.album ?? g.track) : g.track;
}
