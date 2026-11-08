// With the brain on, these mixes are its own picks from the library, for every
// account that has been listening (brainPlaylist); ListenBrainz's lists are
// the way without a brain.
//
// ListenBrainz in the app: the listens go up (scrobbling), the playlists
// come down. Every Monday each account with a ListenBrainz token gets its
// "Weekly Exploration" (new music: whatever the library lacks is fetched
// from Soulseek through slskd first) and "Weekly Jams"; every morning a
// "Daily Jams". They are ordinary playlists owned by the account, named so
// the Home page's tiles pick the newest of each.
//
// Everything runs inside this process on a minute tick with last-run stamps
// in kv, so a restart never skips or doubles a week.
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { ftsQuery, tracksByIds } from './library.js';
import { playlistId } from './ids.js';
import { brainNext, brainOn } from './brain.js';

const LB = 'https://api.listenbrainz.org/1';
const UA = 'slopify/0.1 (https://github.com/lukasbaxter/slopify)';
// mode: what the brain is asked for (recommend.py): radio leans to the new,
// now to what the listener already loves, smart in between.
const KINDS = {
  'weekly-exploration': { name: 'Weekly Exploration', download: true, weekly: true, mode: 'radio' },
  'weekly-jams': { name: 'Weekly Jams', download: false, weekly: true, mode: 'now' },
  'daily-jams': { name: 'Daily Jams', download: false, weekly: false, mode: 'smart' },
} as const;
const MIX_SIZE = 50;
// Songs the brain may know that left the library are dropped: ask for spare.
const MIX_ASK = 80;
// Building a mix is no hurry, unlike the next song in a queue.
const MIX_TIMEOUT_MS = 20000;
const LISTENER_DAYS = 30, LISTENER_PLAYS = 20;
type Kind = keyof typeof KINDS;

