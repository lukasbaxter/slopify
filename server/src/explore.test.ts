import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { buildPlaylist, collectFetched, matchTrack, slskdFind, slskdWait } from './explore.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-explore-'));

describe('ListenBrainz playlists in the app', () => {
  const db = openDb(DATA);
  let first: any, second: any;
  beforeAll(async () => {
    await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
    [first, second] = db.prepare('SELECT id, title, artist, album FROM tracks GROUP BY title, artist HAVING COUNT(*) = 1 ORDER BY title LIMIT 2').all() as any[];
    db.prepare('INSERT INTO users (id, name, pass_hash, role, created) VALUES (?, ?, ?, ?, ?)').run('u1', 'lb', 'x', 'user', Date.now());
    db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run('u1', JSON.stringify({ listenbrainz: { user: 'lbuser', token: 'tok' } }), Date.now());
  }, 120000);

  it('matches a ListenBrainz track to a library track by title + artist, loosely', () => {
    expect(matchTrack(db, { title: first.title, artist: first.artist })).toBe(first.id);
    expect(matchTrack(db, { title: first.title.toUpperCase(), artist: `${first.artist} feat. Someone` })).toBe(first.id);
    expect(matchTrack(db, { title: 'No Such Song At All', artist: first.artist })).toBeNull();
    expect(matchTrack(db, { title: first.title, artist: 'Completely Different Artist' })).toBeNull();
  });

  it('picks the best Soulseek file: flac over mp3, mp3 only at 256 kbps+, title and artist in the path', async () => {
    const fetcher: any = async (url: string, init?: any) => {
      if (url.endsWith('/api/v0/searches') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 's1' }) };
      if (url.endsWith('/searches/s1')) return { ok: true, json: async () => ({ state: 'Completed' }) };
      if (url.endsWith('/responses')) return { ok: true, json: async () => [
        { username: 'a', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 500000, files: [{ filename: 'Music\\Artist X\\Album\\03 Song Y.mp3', size: 1, bitRate: 128 }, { filename: 'Music\\Artist X\\Album\\03 Song Y.flac', size: 2 }] },
        { username: 'b', hasFreeUploadSlot: false, queueLength: 9, files: [{ filename: 'Other\\Song Y (Live).flac', size: 3 }, { filename: 'Artist X - Song Y.mp3', size: 4, bitRate: 320 }] },
      ] };
      throw new Error(`unexpected ${url}`);
    };
    const f = await slskdFind({ slskdUrl: 'http://s', slskdKey: 'k', fetcher }, { title: 'Song Y', artist: 'Artist X' });
    expect(f?.filename).toBe('Music\\Artist X\\Album\\03 Song Y.flac');
    expect(f?.username).toBe('a');
  });

  it('builds the weekly playlist from the createdfor list, fetching what is missing, and replaces it next time', async () => {
    let downloads = 0; let scans = 0;
    const fetcher: any = async (url: string) => {
      if (url.includes('/playlists/createdfor')) return { ok: true, json: async () => ({ playlists: [{ playlist: { title: 'Weekly Exploration for lbuser, week of 2026-09-14', identifier: 'https://listenbrainz.org/playlist/abc', date: '2026-09-14T00:00:00Z', extension: { 'https://musicbrainz.org/doc/jspf#playlist': { additional_metadata: { algorithm_metadata: { source_patch: 'weekly-exploration' } } } } } }] }) };
      if (url.endsWith('/playlist/abc')) return { ok: true, json: async () => ({ playlist: { track: [{ title: first.title, creator: first.artist }, { title: second.title, creator: second.artist }, { title: 'Missing Song', creator: 'Nobody Known' }] } }) };
      if (url.endsWith('/api/v0/searches')) return { ok: true, json: async () => ({ id: 's2' }) };
      if (url.endsWith('/searches/s2')) return { ok: true, json: async () => ({ state: 'Completed' }) };
      if (url.endsWith('/responses')) return { ok: true, json: async () => [{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, files: [{ filename: 'x\\Nobody Known - Missing Song.flac', size: 10 }] }] };
      if (url.includes('/transfers/downloads/peer')) { downloads++; return { ok: true, json: async () => ({}) }; }
      if (url.endsWith('/transfers/downloads')) return { ok: true, json: async () => [{ username: 'peer', directories: [{ files: [{ filename: 'x\\Nobody Known - Missing Song.flac', state: 'Completed, Succeeded' }] }] }] };
      throw new Error(`unexpected ${url}`);
    };
    const opts = { slskdUrl: 'http://s', slskdKey: 'k', fetcher, runScan: async () => { scans++; } };
    const r = await buildPlaylist(db, 'u1', 'weekly-exploration', opts);
    expect(r).toEqual({ name: 'Weekly Exploration 2026-09-14', matched: 2, total: 3, fetched: 1 });
    expect(downloads).toBe(1); expect(scans).toBe(1);
    const pl = db.prepare("SELECT id FROM playlists WHERE user_id = 'u1' AND name LIKE 'Weekly Exploration %'").all() as any[];
    expect(pl.length).toBe(1);
    expect((db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(pl[0].id) as any[]).map((x) => x.track_id)).toEqual([first.id, second.id]);
    // same ListenBrainz playlist again: nothing to do
    expect(await buildPlaylist(db, 'u1', 'weekly-exploration', opts)).toBeNull();
  });
});

