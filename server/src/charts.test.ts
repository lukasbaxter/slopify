// Charts and single-song fetching: a chart lists what the library has in
// chart order and puts the rest in line; the line fetches each song from
// Soulseek, checks it, and shelves it.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from './db.js';
import { parseBillboard, refreshCharts, chartTracks, pullPlaylists, CHARTS, type Spotify } from './charts.js';
import { wantSong, fetchSongs, songKey, localPath } from './songfetch.js';
import { listMade, searchMade } from './madeforyou.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-charts-'));
const db = openDb(dir);
const track = (id: string, title: string, artist: string) => {
  const aid = artist.toLowerCase().replace(/\W/g, '').padEnd(32, '0').slice(0, 32);
  db.prepare('INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES (?, ?, ?)').run(aid, artist, artist.toLowerCase());
  db.prepare('INSERT OR IGNORE INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 1, 0, ?)').run(`al-${aid}`, `${artist} Album`, aid, artist, `/m/${aid}`, artist);
  db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
    VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0)`).run(id, `/m/${id}.flac`, title, artist, JSON.stringify([artist]), JSON.stringify([aid]), `al-${aid}`, `${artist} Album`, artist);
};
beforeAll(() => {
  db.prepare("INSERT INTO users (id, name, pass_hash, role, created) VALUES ('u1', 'u1', 'x', 'user', 0)").run();
  for (let i = 1; i <= 6; i++) track(`t${i}`, `Song ${i}`, `Singer ${i}`);
});

const row = (title: string, artist: string) => `<div class="o-chart-results-list-row-container"><ul><li class="o-chart-results-list__item"><h3 class="c-title" id="title-of-a-story">\n\t${title}\t\n</h3><span class="\n c-label  a-no-trucate a-font-secondary">\n<a href="#">${artist}</a></span></li></ul></div>`;

describe('charts', () => {
  it("reads Billboard's rows", () => {
    expect(parseBillboard(`<html>${row('Choosin&#039; Texas', 'Ella Langley')}${row('Dracula', 'Tame Impala &amp; JENNIE')}</html>`))
      .toEqual([{ title: "Choosin' Texas", artist: 'Ella Langley' }, { title: 'Dracula', artist: 'Tame Impala & JENNIE' }]);
  });

  it('a chart shows the songs the library has, in chart order, and puts the rest in line by rank', async () => {
    const html = [row('Song 3', 'Singer 3'), row('Not Here', 'Somebody'), row('Song 1', 'Singer 1'), row('Also Missing', 'Nobody'), row('Song 5', 'Singer 5'), row('Song 2', 'Singer 2'), row('Song 6', 'Singer 6')].join('');
    const fetcher = (async (url: string) => {
      if (url.includes('billboard.com/charts/hot-100')) return new Response(html);
      return new Response('', { status: 404 });
    }) as any;
    const r = await refreshCharts(db, dir, { fetcher, only: ['hot100'] });
    expect(r).toEqual({ charts: 1, queued: 2 });
    expect(chartTracks(db, 'hot100')).toEqual(['t3', 't1', 't5', 't2', 't6']);
    const line = db.prepare('SELECT title, priority, source FROM song_wants WHERE state = ? ORDER BY priority DESC').all('wanted') as any[];
    expect(line).toEqual([{ title: 'Not Here', priority: 999, source: 'chart:hot100' }, { title: 'Also Missing', priority: 997, source: 'chart:hot100' }]);
    // Everyone sees it, and finds it by its words.
    const made = listMade(db, 'u1');
    expect(made.map((m) => m.id)).toContain('chart:hot100');
    expect(searchMade(made, 'billboard').map((m) => m.id)).toContain('chart:hot100');
    // A song that lands later joins the chart in its place.
    track('t7', 'Not Here', 'Somebody');
    expect(chartTracks(db, 'hot100')).toEqual(['t3', 't7', 't1', 't5', 't2', 't6']);
  });

  it('pulled playlists put their songs in line, a batch at a time', async () => {
    db.prepare("INSERT INTO pulled_playlists (ref, added) VALUES ('6vDGVr652ztNWKZuHvsFvx', 1), ('0vvXsWCC9xrXsKd4FyS8kM', 2)").run();
    const sp = { enabled: true, playlist: async (ref: string) => ({ name: `List ${ref.slice(0, 3)}`, entries: [{ artist: 'Pull Artist', title: `Pulled ${ref.slice(0, 3)}` }, { artist: 'Singer 1', title: 'Song 1' }] }) } as unknown as Spotify;
    const r = await pullPlaylists(db, sp, { perRun: 1 });
    expect(r).toEqual({ lists: 1, queued: 1 }); // Song 1 is in the library already
    expect((db.prepare('SELECT name, songs FROM pulled_playlists WHERE ref = ?').get('6vDGVr652ztNWKZuHvsFvx') as any)).toEqual({ name: 'List 6vD', songs: 2 });
    expect((await pullPlaylists(db, sp, { perRun: 5 })).lists).toBe(1); // the other one; the first is not due for a week
  });

  it('every chart has an id, words and colours', () => {
    for (const c of CHARTS) expect([c.id, c.words.length > 0, /^#[0-9A-F]{6}$/i.test(c.color)]).toEqual([c.id, true, true]);
  });
});

describe('fetching single songs', () => {
  it('a song is in line once, the same song with "feat." credits too; one the library has is not', () => {
    expect(wantSong(db, { artist: 'Fresh Artist', title: 'Fresh Song', source: 't' })).toBe('queued');
    expect(wantSong(db, { artist: 'Fresh Artist feat. Someone', title: 'Fresh Song (feat. Someone)', source: 't', priority: 50 })).toBe('known');
    expect((db.prepare('SELECT priority FROM song_wants WHERE key = ?').get(songKey('Fresh Artist', 'Fresh Song')) as any).priority).toBe(50); // raised
    expect(wantSong(db, { artist: 'Singer 2', title: 'Song 2', source: 't' })).toBe('have');
    expect(songKey('ADELA', 'Nicole Kidman')).toBe(songKey('Adéla', 'Nicole Kidman')); // accents do not count
  });

  it('searches, downloads, checks and shelves a song; a file by someone else is thrown away and tried again later', async () => {
    db.prepare("UPDATE song_wants SET state = 'done-elsewhere' WHERE state = 'wanted'").run(); // only this test's songs
    wantSong(db, { artist: 'Shelf Artist', title: 'Shelf Song', source: 't', priority: 5 });
    wantSong(db, { artist: 'Wrong Artist', title: 'Wrong Song', source: 't', priority: 4 });
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-dl-'));
    const music = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-music-'));
    const transfers: Record<string, string> = {};
    const fetcher = (async (url: string, init?: any) => {
      if (url.endsWith('/searches') && init?.method === 'POST') return Response.json({ id: JSON.parse(init.body).searchText.includes('Shelf') ? 's1' : 's2' });
      if (/\/searches\/s\d$/.test(url) && init?.method === 'DELETE') return new Response('');
      if (/\/searches\/s\d$/.test(url)) return Response.json({ state: 'Completed' });
      if (url.endsWith('/searches/s1/responses')) return Response.json([{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, files: [{ filename: '@@x\\Shelf Artist\\Shelf Artist - Shelf Song.flac', size: 10, length: 200 }] }]);
      if (url.endsWith('/searches/s2/responses')) return Response.json([{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, files: [{ filename: '@@x\\Wrong Artist\\Wrong Artist - Wrong Song.flac', size: 10, length: 200 }] }]);
      if (url.includes('/transfers/downloads/') && init?.method === 'POST') { for (const f of JSON.parse(init.body)) transfers[f.filename] = 'InProgress'; return new Response(''); }
      if (url.endsWith('/transfers/downloads')) return Response.json([{ username: 'peer', directories: [{ files: Object.entries(transfers).map(([filename, state]) => ({ filename, state })) }] }]);
      return new Response('', { status: 404 });
    }) as any;
    const scanned: string[][] = [];
    const o = { slskdUrl: 'http://slskd', slskdKey: 'k', downloadsDir: downloads, musicDir: music, fetcher, scan: async (rel: string[]) => { scanned.push(rel); }, plays: async () => true,
      artistOf: async (f: string) => (f.includes('Wrong') ? 'Somebody Else' : 'Shélf Ártist'), albumOf: async () => 'Shelf Album' }; // accents in the tags still match
    const first = await fetchSongs(db, o, 5);
    expect(first.started).toBe(2);
    // slskd finishes both downloads.
    for (const k of Object.keys(transfers)) { transfers[k] = 'Completed, Succeeded'; const p = localPath(downloads, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'audio'); }
    const second = await fetchSongs(db, o, 5);
    expect([second.got, second.failed]).toEqual([1, 1]);
    expect(fs.existsSync(path.join(music, 'Shelf Artist', 'Shelf Album', 'Shelf Artist - Shelf Song.flac'))).toBe(true);
    expect(scanned).toEqual([[path.join('Shelf Artist', 'Shelf Album')]]);
    const wrong = db.prepare("SELECT state, tries, next_try, note FROM song_wants WHERE title = 'Wrong Song'").get() as any;
    expect([wrong.state, wrong.tries, wrong.next_try > Date.now() + 3000e3, wrong.note]).toEqual(['wanted', 1, true, 'the file is by somebody else']);
    expect(fs.existsSync(localPath(downloads, '@@x\\Wrong Artist\\Wrong Artist - Wrong Song.flac'))).toBe(false); // thrown away
  });
});
