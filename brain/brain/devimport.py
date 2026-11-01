"""Fill the brain's store from a copy of Slopify's database file (no server
needed): for a first training run before the brain endpoints are live.
  python -m brain.devimport /path/to/slopify.db"""
import json, sqlite3, sys
from . import store

def main(path):
    s = sqlite3.connect(f"file:{path}?mode=ro", uri=True); d = store.db()
    d.executemany("""INSERT OR REPLACE INTO tracks (id, seq, title, artist, artist_ids, album, album_id, genres, year, duration_ms, added_at, gone)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                  s.execute("SELECT id, rowid, title, artist, artist_ids, album, album_id, genres, year, duration_ms, added_at FROM tracks"))
    d.executemany("INSERT OR IGNORE INTO plays (seq, user_id, track_id, at, client) VALUES (?, ?, ?, ?, ?)",
                  s.execute("SELECT rowid, user_id, track_id, at, client FROM plays"))
    has_ev = s.execute("SELECT 1 FROM sqlite_master WHERE name = 'play_events'").fetchone()
    if has_ev:
        d.executemany("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", s.execute("SELECT id, user_id, track_id, at, ms_played, end_ms, duration_ms, reason, shuffle, client FROM play_events"))
    d.execute("DELETE FROM taste")
    d.executemany("INSERT OR IGNORE INTO taste VALUES (?, ?, 'like', ?)", s.execute("SELECT user_id, track_id, at FROM likes"))
    for u, j in s.execute("SELECT user_id, json FROM prefs"):
        try:
            d.executemany("INSERT OR IGNORE INTO taste VALUES (?, ?, 'dislike', 0)", [(u, t) for t in (json.loads(j).get("dislikes") or {})])
        except ValueError:
            pass
    d.commit()
    print({k: d.execute(f"SELECT COUNT(*) FROM {k}").fetchone()[0] for k in ("tracks", "plays", "events", "taste")})

if __name__ == "__main__":
    main(sys.argv[1])
