import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { buildPool, finalize, generatePlaylist, type Llm } from './ai.js';
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

const emptyPlan = { title: 'T', artists: [], genres: [], songs: [], playlists: [], useHistory: false, yearFrom: null, yearTo: null };

describe('generated playlists', () => {
  it('pool: songs the model named come first, dislikes never appear', () => {
    const [a, b] = tracks;
    db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run('u1', JSON.stringify({ dislikes: { [b.id]: 1 } }), Date.now());
    const { pool } = buildPool(db, 'u1', { ...emptyPlan, songs: [{ artist: a.artist, title: a.title }, { artist: b.artist, title: b.title }] });
    expect(pool[0].row.id).toBe(a.id);
    expect(pool.some((c) => c.row.id === b.id)).toBe(false);
    db.prepare('DELETE FROM prefs').run();
  });

  it('finalize: always 25 when the pool allows, no repeats, bad numbers ignored', () => {
    const pool = Array.from({ length: 40 }, (_, i) => ({ row: { id: `t${i}`, title: `S${i}`, artist: `A${i % 20}` } as any, score: 40 - i }));
    const out = finalize(pool, [3, 3, 999, -1, 5], { artists: [] });
    expect(out.length).toBe(25);
    expect(out[0].id).toBe('t2'); expect(out[1].id).toBe('t4');
    expect(new Set(out.map((t) => t.id)).size).toBe(25);
  });

  it('runs plan -> pool -> pick and saves the playlist in the order picked', async () => {
    const calls: string[] = [];
    const llm = {
      ensure: async () => {},
      json: async (msgs: any[]) => {
        calls.push(msgs[0].content.slice(0, 20));
        if (calls.length === 1) return { ...emptyPlan, title: 'Plan title', songs: tracks.slice(0, 3).map((t) => ({ artist: t.artist, title: t.title })) };
        return { title: 'Late Night Test', picks: [2, 1, 3] };
      },
    } as unknown as Llm;
    const job: any = { step: '', progress: null };
    const r = await generatePlaylist(db, llm, 'u1', 'something calm', job);
    expect(calls.length).toBe(2);
    expect(r.name).toBe('Late Night Test');
    const ids = (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(r.playlistId) as any[]).map((x) => x.track_id);
    expect(ids.length).toBe(Math.min(25, r.poolSize));
  });
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
