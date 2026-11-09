import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { matchTrack, slskdFind, slskdWait } from './explore.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-explore-'));

describe('matching library tracks and finding them on Soulseek', () => {
  const db = openDb(DATA);
  let first: any;
  beforeAll(async () => {
    await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
    [first] = db.prepare('SELECT id, title, artist, album FROM tracks GROUP BY title, artist HAVING COUNT(*) = 1 ORDER BY title LIMIT 2').all() as any[];
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

