"""The brain's own copy of what it learns from, in SQLite under DATA_DIR."""
import json, os, sqlite3, threading
import numpy as np
from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, seq INTEGER, title TEXT, artist TEXT, artist_ids TEXT, album TEXT,
  album_id TEXT, genres TEXT, year INTEGER, duration_ms INTEGER, added_at INTEGER, gone INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS plays (seq INTEGER PRIMARY KEY, user_id TEXT, track_id TEXT, at INTEGER, client TEXT);
CREATE INDEX IF NOT EXISTS plays_user_at ON plays(user_id, at);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, user_id TEXT, track_id TEXT, at INTEGER, ms_played INTEGER,
  end_ms INTEGER, duration_ms INTEGER, reason TEXT, shuffle TEXT, client TEXT);
CREATE INDEX IF NOT EXISTS events_user_at ON events(user_id, at);
CREATE TABLE IF NOT EXISTS taste (user_id TEXT, track_id TEXT, kind TEXT, at INTEGER, PRIMARY KEY (user_id, track_id, kind));
CREATE TABLE IF NOT EXISTS emb (track_id TEXT PRIMARY KEY, vec BLOB, err TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS weather (hour INTEGER PRIMARY KEY, temp REAL, precip REAL, cloud REAL, code INTEGER, is_day INTEGER);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""

_local = threading.local()

def db():
    c = getattr(_local, "c", None)
    if c is None:
        os.makedirs(config.DATA_DIR, exist_ok=True)
        c = sqlite3.connect(os.path.join(config.DATA_DIR, "brain.db"), timeout=60)
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        _local.c = c
    return c

def kv_get(k, d=None):
    r = db().execute("SELECT v FROM kv WHERE k = ?", (k,)).fetchone()
    return json.loads(r[0]) if r else d

def kv_set(k, v):
    db().execute("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, json.dumps(v)))
    db().commit()

def kv_delete(k):
    db().execute("DELETE FROM kv WHERE k = ?", (k,)); db().commit()

def embeddings():
    """(ids, float32 matrix) of every song heard so far."""
    rows = db().execute("SELECT track_id, vec FROM emb WHERE vec IS NOT NULL").fetchall()
    if not rows:
        return [], np.zeros((0, 512), np.float32)
    return [r[0] for r in rows], np.stack([np.frombuffer(r[1], np.float16) for r in rows]).astype(np.float32)
