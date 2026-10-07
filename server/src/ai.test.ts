import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { buildPool, finalize, generatePlaylist, Progress, type Ask } from './ai.js';
import { parseExport, importSpotify, requestPending, fillPending, type Parsed } from './spotifyImport.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-ai-'));
const db = openDb(DATA);
let tracks: any[] = [];

beforeAll(async () => {
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
  tracks = db.prepare('SELECT id, title, artist, album FROM tracks GROUP BY title, artist HAVING COUNT(*) = 1 ORDER BY title').all() as any[];
  db.prepare('INSERT INTO users (id, name, pass_hash, role, created) VALUES (?, ?, ?, ?, ?)').run('u1', 'ai', 'x', 'user', Date.now());
}, 120000);

const emptyPlan = { title: 'T', vibe: 'calm', artists: [] as string[], genres: [] as string[], songs: [] as { artist: string; title: string }[], playlists: [] as string[], useHistory: false, yearFrom: null, yearTo: null };

describe('generated playlists', () => {
  it('pool: songs the model named are in, dislikes never are, played songs are marked known', async () => {
    const [a, b, c] = tracks;
    db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run('u1', JSON.stringify({ dislikes: { [b.id]: 1 } }), Date.now());
    db.prepare('INSERT INTO plays (user_id, track_id, at) VALUES (?, ?, ?)').run('u1', c.id, 1);
    const pool = await buildPool(db, 'u1', { ...emptyPlan, songs: [a, b, c].map((t) => ({ artist: t.artist, title: t.title })) });
    expect(pool.some((x) => x.row.id === a.id && !x.known)).toBe(true);
    expect(pool.some((x) => x.row.id === b.id)).toBe(false);
    expect(pool.find((x) => x.row.id === c.id)?.known).toBe(true);
    db.prepare('DELETE FROM prefs').run(); db.prepare('DELETE FROM plays').run();
  });

  it('finalize: keeps the order picked, 5 known + 20 new, bad numbers and repeats dropped, 2 per artist among the new', () => {
    const mk = (i: number, known: boolean, artist = `${known ? 'K' : 'N'}${i}`) => ({ row: { id: `${known ? 'k' : 'n'}${i}`, title: `S${i}`, artist, artists: '[]' } as any, known, src: 1 });
    const pool = [...Array.from({ length: 30 }, (_, i) => mk(i, false, i < 5 ? 'Same' : undefined)), ...Array.from({ length: 20 }, (_, i) => mk(i, true))];
    const picks = [31, 2, 1, 2, 3, 4, 999, 0, 32, 33, 34, 35, 36, 10, 11];
    const out = finalize(pool, picks, { artists: [] });
    expect(out.length).toBe(25);
    expect(out.filter((c) => c.known).length).toBe(5);
    expect(out.slice(0, 3).map((c) => c.row.id)).toEqual(['k0', 'n1', 'n0']);
    expect(out.filter((c) => c.row.artist === 'Same').length).toBe(2);
  });

  it('runs plan -> pool -> pick and saves the playlist in the order picked', async () => {
    const calls: string[] = [];
    const ask: Ask = async (system: string, user: string, schema: any) => {
      calls.push(system.slice(0, 20));
      if (schema.properties.vibe) return { ...emptyPlan, yearFrom: 0, yearTo: 0, title: 'Plan Title' } as any;
      if (schema.properties.songs) return { songs: tracks.slice(0, 6).map((t) => ({ artist: t.artist, title: t.title })) } as any;
      const n = (user.match(/^\d+\. (NEW|KNOWN) /gm) || []).length;
      return { title: 'Late Night Test', picks: Array.from({ length: n }, (_, i) => n - i), request: [] } as any;
    };
    const job: any = { state: 'running', step: '', progress: null };
    const r = await generatePlaylist(db, ask, 'u1', 'something calm', job);
    job.state = 'done';
    expect(calls.length).toBe(4); // plan + 2 song lists + pick
    expect(r.name).toBe('Late Night Test');
    const ids = (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(r.playlistId) as any[]).map((x) => x.track_id);
    expect(ids.length).toBe(Math.min(25, r.poolSize));
    expect(ids).toEqual(r.tracks.map((t: any) => t.id));
  });
});

describe('progress', () => {
  it('walks the checklist and the time left only goes down', () => {
    const job: any = { state: 'running', step: '', progress: null };
    const pr = new Progress(job, null);
    expect(job.info.stages.map((x: any) => x.key)).toEqual(['plan', 'find', 'pick']);
    pr.start('plan'); const left0 = job.info.leftMs;
    pr.start('find'); pr.start('pick', 'from 200 songs');
    expect(job.step).toBe('Picking and ordering 25 songs: from 200 songs');
    expect(job.info.stages.map((x: any) => x.state)).toEqual(['done', 'done', 'active']);
    expect(job.info.leftMs).toBeLessThan(left0);
    pr.finish(); job.state = 'done';
    expect(job.info.stages.map((x: any) => x.state)).toEqual(['done', 'done', 'done']);
    expect(job.info.leftMs).toBe(0);
  });
});

