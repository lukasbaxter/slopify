// ListenBrainz scrobbling, plus the shared helpers other features use:
// matching a title + artist to a library track (AI playlists, Spotify
// import) and fetching one track from Soulseek through slskd (Upgrade to
// FLAC). Slopify makes no weekly or daily playlists of its own here: Home's
// Made For You is the Daily Mixes (dailymix.ts) and nothing else.
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { ftsQuery, tracksByIds } from './library.js';

const LB = 'https://api.listenbrainz.org/1';
const UA = 'slopify/0.1 (https://github.com/lukasbaxter/slopify)';

export type ExploreOptions = {
  slskdUrl?: string; slskdKey?: string;
  log?: (m: string) => void; fetcher?: typeof fetch;
};
type LbTrack = { title: string; artist: string; album?: string; mbid?: string };

const norm = (s: string) => (s || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function lbCreds(db: DB, uid: string): { user: string; token: string } | null {
  const p = JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid) as any)?.json ?? '{}');
  const lb = p.listenbrainz || {};
  return lb.token && lb.user ? { user: String(lb.user).trim(), token: String(lb.token).trim() } : null;
}

// --- library matching -------------------------------------------------------
export function matchTrack(db: DB, t: LbTrack): string | null {
  // Title words through FTS (all of them), the artist checked loosely after:
  // "feat." credits and spelling variants must not lose the match. Title +
  // artist words first: a common title ("Intro", "Home") has more than 60
  // rows in a big library and the right one fell off the end.
  const fq = ftsQuery(t.title);
  if (!fq) return null;
  const q = db.prepare('SELECT t.id, t.title, t.artist, t.artists, t.album FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH ? LIMIT 60');
  const firstArtistWord = norm(t.artist).split(' ').find((w) => w.length > 1);
  let rows: any[] = [];
  try { if (firstArtistWord) rows = q.all(`${fq} "${firstArtistWord}"*`); } catch { /* fall through to the title alone */ }
  if (!rows.length) { try { rows = q.all(fq); } catch { return null; } }
  const nt = norm(t.title), na = norm(t.artist);
  let best: { id: string; score: number } | null = null;
  for (const r of rows) {
    const rt = norm(r.title); if (rt !== nt && !rt.startsWith(nt) && !nt.startsWith(rt)) continue;
    const artists = [r.artist, ...JSON.parse(r.artists || '[]')].map(norm);
    const artistOk = artists.some((a) => a === na || a.includes(na) || na.includes(a));
    if (!artistOk) continue;
    const score = (rt === nt ? 2 : 1) + (artists[0] === na ? 1 : 0) + (t.album && norm(r.album) === norm(t.album) ? 1 : 0);
    if (!best || score > best.score) best = { id: r.id, score };
  }
  return best?.id ?? null;
}

// --- slskd: find and fetch one track ----------------------------------------
type SlskdFile = { username: string; filename: string; size: number; bitRate?: number; extension?: string; hasFreeUploadSlot: boolean; queueLength: number };
export async function slskdFind(opts: ExploreOptions, t: LbTrack, pick: { formats?: string[]; durationS?: number } = {}): Promise<SlskdFile | null> {
  if (!opts.slskdUrl || !opts.slskdKey) return null;
  const formats = pick.formats ?? ['flac', 'mp3'];
  const f = opts.fetcher ?? fetch;
  const H = { 'X-API-Key': opts.slskdKey, 'Content-Type': 'application/json' };
  const r = await f(`${opts.slskdUrl}/api/v0/searches`, { method: 'POST', headers: H, body: JSON.stringify({ searchText: `${t.artist} ${t.title}`, filterResponses: true, fileLimit: 2000, responseLimit: 100, searchTimeout: 8000 }) });
  if (!r.ok) throw new Error(`slskd search ${r.status}`);
  const { id } = await r.json() as any;
  let terminal = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, opts.fetcher ? 0 : 1000));
    const s = await (await f(`${opts.slskdUrl}/api/v0/searches/${id}`, { headers: H })).json() as any;
    if (s.state && /Completed|Errored|TimedOut|Cancelled/.test(s.state)) { terminal = true; break; }
  }
  // Still running after the poll budget: give it one more cycle rather than
  // reading a half-filled response list as the final answer.
  if (!terminal) await new Promise((res) => setTimeout(res, opts.fetcher ? 0 : 1000));
  const responses = await (await f(`${opts.slskdUrl}/api/v0/searches/${id}/responses`, { headers: H })).json() as any[];
  // Done with it: drop the search record so slskd's list does not grow
  // forever (the flac task reuses this and runs hourly). Best effort only.
  try { await f(`${opts.slskdUrl}/api/v0/searches/${id}`, { method: 'DELETE', headers: H }); } catch { /* slskd will age it out */ }
  const nt = norm(t.title), na = norm(t.artist);
  const cands: (SlskdFile & { score: number })[] = [];
  for (const resp of responses || []) for (const file of resp.files || []) {
    const name = String(file.filename || ''); const base = norm(name.split(/[\\/]/).pop() || ''); const full = norm(name);
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!formats.includes(ext)) continue;
    if (pick.durationS && file.length && Math.abs(Number(file.length) - pick.durationS) > 4) continue;
    const kbps = Number(file.bitRate) || (ext === 'flac' ? 1000 : 0);
    if (ext === 'mp3' && kbps && kbps < 256) continue;
    if (!base.includes(nt) || !(full.includes(na) || base.includes(na))) continue;
    if (/remix|live|karaoke|instrumental|cover/.test(base) && !/remix|live|karaoke|instrumental|cover/.test(nt)) continue;
    const score = (ext === 'flac' ? 100 : Math.min(kbps, 320) / 4) + (resp.hasFreeUploadSlot ? 20 : 0) - Math.min(resp.queueLength || 0, 50) + (resp.uploadSpeed ? Math.min(resp.uploadSpeed / 100000, 10) : 0);
    cands.push({ username: resp.username, filename: name, size: file.size, bitRate: kbps, extension: ext, hasFreeUploadSlot: !!resp.hasFreeUploadSlot, queueLength: resp.queueLength || 0, score });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0] ?? null;
}
export async function slskdDownload(opts: ExploreOptions, file: SlskdFile): Promise<boolean> {
  const f = opts.fetcher ?? fetch;
  const H = { 'X-API-Key': opts.slskdKey!, 'Content-Type': 'application/json' };
  const r = await f(`${opts.slskdUrl}/api/v0/transfers/downloads/${encodeURIComponent(file.username)}`, { method: 'POST', headers: H, body: JSON.stringify([{ filename: file.filename, size: file.size }]) });
  return r.ok;
}

