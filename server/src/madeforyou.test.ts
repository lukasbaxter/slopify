// Themed playlists made for each listener: their own songs that fit, songs
// they play that sound like it, and new ones the brain heard; each person's
// copy their own.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { dropGenreCache } from './genres.js';
import { THEMES, inSeason, loadLib, listenerOf, pickThemeTracks, pickThisIs, buildForListener, listMade, searchMade, type Theme } from './madeforyou.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-made-'));
const db = openDb(dir);
const theme = (id: string) => THEMES.find((t) => t.id === id)!;

// 4 rock artists (r1..r4), 2 pop (p1, p2), 1 jazz; 10 songs each. Two
// listeners: u1 plays rock r1 and pop p1, u2 plays rock r2.
beforeAll(() => {
  for (const u of ['u1', 'u2']) db.prepare("INSERT INTO users (id, name, pass_hash, role, created) VALUES (?, ?, 'x', 'user', 0)").run(u, u);
  const artists: [string, string, number | null][] = [['r1', 'Rock', 1975], ['r2', 'Rock', 1995], ['r3', 'Rock', 1995], ['r4', 'Rock', 2005], ['p1', 'Pop', 2015], ['p2', 'Pop', 2015], ['j1', 'Jazz', 1960]];
  for (const [a, g, y] of artists) {
    const aid = a.padEnd(32, '0');
    db.prepare('INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run(aid, `Artist ${a}`, a);
    db.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name, genre) VALUES (?, ?, ?, ?, ?, 10, 0, ?, ?)').run(`al-${a}`, `Album ${a}`, aid, `Artist ${a}`, `/m/${a}`, a, g);
    for (let k = 0; k < 10; k++) db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at, year)
      VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(`${a}-${k}`, `/m/${a}/${k}.flac`, k === 9 ? `Song ${a} (Instrumental)` : `Song ${a} ${k}`, `Artist ${a}`, '[]', JSON.stringify([aid]), `al-${a}`, `Album ${a}`, `Artist ${a}`, y);
  }
  // A Christmas song on a pop album.
  db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at, year) VALUES ('xmas', '/m/p1/x.flac', 0, 0, 'Jingle Bell Rock', 'Artist p1', '[]', ?, 'al-p1', 'Album p1', 'Artist p1', 0, 2015)`).run(JSON.stringify(['p1'.padEnd(32, '0')]));
  const play = db.prepare('INSERT INTO plays (user_id, track_id, at) VALUES (?, ?, ?)');
  let at = 1;
  for (let k = 0; k < 5; k++) for (let n = 0; n <= k; n++) play.run('u1', `r1-${k}`, at++);
  for (let k = 0; k < 3; k++) play.run('u1', `p1-${k}`, at++);
  for (let k = 0; k < 5; k++) play.run('u2', `r2-${k}`, at++);
  db.prepare("INSERT INTO prefs (user_id, json, updated) VALUES ('u1', ?, 0)").run(JSON.stringify({ dislikes: { 'r3-0': 1 } }));
  dropGenreCache();
});

const hits = (ids: string[]) => ids.map((id, i) => ({ id, sound: 1 - i / 100 }));

describe('a themed playlist for one listener', () => {
  it('holds their own songs that fit and new ones the brain heard, never what they turned down or odd versions', () => {
    const lib = loadLib(db);
    const me = listenerOf(db, 'u1');
    // The brain heard rock songs, and (close to rock by sound) one of their pop songs.
    const sound = hits(['r3-0', 'r3-1', 'r4-1', 'p1-0', 'r2-1', 'r3-9', 'j1-1']);
    const ids = pickThemeTracks(lib, me, theme('rock'), sound, '2026-11-17', 30);
    expect(ids.filter((id) => id.startsWith('r1-'))).toHaveLength(4); // theirs, four per artist at most
    expect(ids).toContain('p1-0'); // theirs and sounds like rock
    expect(ids).not.toContain('r3-0'); // disliked
    expect(ids).not.toContain('r3-9'); // instrumental
    expect(ids.some((id) => id.startsWith('j1'))).toBe(false); // not rock
    expect(ids.slice(0, 3)).toEqual(['r3-1', expect.stringMatching(/^r1-/), 'r4-1']); // brain picks first, theirs woven in
  });

  it('a mood takes only their songs that sound like it, not everything they play', () => {
    const lib = loadLib(db), me = listenerOf(db, 'u1');
    // The brain heard one of their rock songs as chill, and some new songs.
    const ids = pickThemeTracks(lib, me, theme('chill'), hits(['r2-1', 'r1-3', 'p2-1', 'j1-2']), 'd', 20);
    expect(ids.filter((id) => me.plays.has(id))).toEqual(['r1-3']);
    expect(ids).toEqual(expect.arrayContaining(['r2-1', 'p2-1', 'j1-2']));
  });

  it("is each listener's own", () => {
    const lib = loadLib(db);
    const a = pickThemeTracks(lib, listenerOf(db, 'u1'), theme('rock'), [], '2026-11-17', 12);
    const b = pickThemeTracks(lib, listenerOf(db, 'u2'), theme('rock'), [], '2026-11-17', 12);
    // The first of their own (the second slot) is what each of them plays.
    expect(a[1]).toMatch(/^r1-/);
    expect(b[1]).toMatch(/^r2-/);
  });

  it('decades by the year on the song, Christmas by its name, and only in season', () => {
    const lib = loadLib(db), me = listenerOf(db, 'u1');
    expect(pickThemeTracks(lib, me, theme('90s'), [], 'd').every((id) => /^r[23]-/.test(id))).toBe(true);
    expect(pickThemeTracks(lib, me, theme('christmas'), [], 'd')).toEqual(['xmas']);
    expect(pickThemeTracks(lib, me, theme('pop'), [], 'd')).not.toContain('xmas'); // not in the others
    const xmas = theme('christmas');
    expect([inSeason(xmas, new Date(2026, 10, 17)), inSeason(xmas, new Date(2026, 11, 26)), inSeason(xmas, new Date(2026, 11, 27)), inSeason(xmas, new Date(2026, 6, 1))]).toEqual([true, true, false, false]);
    const wraps: Theme = { ...xmas, season: ['12-20', '01-05'] };
    expect([inSeason(wraps, new Date(2027, 0, 3)), inSeason(wraps, new Date(2026, 10, 30))]).toEqual([true, false]);
  });

  it('"Holiday" alone is not Christmas: an album called Holiday Hills, a song called Holiday', () => {
    const add = (id: string, title: string, album: string) => db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at, year)
      VALUES (?, ?, 0, 0, ?, 'Artist p1', '[]', ?, 'al-p1', ?, 'Artist p1', 0, 2015)`).run(id, `/m/p1/${id}.flac`, title, JSON.stringify(['p1'.padEnd(32, '0')]), album);
    add('redhanded', 'Red Handed', 'Holiday Hills'); add('holiday', 'Holiday', 'Album p1'); add('happyhols', 'Happy Holidays', 'Album p1');
    const lib = loadLib(db), me = listenerOf(db, 'u1');
    const xmas = pickThemeTracks(lib, me, theme('christmas'), [], 'd');
    expect(xmas).not.toContain('redhanded'); expect(xmas).not.toContain('holiday'); expect(xmas).toContain('happyhols');
    db.prepare("DELETE FROM tracks WHERE id IN ('redhanded', 'holiday', 'happyhols')").run();
  });

  it('This Is an artist: their songs, most played first, one copy each, no odd versions', () => {
    const ids = pickThisIs(loadLib(db), listenerOf(db, 'u1'), 'r1'.padEnd(32, '0'));
    expect(ids[0]).toBe('r1-4');
    expect(ids).not.toContain('r1-9');
    expect(ids).toHaveLength(9);
  });
});

