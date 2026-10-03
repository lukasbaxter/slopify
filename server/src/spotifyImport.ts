// Import from a Spotify data export: listening history, Liked Songs, saved
// albums and playlists, matched against this library.
//
// Spotify sends two different downloads, both "my_spotify_data.zip":
//   - Account data: YourLibrary.json (liked songs + saved albums, no dates),
//     Playlist1.json.. (playlists with the date each song was added),
//     StreamingHistory_music_N.json (the last year: endTime, msPlayed).
//   - Extended streaming history: Streaming_History_Audio_*.json (every
//     play since the account started: ts, ms_played, spotify_track_uri).
// Either zip, the JSON files inside them, or both at once. A play counts
// from 30 seconds, as Spotify counts it. Plays are keyed by their start
// time, so importing the same export twice adds nothing. Playlists that
// already exist here under the same name are left alone.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { z } from 'zod';
import type { DB } from './db.js';
import { playlistId } from './ids.js';
import { matchTrack } from './explore.js';
import { startJob, jobOut, type Job } from './jobs.js';

type Song = { artist: string; title: string; album?: string };
type Play = Song & { at: number };
type Playlist = { name: string; items: (Song & { added: number })[] };
export type Parsed = { plays: Play[]; basicPlays: Play[]; likes: Song[]; albums: { artist: string; album: string }[]; playlists: Playlist[]; files: string[] };

const MIN_MS = 30000;
const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Zip-bomb guard: fflate's filter sees each entry's declared originalSize
// before inflating, so oversized entries are skipped and the whole unzip is
// abandoned once the cumulative inflated size passes the budget.
const MAX_ENTRY = 256 * 1024 * 1024; // one JSON file
const MAX_INFLATED = 1024 * 1024 * 1024; // whole archive

// Everything readable in one upload (a zip or a single JSON file) goes into `into`.
export function parseExport(name: string, bytes: Uint8Array, into: Parsed) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let inflated = 0;
  const files: [string, Uint8Array][] = isZip
    ? Object.entries(unzipSync(bytes, { filter: (f) => {
        if (!/\.json$/i.test(f.name) || /__MACOSX/.test(f.name) || f.originalSize > MAX_ENTRY) return false;
        inflated += f.originalSize;
        if (inflated > MAX_INFLATED) throw new Error('zip expands too large to import');
        return true;
      } }))
    : [[name, bytes]];
  for (const [fname, data] of files) {
    const base = fname.split('/').pop() || fname;
    if (/podcast|video|audiobook|search|inferences|userdata|identity|marquee|payments|follow|wrapped/i.test(base)) continue;
    let j: any; try { j = JSON.parse(strFromU8(data)); } catch { continue; }
    let used = true;
    if (Array.isArray(j) && j.length && 'ts' in j[0] && ('master_metadata_track_name' in j[0] || 'ms_played' in j[0])) {
      for (const e of j) {
        if (!e.master_metadata_track_name || !e.master_metadata_album_artist_name || (e.ms_played ?? 0) < MIN_MS) continue;
        const end = Date.parse(e.ts); if (!end) continue;
        into.plays.push({ title: e.master_metadata_track_name, artist: e.master_metadata_album_artist_name, album: e.master_metadata_album_album_name || undefined, at: end - (e.ms_played || 0) });
      }
    } else if (Array.isArray(j) && j.length && 'endTime' in j[0] && 'trackName' in j[0]) {
      for (const e of j) {
        if (!e.trackName || !e.artistName || (e.msPlayed ?? 0) < MIN_MS) continue;
        const end = Date.parse(String(e.endTime).replace(' ', 'T') + 'Z'); if (!end) continue;
        into.basicPlays.push({ title: e.trackName, artist: e.artistName, at: end - (e.msPlayed || 0) });
      }
    } else if (j && Array.isArray(j.playlists)) {
      for (const p of j.playlists) {
        const items = (p.items || []).map((it: any) => it.track && it.track.trackName && it.track.artistName
          ? { title: it.track.trackName, artist: it.track.artistName, album: it.track.albumName || undefined, added: Date.parse(it.addedDate || '') || 0 } : null).filter(Boolean);
        if (p.name) into.playlists.push({ name: String(p.name).slice(0, 120), items });
      }
    } else if (j && (Array.isArray(j.tracks) || Array.isArray(j.albums))) {
      for (const t of j.tracks || []) if (t.track && t.artist) into.likes.push({ title: t.track, artist: t.artist, album: t.album || undefined });
      for (const a of j.albums || []) if (a.album && a.artist) into.albums.push({ artist: a.artist, album: a.album });
    } else used = false;
    if (used) into.files.push(base);
  }
}

