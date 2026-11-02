// Songs that will not play right, found by the brain (it reads two clips of
// every song and lists the ones that gave no audio) and checked here by
// decoding the whole file:
//  - length: the file is fine but the length on record is wrong (an MP3
//    whose header lies: 21 minutes on record, 3:20 of audio). The length
//    is corrected, so the seek bar, the brain's clips and the speakers'
//    "ended" check all line up.
//  - damaged: the audio stops early or breaks (a cut download, a 30 s
//    preview saved as the whole song). Upgrade to FLAC replaces these
//    first, from Soulseek, verified the same way.
//  - empty: not a song (a stub of a few KB, under a second): out of the library.
//  - fine: it decodes; the brain tries again.
// FLAC, ALAC and WAV record their exact length, so a short decode there is
// damage; an MP3's header is a guess, so a clean short decode is a wrong length.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { DB } from './db.js';
import { bumpLibraryVersion } from './db.js';
import { retireTrack } from './remap.js';

export type CheckKind = 'fine' | 'length' | 'damaged' | 'empty' | 'missing';

// Decoded length and decoder complaints, reading the file once front to back.
export function decodeLength(file: string, ffmpeg = 'ffmpeg'): Promise<{ ms: number; errors: number; message: string }> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-progress', 'pipe:1', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('close', () => {
      const us = [...out.matchAll(/out_time_us=(\d+)/g)].map((m) => Number(m[1])).pop() ?? 0;
      const lines = err.split('\n').filter((l) => l.trim());
      resolve({ ms: Math.round(us / 1000), errors: lines.length, message: lines.slice(0, 2).join(' ').slice(0, 300) });
    });
    p.on('error', (e) => resolve({ ms: 0, errors: 1, message: e.message }));
  });
}

const EXACT = /flac|alac|pcm|wav|aiff/i;
export function classify(storedMs: number, decodedMs: number, errors: number, codec: string | null): CheckKind {
  if (decodedMs < 1000 && storedMs < 2000) return 'empty';
  if (decodedMs >= storedMs * 0.97 - 1500) return 'fine';
  if (!EXACT.test(codec || '') && errors === 0) return 'length';
  return 'damaged';
}

export async function checkSongs(db: DB, ids: string[], opts: { cacheDir?: string; log?: (m: string) => void; ffmpeg?: string } = {}) {
  const out: Record<CheckKind, string[]> = { fine: [], length: [], damaged: [], empty: [], missing: [] };
  const get = db.prepare('SELECT id, path, duration_ms, codec, album_id FROM tracks WHERE id = ?');
  const save = db.prepare(`INSERT INTO song_checks (track_id, kind, stored_ms, decoded_ms, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_id) DO UPDATE SET kind = excluded.kind, stored_ms = excluded.stored_ms, decoded_ms = excluded.decoded_ms, error = excluded.error, checked_at = excluded.checked_at`);
  let changed = false;
  for (const id of ids) {
    const t = get.get(id) as { id: string; path: string; duration_ms: number; codec: string | null; album_id: string } | undefined;
    if (!t) continue;
    if (!(await fs.stat(t.path).then((s) => s.isFile(), () => false))) { out.missing.push(id); continue; }
    const d = await decodeLength(t.path, opts.ffmpeg);
    const kind = classify(t.duration_ms, d.ms, d.errors, t.codec);
    out[kind].push(id);
    opts.log?.(`song check ${t.path}: ${kind} (on record ${Math.round(t.duration_ms / 1000)} s, decodes ${Math.round(d.ms / 1000)} s${d.errors ? `, ${d.message}` : ''})`);
    if (kind === 'empty') {
      retireTrack(db, id, new Set([id]), opts.cacheDir);
      db.prepare('DELETE FROM tracks WHERE id = ?').run(id); changed = true;
      continue;
    }
    save.run(id, kind, t.duration_ms, d.ms, d.errors ? d.message : null, Date.now());
    // A wrong length is put right; a damaged MP3 whose header also lies
    // gets its real length too, so the search for a replacement looks for
    // the right song.
    if (kind === 'length' || (kind === 'damaged' && !EXACT.test(t.codec || '') && t.duration_ms > d.ms * 1.3)) {
      db.prepare('UPDATE tracks SET duration_ms = ? WHERE id = ?').run(d.ms, id);
      db.prepare('UPDATE albums SET duration_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM tracks WHERE album_id = ?) WHERE id = ?').run(t.album_id, t.album_id);
      changed = true;
    }
  }
  if (changed) bumpLibraryVersion(db);
  return out;
}

// The length a scan should record for a song: the checked one when its
// header is known to lie.
export function checkedLength(db: DB, id: string): number | null {
  const r = db.prepare("SELECT decoded_ms FROM song_checks WHERE track_id = ? AND kind = 'length'").get(id) as { decoded_ms: number } | undefined;
  return r ? r.decoded_ms : null;
}
