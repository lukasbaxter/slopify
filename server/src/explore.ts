// ListenBrainz in the app: the listens go up (scrobbling), the playlists
// come down. Every Monday each account with a ListenBrainz token gets its
// "Weekly Exploration" (new music: whatever the library lacks is fetched
// from Soulseek through slskd first) and "Weekly Jams"; every morning a
// "Daily Jams". They are ordinary playlists owned by the account, named so
// the Home page's tiles pick the newest of each.
//
// Everything runs inside this process on a minute tick with last-run stamps
// in kv, so a restart never skips or doubles a week.
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { ftsQuery, tracksByIds } from './library.js';
import { playlistId } from './ids.js';

const LB = 'https://api.listenbrainz.org/1';
const UA = 'slopify/0.1 (https://github.com/lukasbaxter/slopify)';
const KINDS = {
  'weekly-exploration': { name: 'Weekly Exploration', download: true, weekly: true },
  'weekly-jams': { name: 'Weekly Jams', download: false, weekly: true },
  'daily-jams': { name: 'Daily Jams', download: false, weekly: false },
} as const;
type Kind = keyof typeof KINDS;

export type ExploreOptions = { slskdUrl?: string; slskdKey?: string; log?: (m: string) => void; fetcher?: typeof fetch; runScan?: () => Promise<unknown>; now?: () => number };
type LbTrack = { title: string; artist: string; album?: string; mbid?: string };

const norm = (s: string) => (s || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const kvGet = (db: DB, k: string) => (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any)?.v as string | undefined;
const kvSet = (db: DB, k: string, v: string) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);

export function lbCreds(db: DB, uid: string): { user: string; token: string } | null {
  const p = JSON.parse((db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(uid) as any)?.json ?? '{}');
  const lb = p.listenbrainz || {};
  return lb.token && lb.user ? { user: String(lb.user).trim(), token: String(lb.token).trim() } : null;
}

// --- library matching -------------------------------------------------------
export function matchTrack(db: DB, t: LbTrack): string | null {
  // Title words through FTS (all of them), the artist checked loosely after:
  // "feat." credits and spelling variants must not lose the match.
  const fq = ftsQuery(t.title);
  if (!fq) return null;
  let rows: any[] = [];
  try { rows = db.prepare('SELECT t.id, t.title, t.artist, t.artists, t.album FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH ? LIMIT 60').all(fq); } catch { return null; }
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
export async function slskdFind(opts: ExploreOptions, t: LbTrack): Promise<SlskdFile | null> {
  if (!opts.slskdUrl || !opts.slskdKey) return null;
  const f = opts.fetcher ?? fetch;
  const H = { 'X-API-Key': opts.slskdKey, 'Content-Type': 'application/json' };
  const r = await f(`${opts.slskdUrl}/api/v0/searches`, { method: 'POST', headers: H, body: JSON.stringify({ searchText: `${t.artist} ${t.title}`, filterResponses: true, fileLimit: 2000, responseLimit: 100, searchTimeout: 8000 }) });
  if (!r.ok) throw new Error(`slskd search ${r.status}`);
  const { id } = await r.json() as any;
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, opts.fetcher ? 0 : 1000));
    const s = await (await f(`${opts.slskdUrl}/api/v0/searches/${id}`, { headers: H })).json() as any;
    if (s.state && /Completed|Errored|TimedOut|Cancelled/.test(s.state)) break;
  }
  const responses = await (await f(`${opts.slskdUrl}/api/v0/searches/${id}/responses`, { headers: H })).json() as any[];
  const nt = norm(t.title), na = norm(t.artist);
  const cands: (SlskdFile & { score: number })[] = [];
  for (const resp of responses || []) for (const file of resp.files || []) {
    const name = String(file.filename || ''); const base = norm(name.split(/[\\/]/).pop() || ''); const full = norm(name);
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!['flac', 'mp3'].includes(ext)) continue;
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
// Wait until every started download has finished (or failed), up to `ms`.
export async function slskdWait(opts: ExploreOptions, files: SlskdFile[], ms: number) {
  const f = opts.fetcher ?? fetch;
  const H = { 'X-API-Key': opts.slskdKey! };
  const t0 = Date.now();
  const done = new Set<string>();
  while (Date.now() - t0 < ms && done.size < files.length) {
    const all = await (await f(`${opts.slskdUrl}/api/v0/transfers/downloads`, { headers: H })).json() as any[];
    for (const u of all || []) for (const d of u.directories || []) for (const x of d.files || []) {
      if (files.some((w) => w.filename === x.filename) && /Completed|Succeeded|Errored|Cancelled|Rejected|TimedOut/.test(String(x.state))) done.add(x.filename);
    }
    if (done.size < files.length) await new Promise((res) => setTimeout(res, opts.fetcher ? 0 : 5000));
  }
  return done.size;
}

