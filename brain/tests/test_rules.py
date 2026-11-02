"""The household's rules and the retry-later path, without a GPU or a
Slopify: run with `python -m pytest brain/tests` (the CPU image has all it
needs: `docker run --rm -v $PWD/tests:/app/tests IMAGE python -m pytest tests`)."""
import http.server, json, os, threading, tempfile
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
os.environ["SLOPIFY_URL"] = "http://127.0.0.1:9"   # nothing listens: unreachable
os.environ["BRAIN_KEY"] = "k"
import pytest
from brain import gate, settings, weather, store, config

RULES = dict(settings.DEFAULTS)

def rules(**kw):
    return {**RULES, **kw}

def test_hours_window_and_wrap():
    assert gate.in_hours(0, 0, 13)                     # same hour twice: any time
    assert gate.in_hours(1, 7, 3) and not gate.in_hours(1, 7, 7) and not gate.in_hours(1, 7, 12)
    assert gate.in_hours(22, 6, 23) and gate.in_hours(22, 6, 2) and not gate.in_hours(22, 6, 12)

def blocked(r, **kw):
    a = dict(hour=12, listening=False, others_gb=None, encoding=False, burst=gate.Burst(), now=1000.0); a.update(kw)
    return gate.blocked(r, **a)

def test_each_rule_holds_heavy_work():
    assert blocked(rules(power="full")) is None
    assert "waiting for 01:00" in blocked(rules(power="full", fromHour=1, toHour=7))
    assert blocked(rules(power="full", pauseListening=True), listening=True) == "paused while someone is listening"
    assert blocked(rules(power="full", pauseListening=False), listening=True) is None
    assert "12.0 GB" in blocked(rules(power="full", otherGb=8), others_gb=12.0)
    assert blocked(rules(power="full", otherGb=8), others_gb=3.0) is None
    assert blocked(rules(power="full", otherGb=0), others_gb=30.0) is None              # 0: never
    assert blocked(rules(power="full", pauseEncoding=True), encoding=True) == "paused while the GPU encodes video"
    # On the CPU the GPU's rules do not apply; the hours and listening still do.
    assert blocked(rules(power="cpu", otherGb=1, pauseEncoding=True), others_gb=20.0, encoding=True) is None
    assert blocked(rules(power="cpu", pauseListening=True), listening=True) is not None

def test_power_works_in_bursts():
    b = gate.Burst()
    assert b.blocked("normal", 0) is None and b.blocked("normal", 599) is None
    assert "resting until" in b.blocked("normal", 600)
    assert b.blocked("normal", 1199) is not None and b.blocked("normal", 1200) is None   # 10 off, then on again
    assert b.blocked("full", 10 ** 6) is None
    l = gate.Burst(); l.blocked("light", 0)
    assert l.blocked("light", 300) is not None and l.blocked("light", 300 + 899) is not None and l.blocked("light", 1200) is None

def test_rules_from_slopify_typed_or_ignored():
    m = settings.merge({"power": "light", "otherGb": "8", "location": "Victoria, BC", "nonsense": 1, "enabled": None})
    assert m["power"] == "light" and m["otherGb"] == 0 and m["location"] == "Victoria, BC" and m["enabled"] is True and "nonsense" not in m

class R:
    def __init__(self, code, body=None): self.status_code, self._b = code, body
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError(self.status_code)
        return self
    def json(self): return self._b

def test_old_or_down_slopify_keeps_last_rules():
    settings._s.update(at=0, rules=dict(settings.DEFAULTS), from_slopify=False)
    s = settings.refresh(force=True, get=lambda *a, **k: R(200, {"settings": {"power": "full"}, "tz": "America/Vancouver", "listening": True}))
    assert s["rules"]["power"] == "full" and s["tz"] == "America/Vancouver" and s["listening"] and s["from_slopify"]
    def down(*a, **k): raise ConnectionError("refused")
    assert settings.refresh(force=True, get=down)["rules"]["power"] == "full"            # kept
    assert settings.refresh(force=True, get=lambda *a, **k: R(404))["from_slopify"] is False