export type ExploreOptions = {
  slskdUrl?: string; slskdKey?: string;
  // slskd's finished-downloads folder as THIS container sees it: fetched
  // tracks are moved from there into musicDir and scanned right away.
  // Without it, downloads stay in slskd's folder for the rest of the stack
  // (an ingest, a manual import) to bring in.
  slskdDownloadsDir?: string; musicDir?: string;
  scanFolders?: (rels: string[]) => Promise<unknown>;
  log?: (m: string) => void; fetcher?: typeof fetch; runScan?: () => Promise<unknown>; now?: () => number;
  // Stand-ins for the brain (tests).
  brainUrl?: string; brainKey?: string; brain?: boolean;
};
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
// Move the tracks slskd finished into the library: each goes to
// <artist>/<album or title>/<original file name>, reusing an existing artist
// folder whatever its case (a case-insensitive share cannot hold two). The
// scanner reads tags, so the folder names only need to be sane.
export function collectFetched(pairs: { file: SlskdFile; t: LbTrack; startedAt?: number }[], o: { downloadsDir: string; musicDir: string; log?: (m: string) => void }): string[] {
  const log = o.log ?? (() => {});
  // NFC first (slskd peers send decomposed names that then mismatch the
  // share's composed ones); trailing dots and spaces stripped too, CIFS
  // cannot store them.
  const safe = (x: string) => String(x || '').normalize('NFC').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '').replace(/[. ]+$/, '').trim() || 'Unknown';
  let entries: string[] = [];
  try { entries = (fs.readdirSync(o.downloadsDir, { recursive: true }) as unknown as string[]).map(String); } catch (e: any) { log(`explore: reading ${o.downloadsDir}: ${e.message}`); return []; }
  const byBase = new Map<string, string[]>();
  for (const e of entries) { const b = path.basename(e); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b)!.push(path.join(o.downloadsDir, e)); }
  let artistDirs = new Map<string, string>();
  try { artistDirs = new Map(fs.readdirSync(o.musicDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => [norm(d.name), d.name])); } catch { /* new library */ }
  const rels = new Set<string>();
  for (const { file, t, startedAt } of pairs) {
    const base = String(file.filename).split(/[\\/]/).pop()!;
    // The downloads dir is SHARED with other consumers (Soularr/Lidarr import
    // album folders from it), so only a file written since this run asked
    // slskd for it (startedAt, minus a minute of clock slack) may be taken;
    // an older twin with the same name and size belongs to someone else.
    // Residual risk: another consumer fetching the very same file inside the
    // same window is indistinguishable by name+size+mtime and would still be
    // picked up here.
    const src = (byBase.get(base) || []).find((p) => {
      try { const s = fs.statSync(p); return s.size === file.size && (!startedAt || s.mtimeMs >= startedAt - 60000); } catch { return false; }
    });
    if (!src) continue; // not downloaded after all
    const artist = artistDirs.get(norm(t.artist)) || safe(t.artist);
    const folder = path.join(artist, safe(t.album || t.title));
    try {
      fs.mkdirSync(path.join(o.musicDir, folder), { recursive: true });
      const dest = path.join(o.musicDir, folder, safe(base));
      let destStat: fs.Stats | null = null;
      try { destStat = fs.statSync(dest); } catch { /* not there: the normal case */ }
      if (destStat && destStat.size !== file.size) {
        // Something else sits at dest (a user's own file, a partial copy).
        // With no db handle here we cannot tell whose it is, so the
        // conservative move is to touch neither: dest stays as it is and the
        // download stays in staging for a later look.
        log(`explore: ${path.join(folder, safe(base))} exists with a different size; leaving ${base} in staging`);
        continue;
      }
      if (!destStat) fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL); // copy+rm: the library may be another filesystem
      // dest already there with the same size: delivered by an earlier run,
      // so only the staging copy goes.
      fs.rmSync(src);
      rels.add(folder);
      log(`explore: ${t.artist} - ${t.title} -> ${path.join(folder, safe(base))}`);
    } catch (e: any) { log(`explore: moving ${base}: ${e.message}`); }
  }
  return [...rels];
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
export async function buildPlaylist(db: DB, uid: string, kind: Kind, opts: ExploreOptions): Promise<{ name: string; matched: number; total: number; fetched: number } | 'no-playlist' | null> {
  const log = opts.log ?? (() => {});
  const creds = lbCreds(db, uid); if (!creds) return null;
  const lists = await lbCreatedFor(opts, creds.user, creds.token);
  const latest = lists.filter((l) => l.kind === kind).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!latest) { log(`explore ${creds.user}: no ${kind} playlist on ListenBrainz yet`); return 'no-playlist'; }
  const key = `explore:${uid}:${kind}`;
  const prev = JSON.parse(kvGet(db, key) || 'null');
  if (prev?.mbid === latest.mbid && db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(prev.playlistId)) return null; // already built
  const tracks = await lbPlaylistTracks(opts, latest.mbid, creds.token);
  const ids = tracks.map((t) => matchTrack(db, t));
  let fetched = 0;
  if (KINDS[kind].download && opts.slskdUrl && opts.slskdKey) {
    const missing = tracks.filter((_, i) => !ids[i]);
    const started: { file: SlskdFile; t: LbTrack; startedAt: number }[] = [];
    for (const t of missing) {
      try {
        const startedAt = (opts.now ?? Date.now)(); // before the download ask: collectFetched and slskdWait ignore anything older
        const file = await slskdFind(opts, t);
        if (file && await slskdDownload(opts, file)) { started.push({ file, t, startedAt }); log(`explore: fetching ${t.artist} - ${t.title} from ${file.username}`); }
      } catch (e: any) { log(`explore: ${t.artist} - ${t.title}: ${e.message}`); }
    }
    if (started.length) {
      fetched = await slskdWait(opts, started.map((s) => s.file), 25 * 60 * 1000, started[0].startedAt);
      if (opts.slskdDownloadsDir && opts.musicDir) {
        const rels = collectFetched(started, { downloadsDir: opts.slskdDownloadsDir, musicDir: opts.musicDir, log });
        if (rels.length) await (opts.scanFolders ? opts.scanFolders(rels) : opts.runScan?.());
      } else await opts.runScan?.();
      tracks.forEach((t, i) => { if (!ids[i]) ids[i] = matchTrack(db, t); });
    }
  }
  const trackIds = ids.filter((x): x is string => !!x);
  const name = `${KINDS[kind].name} ${latest.date}`;
  savePlaylist(db, uid, kind, name, trackIds, { mbid: latest.mbid, date: latest.date, total: tracks.length });
  log(`explore ${creds.user}: ${name}: ${trackIds.length}/${tracks.length} in the library (${fetched} fetched)`);
  return { name, matched: trackIds.length, total: tracks.length, fetched };
}