describe('requested songs', () => {
  it('a requested song that arrives is appended to its playlist once', async () => {
    const { buildServer } = await import('./app.js');
    const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-ai2-'));
    const app = await buildServer({ dataDir: D2, musicDir: MUSIC });
    const d2 = (app as any).db;
    await scanLibrary(d2, { musicDir: MUSIC, dataDir: D2 });
    const t = d2.prepare('SELECT id, title, artist FROM tracks GROUP BY title, artist HAVING COUNT(*) = 1 LIMIT 1').get();
    const uid = d2.prepare('SELECT id FROM users LIMIT 1').get().id;
    d2.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run('pl_x', uid, 'X', 1, 1);
    d2.prepare('INSERT INTO ai_pending (playlist_id, artist, title, release, requested) VALUES (?, ?, ?, ?, ?)').run('pl_x', t.artist, t.title, 'r', Date.now());
    d2.prepare('INSERT INTO ai_pending (playlist_id, artist, title, release, requested) VALUES (?, ?, ?, ?, ?)').run('pl_x', 'Nobody', 'Not Yet', 'r', Date.now());
    const ai = (app as any).ai; ai.fillPending(); ai.fillPending();
    expect(d2.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = 'pl_x'").all().map((r: any) => r.track_id)).toEqual([t.id]);
    expect(d2.prepare('SELECT title FROM ai_pending').all().map((r: any) => r.title)).toEqual(['Not Yet']);
    await app.close();
  }, 60000);
});

describe('Spotify import', () => {
  it('reads both exports from zips, matches, and is idempotent', async () => {
    const [a, b] = tracks;
    const zip = zipSync({
      'Spotify Account Data/YourLibrary.json': strToU8(JSON.stringify({ tracks: [{ artist: a.artist, track: a.title, album: a.album }, { artist: 'Nobody', track: 'Not Here' }], albums: [] })),
      'Spotify Account Data/Playlist1.json': strToU8(JSON.stringify({ playlists: [{ name: 'Car', items: [{ track: { trackName: `${b.title} - Remastered 2011`, artistName: b.artist }, addedDate: '2024-01-02' }, { track: null, episode: {} }] }] })),
      'Spotify Account Data/StreamingHistory_music_0.json': strToU8(JSON.stringify([{ endTime: '2024-01-01 10:00', artistName: a.artist, trackName: a.title, msPlayed: 5000 }])),
      'Spotify Account Data/StreamingHistory_podcast_0.json': strToU8('[]'),
    });
    const ext = zipSync({
      'Spotify Extended Streaming History/Streaming_History_Audio_2020.json': strToU8(JSON.stringify([
        { ts: '2020-05-01T10:03:00Z', ms_played: 180000, master_metadata_track_name: a.title, master_metadata_album_artist_name: a.artist },
        { ts: '2020-05-01T10:03:10Z', ms_played: 4000, master_metadata_track_name: b.title, master_metadata_album_artist_name: b.artist },
        { ts: '2020-05-01T11:00:00Z', ms_played: 90000, master_metadata_track_name: null, episode_name: 'pod' },
      ])),
    });
    const parse = () => { const p: Parsed = { plays: [], basicPlays: [], likes: [], albums: [], playlists: [], files: [] }; parseExport('a.zip', zip, p); parseExport('b.zip', ext, p); return p; };
    const p = parse();
    expect(p.files.sort()).toEqual(['Playlist1.json', 'StreamingHistory_music_0.json', 'Streaming_History_Audio_2020.json', 'YourLibrary.json']);
    const r = await importSpotify(db, 'u1', p);
    expect(r.plays).toEqual({ total: 1, matched: 1, added: 1 });
    expect(r.likes).toEqual({ total: 2, matched: 1, added: 1 });
    expect(r.playlists.created).toBe(1); expect(r.playlists.songsMatched).toBe(1);
    expect(r.missing[0]).toMatchObject({ artist: 'Nobody', title: 'Not Here' });
    expect((db.prepare("SELECT at FROM plays WHERE user_id = 'u1' AND client = 'spotify'").get() as any).at).toBe(Date.parse('2020-05-01T10:00:00Z'));
    const again = await importSpotify(db, 'u1', parse());
    expect(again.plays.added).toBe(0); expect(again.likes.added).toBe(0);
    expect(again.playlists.created).toBe(0); expect(again.playlists.skipped).toEqual(['Car']);
  });

  it('puts missing liked songs, playlist songs and saved albums aside, once', async () => {
    const c = tracks[2];
    const p: Parsed = { plays: [], basicPlays: [], files: ['x'],
      likes: [{ artist: 'Ghost', title: 'Gone Song', album: 'Gone Album' }],
      albums: [{ artist: 'Ghost', album: 'Saved Away' }],
      playlists: [{ name: 'Gaps', items: [{ artist: 'Ghost', title: 'First', added: 1 }, { artist: c.artist, title: c.title, added: 2 }] }] };
    const r = await importSpotify(db, 'u1', p);
    expect(r.queued).toEqual({ songs: 2, albums: 1 });
    const pl = (db.prepare("SELECT id FROM playlists WHERE user_id = 'u1' AND name = 'Gaps'").get() as any).id;
    // The song that is here keeps its Spotify place, after the one that is not.
    expect(db.prepare('SELECT pos, track_id FROM playlist_tracks WHERE playlist_id = ?').all(pl)).toEqual([{ pos: 1, track_id: c.id }]);
    expect(db.prepare("SELECT kind, playlist_id, pos, title FROM spotify_pending WHERE user_id = 'u1' AND artist = 'Ghost' ORDER BY id").all()).toEqual([
      { kind: 'like', playlist_id: '', pos: null, title: 'Gone Song' },
      { kind: 'album', playlist_id: '', pos: null, title: 'Saved Away' },
      { kind: 'playlist', playlist_id: pl, pos: 0, title: 'First' },
    ]);
    expect((await importSpotify(db, 'u1', { ...p, playlists: [] })).queued).toEqual({ songs: 0, albums: 0 });
  });

  it('requests each missing release in Lidarr once; what cannot be found or keeps failing is set aside', async () => {
    db.prepare('DELETE FROM spotify_pending').run();
    const add = db.prepare("INSERT INTO spotify_pending (user_id, kind, playlist_id, at, artist, title, album, created) VALUES ('u1', ?, ?, 1, ?, ?, ?, ?)");
    add.run('like', '', 'Band', 'One', 'Record', Date.now());
    add.run('playlist', 'pl_1', 'Band', 'Two', 'Record', Date.now());
    add.run('like', '', 'Band', 'Loose', null, Date.now());
    add.run('like', '', 'Nobody', 'Nowhere', null, Date.now());
    add.run('album', '', 'Broken', 'Lp', null, Date.now());
    let requested: string[] = [];
    const lidarr: any = {
      enabled: true,
      search: async (q: string) => q === 'Band Record' ? [{ album_id: 'rg-record', artist: 'Band', title: 'Record' }] : q === 'Broken Lp' ? [{ album_id: 'rg-broken', artist: 'Broken', title: 'Lp' }] : [],
      releaseForTrack: async (artist: string) => artist === 'Band' ? { album_id: 'rg-single', artist: 'Band', title: 'Loose' } : null,
      request: async (id: string) => { requested.push(id); if (id === 'rg-broken') throw new Error('Lidarr is still fetching the artist'); return { id: requested.length, album_id: id, artist: 'Band', title: id, status: 'queued' }; },
    };
    const r = await requestPending(db, lidarr);
    expect(r).toEqual({ requested: 3, notfound: 1, failed: 1 });
    expect(requested.sort()).toEqual(['rg-broken', 'rg-record', 'rg-single']);
    expect(db.prepare('SELECT title, state FROM spotify_pending ORDER BY id').all()).toEqual([
      { title: 'One', state: 'requested' }, { title: 'Two', state: 'requested' }, { title: 'Loose', state: 'requested' },
      { title: 'Nowhere', state: 'notfound' }, { title: 'Lp', state: 'new' },
    ]);
    expect((db.prepare("SELECT COUNT(*) n FROM my_requests WHERE user_id = 'u1' AND source = 'spotify'").get() as any).n).toBe(2);
    // Retried by later runs, given up after the third failure.
    requested = []; await requestPending(db, lidarr); await requestPending(db, lidarr);
    expect((db.prepare("SELECT state, tries FROM spotify_pending WHERE title = 'Lp'").get() as any)).toEqual({ state: 'failed', tries: 3 });
  });

  it('puts what arrived in its place', async () => {
    db.prepare('DELETE FROM spotify_pending').run();
    const [, , c, d] = tracks;
    db.prepare("DELETE FROM likes WHERE user_id = 'u1' AND track_id = ?").run(d.id);
    db.prepare("INSERT INTO playlists (id, user_id, name, created, updated) VALUES ('pl_arrive', 'u1', 'Arrive', 1, 1)").run();
    db.prepare("INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES ('pl_arrive', 1, ?, 1)").run(c.id);
    const add = db.prepare("INSERT INTO spotify_pending (user_id, kind, playlist_id, pos, at, artist, title, created, state) VALUES ('u1', ?, ?, ?, 7, ?, ?, ?, 'requested')");
    add.run('playlist', 'pl_arrive', 0, d.artist, d.title, Date.now());
    add.run('like', '', null, d.artist, d.title, Date.now());
    add.run('like', '', null, 'Still', 'Coming', Date.now());
    expect(fillPending(db)).toBe(2);
    expect(db.prepare("SELECT pos, track_id FROM playlist_tracks WHERE playlist_id = 'pl_arrive' ORDER BY pos").all()).toEqual([{ pos: 0, track_id: d.id }, { pos: 1, track_id: c.id }]);
    expect((db.prepare("SELECT at FROM likes WHERE user_id = 'u1' AND track_id = ?").get(d.id) as any).at).toBe(7);
    expect(db.prepare('SELECT title FROM spotify_pending').all()).toEqual([{ title: 'Coming' }]);
  });
});
