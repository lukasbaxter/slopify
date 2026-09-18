import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { buildPlaylist, matchTrack, slskdFind } from './explore.js';

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
    const fetcher: any = async (url: string, init?: any) => {
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
