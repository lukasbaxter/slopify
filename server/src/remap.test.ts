import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from './db.js';
import { scanLibrary } from './scanner.js';

// A replaced file is new audio, so a new id: what listeners did with the old
// one has to follow it, at the same path, at a new path, or days later.
const tone = (file: string, hz: number, title: string, secs = 6) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}`,
    '-metadata', `title=${title}`, '-metadata', 'artist=Remy', '-metadata', 'album_artist=Remy', '-metadata', 'album=Leading Me On', file]);
  // A new mtime second, or the scanner takes the file as unchanged.
  const t = new Date(Date.now() + Math.random() * 1e6); fs.utimesSync(file, t, t);
};

function lib() {
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-remap-m-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-remap-d-'));
  const db = openDb(data);
  db.prepare("INSERT INTO playlists (id, user_id, name, created, updated) VALUES ('pl', 'u', 'P', 0, 0)").run();
  const scan = () => scanLibrary(db, { musicDir: music, dataDir: data });
  const idOf = (title: string) => (db.prepare('SELECT id FROM tracks WHERE title = ?').get(title) as any)?.id as string | undefined;
  const use = (id: string) => {
    db.prepare("INSERT INTO likes (user_id, track_id, at) VALUES ('u', ?, 1)").run(id);
    db.prepare("INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES ('pl', (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = 'pl'), ?, 0)").run(id);
    db.prepare("INSERT INTO plays (user_id, track_id, at) VALUES ('u', ?, 5)").run(id);
  };
  const traces = (id: string) => ['likes', 'playlist_tracks', 'plays'].map((t) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE track_id = ?`).get(id) as any).n);
  return { music, db, scan, idOf, use, traces };
}

describe('a replaced song keeps its likes, playlist spots and plays', () => {
  it('same path, new audio (a re-rip): moved, lyrics too, old row gone', async () => {
    const L = lib();
    const f = path.join(L.music, 'Remy', 'Leading Me On', '01 Song.mp3');
    tone(f, 440, 'Song'); await L.scan();
    const old = L.idOf('Song')!;
    L.use(old);
    L.db.prepare("INSERT INTO lyrics (track_id, kind, lines, source, fetched_at) VALUES (?, 'synced', '[]', 'lrclib', 0)").run(old);
    tone(f, 450, 'Song'); const r = await L.scan();
    const now = L.idOf('Song')!;
    expect(now).not.toBe(old);
    expect(r.changed).toBe(1);
    expect(L.traces(now)).toEqual([1, 1, 1]);
    expect(L.traces(old)).toEqual([0, 0, 0]);
    expect((L.db.prepare('SELECT source FROM lyrics WHERE track_id = ?').get(now) as any)?.source).toBe('lrclib');
    expect((L.db.prepare('SELECT COUNT(*) n FROM tracks').get() as any).n).toBe(1);
  });

  it('MP3 swapped for its FLAC at a new path, same scan: moved', async () => {
    const L = lib();
    const mp3 = path.join(L.music, 'Remy', 'Leading Me On', '02 Other.mp3');
    tone(path.join(L.music, 'Remy', 'Leading Me On', '04 Keep.mp3'), 300, 'Keep'); // keeps the walk from looking broken
    tone(mp3, 500, 'Other'); await L.scan();
    const old = L.idOf('Other')!; L.use(old);
    fs.rmSync(mp3); tone(mp3.replace(/\.mp3$/, '.flac'), 510, 'Other');
    const r = await L.scan();
    expect(r.added).toBe(1); expect(r.removed).toBe(1);
    expect(L.traces(L.idOf('Other')!)).toEqual([1, 1, 1]);
  });

  it('the replacement lands days later (old file deleted first): moved when it arrives', async () => {
    const L = lib();
    const mp3 = path.join(L.music, 'Remy', 'Leading Me On', '03 Later.mp3');
    tone(path.join(L.music, 'Remy', 'Leading Me On', '04 Keep.mp3'), 300, 'Keep'); // keeps the walk from looking broken
    tone(mp3, 600, 'Later'); await L.scan();
    const old = L.idOf('Later')!; L.use(old);
    fs.rmSync(mp3); await L.scan();
    expect(L.idOf('Later')).toBeUndefined();
    expect((L.db.prepare('SELECT COUNT(*) n FROM gone_tracks').get() as any).n).toBe(1);
    tone(path.join(L.music, 'Remy', 'Leading Me On (Deluxe)', '03 Later.flac'), 610, 'Later');
    await L.scan();
    expect(L.traces(L.idOf('Later')!)).toEqual([1, 1, 1]);
    expect((L.db.prepare('SELECT COUNT(*) n FROM gone_tracks').get() as any).n).toBe(0);
  });

  it('never guesses: two equally good candidates, or a different length, move nothing', async () => {
    const L = lib();
    const a = path.join(L.music, 'Remy', 'Leading Me On', '05 Twin.mp3');
    tone(path.join(L.music, 'Remy', 'Leading Me On', '04 Keep.mp3'), 300, 'Keep');
    tone(a, 700, 'Twin'); await L.scan();
    const old = L.idOf('Twin')!; L.use(old);
    fs.rmSync(a);
    tone(path.join(L.music, 'Remy', 'A', '05 Twin.flac'), 710, 'Twin');
    tone(path.join(L.music, 'Remy', 'B', '05 Twin.flac'), 720, 'Twin');
    tone(path.join(L.music, 'Remy', 'Leading Me On', '06 Long.mp3'), 800, 'Long', 6);
    await L.scan();
    const ids = (L.db.prepare("SELECT id FROM tracks WHERE title = 'Twin'").all() as any[]).map((r) => r.id);
    for (const id of ids) expect(L.traces(id)).toEqual([0, 0, 0]);
    // The other side: a lone song of a clearly different length is not it.
    const long = L.idOf('Long')!; L.use(long);
    fs.rmSync(path.join(L.music, 'Remy', 'Leading Me On', '06 Long.mp3'));
    tone(path.join(L.music, 'Remy', 'Leading Me On', '06 Long.flac'), 810, 'Long', 30);
    await L.scan();
    expect(L.traces(L.idOf('Long')!)).toEqual([0, 0, 0]);
  });
}, 120000);
