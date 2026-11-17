// Single songs fetched straight from Soulseek, without Lidarr: chart songs,
// and songs from playlists the server pulls in. Lidarr thinks in albums and
// gets slow past a few hundred thousand of them; a chart is single songs, so
// they come one at a time here:
//   wantSong()   puts a song in line (once; not when the library has it)
//   the task     every quarter hour: finishes what slskd downloaded (plays
//                through, by the right artist, then into the library as
//                <Artist>/<Album>/ and scanned), then searches for the next
//                few in line, most wanted first. A song nobody has is tried
//                again later, less and less often, then left.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import type { TaskDef } from './tasks.js';
import { playsThrough } from './tasks.js';
import { decodeLength } from './damage.js';
import { matchTrack, slskdFind, slskdDownload } from './explore.js';
import { safeName } from './downloads.js';

export type WantedSong = { artist: string; title: string; album?: string | null; durationS?: number | null; source: string; priority?: number };
// Accents do not count ("ADELA" is "Adéla").
const norm = (s: string) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// "Dracula (feat. X)" and "Dracula" are one song; the first credited artist decides.
export const songKey = (artist: string, title: string) => `${norm(String(artist).split(/,|&| feat\.? | ft\.? | x | with /i)[0])}|${norm(title)}`;

// Wait between tries for a song nobody had: an hour, six, a day, three days,
// a week; after that it is left (state 'missing') until the retry chore.
const BACKOFF_MS = [3600e3, 6 * 3600e3, 86400e3, 3 * 86400e3, 7 * 86400e3];