// Spotify decorates titles the library usually does not: "Song - Remastered
// 2011", "Song - Radio Edit", "Song (feat. X)". Tried plain first, then without.
const stripped = (t: string) => t.replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|live|single|bonus|from|mix).*$/i, '').replace(/\s*[([]feat\.?[^)\]]*[)\]]/i, '').trim();

export async function importSpotify(db: DB, uid: string, parsed: Parsed, job?: Job) {
  const step = (s: string, p?: number) => { if (job) { job.step = s; job.progress = p ?? null; } };
  const plays = parsed.plays.length ? parsed.plays : parsed.basicPlays; // the extended history covers the basic one
  // Every distinct song once.
  const songs = new Map<string, Song & { count: number }>();
  const key = (s: Song) => `${norm(s.artist)}|${norm(s.title)}`;
  const note = (s: Song, n = 0) => { const k = key(s); const e = songs.get(k); if (e) e.count += n; else songs.set(k, { ...s, count: n }); };
  for (const p of plays) note(p, 1);
  for (const s of parsed.likes) note(s);
  for (const pl of parsed.playlists) for (const s of pl.items) note(s);

  const found = new Map<string, string | null>();
  let i = 0;
  for (const [k, s] of songs) {
    let id = matchTrack(db, s);
    if (!id) { const t2 = stripped(s.title); if (t2 && t2 !== s.title) id = matchTrack(db, { ...s, title: t2 }); }
    found.set(k, id);
    if (++i % 200 === 0) { step(`Matching songs to your library: ${i} of ${songs.size}`, i / songs.size); await new Promise((r) => setImmediate(r)); }
  }
  step('Saving');
  const out = {
    files: parsed.files,
    plays: { total: plays.length, matched: 0, added: 0 },
    likes: { total: parsed.likes.length, matched: 0, added: 0 },
    albums: { total: parsed.albums.length, matched: 0, added: 0 },
    playlists: { total: parsed.playlists.length, created: 0, skipped: [] as string[], songs: 0, songsMatched: 0 },
    songs: { total: songs.size, matched: [...found.values()].filter(Boolean).length },
    missing: [] as { artist: string; title: string; plays: number }[],
  };
  db.transaction(() => {
    const insPlay = db.prepare("INSERT OR IGNORE INTO plays (user_id, track_id, at, client) VALUES (?, ?, ?, 'spotify')");
    for (const p of plays) { const id = found.get(key(p)); if (!id) continue; out.plays.matched++; out.plays.added += insPlay.run(uid, id, p.at).changes; }
    // Liked Songs has no dates in the export; keep its order (newest first) a second apart.
    const insLike = db.prepare('INSERT INTO likes (user_id, track_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
    const t0 = Date.now();
    parsed.likes.forEach((s, n) => { const id = found.get(key(s)); if (!id) return; out.likes.matched++; out.likes.added += insLike.run(uid, id, t0 - n * 1000).changes; });
    const albumRows = db.prepare('SELECT id, name, artist FROM albums').all() as { id: string; name: string; artist: string }[];
    const albumBy = new Map(albumRows.map((a) => [`${norm(a.artist)}|${norm(a.name)}`, a.id]));
    const insAlbum = db.prepare('INSERT INTO album_likes (user_id, album_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
    parsed.albums.forEach((a, n) => { const id = albumBy.get(`${norm(a.artist)}|${norm(a.album)}`); if (!id) return; out.albums.matched++; out.albums.added += insAlbum.run(uid, id, t0 - n * 1000).changes; });
    const have = new Set((db.prepare('SELECT name FROM playlists WHERE user_id = ?').all(uid) as any[]).map((r) => String(r.name).toLowerCase()));
    const insPl = db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)');
    const insPt = db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)');
    for (const pl of parsed.playlists) {
      if (have.has(pl.name.toLowerCase())) { out.playlists.skipped.push(pl.name); continue; }
      const ids = pl.items.map((s) => ({ id: found.get(key(s)), added: s.added })).filter((x) => x.id);
      out.playlists.songs += pl.items.length; out.playlists.songsMatched += ids.length;
      const id = playlistId(); const created = Math.min(...pl.items.map((s) => s.added || t0), t0);
      const updated = Math.max(0, ...pl.items.map((s) => s.added || 0)) || t0;
      insPl.run(id, uid, pl.name, created, updated);
      ids.forEach((x, pos) => insPt.run(id, pos, x.id, x.added || t0));
      have.add(pl.name.toLowerCase()); out.playlists.created++;
    }
  })();
  out.missing = [...songs.entries()].filter(([k]) => !found.get(k)).map(([, s]) => ({ artist: s.artist, title: s.title, plays: s.count }))
    .sort((a, b) => b.plays - a.plays).slice(0, 100);
  return out;
}

