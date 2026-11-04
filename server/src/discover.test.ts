import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { registerDiscover } from './discover.js';

// A collaboration filed under a combined album artist ("Porter Robinson; League
// of Legends") must still count as the solo artist's in Everywhere search and
// on their artist page; before, both said "not on the server".
describe('library matching for catalog releases', () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-discover-')));
  const artist = db.prepare('INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?)');
  artist.run('porter', 'Porter Robinson', 'porter robinson');
  artist.run('lol', 'League of Legends', 'league of legends');
  artist.run('combo', 'Porter Robinson; League of Legends', 'porter robinson; league of legends');
  const album = db.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES (?, ?, ?, ?, ?, 1, 0, ?)');
  album.run('al-ego', 'Everything Goes On', 'combo', 'Porter Robinson; League of Legends', '/m/ego', 'everything goes on');
  album.run('al-nurture', 'Nurture', 'porter', 'Porter Robinson', '/m/nurture', 'nurture');
  const track = db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
    VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0)`);
  track.run('t-ego', '/m/ego/01.flac', 'Everything Goes On', 'Porter Robinson, League of Legends', '["Porter Robinson","League of Legends"]', '["porter","lol"]', 'al-ego', 'Everything Goes On', 'Porter Robinson; League of Legends');
  track.run('t-look', '/m/nurture/01.flac', 'Look at the Sky', 'Porter Robinson', '["Porter Robinson"]', '["porter"]', 'al-nurture', 'Nurture', 'Porter Robinson');

  const releases = [
    { album_id: 'mb-ego', artist: 'Porter Robinson, League of Legends', title: 'Everything Goes On', rtype: 'Single', year: '2022', date: '2022-08-31', image: null, total_tracks: 1 },
    { album_id: 'mb-nurture', artist: 'Porter Robinson', title: 'Nurture', rtype: 'Album', year: '2021', date: '2021-04-23', image: null, total_tracks: 14 },
    { album_id: 'mb-worlds', artist: 'Porter Robinson', title: 'Worlds', rtype: 'Album', year: '2014', date: '2014-08-12', image: null, total_tracks: 12 },
  ];
  const lidarr: any = {
    enabled: true,
    statuses: async () => new Map([['mb-worlds', { status: 'queued', updated: 0 }]]),
    discography: async () => ({ artist: { name: 'Porter Robinson', image: null }, releases }),
    search: async () => releases,
  };
  const app = Fastify();
  app.decorate('requireUser', async () => {});
  registerDiscover(app, db, { lidarr });

  it('Everywhere search marks a collaboration under a combined album artist as in the library', async () => {
    const r = (await app.inject({ url: '/api/gsearch?q=everything goes on' })).json();
    const by = Object.fromEntries(r.albums.map((a: any) => [a.album_id, a.inLibrary]));
    expect(by).toEqual({ 'mb-ego': 'al-ego', 'mb-nurture': 'al-nurture', 'mb-worlds': null });
    expect(r.albums.find((a: any) => a.album_id === 'mb-worlds').requestStatus).toBe('queued');
  });

  it('the artist page does too, without listing the collaboration again as an extra', async () => {
    const r = (await app.inject({ url: '/api/discography/porter' })).json();
    expect(r.releases.find((x: any) => x.album_id === 'mb-ego').inLibrary).toBe('al-ego');
    expect(r.releases.filter((x: any) => x.inLibrary === 'al-ego').length).toBe(1);
    expect(r.releases.find((x: any) => x.album_id === 'mb-worlds').requestStatus).toBe('queued');
  });
});

// The kept radar holds only the raw releases: whether one is in the
// library or mid-request changes by the minute and is flagged per look.
describe('release radar', () => {
  it('serves fresh inLibrary/requestStatus from the cached raw list, without refetching discographies', async () => {
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-radar-')));
    db.prepare("INSERT INTO artists (id, name, sort_name) VALUES ('tycho', 'Tycho', 'tycho')").run();
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al-dive', 'Dive', 'tycho', 'Tycho', '/m/dive', 1, 0, 'dive')").run();
    db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
      VALUES ('t-dive', '/m/dive/01.flac', 0, 0, 'A Walk', 'Tycho', '["Tycho"]', '["tycho"]', 'al-dive', 'Dive', 'Tycho', 0)`).run();
    db.prepare('INSERT INTO plays (user_id, track_id, at) VALUES (?, ?, ?)').run('u1', 't-dive', Date.now());
    const date = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    let status = new Map([['mb-ih', { status: 'queued', updated: 0 }]]);
    let discogCalls = 0;
    const lidarr: any = {
      enabled: true,
      statuses: async () => status,
      discography: async () => { discogCalls++; return { artist: { name: 'Tycho', image: null }, releases: [{ album_id: 'mb-ih', artist: 'Tycho', title: 'Infinite Health', rtype: 'Album', year: date.slice(0, 4), date, image: null, total_tracks: 10, secondary: [] }] }; },
    };
    const app = Fastify();
    app.decorate('requireUser', async () => {});
    registerDiscover(app, db, { lidarr });
    const first = (await app.inject({ url: '/api/radar' })).json();
    expect(first.releases[0]).toMatchObject({ album_id: 'mb-ih', requestStatus: 'queued', inLibrary: null });
    // it downloaded in the meantime: the cached radar must show that
    status = new Map();
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al-ih', 'Infinite Health', 'tycho', 'Tycho', '/m/ih', 10, 0, 'infinite health')").run();
    const second = (await app.inject({ url: '/api/radar' })).json();
    expect(second.releases[0]).toMatchObject({ album_id: 'mb-ih', requestStatus: null, inLibrary: 'al-ih', localName: 'Infinite Health' });
    expect(discogCalls).toBe(1);
    await app.close();
  });
  let radarRuns = 0; // discography() caches per artist: each test its own
  const radarSetup = () => {
    const id = `radar-artist-${++radarRuns}`;
    const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-radar-')));
    db.prepare("INSERT INTO artists (id, name, sort_name) VALUES (?, 'Tycho', 'tycho')").run(id);
    db.prepare("INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name) VALUES ('al-dive', 'Dive', ?, 'Tycho', '/m/dive', 1, 0, 'dive')").run(id);
    db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
      VALUES ('t-dive', '/m/dive/01.flac', 0, 0, 'A Walk', 'Tycho', '["Tycho"]', ?, 'al-dive', 'Dive', 'Tycho', 0)`).run(JSON.stringify([id]));
    db.prepare('INSERT INTO plays (user_id, track_id, at) VALUES (?, ?, ?)').run('u1', 't-dive', Date.now());
    const date = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const release = (id: string) => ({ album_id: id, artist: 'Tycho', title: id, rtype: 'album', year: date.slice(0, 4), date, image: null, total_tracks: 1 });
    const start = (lidarr: any) => { const app = Fastify(); app.decorate('requireUser', async () => {}); registerDiscover(app, db, { lidarr }); return app; };
    const keep = (at: number, id: string) => db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('radar', ?)").run(JSON.stringify({ at, releases: [{ ...release(id), artistId: id, artistName: 'Tycho' }] }));
    const kept = () => JSON.parse((db.prepare("SELECT v FROM kv WHERE k = 'radar'").get() as any).v);
    return { release, start, keep, kept };
  };
  const base = { enabled: true, statuses: async () => new Map() };

  it('a restart costs nothing: the kept list answers without asking Lidarr', async () => {
    const { start, keep } = radarSetup();
    keep(Date.now(), 'kept');
    let calls = 0;
    const app = start({ ...base, discography: async () => { calls++; throw new Error('not needed'); } });
    const r = (await app.inject({ url: '/api/radar' })).json();
    expect(r.releases.map((x: any) => x.album_id)).toEqual(['kept']);
    expect(calls).toBe(0);
    await app.close();
  });

  it('an old list answers at once and is rebuilt behind the scenes, once', async () => {
    const { start, keep, kept, release } = radarSetup();
    keep(Date.now() - 7 * 3600e3, 'old');
    let calls = 0; let finish: (v: any) => void = () => {};
    const app = start({ ...base, discography: () => { calls++; return new Promise((res) => { finish = res; }); } });
    const a = (await app.inject({ url: '/api/radar' })).json(); // Lidarr has not answered
    const b = (await app.inject({ url: '/api/radar' })).json();
    expect(a.releases[0].album_id).toBe('old');
    expect(b.releases[0].album_id).toBe('old');
    expect(calls).toBe(1);
    finish({ artist: { name: 'Tycho', image: null }, releases: [release('new')] });
    await expect.poll(() => kept().releases[0].album_id).toBe('new');
    await app.close();
  });

  it('Lidarr down during a rebuild leaves the list as it was', async () => {
    const { start, keep, kept } = radarSetup();
    keep(Date.now() - 7 * 3600e3, 'old');
    let calls = 0;
    const app = start({ ...base, discography: async () => { calls++; throw new Error('lidarr down'); } });
    await app.inject({ url: '/api/radar' });
    await expect.poll(() => calls).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(kept().releases[0].album_id).toBe('old');
    await app.close();
  });
});