GEO = {"results": [
    {"name": "Victoria", "latitude": 22.28, "longitude": 114.15, "country": "Hong Kong", "country_code": "HK", "admin1": "Central and Western", "timezone": "Asia/Hong_Kong"},
    {"name": "Victoria", "latitude": 48.4284, "longitude": -123.3656, "country": "Canada", "country_code": "CA", "admin1": "British Columbia", "timezone": "America/Vancouver"},
]}

def test_location_by_name():
    get = lambda *a, **k: R(200, GEO)
    p = weather.lookup("Victoria, BC", get=get)
    assert p == {"name": "Victoria, BC", "lat": 48.43, "lon": -123.37, "timezone": "America/Vancouver", "label": "Victoria, British Columbia, Canada"}
    assert weather.lookup("Victoria", get=get)["timezone"] == "Asia/Hong_Kong"          # first hit without a hint
    assert weather.lookup("Victoria, Narnia", get=get) == {"name": "Victoria, Narnia", "error": "not found"}

def test_unreachable_slopify_is_not_damage():
    """Every fetch fails while Slopify restarts: nothing is recorded as
    undecodable, and songs an older brain recorded that way go back in line."""
    pytest.importorskip("torch")
    from brain import audio
    d = store.db()
    d.executemany("INSERT OR REPLACE INTO tracks (id, seq, title, artist, duration_ms, gone) VALUES (?, ?, 't', 'a', 200000, 0)", [(f"{i:032x}", i) for i in range(6)])
    d.commit()
    r = audio.run(limit=6)
    assert r["done"] == 0 and r["failed"] == 0 and r["later"] >= 1
    assert d.execute("SELECT COUNT(*) FROM emb").fetchone()[0] == 0
    d.execute("INSERT INTO emb VALUES (?, NULL, ?, 0)", ("a" * 32, "Connection refused"))
    d.execute("INSERT INTO emb VALUES (?, NULL, ?, 0)", ("b" * 32, "Invalid data found when processing input"))
    d.commit()
    assert audio.forget_unreachable() == 1
    assert [r[0] for r in d.execute("SELECT track_id FROM emb")] == ["b" * 32]

def test_damaged_song_with_slopify_up_is_recorded():
    pytest.importorskip("torch")
    from brain import audio
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"ok" if self.path == "/healthz" else b"this is not audio" * 100
            self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        config.SLOPIFY_URL = f"http://127.0.0.1:{srv.server_address[1]}"
        d = store.db(); d.execute("DELETE FROM emb"); d.execute("DELETE FROM tracks")
        d.execute("INSERT INTO tracks (id, seq, title, artist, duration_ms, gone) VALUES (?, 1, 't', 'a', 200000, 0)", ("c" * 32,)); d.commit()
        r = audio.run(limit=1)
        assert r["failed"] == 1 and r["later"] == 0
        assert d.execute("SELECT err FROM emb WHERE track_id = ?", ("c" * 32,)).fetchone()[0]
    finally:
        srv.shutdown(); config.SLOPIFY_URL = "http://127.0.0.1:9"

def test_length_on_record_too_long_still_heard(tmp_path):
    """The Moby rips: 22 minutes on record, 4 of audio. The clips at 35% and
    70% land past the end; the start is used instead."""
    pytest.importorskip("torch")
    import subprocess
    from brain import audio
    f = tmp_path / "s.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", str(f)], check=True)
    body = f.read_bytes()
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            b = b"ok" if self.path == "/healthz" else body
            self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        config.SLOPIFY_URL = f"http://127.0.0.1:{srv.server_address[1]}"
        clips = audio.clips_for("d" * 32, 1_300_000)
        assert len(clips) == 1 and len(clips[0]) > audio.SR * 10
    finally:
        srv.shutdown(); config.SLOPIFY_URL = "http://127.0.0.1:9"
