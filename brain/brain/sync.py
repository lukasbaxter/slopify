"""Pull what is new from Slopify: catalog, plays, how plays went, likes."""
import time, httpx
from . import config, store

def client():
    return httpx.Client(base_url=config.SLOPIFY_URL, headers={"X-Brain-Key": config.BRAIN_KEY}, timeout=120)

def _pages(c, path, cursor_key, insert):
    after = store.kv_get(cursor_key, 0); n = 0
    while True:
        items = c.get(path, params={"after": after}).raise_for_status().json()["items"]
        if not items:
            break
        insert(items); after = items[-1]["seq"]; n += len(items)
        store.kv_set(cursor_key, after)
    return n

def run():
    d = store.db(); out = {}
    with client() as c:
        def tracks(items):
            d.executemany("""INSERT INTO tracks (id, seq, title, artist, artist_ids, album, album_id, genres, year, duration_ms, added_at, gone)
              VALUES (:id, :seq, :title, :artist, :artist_ids, :album, :album_id, :genres, :year, :duration_ms, :added_at, 0)
              ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, title=excluded.title, artist=excluded.artist, artist_ids=excluded.artist_ids,
              album=excluded.album, album_id=excluded.album_id, genres=excluded.genres, year=excluded.year, duration_ms=excluded.duration_ms, gone=0""", items)
            d.commit()
        out["tracks"] = _pages(c, "/api/brain/catalog", "cur_catalog", tracks)
        # What was removed: a page cannot say, the full id list can.
        ids = set(c.get("/api/brain/ids").raise_for_status().json()["ids"])
        have = {r[0] for r in d.execute("SELECT id FROM tracks WHERE gone = 0")}
        gone = have - ids
        if gone:
            d.executemany("UPDATE tracks SET gone = 1 WHERE id = ?", [(i,) for i in gone]); d.commit()
        out["gone"] = len(gone)
        def plays(items):
            d.executemany("INSERT OR IGNORE INTO plays (seq, user_id, track_id, at, client) VALUES (:seq, :user_id, :track_id, :at, :client)", items); d.commit()
        out["plays"] = _pages(c, "/api/brain/plays", "cur_plays", plays)
        def events(items):
            d.executemany("""INSERT OR IGNORE INTO events (seq, user_id, track_id, at, ms_played, end_ms, duration_ms, reason, shuffle, client)
              VALUES (:seq, :user_id, :track_id, :at, :ms_played, :end_ms, :duration_ms, :reason, :shuffle, :client)""", items); d.commit()
        out["events"] = _pages(c, "/api/brain/events", "cur_events", events)
        t = c.get("/api/brain/taste").raise_for_status().json()
        d.execute("DELETE FROM taste")
        d.executemany("INSERT OR IGNORE INTO taste VALUES (?, ?, 'like', ?)", [(x["user_id"], x["track_id"], x["at"]) for x in t["likes"]])
        d.executemany("INSERT OR IGNORE INTO taste VALUES (?, ?, 'dislike', 0)", [(x["user_id"], x["track_id"]) for x in t["dislikes"]])
        d.commit()
        out["likes"] = len(t["likes"]); out["dislikes"] = len(t["dislikes"])
    store.kv_set("last_sync", {"at": int(time.time() * 1000), **out})
    return out
