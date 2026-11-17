import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { scanLibrary } from './scanner.js';
import { playlistRecommendations, warmPlaylistReco } from './playlistreco.js';
import { bumpLibraryVersion } from './db.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-reco-'));
let app: Awaited<ReturnType<typeof buildServer>>; let db: any;

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  db = (app as any).db;
  await scanLibrary(db, { musicDir: MUSIC, dataDir: DATA });
}, 120000);
afterAll(async () => { await app.close(); });

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
// Fake Deezer: Ada Lovelace's related list names The Fixture Band (and an
// artist this library does not have); everyone else has no relations.
const deezer = (calls: string[]) => (async (url: string) => {
  calls.push(url);
  const q = new URL(url).searchParams.get('q');
  if (url.includes('/search/artist')) return ok({ data: [{ id: q === 'Ada Lovelace' ? 1 : 2, name: q, nb_fan: 5000 }] });
  if (url.includes('/artist/1/related')) return ok({ data: [{ name: 'Not Here' }, { name: 'The Fixture Band' }] });
  return ok({ data: [] });
}) as any;

describe("a playlist's Recommended", () => {
  it("comes from the playlist's circle: its artists and the ones they are related to", async () => {
    const ada = db.prepare("SELECT id FROM artists WHERE name = 'Ada Lovelace'").get();
    const band = db.prepare("SELECT id FROM artists WHERE name = 'The Fixture Band'").get();
    const adaTracks = db.prepare('SELECT id, title FROM tracks WHERE artist_ids LIKE ? ORDER BY title').all(`%"${ada.id}"%`) as any[];
    db.prepare('INSERT INTO users (id, name, pass_hash, created) VALUES (?, ?, ?, ?)').run('u-reco', 'reco', 'x', Date.now());
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run('pl_reco', 'u-reco', 'ada', Date.now(), Date.now());
    adaTracks.slice(0, 3).forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run('pl_reco', i, t.id, Date.now()));
    const bandTracks = db.prepare('SELECT id FROM tracks WHERE artist_ids LIKE ?').all(`%"${band.id}"%`) as any[];
    db.prepare('INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?)').run('u-reco', JSON.stringify({ dislikes: { [bandTracks[0].id]: 1 } }), Date.now());

    const calls: string[] = [];
    const out = await playlistRecommendations(db, 'pl_reco', 'u-reco', { fetcher: deezer(calls) });
    expect(out.length).toBeGreaterThan(0);
    const inPlaylist = new Set(adaTracks.slice(0, 3).map((t) => t.id));
    for (const t of out) {
      expect(inPlaylist.has(t.id)).toBe(false);
      expect(t.id).not.toBe(bandTracks[0].id); // disliked
      const ids = JSON.parse(t.artist_ids);
      expect(ids.includes(ada.id) || ids.includes(band.id)).toBe(true);
    }
    // One song per related artist, two at most for a playlist artist.
    expect(out.filter((t) => JSON.parse(t.artist_ids)[0] === band.id).length).toBe(1);
    expect(out.filter((t) => JSON.parse(t.artist_ids)[0] === ada.id).length).toBeLessThanOrEqual(2);
    // Deezer answers are kept: a second ask makes no calls, and the same seed gives the same songs.
    const again: string[] = [];
    const out2 = await playlistRecommendations(db, 'pl_reco', 'u-reco', { fetcher: deezer(again) });
    expect(again).toEqual([]);
    expect(out2.map((t) => t.id)).toEqual(out.map((t) => t.id));
    expect(await warmPlaylistReco(db, { fetcher: deezer([]) })).toBe(0);
  });

  it('Refresh brings songs it has not shown yet; the same generation again gives the same ones', async () => {
    // A playlist with a circle of eight related artists, six songs each.
    const now = Date.now(); const ada = db.prepare("SELECT id FROM artists WHERE name = 'Ada Lovelace'").get();
    const rel = Array.from({ length: 8 }, (_, i) => `Circle Artist ${i}`);
    rel.forEach((name, i) => {
      const id = `circle${i}`.padEnd(32, '0');
      db.prepare('INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run(id, name, name.toLowerCase());
      db.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 6, 0, ?)').run(`al-${id}`, `${name} Album`, id, name, `/m/${id}`, name);
      for (let k = 0; k < 6; k++) db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
        VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0)`).run(`c${i}t${k}`.padEnd(32, '0'), `/m/c${i}t${k}.flac`, `Circle Song ${i}-${k}`, name, JSON.stringify([name]), JSON.stringify([id]), `al-${id}`, `${name} Album`, name);
    });
    db.prepare('INSERT INTO playlists (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)').run('pl_circle', 'u-reco', 'circle', now, now);
    (db.prepare('SELECT id FROM tracks WHERE artist_ids LIKE ? LIMIT 3').all(`%"${ada.id}"%`) as any[]).forEach((t, i) => db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id, added) VALUES (?, ?, ?, ?)').run('pl_circle', i, t.id, now));
    db.prepare("DELETE FROM ext_cache WHERE k LIKE 'dzrel:%'").run();
    bumpLibraryVersion(db);
    const f = (async (url: string) => {
      const q = new URL(url).searchParams.get('q');
      if (url.includes('/search/artist')) return ok({ data: [{ id: q === 'Ada Lovelace' ? 1 : 2, name: q, nb_fan: 5000 }] });
      if (url.includes('/artist/1/related')) return ok({ data: rel.map((name) => ({ name })) });
      return ok({ data: [] });
    }) as any;
    const gens: string[][] = [];
    for (let g = 1; g <= 3; g++) gens.push((await playlistRecommendations(db, 'pl_circle', 'u-reco', { fetcher: f, n: 6, seed: g })).map((t) => t.id));
    for (const x of gens) expect(x.length).toBe(6);
    expect(new Set(gens.flat()).size).toBe(18); // three Refreshes, all different songs
    expect((await playlistRecommendations(db, 'pl_circle', 'u-reco', { fetcher: f, n: 6, seed: 3 })).map((t) => t.id)).toEqual(gens[2]);
    // Once the circle runs out it goes round again rather than going empty.
    for (let g = 4; g < 14; g++) expect((await playlistRecommendations(db, 'pl_circle', 'u-reco', { fetcher: f, n: 6, seed: g })).length).toBe(6);
  });
});