// The playlist goes in, the one it follows goes out unless someone changed it.
function savePlaylist(db: DB, uid: string, kind: Kind, name: string, trackIds: string[], from: { mbid: string; date: string; total: number }) {
  const key = `explore:${uid}:${kind}`;
  const prev = JSON.parse(kvGet(db, key) || 'null');
  const now = Date.now();
  db.transaction(() => {
    if (prev?.playlistId) {
      // Replace the previous generated playlist only if it still holds
      // exactly the tracks we put in it (kept as trackIds in kv). Any edit
      // since means the user made it theirs: keep it, the new one appears
      // alongside. A kv entry from before trackIds were stored also keeps it.
      const cur = (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(prev.playlistId) as any[]).map((r) => r.track_id);
      const untouched = Array.isArray(prev.trackIds) && cur.length === prev.trackIds.length && cur.every((x, i) => x === prev.trackIds[i]);
      if (untouched) db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(prev.playlistId, uid);
    }
    const id = playlistId();
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run(id, uid, name, now, now);
    trackIds.forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run(id, i, t, now));
    kvSet(db, key, JSON.stringify({ mbid: from.mbid, playlistId: id, date: from.date, built: now, matched: trackIds.length, total: from.total, trackIds }));
    // Keep the last four of each kind; older ones go. Only names matching the
    // exact generated pattern "<Name> YYYY-MM-DD" count — a user's own
    // "Weekly Exploration faves" must never be pruned by a LIKE match.
    const pat = new RegExp(`^${KINDS[kind].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d{4}-\\d{2}-\\d{2}$`);
    const old = (db.prepare('SELECT id, name FROM playlists WHERE user_id = ? AND name LIKE ? ORDER BY name DESC').all(uid, `${KINDS[kind].name} %`) as any[]).filter((o) => pat.test(o.name));
    for (const o of old.slice(4)) db.prepare('DELETE FROM playlists WHERE id = ?').run(o.id);
  })();
}

// The brain's mix for one account: a read of its picks and a playlist written.
// Nobody's playback is touched, and a brain that is off or does not answer
// (null) leaves the account to ListenBrainz. Exploration leaves out everything
// the listener has played: that is what makes it new.
export async function brainPlaylist(db: DB, uid: string, kind: Kind, opts: ExploreOptions) {
  const exclude = KINDS[kind].mode === 'radio' ? (db.prepare('SELECT DISTINCT track_id id FROM plays WHERE user_id = ?').all(uid) as any[]).map((r) => r.id as string) : [];
  const ids = await brainNext(db, { user: uid, mode: KINDS[kind].mode, seeds: [], n: MIX_ASK, exclude }, { url: opts.brainUrl, key: opts.brainKey, fetcher: opts.fetcher, timeoutMs: MIX_TIMEOUT_MS, log: opts.log });
  if (!ids) return null;
  const trackIds = ids.slice(0, MIX_SIZE);
  const date = new Date((opts.now ?? Date.now)()).toLocaleDateString('en-CA');
  const name = `${KINDS[kind].name} ${date}`;
  savePlaylist(db, uid, kind, name, trackIds, { mbid: 'brain', date, total: trackIds.length });
  (opts.log ?? (() => {}))(`explore ${uid.slice(0, 6)}: ${name}: ${trackIds.length} songs from the brain`);
  return { name, matched: trackIds.length, total: trackIds.length, fetched: 0 };
}

// Who gets a mix: with the brain, everyone listening lately; else who has a token.
function mixAccounts(db: DB, brain: boolean, now: number): string[] {
  const all = (db.prepare('SELECT id FROM users').all() as any[]).map((u) => u.id as string);
  if (!brain) return all.filter((id) => lbCreds(db, id));
  const active = new Set((db.prepare('SELECT user_id id FROM plays WHERE at > ? GROUP BY user_id HAVING COUNT(*) >= ?').all(now - LISTENER_DAYS * 86400000, LISTENER_PLAYS) as any[]).map((r) => r.id as string));
  return all.filter((id) => active.has(id) || lbCreds(db, id));
}

