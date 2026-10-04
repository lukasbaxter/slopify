import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { registerLibrary } from './library.js';

// Drake's page: his own albums and his collabs are his discography; Migos'
// album with a Drake feature on it only "appears on".
it('an artist page lists own albums and collabs together, features apart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-artistpage-'));
  const db = openDb(dir);
  const artist = db.prepare('INSERT INTO artists (id, name, sort_name) VALUES (?, ?, ?)');
  artist.run('drake', 'Drake', 'drake'); artist.run('combo', 'Drake, 21 Savage', 'drake, 21 savage'); artist.run('migos', 'Migos', 'migos');
  const album = db.prepare('INSERT INTO albums (id, name, artist_id, artist, dir, track_count, added_at, sort_name, year) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)');
  album.run('own', 'Views', 'drake', 'Drake', '/m/1', 'views', 2016);
  album.run('collab', 'Her Loss', 'combo', 'Drake, 21 Savage', '/m/2', 'her loss', 2022);
  album.run('feat', 'Culture III', 'migos', 'Migos', '/m/3', 'culture iii', 2021);
  const track = db.prepare(`INSERT INTO tracks (id, path, mtime, size, title, artist, artists, artist_ids, album_id, album, album_artist, added_at)
    VALUES (?, ?, 0, 0, 'T', ?, '[]', ?, ?, 'A', ?, 0)`);
  track.run('t1', '/m/1/1.flac', 'Drake', '["drake"]', 'own', 'Drake');
  track.run('t2', '/m/2/1.flac', 'Drake, 21 Savage', '["drake","savage"]', 'collab', 'Drake, 21 Savage');
  track.run('t3', '/m/3/1.flac', 'Migos, Drake', '["migos","drake"]', 'feat', 'Migos');
  const app = Fastify();
  app.decorate('requireUser', async () => {});
  registerLibrary(app, db, dir);
  const r = (await app.inject({ url: '/api/artists/drake' })).json();
  expect(r.albums.map((a: any) => a.name)).toEqual(['Her Loss', 'Views']);
  expect(r.appearsOn.map((a: any) => a.name)).toEqual(['Culture III']);
  await app.close();
});