describe('collectFetched: the staging dir is shared with other consumers', () => {
  const mkFile = (name: string, size = 10): any => ({ username: 'u', filename: `dl\\${name}`, size, hasFreeUploadSlot: true, queueLength: 0 });
  const t = { title: 'Song', artist: 'Arty', album: 'Alb' };

  it('takes only files written since the download was asked for', () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stage-'));
    const music = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-mus-'));
    const src = path.join(staging, 'Arty - Song.flac');
    fs.writeFileSync(src, Buffer.alloc(10));
    const old = (Date.now() - 7 * 86400000) / 1000;
    fs.utimesSync(src, old, old);
    // a week-old twin with the right name and size belongs to Soularr/Lidarr: left alone
    expect(collectFetched([{ file: mkFile('Arty - Song.flac'), t, startedAt: Date.now() }], { downloadsDir: staging, musicDir: music })).toEqual([]);
    expect(fs.existsSync(src)).toBe(true);
    // freshly written: taken
    fs.writeFileSync(src, Buffer.alloc(10));
    const rels = collectFetched([{ file: mkFile('Arty - Song.flac'), t, startedAt: Date.now() - 5000 }], { downloadsDir: staging, musicDir: music });
    expect(rels).toEqual([path.join('Arty', 'Alb')]);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.statSync(path.join(music, 'Arty', 'Alb', 'Arty - Song.flac')).size).toBe(10);
  });

  it('dest already there: same size means already delivered (src removed); a different size touches nothing', () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stage2-'));
    const music = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-mus2-'));
    const src = path.join(staging, 'Arty - Song.flac');
    const dest = path.join(music, 'Arty', 'Alb', 'Arty - Song.flac');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // dest holds the same size: an earlier run delivered it, only the staging copy goes
    fs.writeFileSync(dest, Buffer.alloc(10));
    fs.writeFileSync(src, Buffer.alloc(10));
    expect(collectFetched([{ file: mkFile('Arty - Song.flac'), t, startedAt: Date.now() - 5000 }], { downloadsDir: staging, musicDir: music })).toEqual([path.join('Arty', 'Alb')]);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.statSync(dest).size).toBe(10);
    // dest holds something ELSE (different size): neither side is touched
    fs.writeFileSync(dest, Buffer.alloc(20));
    fs.writeFileSync(src, Buffer.alloc(10));
    expect(collectFetched([{ file: mkFile('Arty - Song.flac'), t, startedAt: Date.now() - 5000 }], { downloadsDir: staging, musicDir: music })).toEqual([]);
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.statSync(dest).size).toBe(20);
  });
});

describe('slskdWait and slskd transfer history', () => {
  const want = (name: string): any => ({ username: 'p', filename: name, size: 1, hasFreeUploadSlot: true, queueLength: 0 });
  const iso = (ms: number) => new Date(ms).toISOString();

  it('ignores records requested before this run and counts only Succeeded', async () => {
    const since = Date.now();
    const recs = [
      { filename: 'f1', state: 'Completed, Errored', requestedAt: iso(since - 86400000) }, // yesterday's failure: history
      { filename: 'f1', state: 'Completed, Succeeded', requestedAt: iso(since + 1000) },
      { filename: 'f2', state: 'Completed, Errored', requestedAt: iso(since + 1000) }, // this run, terminal, but not a fetch
    ];
    const fetcher: any = async (url: string) => {
      if (url.endsWith('/transfers/downloads')) return { ok: true, json: async () => [{ username: 'p', directories: [{ files: recs }] }] };
      throw new Error(`unexpected ${url}`);
    };
    expect(await slskdWait({ slskdUrl: 'http://s', slskdKey: 'k', fetcher }, [want('f1'), want('f2')], 1000, since)).toBe(1);
  });

  it('a stale Errored record alone neither ends the wait nor counts', async () => {
    const stale = [{ filename: 'f1', state: 'Completed, Errored', requestedAt: iso(Date.now() - 86400000) }];
    const fetcher: any = async () => ({ ok: true, json: async () => [{ username: 'p', directories: [{ files: stale }] }] });
    const t0 = Date.now();
    expect(await slskdWait({ slskdUrl: 'http://s', slskdKey: 'k', fetcher }, [want('f1')], 60, Date.now())).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60); // waited the budget out instead of trusting history
  });
});