export function registerSpotifyImport(app: FastifyInstance, db: DB, dataDir: string) {
  const auth = { preHandler: (app as any).requireUser };
  const dir = path.join(dataDir, 'imports');
  const MAX = 2 * 1024 * 1024 * 1024;
  // Disk-fill guard: each user may hold a few pending uploads within a byte
  // budget; anything beyond is refused until an import consumes them (or the
  // daily cleanup below does).
  const MAX_PENDING = 3;
  const MAX_PENDING_BYTES = 512 * 1024 * 1024;
  // One file per request, streamed to disk (an extended history zip can run to hundreds of MB).
  app.post('/api/import/spotify/upload', auth, async (req: any, reply) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true }); }
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`${req.user.id}-`) && f.endsWith('.bin'));
    if (mine.length >= MAX_PENDING) return reply.code(429).send({ error: 'too many pending uploads — import them first' });
    const pendingBytes = mine.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
    const budget = Math.min(MAX, MAX_PENDING_BYTES - pendingBytes);
    if (budget <= 0) return reply.code(413).send({ error: 'pending uploads are too large — import them first' });
    const id = `${req.user.id}-${crypto.randomBytes(6).toString('hex')}`;
    const name = String(req.headers['x-filename'] || 'upload').replace(/[^\w. -]/g, '_').slice(0, 100);
    const file = path.join(dir, `${id}.bin`);
    const out = fs.createWriteStream(file); let n = 0;
    try {
      for await (const c of req.raw) { n += c.length; if (n > budget) throw new Error('too large'); if (!out.write(c)) await new Promise<void>((r) => out.once('drain', () => r())); }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    } catch (e: any) { out.destroy(); fs.rmSync(file, { force: true }); return reply.code(e?.message === 'too large' ? 413 : 400).send({ error: e?.message || 'upload failed' }); }
    fs.writeFileSync(path.join(dir, `${id}.name`), name);
    return { fileId: id, bytes: n };
  });
  app.post('/api/import/spotify', auth, async (req: any, reply) => {
    const b = z.object({ fileIds: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(40) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'fileIds required' });
    const uid = req.user.id as string;
    if (b.data.fileIds.some((f) => !f.startsWith(`${uid}-`) || !fs.existsSync(path.join(dir, `${f}.bin`)))) return reply.code(404).send({ error: 'upload not found' });
    const job = startJob(uid, 'spotify-import', async (j) => {
      const parsed: Parsed = { plays: [], basicPlays: [], likes: [], albums: [], playlists: [], files: [] };
      try {
        for (const f of b.data.fileIds) {
          j.step = 'Reading the export';
          const name = fs.existsSync(path.join(dir, `${f}.name`)) ? fs.readFileSync(path.join(dir, `${f}.name`), 'utf8') : f;
          parseExport(name, fs.readFileSync(path.join(dir, `${f}.bin`)), parsed);
        }
      } finally { for (const f of b.data.fileIds) for (const x of ['bin', 'name']) fs.rmSync(path.join(dir, `${f}.${x}`), { force: true }); }
      if (!parsed.files.length) throw new Error('No Spotify data found in that file. Upload the my_spotify_data.zip Spotify emailed you, or the JSON files inside it.');
      const r = await importSpotify(db, uid, parsed, j);
      app.log.info({ uid, plays: r.plays, likes: r.likes, playlists: r.playlists.created }, 'spotify import');
      return r;
    });
    return jobOut(job);
  });
}
