import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { registerDiscover } from './discover.js';

// A collaboration filed under a combined album artist ("Porter Robinson; League
// of Legends") must still count as the solo artist's in Everywhere search and
// on their artist page; before, both said "not on the server".
describe('library matching for Spotify releases', () => {
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
    { album_id: 'sp-ego', artist: 'Porter Robinson, League of Legends', title: 'Everything Goes On', rtype: 'Single', year: '2022' },
    { album_id: 'sp-nurture', artist: 'Porter Robinson', title: 'Nurture', rtype: 'Album', year: '2021' },
    { album_id: 'sp-worlds', artist: 'Porter Robinson', title: 'Worlds', rtype: 'Album', year: '2014' },
  ];
  const fetcher: any = async (url: string) => {
    if (url.includes('/api/search')) return { ok: true, json: async () => ({ results: releases }) };
    if (url.includes('/api/artist')) return { ok: true, json: async () => ({ artist: { name: 'Porter Robinson' }, releases }) };
    if (url.includes('/api/requests')) return { ok: true, json: async () => ({ requests: [] }) };
    throw new Error(`unexpected ${url}`);
  };
  const app = Fastify();
  app.decorate('requireUser', async () => {});
  registerDiscover(app, db, { musicRequestsUrl: 'http://mr', fetcher });

  it('Everywhere search marks a collaboration under a combined album artist as in the library', async () => {
    const r = (await app.inject({ url: '/api/gsearch?q=everything goes on' })).json();
    const by = Object.fromEntries(r.albums.map((a: any) => [a.album_id, a.inLibrary]));
    expect(by).toEqual({ 'sp-ego': 'al-ego', 'sp-nurture': 'al-nurture', 'sp-worlds': null });
  });

  it('the artist page does too, without listing the collaboration again as an extra', async () => {
    const r = (await app.inject({ url: '/api/discography/porter' })).json();
    expect(r.releases.find((x: any) => x.album_id === 'sp-ego').inLibrary).toBe('al-ego');
    expect(r.releases.filter((x: any) => x.inLibrary === 'al-ego').length).toBe(1);
  });
});