// In line once. A song the library already has is noted as such. A higher
// priority (a chart moving up) raises it; nothing ever lowers it.
export function wantSong(db: DB, s: WantedSong, now = Date.now()): 'have' | 'queued' | 'known' {
  if (!s.artist?.trim() || !s.title?.trim()) return 'known';
  const key = songKey(s.artist, s.title);
  const row = db.prepare('SELECT state, priority FROM song_wants WHERE key = ?').get(key) as { state: string; priority: number } | undefined;
  if (row) {
    if ((s.priority ?? 0) > row.priority) db.prepare('UPDATE song_wants SET priority = ? WHERE key = ?').run(s.priority ?? 0, key);
    return row.state === 'got' ? 'have' : 'known';
  }
  const have = matchTrack(db, { artist: s.artist, title: s.title, album: s.album ?? undefined });
  db.prepare(`INSERT INTO song_wants (key, artist, title, album, duration_s, source, priority, state, added, track_id, done)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, s.artist.trim(), s.title.trim(), s.album ?? null, s.durationS ?? null, s.source, s.priority ?? 0,
    have ? 'got' : 'wanted', now, have, have ? now : null);
  return have ? 'have' : 'queued';
}

type Row = { id: number; key: string; artist: string; title: string; album: string | null; duration_s: number | null; tries: number; peer: string | null; file: string | null; size: number | null; started: number | null };
export type FetchOptions = {
  slskdUrl?: string; slskdKey?: string; downloadsDir?: string; musicDir: string;
  scan: (rel: string[]) => Promise<unknown>;
  fetcher?: typeof fetch; log?: (m: string) => void;
  plays?: (file: string) => Promise<boolean>; artistOf?: (file: string) => Promise<string | null>; albumOf?: (file: string) => Promise<string | null>;
  searchGapMs?: number;
};
const defaultPlays = async (file: string) => { let stated = 0; try { stated = ((await parseFile(file, { duration: true })).format.duration ?? 0) * 1000; } catch { return false; } return playsThrough(await decodeLength(file), stated); };
const tagsOf = async (file: string) => { try { return (await parseFile(file)).common; } catch { return null; } };

// Where slskd puts a download: <downloads>/<the remote folder's name>/<file name>.
export const localPath = (downloadsDir: string, remote: string) => {
  const parts = remote.split(/[\\/]/).filter(Boolean);
  return path.join(downloadsDir, parts.length > 1 ? parts[parts.length - 2] : '', parts[parts.length - 1]);
};

// One run: settle downloads, then search for up to `perRun` more.
export async function fetchSongs(db: DB, o: FetchOptions, perRun: number, now = () => Date.now()) {
  const log = o.log ?? (() => {});
  const out = { got: 0, failed: 0, started: 0, notFound: 0, already: 0, waiting: 0 };
  if (!o.slskdUrl || !o.slskdKey || !o.downloadsDir) return out;
  const f = o.fetcher ?? fetch;
  const H = { 'X-API-Key': o.slskdKey };
  const plays = o.plays ?? defaultPlays;
  const artistOf = o.artistOf ?? (async (file: string) => { const c = await tagsOf(file); return c ? [c.albumartist, c.artist, ...(c.artists || [])].filter(Boolean).join(' ') : null; });
  const albumOf = o.albumOf ?? (async (file: string) => (await tagsOf(file))?.album ?? null);
  const retryLater = (r: Row, note: string) => {
    const tries = r.tries + 1;
    const wait = BACKOFF_MS[Math.min(tries - 1, BACKOFF_MS.length - 1)];
    db.prepare("UPDATE song_wants SET state = ?, tries = ?, next_try = ?, peer = NULL, file = NULL, size = NULL, started = NULL, note = ? WHERE id = ?")
      .run(tries >= BACKOFF_MS.length ? 'missing' : 'wanted', tries, now() + wait, note, r.id);
  };

  // 1. What slskd has been downloading for us.
  const busy = db.prepare("SELECT * FROM song_wants WHERE state = 'downloading'").all() as Row[];
  if (busy.length) {
    const all = await (await f(`${o.slskdUrl}/api/v0/transfers/downloads`, { headers: H })).json() as any[];
    const state = new Map<string, string>();
    for (const u of all || []) for (const d of u.directories || []) for (const x of d.files || []) state.set(`${u.username}\n${x.filename}`, String(x.state));
    for (const r of busy) {
      const st = state.get(`${r.peer}\n${r.file}`) || '';
      if (/Succeeded/.test(st)) {
        const local = localPath(o.downloadsDir, r.file!);
        try {
          if (!fs.existsSync(local)) throw new Error('the download is not where slskd said');
          if (!(await plays(local))) throw new Error('does not play through');
          const by = norm(await artistOf(local) || ''), want = norm(r.artist.split(/,|&| feat/i)[0]);
          if (by && !(by.includes(want) || want.includes(by))) throw new Error(`the file is by ${by}`);
          const album = (await albumOf(local)) || r.album || 'Singles';
          const rel = path.join(safeName(r.artist.split(/,| & | feat\.? /i)[0]), safeName(album));
          const dest = path.join(o.musicDir, rel, path.basename(local));
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          if (fs.existsSync(dest)) throw new Error('a file of that name is in the library');
          try { await fsp.rename(local, dest); } catch { await fsp.copyFile(local, dest); await fsp.rm(local, { force: true }); }
          await o.scan([rel]);
          const id = matchTrack(db, { artist: r.artist, title: r.title });
          db.prepare("UPDATE song_wants SET state = 'got', done = ?, track_id = ?, note = NULL WHERE id = ?").run(now(), id, r.id);
          out.got++; log(`${r.artist} - ${r.title}: in the library`);
        } catch (e: any) {
          await fsp.rm(local, { force: true }).catch(() => {});
          retryLater(r, e.message); out.failed++; log(`${r.artist} - ${r.title}: ${e.message}, trying another copy later`);
        }
      } else if (/Errored|Cancelled|Rejected|TimedOut|Failed/.test(st) || (!st && now() - (r.started || 0) > 10 * 60e3) || now() - (r.started || 0) > 6 * 3600e3) {
        retryLater(r, st ? `the download ${st.toLowerCase()}` : 'the download went missing'); out.failed++;
      } else out.waiting++;
    }
  }

  // 2. The next few in line, most wanted first.
  const next = db.prepare("SELECT * FROM song_wants WHERE state = 'wanted' AND next_try <= ? ORDER BY priority DESC, added LIMIT ?").all(now(), perRun) as Row[];
  for (const [i, r] of next.entries()) {
    if (i && o.searchGapMs) await new Promise((res) => setTimeout(res, o.searchGapMs));
    const have = matchTrack(db, { artist: r.artist, title: r.title, album: r.album ?? undefined });
    if (have) { db.prepare("UPDATE song_wants SET state = 'got', done = ?, track_id = ? WHERE id = ?").run(now(), have, r.id); out.already++; continue; }
    try {
      const file = await slskdFind({ slskdUrl: o.slskdUrl, slskdKey: o.slskdKey, fetcher: o.fetcher }, { artist: r.artist, title: r.title }, { durationS: r.duration_s ?? undefined });
      if (!file) { retryLater(r, 'nobody on Soulseek has it'); out.notFound++; continue; }
      if (!(await slskdDownload({ slskdUrl: o.slskdUrl, slskdKey: o.slskdKey, fetcher: o.fetcher }, file))) { retryLater(r, 'slskd would not start the download'); out.failed++; continue; }
      db.prepare("UPDATE song_wants SET state = 'downloading', peer = ?, file = ?, size = ?, started = ? WHERE id = ?").run(file.username, file.filename, file.size, now(), r.id);
      out.started++;
    } catch (e: any) { retryLater(r, e.message); out.failed++; }
  }
  return out;
}

export function songFetchTask(db: DB, o: Omit<FetchOptions, 'scan'> & { app: FastifyInstance }): TaskDef {
  return {
    id: 'songs', name: 'Fetch songs', schedule: { mode: 'interval', hours: 0.25 }, alongside: true,
    settings: [{ key: 'perRun', label: 'Songs searched per run', type: 'number', min: 1, max: 100, default: 20 }],
    description: 'Fetch single songs (charts, pulled playlists) from Soulseek, check they play, and shelve them in the library',
    info: () => {
      const c = Object.fromEntries((db.prepare('SELECT state, COUNT(*) n FROM song_wants GROUP BY state').all() as { state: string; n: number }[]).map((r) => [r.state, r.n]));
      return `${c.wanted || 0} wanted, ${c.downloading || 0} downloading, ${c.got || 0} fetched, ${c.missing || 0} not found`;
    },
    run: async (ctx) => {
      if (!o.slskdUrl || !o.slskdKey || !o.downloadsDir) return 'slskd is not configured (SLSKD_URL / SLSKD_API_KEY / SLSKD_DOWNLOADS_DIR)';
      const scan = (rel: string[]) => ((o.app as any).scanFolders as (r: string[]) => Promise<unknown>)(rel);
      const r = await fetchSongs(db, { ...o, scan, log: ctx.log, searchGapMs: 6000 }, ctx.setting<number>('perRun'));
      return `${r.got} songs shelved, ${r.started} downloads started, ${r.waiting} still downloading, ${r.notFound} not found, ${r.failed} failed${r.already ? `, ${r.already} already here` : ''}`;
    },
  };
}