// Wait until every started download has finished (or failed), up to `ms`;
// returns how many actually SUCCEEDED (an Errored end stops the waiting for
// that file but is not a fetch). slskd keeps historical transfer records, so
// with `since` (when slskdDownload was called, minus a minute of slack) any
// record requested before it is an old run's and is ignored — a stale
// Errored row must not end the wait instantly or be mistaken for this run.
export async function slskdWait(opts: ExploreOptions, files: SlskdFile[], ms: number, since?: number) {
  const f = opts.fetcher ?? fetch;
  const H = { 'X-API-Key': opts.slskdKey! };
  const t0 = Date.now();
  const done = new Set<string>(); const won = new Set<string>();
  while (Date.now() - t0 < ms && done.size < files.length) {
    const all = await (await f(`${opts.slskdUrl}/api/v0/transfers/downloads`, { headers: H })).json() as any[];
    for (const u of all || []) for (const d of u.directories || []) for (const x of d.files || []) {
      if (!files.some((w) => w.filename === x.filename)) continue;
      const ts = Date.parse(x.requestedAt || x.enqueuedAt || x.startedAt || '');
      if (since && Number.isFinite(ts) && ts < since - 60000) continue; // a record from an earlier run of the same file
      const state = String(x.state);
      if (/Completed|Succeeded|Errored|Cancelled|Rejected|TimedOut/.test(state)) {
        done.add(x.filename);
        if (/Succeeded/.test(state)) won.add(x.filename);
      }
    }
    if (done.size < files.length) await new Promise((res) => setTimeout(res, opts.fetcher ? 0 : 5000));
  }
  return won.size;
}

// --- scrobbling ------------------------------------------------------------------
// A play counts as a listen once half of it (or 4 minutes) has gone by with
// the track still on, or a later play started that much later.
export function submitListen(db: DB, opts: ExploreOptions, uid: string, trackId: string, startedAt: number) {
  const creds = lbCreds(db, uid); if (!creds) return;
  const t = tracksByIds(db, [trackId])[0]; if (!t) return;
  const f = opts.fetcher ?? fetch;
  const body = { listen_type: 'single', payload: [{ listened_at: Math.floor(startedAt / 1000), track_metadata: { artist_name: t.artist, track_name: t.title, release_name: t.album || undefined, additional_info: { duration_ms: t.durationMs, media_player: 'Slopify', submission_client: 'Slopify' } } }] };
  f(`${LB}/submit-listens`, { method: 'POST', headers: { Authorization: `Token ${creds.token}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) })
    .then(async (r) => { if (!r.ok) (opts.log ?? (() => {}))(`listenbrainz submit ${r.status}: ${(await r.text()).slice(0, 120)}`); })
    .catch((e) => (opts.log ?? (() => {}))(`listenbrainz submit: ${e.message}`));
}

export function registerScrobbling(app: FastifyInstance, db: DB, opts: ExploreOptions = {}) {
  const o = { ...opts, log: (m: string) => app.log.info(m) };
  // Scrobble: the session tells us a play started; we confirm it after half the track.
  const pending = new Map<string, NodeJS.Timeout>();
  app.decorate('scrobbleStart', (uid: string, trackId: string, at: number) => {
    if (!lbCreds(db, uid)) return;
    const t = tracksByIds(db, [trackId])[0]; if (!t) return;
    const wait = Math.min(t.durationMs / 2, 240000);
    const key = `${uid}:${trackId}:${at}`;
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      const s = (app as any).sessionOf?.(uid);
      const still = s && s.trackId === trackId && (s.playing || s.positionMs >= wait);
      const later = db.prepare('SELECT 1 FROM plays WHERE user_id = ? AND at >= ? LIMIT 1').get(uid, at + wait);
      if (still || later) submitListen(db, o, uid, trackId, at);
    }, wait).unref());
  });
}