// --- ListenBrainz ------------------------------------------------------------
async function lbGet(opts: ExploreOptions, path: string, token?: string) {
  const f = opts.fetcher ?? fetch;
  const r = await f(`${LB}${path}`, { headers: { 'User-Agent': UA, ...(token ? { Authorization: `Token ${token}` } : {}) } });
  if (!r.ok) throw new Error(`listenbrainz ${path}: ${r.status}`);
  return r.json();
}
export async function lbCreatedFor(opts: ExploreOptions, user: string, token: string): Promise<{ kind: Kind; mbid: string; date: string }[]> {
  const j = await lbGet(opts, `/user/${encodeURIComponent(user)}/playlists/createdfor?count=25`, token) as any;
  const out: { kind: Kind; mbid: string; date: string }[] = [];
  for (const p of j.playlists || []) {
    const pl = p.playlist || {};
    const ext = pl.extension?.['https://musicbrainz.org/doc/jspf#playlist'] || {};
    const source = ext.additional_metadata?.algorithm_metadata?.source_patch || '';
    const kind = (Object.keys(KINDS) as Kind[]).find((k) => source === k || new RegExp(KINDS[k].name.replace(' ', '.?'), 'i').test(pl.title || ''));
    if (!kind) continue;
    const mbid = String(pl.identifier || '').split('/').pop() || '';
    out.push({ kind, mbid, date: String(pl.date || '').slice(0, 10) });
  }
  return out;
}
export async function lbPlaylistTracks(opts: ExploreOptions, mbid: string, token: string): Promise<LbTrack[]> {
  const j = await lbGet(opts, `/playlist/${mbid}`, token) as any;
  return (j.playlist?.track || []).map((t: any) => ({ title: t.title, artist: t.creator, album: t.album, mbid: String(t.identifier?.[0] || t.identifier || '').split('/').pop() }));
}

// --- the job -------------------------------------------------------------------
export async function buildPlaylist(db: DB, uid: string, kind: Kind, opts: ExploreOptions): Promise<{ name: string; matched: number; total: number; fetched: number } | null> {
  const log = opts.log ?? (() => {});
  const creds = lbCreds(db, uid); if (!creds) return null;
  const lists = await lbCreatedFor(opts, creds.user, creds.token);
  const latest = lists.filter((l) => l.kind === kind).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!latest) { log(`explore ${creds.user}: no ${kind} playlist on ListenBrainz yet`); return null; }
  const key = `explore:${uid}:${kind}`;
  const prev = JSON.parse(kvGet(db, key) || 'null');
  if (prev?.mbid === latest.mbid && db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(prev.playlistId)) return null; // already built
  const tracks = await lbPlaylistTracks(opts, latest.mbid, creds.token);
  const ids = tracks.map((t) => matchTrack(db, t));
  let fetched = 0;
  if (KINDS[kind].download && opts.slskdUrl && opts.slskdKey) {
    const missing = tracks.filter((_, i) => !ids[i]);
    const started: SlskdFile[] = [];
    for (const t of missing) {
      try { const file = await slskdFind(opts, t); if (file && await slskdDownload(opts, file)) { started.push(file); log(`explore: fetching ${t.artist} - ${t.title} from ${file.username}`); } }
      catch (e: any) { log(`explore: ${t.artist} - ${t.title}: ${e.message}`); }
    }
    if (started.length) {
      fetched = await slskdWait(opts, started, 25 * 60 * 1000);
      await opts.runScan?.();
      tracks.forEach((t, i) => { if (!ids[i]) ids[i] = matchTrack(db, t); });
    }
  }
  const trackIds = ids.filter((x): x is string => !!x);
  const name = `${KINDS[kind].name} ${latest.date}`;
  const now = Date.now();
  db.transaction(() => {
    if (prev?.playlistId) db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(prev.playlistId, uid);
    const id = playlistId();
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid, name, now, now);
    trackIds.forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t, now));
    kvSet(db, key, JSON.stringify({ mbid: latest.mbid, playlistId: id, date: latest.date, built: now, matched: trackIds.length, total: tracks.length }));
    // Keep the last four of each kind; older ones go.
    const old = db.prepare('SELECT id FROM playlists WHERE user_id = ? AND name LIKE ? ORDER BY name DESC').all(uid, `${KINDS[kind].name} %`) as any[];
    for (const o of old.slice(4)) db.prepare('DELETE FROM playlists WHERE id = ?').run(o.id);
  })();
  log(`explore ${creds.user}: ${name}: ${trackIds.length}/${tracks.length} in the library (${fetched} fetched)`);
  return { name, matched: trackIds.length, total: tracks.length, fetched };
}

