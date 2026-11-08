"""The API while the model thinks: a /recommend that takes a while must not
hold up /status or anything else, and two of them never run the model at the
same time. Needs torch (the brain's images have it; skipped without)."""
import asyncio, os, tempfile, threading, time
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("SLOPIFY_URL", "http://127.0.0.1:9")
os.environ.setdefault("BRAIN_KEY", "k")
import pytest
pytest.importorskip("torch")
httpx = pytest.importorskip("httpx")
from brain import serve, config
from brain.recommend import Engine

KEY = {"X-Brain-Key": config.BRAIN_KEY}

class Slow:
    """Stands in for the model: each answer takes `secs` of blocking work."""
    def __init__(self, secs):
        self.secs = secs; self.now = 0; self.most = 0; self.lock = threading.Lock()
    def __call__(self, ask):
        with self.lock:
            self.now += 1; self.most = max(self.most, self.now)
        time.sleep(self.secs)
        with self.lock:
            self.now -= 1
        return {"items": ["a"], "model": None}

def test_a_slow_recommend_does_not_hold_up_other_requests(monkeypatch):
    class Model:
        recommend = Slow(0.6)
    monkeypatch.setattr(serve, "engine", Model())
    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=serve.app), base_url="http://brain") as c:
            t0 = time.monotonic()
            rec = asyncio.create_task(c.post("/recommend", json={"mode": "continue", "user": "u"}, headers=KEY))
            await asyncio.sleep(0.05)
            h = await c.get("/healthz")
            took = time.monotonic() - t0
            r = await rec
            return h, took, r
    h, took, r = asyncio.run(go())
    assert h.status_code == 200 and r.status_code == 200
    assert r.json()["items"] == ["a"]
    assert took < 0.4, f"/healthz waited {took:.2f} s behind /recommend"

# Answering off the event loop must not run the model twice at once: on the
# loop, one answer at a time was a given.
def test_two_recommends_never_run_the_model_at_once(monkeypatch):
    slow = Slow(0.2)
    e = Engine(); e.ready = True
    monkeypatch.setattr(e, "_recommend", slow, raising=False)
    monkeypatch.setattr(serve, "engine", e)
    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=serve.app), base_url="http://brain") as c:
            return await asyncio.gather(*[c.post("/recommend", json={"mode": "continue", "user": "u"}, headers=KEY) for _ in range(3)])
    rs = asyncio.run(go())
    assert [r.status_code for r in rs] == [200, 200, 200]
    assert slow.most == 1
