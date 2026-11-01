"""The brain's API and its maintainer loop.
  POST /recommend   what to play next (Slopify asks; X-Brain-Key)
  GET  /status      what it knows, how well it does, what it is doing
The loop, all day: pull what is new from Slopify (5 min), the weather
(hourly), listen to songs it has not heard yet, and retrain every night (and
once the songs it can hear have grown by a fifth since the last training)."""
import datetime as dt, hmac, threading, time, traceback
from fastapi import FastAPI, Header, HTTPException, Request
from . import config, store, sync, weather, audio, train, features
from .recommend import Engine

app = FastAPI(title="Slopify brain")
engine = Engine()
state = {"phase": "starting", "log": [], "embed": None, "errors": 0}

def log(msg):
    line = f"{dt.datetime.now(features.TZ):%m-%d %H:%M:%S} {msg}"
    print(line, flush=True); state["log"] = (state["log"] + [line])[-200:]

def check(key):
    if not config.BRAIN_KEY or not key or not hmac.compare_digest(key, config.BRAIN_KEY):
        raise HTTPException(401, "unauthorized")

@app.post("/recommend")
async def recommend(req: Request, x_brain_key: str = Header(default="")):
    check(x_brain_key)
    ask = await req.json(); t0 = time.time()
    out = engine.recommend(ask)
    if out is None:
        raise HTTPException(503, "no model yet")
    out["ms"] = round((time.time() - t0) * 1000)
    w = weather.words(weather.at(ask.get("now") or time.time() * 1000))
    log(f"{ask.get('mode')} for {str(ask.get('user'))[:6]} on {features.device_of(ask.get('client'))}{', ' + w if w else ''}: {len(out['items'])} in {out['ms']} ms")
    return out

@app.get("/status")
def status(x_brain_key: str = Header(default="")):
    check(x_brain_key)
    d = store.db()
    heard, failed = d.execute("SELECT SUM(vec IS NOT NULL), SUM(vec IS NULL) FROM emb").fetchone()
    return {"phase": state["phase"], "model_loaded": engine.ready, "loaded_at": engine.loaded_at,
            "songs": d.execute("SELECT COUNT(*) FROM tracks WHERE gone = 0").fetchone()[0], "heard": heard or 0, "undecodable": failed or 0,
            "embedding": state["embed"], "last_sync": store.kv_get("last_sync"), "last_train": store.kv_get("last_train"),
            "weather_now": weather.words(weather.at(time.time() * 1000)), "log": state["log"][-40:]}

@app.get("/undecodable")
def undecodable(x_brain_key: str = Header(default="")):
    check(x_brain_key)
    return {"items": [dict(zip(("id", "artist", "title", "error"), r)) for r in store.db().execute(
        "SELECT e.track_id, t.artist, t.title, e.err FROM emb e JOIN tracks t ON t.id = e.track_id WHERE e.vec IS NULL ORDER BY e.at DESC LIMIT 500")]}

def maintain():
    last_sync = last_weather = 0; trained_day = None
    if engine.load():
        log(f"model loaded ({len(engine.meta['ids'])} songs)")
    while True:
        try:
            now = time.time()
            if config.SLOPIFY_URL and now - last_sync > config.SYNC_EVERY_S:
                state["phase"] = "syncing"; r = sync.run(); last_sync = now
                if any(r.get(k) for k in ("tracks", "plays", "events", "gone")):
                    log(f"sync: {r}")
            if weather.enabled() and now - last_weather > 3600:
                first = store.db().execute("SELECT MIN(at) FROM plays").fetchone()[0]
                if first:
                    weather.backfill(first)
                weather.refresh(); last_weather = now
            local = dt.datetime.now(features.TZ)
            lt = store.kv_get("last_train") or {}
            heard = store.db().execute("SELECT COUNT(*) FROM emb WHERE vec IS NOT NULL").fetchone()[0]
            grown = heard > 1000 and heard > 1.2 * (lt.get("heard") or 0)
            if (local.hour == config.TRAIN_AT_HOUR and trained_day != local.date()) or not lt or grown:
                state["phase"] = "training"; trained_day = local.date()
                meta = train.train(log=log)
                engine.load(); log(f"retrained: {meta['metrics']} vs old mix {meta['baselines']['old_mix']}")
                continue
            if config.SLOPIFY_URL and audio.todo(1):
                state["phase"] = "listening"
                def prog(done, failed, total, secs):
                    state["embed"] = {"done": done, "failed": failed, "batch": total, "per_s": round(done / max(1, secs), 1)}
                r = audio.run(limit=500, progress=prog)
                log(f"listened to {r['done']} songs ({r['failed']} would not decode) in {r.get('seconds')} s")
                continue
            state["phase"] = "idle"; time.sleep(30)
        except Exception as e:  # noqa: BLE001 - the loop must survive anything; the error is logged
            state["errors"] += 1; log(f"maintainer: {e!r}"); traceback.print_exc(); time.sleep(60)

@app.on_event("startup")
def start():
    threading.Thread(target=maintain, daemon=True, name="maintainer").start()
