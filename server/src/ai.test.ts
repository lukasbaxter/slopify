import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { buildPool, choose, generatePlaylist, type Llm } from './ai.js';
import { parseExport, importSpotify, type Parsed } from './spotifyImport.js';

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

  it('choose: 5 known + 20 new, best fit first, weak fits only when nothing else is left', () => {
    const mk = (i: number, known: boolean, fit: number) => ({ row: { id: `${known ? 'k' : 'n'}${i}`, title: `S${i}`, artist: `${known ? 'K' : 'N'}${i}`, artists: '[]' } as any, known, src: 1, fit });
    const pool = [...Array.from({ length: 30 }, (_, i) => mk(i, false, i < 22 ? 8 : 2)), ...Array.from({ length: 20 }, (_, i) => mk(i, true, 9))];
    const out = choose(pool, { artists: [] });
    expect(out.length).toBe(25);
    expect(out.filter((c) => c.known).length).toBe(5);
    expect(out.filter((c) => !c.known).every((c) => c.fit === 8)).toBe(true);
  });

  it('runs plan -> rate -> order and saves the playlist in the order given', async () => {
    const calls: string[] = [];
    const llm = {
      ensure: async () => {},
      json: async (msgs: any[], schema: any) => {
        calls.push(msgs[0].content.slice(0, 12));
        if (calls.length === 1) return { ...emptyPlan, title: 'Late Night Test', songs: tracks.slice(0, 6).map((t) => ({ artist: t.artist, title: t.title })) };
        if (schema.properties.scores) return { scores: Array.from({ length: schema.properties.scores.minItems }, () => 7) };
        return { order: Array.from({ length: schema.properties.order.minItems }, (_, i) => schema.properties.order.minItems - i) };
      },
    } as unknown as Llm;
    const job: any = { step: '', progress: null };
    const r = await generatePlaylist(db, llm, 'u1', 'something calm', job);
    expect(r.name).toBe('Late Night Test');
    const ids = (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(r.playlistId) as any[]).map((x) => x.track_id);
    expect(ids.length).toBe(Math.min(25, r.poolSize));
    expect(ids).toEqual(r.tracks.map((t: any) => t.id));
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
    const llm = (app as any).aiLlm; llm.fillPending(); llm.fillPending();
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
});