describe('rebuilds keep user edits; pruning only touches generated names', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-explore2-'));
  const db = openDb(data);
  let tr: any[];
  beforeAll(async () => {
    await scanLibrary(db, { musicDir: MUSIC, dataDir: data });
    tr = db.prepare('SELECT id, title, artist FROM tracks GROUP BY title, artist HAVING COUNT(*) = 1 ORDER BY title LIMIT 2').all() as any[];
    db.prepare('INSERT INTO users (id, name, pass_hash, role, created) VALUES (?, ?, ?, ?, ?)').run('u1', 'lb', 'x', 'user', Date.now());
    db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run('u1', JSON.stringify({ listenbrainz: { user: 'lbuser', token: 'tok' } }), Date.now());
    const ins = db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)');
    ins.run('px', 'u1', 'Weekly Exploration faves', 1, 1); // the user's own, a LIKE match but not the generated pattern
    ins.run('p01', 'u1', 'Weekly Exploration 2026-01-01', 1, 1);
    ins.run('p02', 'u1', 'Weekly Exploration 2026-01-02', 1, 1);
    ins.run('p03', 'u1', 'Weekly Exploration 2026-01-03', 1, 1);
  }, 120000);
  const mkFetcher = (mbid: string, date: string): any => async (url: string) => {
    if (url.includes('/playlists/createdfor')) return { ok: true, json: async () => ({ playlists: [{ playlist: { title: `Weekly Exploration for lbuser, week of ${date}`, identifier: `https://listenbrainz.org/playlist/${mbid}`, date: `${date}T00:00:00Z`, extension: { 'https://musicbrainz.org/doc/jspf#playlist': { additional_metadata: { algorithm_metadata: { source_patch: 'weekly-exploration' } } } } } }] }) };
    if (url.endsWith(`/playlist/${mbid}`)) return { ok: true, json: async () => ({ playlist: { track: [{ title: tr[0].title, creator: tr[0].artist }] } }) };
    throw new Error(`unexpected ${url}`);
  };
  const names = () => (db.prepare("SELECT name FROM playlists WHERE user_id = 'u1' AND name LIKE 'Weekly Exploration %' ORDER BY name").all() as any[]).map((p) => p.name);

  it('replaces an untouched playlist, keeps an edited one alongside the new, and never prunes non-pattern names', async () => {
    expect(await buildPlaylist(db, 'u1', 'weekly-exploration', { fetcher: mkFetcher('m1', '2026-09-14') })).toMatchObject({ name: 'Weekly Exploration 2026-09-14' });
    // untouched since generation: replaced
    await buildPlaylist(db, 'u1', 'weekly-exploration', { fetcher: mkFetcher('m2', '2026-09-21') });
    expect(names()).toContain('Weekly Exploration 2026-09-21');
    expect(names()).not.toContain('Weekly Exploration 2026-09-14');
    // the user adds a track: the playlist is theirs now
    const cur = db.prepare("SELECT id FROM playlists WHERE name = 'Weekly Exploration 2026-09-21'").get() as any;
    db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, 99, ?, ?)').run(cur.id, tr[1].id, Date.now());
    await buildPlaylist(db, 'u1', 'weekly-exploration', { fetcher: mkFetcher('m3', '2026-09-28') });
    const n = names();
    expect(n).toContain('Weekly Exploration 2026-09-28');
    expect(n).toContain('Weekly Exploration 2026-09-21'); // kept, edits and all
    // prune (keep 4): the oldest dated one went, the user's own name never does
    expect(n).not.toContain('Weekly Exploration 2026-01-01');
    expect(n).toContain('Weekly Exploration 2026-01-02');
    expect(n).toContain('Weekly Exploration faves');
  });
});