export async function exploreAll(db: DB, opts: ExploreOptions, kinds: Kind[]) {
  const brain = opts.brain ?? brainOn(db);
  const built: any[] = [];
  let failures = 0; // throws, plus accounts whose ListenBrainz list has no such playlist yet
  for (const uid of mixAccounts(db, brain, (opts.now ?? Date.now)())) {
    for (const k of kinds) {
      try {
        const mine = brain ? await brainPlaylist(db, uid, k, opts) : null;
        if (mine) { built.push({ user: uid, ...mine }); continue; }
        if (!lbCreds(db, uid)) { if (brain) failures++; continue; }
        const r = await buildPlaylist(db, uid, k, opts); if (r === 'no-playlist') failures++; else if (r) built.push({ user: uid, ...r });
      } catch (e: any) { failures++; (opts.log ?? (() => {}))(`explore ${uid} ${k}: ${e.message}`); }
    }
  }
  return { built, failures };
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

// Weekly on Monday from 06:30, daily from 07:15, whichever minute the process is awake.
// The last-run stamp is written only AFTER a run that worked: something was
// built, or every list was fetched and there was simply nothing new. A
// throw or an account with no ListenBrainz playlist yet leaves the stamp
// unset so the run is retried — and the try-stamp backs those retries off
// to one an hour, so a ListenBrainz outage is not hammered every minute.
export function exploreScheduler(db: DB, run: (kinds: Kind[]) => Promise<any>) {
  const attempt = (slot: 'weekly' | 'daily', kinds: Kind[], at: number) => {
    const tried = kvGet(db, `explore:try:${slot}`) || '0';
    if (at - Number(tried) < 3600000) return;
    kvSet(db, `explore:try:${slot}`, String(at));
    void run(kinds).then((r: any) => {
      // Another run was going (the other slot, the button): not a try; next minute again.
      if (r?.running) { kvSet(db, `explore:try:${slot}`, tried); return; }
      if (Array.isArray(r?.built) && (r.built.length > 0 || r.failures === 0)) kvSet(db, `explore:last:${slot}`, String(at));
    });
  };
  return (now = new Date()) => {
    const at = now.getTime();
    const day = now.getDay(), mins = now.getHours() * 60 + now.getMinutes();
    const lastWeekly = Number(kvGet(db, 'explore:last:weekly') || 0), lastDaily = Number(kvGet(db, 'explore:last:daily') || 0);
    // Each on its own: on a Monday whose weekly run had not worked yet, the
    // weekly one kept winning and Daily Jams never ran that day.
    if (day === 1 && mins >= 390 && at - lastWeekly > 6 * 86400000) attempt('weekly', ['weekly-exploration', 'weekly-jams'], at);
    if (mins >= 435 && new Date(lastDaily).toDateString() !== now.toDateString()) attempt('daily', ['daily-jams'], at);
  };
}

export function registerExplore(app: FastifyInstance, db: DB, opts: ExploreOptions) {
  const log = (m: string) => app.log.info(m);
  // With an ingest (new music on the SSD, library on the NAS) the fresh downloads are taken in by a sweep, not a walk of the NAS.
  const o = { ...opts, log, runScan: async () => { const ing = (app as any).ingest; if (ing) { await ing.sweep({ settleMs: 60000 }); (app as any).runAfterScan?.(); return; } await (app as any).runScan?.(); /* wait for it */ for (let i = 0; i < 600; i++) { if (!(app as any).scanning?.()) break; await new Promise((r) => setTimeout(r, 1000)); } } };
  let running = false;
  const run = async (kinds: Kind[]) => { if (running) return { running: true }; running = true; try { return await exploreAll(db, o, kinds); } finally { running = false; } };
  app.decorate('exploreRun', run);
  app.decorate('exploreStatus', () => ({
    running,
    lastWeekly: Number(kvGet(db, 'explore:last:weekly') || 0) || null, lastDaily: Number(kvGet(db, 'explore:last:daily') || 0) || null,
    brain: brainOn(db),
    users: (db.prepare('SELECT id, name FROM users').all() as any[]).filter((u) => mixAccounts(db, brainOn(db), Date.now()).includes(u.id)).map((u) => ({ name: u.name, ...Object.fromEntries((Object.keys(KINDS) as Kind[]).map((k) => [k, JSON.parse(kvGet(db, `explore:${u.id}:${k}`) || 'null')])) })),
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
  const tick = exploreScheduler(db, run);
  if (process.env.NODE_ENV !== 'test') setInterval(() => tick(), 60000).unref();
  app.post('/api/admin/explore', { preHandler: (app as any).requireAdmin }, async (req) => {
    const kinds = ((req.body as any)?.kinds as Kind[] | undefined)?.filter((k) => k in KINDS) ?? (['weekly-exploration', 'weekly-jams', 'daily-jams'] as Kind[]);
    const job = run(kinds);
    // The brain answers in seconds, so the button can say what happened; the
    // ListenBrainz way can sit on Soulseek for half an hour, and just runs on.
    const done: any = await Promise.race([job, new Promise((r) => { setTimeout(r, 15000, null); })]);
    return { started: true, kinds, built: done?.built?.length ?? null, failures: done?.failures ?? null };
  });
  app.get('/api/admin/explore', { preHandler: (app as any).requireAdmin }, async () => (app as any).exploreStatus());
}
