// Home's Daily Mixes, truly daily: one per listener and artist, made on the
// first ask of the listener's local day and kept (daily_mixes) until the next
// one, through restarts. The day is the listener's own: the browser's
// offset (?tzo=, minutes as getTimezoneOffset reports them), else the last
// one it sent, else this server's.
//
// With BRAIN_DAILY_MIXES=1 and the brain on, the songs around the artist are
// the ones that sound like the artist's songs this listener plays most (CLAP,
// brain /similar); a brain that is off, slow or old means the usual mix for
// that one, never a wait past BRAIN_TIMEOUT_MS.
import crypto from 'node:crypto';
import type { DB } from './db.js';
import { config } from './config.js';
import { brainSimilar, dislikedOf } from './brain.js';

// Songs kept per mix; a request for fewer gets the start of it, so the mix's
// page (50) and Play on Home (100) agree.
export const DAILY_SIZE = 100;
const KEEP_MS = 30 * 86400_000; // mixes of artists not asked for in a month go

export type DailyMix = { ids: string[]; from: 'brain' | 'own'; day: string };
// Makes the mix's songs; `sounds` = the brain's picks, closest first; `day`
// = the listener's day it is for (the day picks the artist's own songs).
export type MakeMix = (sounds?: string[], day?: string) => Promise<{ id: string }[]>;
type BrainOpts = { url?: string; key?: string; timeoutMs?: number; fetcher?: typeof fetch };

// The listener's calendar day at `now`, YYYY-MM-DD.
export const dayOf = (now: number, tzo: number) => new Date(now - tzo * 60000).toISOString().slice(0, 10);

const tzoOf = (x: unknown): number | null => {
  if (x === undefined || x === null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? Math.round(n) : null;
};

// The artist's songs this listener plays most (some of them, different ones
// most days), or any of theirs when they have not played them here.
function seedsOf(db: DB, artistId: string, uid: string, day: string): string[] {
  const like = `%"${artistId}"%`;
  const played = (db.prepare('SELECT p.track_id id, COUNT(*) n FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? AND t.artist_ids LIKE ? GROUP BY p.track_id ORDER BY n DESC LIMIT 12').all(uid, like) as any[]).map((r) => r.id as string);
  const pool = played.length ? played : (db.prepare('SELECT id FROM tracks WHERE artist_ids LIKE ? LIMIT 200').all(like) as any[]).map((r) => r.id as string);
  // the day picks which: stable within it, different across days
  const rank = (id: string) => crypto.createHash('sha1').update(`${day}|${id}`).digest().readUInt32BE(0);
  return [...pool].sort((a, b) => rank(a) - rank(b)).slice(0, 5);
}

const inflight = new Map<string, Promise<DailyMix>>();

export async function dailyMix(db: DB, artistId: string, uid: string, make: MakeMix,
  o: { tzo?: unknown; now?: number; brain?: boolean; brainOpts?: BrainOpts; log?: (m: string) => void } = {}): Promise<DailyMix> {
  const now = o.now ?? Date.now();
  const last = db.prepare('SELECT tzo FROM daily_mixes WHERE user_id = ? ORDER BY made DESC LIMIT 1').get(uid) as { tzo: number } | undefined;
  const tzo = tzoOf(o.tzo) ?? last?.tzo ?? new Date(now).getTimezoneOffset();
  const day = dayOf(now, tzo);
  const kept = db.prepare('SELECT day, track_ids, source FROM daily_mixes WHERE user_id = ? AND artist_id = ?').get(uid, artistId) as { day: string; track_ids: string; source: string } | undefined;
  // a later day than today (the listener flew west) is still today's mix
  const fresh = (k: typeof kept) => k && k.day >= day;
  const out = (k: NonNullable<typeof kept>): DailyMix => {
    const dis = new Set(dislikedOf(db, uid));
    return { ids: (JSON.parse(k.track_ids) as string[]).filter((id) => !dis.has(id)), from: k.source === 'brain' ? 'brain' : 'own', day: k.day };
  };
  if (fresh(kept)) return out(kept!);

  const key = `${uid}|${artistId}|${day}`;
  let job = inflight.get(key);
  if (!job) {
    job = (async (): Promise<DailyMix> => {
      let sounds: string[] | null = null;
      if (o.brain ?? config.brain.dailyMixes) {
        const seeds = seedsOf(db, artistId, uid, day);
        const seed = crypto.createHash('sha1').update(key).digest().readUInt32BE(0);
        sounds = await brainSimilar(db, { user: uid, seeds, n: DAILY_SIZE, exclude: seeds, seed }, { ...o.brainOpts, log: o.log });
      }
      const ids = (await make(sounds ?? undefined, day)).map((t) => t.id).slice(0, DAILY_SIZE);
      const from = sounds ? 'brain' : 'own';
      db.prepare(`INSERT INTO daily_mixes (user_id, artist_id, day, tzo, track_ids, source, made) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, artist_id) DO UPDATE SET day = excluded.day, tzo = excluded.tzo, track_ids = excluded.track_ids, source = excluded.source, made = excluded.made`)
        .run(uid, artistId, day, tzo, JSON.stringify(ids), from, now);
      db.prepare('DELETE FROM daily_mixes WHERE made < ?').run(now - KEEP_MS);
      o.log?.(`daily mix ${artistId.slice(0, 6)} for ${uid.slice(0, 6)} on ${day}: ${ids.length} songs (${from})`);
      return { ids, from, day };
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const made = await job, dis = new Set(dislikedOf(db, uid));
  return { ...made, ids: made.ids.filter((id) => !dis.has(id)) };
}