export async function exploreAll(db: DB, opts: ExploreOptions, kinds: Kind[]) {
  const users = db.prepare('SELECT id FROM users').all() as any[];
  const out: any[] = [];
  for (const u of users) {
    if (!lbCreds(db, u.id)) continue;
    for (const k of kinds) { try { const r = await buildPlaylist(db, u.id, k, opts); if (r) out.push({ user: u.id, ...r }); } catch (e: any) { (opts.log ?? (() => {}))(`explore ${u.id} ${k}: ${e.message}`); } }
  }
  return out;
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

export function registerExplore(app: FastifyInstance, db: DB, opts: ExploreOptions) {
  const log = (m: string) => app.log.info(m);
  const o = { ...opts, log, runScan: async () => { await (app as any).runScan?.(); /* wait for it */ for (let i = 0; i < 600; i++) { if (!(app as any).scanning?.()) break; await new Promise((r) => setTimeout(r, 1000)); } } };
  let running = false;
  const run = async (kinds: Kind[]) => { if (running) return { running: true }; running = true; try { return await exploreAll(db, o, kinds); } finally { running = false; } };
  app.decorate('exploreRun', run);
  app.decorate('exploreStatus', () => ({
    running,
    lastWeekly: Number(kvGet(db, 'explore:last:weekly') || 0) || null, lastDaily: Number(kvGet(db, 'explore:last:daily') || 0) || null,
    users: (db.prepare('SELECT id, name FROM users').all() as any[]).filter((u) => lbCreds(db, u.id)).map((u) => ({ name: u.name, ...Object.fromEntries((Object.keys(KINDS) as Kind[]).map((k) => [k, JSON.parse(kvGet(db, `explore:${u.id}:${k}`) || 'null')])) })),
    slskd: !!(opts.slskdUrl && opts.slskdKey),
  }));
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
  // Weekly on Monday from 06:30, daily from 07:15, whichever minute the process is awake.
  const tick = () => {
    const now = new Date();
    const day = now.getDay(), mins = now.getHours() * 60 + now.getMinutes();
    const lastWeekly = Number(kvGet(db, 'explore:last:weekly') || 0), lastDaily = Number(kvGet(db, 'explore:last:daily') || 0);
    if (day === 1 && mins >= 390 && Date.now() - lastWeekly > 6 * 86400000) { kvSet(db, 'explore:last:weekly', String(Date.now())); void run(['weekly-exploration', 'weekly-jams']); }
    else if (mins >= 435 && new Date(lastDaily).toDateString() !== now.toDateString()) { kvSet(db, 'explore:last:daily', String(Date.now())); void run(['daily-jams']); }
  };
  if (process.env.NODE_ENV !== 'test') setInterval(tick, 60000).unref();
  app.post('/api/admin/explore', { preHandler: (app as any).requireAdmin }, async (req) => {
    const kinds = ((req.body as any)?.kinds as Kind[] | undefined)?.filter((k) => k in KINDS) ?? (['weekly-exploration', 'weekly-jams', 'daily-jams'] as Kind[]);
    void run(kinds);
    return { started: true, kinds };
  });
  app.get('/api/admin/explore', { preHandler: (app as any).requireAdmin }, async () => (app as any).exploreStatus());
}