describe('building and finding them', () => {
  it("builds a listener's set, lists it in order and finds it by words", async () => {
    const seen: string[] = [];
    const search = async (text: string) => { seen.push(text); return hits(['r3-1', 'r4-1', 'r4-2', 'r2-3', 'r3-2', 'r4-3', 'r3-3', 'r2-4', 'r4-4', 'r3-4', 'r4-5', 'r3-5']); };
    const n = await buildForListener(db, dir, 'u1', { search, covers: false, now: Date.parse('2026-11-17T12:00:00Z') });
    expect(n).toBeGreaterThan(0);
    const made = listMade(db, 'u1', Date.parse('2026-11-17T12:00:00Z'));
    const ids = made.map((m) => m.id);
    expect(ids).toContain('rock');
    expect(ids).not.toContain('summer'); // out of season
    expect(ids).toContain('chill'); // moods need the brain: it answered here
    expect(ids.some((id) => id.startsWith('thisis:'))).toBe(true);
    expect(searchMade(made, 'rock').map((m) => m.id)).toContain('rock');
    expect(searchMade(made, 'ro').map((m) => m.id)).toContain('rock');
    expect(searchMade(made, 'jazz')).toEqual([]); // not theirs (too few songs)
    expect(seen).toContain(theme('rock').text);
  });

  it('without the brain there are no mood playlists (nothing to hear them by)', async () => {
    await buildForListener(db, dir, 'u2', { search: async () => [], covers: false, now: Date.parse('2026-11-17T12:00:00Z') });
    const ids = listMade(db, 'u2', Date.parse('2026-11-17T12:00:00Z')).map((m) => m.id);
    expect(ids).toContain('rock');
    expect(ids.filter((id) => THEMES.find((t) => t.id === id)?.kind === 'mood')).toEqual([]);
  });
});
