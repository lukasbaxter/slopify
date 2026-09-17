// One SQLite file in /data, WAL mode. Migrations are plain SQL steps
// applied in order; the schema version lives in the file.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', must_change_pw INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, last_seen INTEGER
  );
  CREATE TABLE tokens (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'web', created INTEGER NOT NULL, last_seen INTEGER
  );
  CREATE INDEX tokens_user ON tokens(user_id);
  CREATE TABLE artists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT NOT NULL, image_hash TEXT,
    track_count INTEGER NOT NULL DEFAULT 0, album_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX artists_sort ON artists(sort_name);
  CREATE TABLE albums (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, artist_id TEXT, artist TEXT NOT NULL, year INTEGER,
    dir TEXT NOT NULL, cover_hash TEXT, track_count INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL, sort_name TEXT NOT NULL
  );
  CREATE INDEX albums_sort ON albums(sort_name);
  CREATE INDEX albums_artist ON albums(artist_id);
  CREATE INDEX albums_added ON albums(added_at DESC);
  CREATE TABLE tracks (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
    title TEXT NOT NULL, artist TEXT NOT NULL, artists TEXT NOT NULL, artist_ids TEXT NOT NULL,
    album_id TEXT NOT NULL REFERENCES albums(id), album TEXT NOT NULL, album_artist TEXT NOT NULL,
    track_no INTEGER, disc_no INTEGER, year INTEGER, genres TEXT NOT NULL DEFAULT '[]',
    duration_ms INTEGER NOT NULL DEFAULT 0, codec TEXT, bitrate INTEGER, sample_rate INTEGER, channels INTEGER,
    fingerprint TEXT, mbid TEXT, identity_state TEXT NOT NULL DEFAULT 'unchecked', identity_score REAL NOT NULL DEFAULT 0,
    jf_id TEXT, added_at INTEGER NOT NULL
  );
  CREATE INDEX tracks_album ON tracks(album_id, disc_no, track_no);
  CREATE INDEX tracks_jf ON tracks(jf_id);
  CREATE INDEX tracks_added ON tracks(added_at DESC);
  CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist, album, content='tracks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN INSERT INTO tracks_fts(rowid, title, artist, album) VALUES (new.rowid, new.title, new.artist, new.album); END;
  CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album) VALUES ('delete', old.rowid, old.title, old.artist, old.album); END;
  CREATE TRIGGER tracks_au AFTER UPDATE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album) VALUES ('delete', old.rowid, old.title, old.artist, old.album);
    INSERT INTO tracks_fts(rowid, title, artist, album) VALUES (new.rowid, new.title, new.artist, new.album);
  END;
  CREATE TABLE lyrics (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, kind TEXT NOT NULL,
    lines TEXT NOT NULL, source TEXT NOT NULL, fetched_at INTEGER NOT NULL
  );
  CREATE TABLE artwork (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, src TEXT, width INTEGER, height INTEGER, created INTEGER NOT NULL);
  CREATE TABLE likes (user_id TEXT NOT NULL, track_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, track_id));
  CREATE INDEX likes_user_at ON likes(user_id, at DESC);
  CREATE TABLE playlists (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE playlist_tracks (playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, pos INTEGER NOT NULL, track_id TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (playlist_id, pos));
  CREATE TABLE plays (user_id TEXT NOT NULL, track_id TEXT NOT NULL, at INTEGER NOT NULL, client TEXT, PRIMARY KEY (user_id, at, track_id));
  CREATE INDEX plays_user_at ON plays(user_id, at DESC);
  CREATE TABLE prefs (user_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE scans (id INTEGER PRIMARY KEY AUTOINCREMENT, started INTEGER NOT NULL, finished INTEGER, files INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, error TEXT);
  CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `,
];

export type DB = Database.Database;

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'slopify.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const v = db.pragma('user_version', { simple: true }) as number;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.pragma(`user_version = ${i + 1}`);
  }
  return db;
}

export function libraryVersion(db: DB): string {
  return (db.prepare('SELECT v FROM kv WHERE k = ?').get('library_version') as { v: string } | undefined)?.v ?? '0';
}
export function bumpLibraryVersion(db: DB): string {
  const v = String(Date.now());
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('library_version', v);
  return v;
}
