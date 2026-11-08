"""The brain's API and its maintainer loop.
  POST /recommend   what to play next (Slopify asks; X-Brain-Key)
  POST /similar     songs that sound like seed songs (Home's Daily Mixes)
  POST /train       retrain now (Slopify's Brain task: Run now, its schedule)
  GET  /status      what it knows, how well it does, what it is doing
The loop, all day: pull what is new from Slopify (5 min), the household's
rules (30 s), the weather (hourly), listen to songs it has not heard yet,
and retrain when Slopify's schedule says (or nightly, with an older
Slopify) and once the songs it can hear have grown by a fifth. Listening and
training wait for the rules (gate.py); answering never does."""
import asyncio, datetime as dt, hmac, threading, time, traceback
import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from . import config, store, sync, weather, audio, train, features, settings, device
from .gate import Gate
from .recommend import Engine

app = FastAPI(title="Slopify brain")
engine = Engine()
state = {"phase": "starting", "log": [], "embed": None, "errors": 0, "paused": None, "train_now": False, "place": None}
gate = Gate(rules=lambda: settings.refresh()["rules"], listening=lambda: settings.refresh()["listening"],
            device=device.pick, hour=lambda: dt.datetime.now(features.tz()).hour)

def log(msg):
    line = f"{dt.datetime.now(features.tz()):%m-%d %H:%M:%S} {msg}"
    print(line, flush=True); state["log"] = (state["log"] + [line])[-200:]

def check(key):
    if not config.BRAIN_KEY or not key or not hmac.compare_digest(key, config.BRAIN_KEY):
        raise HTTPException(401, "unauthorized")

@app.post("/recommend")
async def recommend(req: Request, x_brain_key: str = Header(default="")):
    check(x_brain_key)
    ask = await req.json(); t0 = time.time()
    # Off the event loop: run on it, the model held up /status and every
    # other request for as long as it thought (Engine.recommend runs one at a time).
    out = await asyncio.to_thread(engine.recommend, ask)
    if out is None:
        raise HTTPException(503, "no model yet")
    out["ms"] = round((time.time() - t0) * 1000)
    w = weather.words(weather.at(ask.get("now") or time.time() * 1000))
    log(f"{ask.get('mode')} for {str(ask.get('user'))[:6]} on {features.device_of(ask.get('client'))}{', ' + w if w else ''}: {len(out['items'])} in {out['ms']} ms")
    return out

@app.post("/similar")
async def similar(req: Request, x_brain_key: str = Header(default="")):
    """Songs that sound like the seeds (CLAP): Home's Daily Mixes."""
    check(x_brain_key)
    ask = await req.json(); t0 = time.time()
    out = await asyncio.to_thread(engine.similar, ask)
    if out is None:
        raise HTTPException(503, "no model yet")
    log(f"similar for {str(ask.get('user'))[:6]}: {len(out['items'])} in {round((time.time() - t0) * 1000)} ms")
    return out

@app.post("/search")
async def search(req: Request, x_brain_key: str = Header(default="")):
    """Songs that sound like the words: generated playlists."""
    check(x_brain_key)
    ask = await req.json(); t0 = time.time()
    out = await asyncio.to_thread(engine.search, ask)
    if out is None:
        raise HTTPException(503, "no model yet")
    log(f"search for {str(ask.get('user'))[:6]}: {str(ask.get('text'))[:60]!r}: {len(out['items'])} in {round((time.time() - t0) * 1000)} ms")
    return out

@app.post("/retry")
async def retry(req: Request, x_brain_key: str = Header(default="")):
    """Songs Slopify checked (a wrong length fixed, a file that decodes after
    all): listen to them again."""
    check(x_brain_key)
    ids = [str(i) for i in ((await req.json()).get("ids") or [])][:5000]
    d = store.db(); d.executemany("DELETE FROM emb WHERE track_id = ? AND vec IS NULL", [(i,) for i in ids]); d.commit()
    return {"retrying": len(ids)}

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.post("/train")
def train_now(x_brain_key: str = Header(default="")):
    check(x_brain_key)
    state["train_now"] = True
    return {"queued": True, "phase": state["phase"]}

@app.get("/status")
def status(x_brain_key: str = Header(default="")):
    check(x_brain_key)
    d = store.db()
    heard, failed = d.execute("SELECT SUM(vec IS NOT NULL), SUM(vec IS NULL) FROM emb").fetchone()
    songs = d.execute("SELECT COUNT(*) FROM tracks WHERE gone = 0").fetchone()[0]
    rate = (state["embed"] or {}).get("per_s") or 0
    left = max(0, songs - (heard or 0) - (failed or 0))
    p = weather.place()
    return {"phase": state["phase"], "paused": state["paused"], "model_loaded": engine.ready, "loaded_at": engine.loaded_at,
            "device": getattr(engine, "dev", None), "songs": songs, "heard": heard or 0, "undecodable": failed or 0,
            "left": left, "eta_s": round(left / rate) if rate and left else None,
            "embedding": state["embed"], "last_sync": store.kv_get("last_sync"), "last_train": store.kv_get("last_train"),
            "training": state["phase"] == "training" or state["train_now"],
            "place": (p or {}).get("label"), "place_error": (state["place"] or {}).get("error"), "tz": features.refresh_tz(),
            "rules_from_slopify": settings.refresh()["from_slopify"], "slopify_error": state.get("unreachable"),
            "weather_now": weather.words(weather.at(time.time() * 1000)), "log": state["log"][-40:]}

@app.get("/undecodable")
def undecodable(x_brain_key: str = Header(default="")):
    check(x_brain_key)
    return {"items": [dict(zip(("id", "artist", "title", "error"), r)) for r in store.db().execute(
        "SELECT e.track_id, t.artist, t.title, e.err FROM emb e JOIN tracks t ON t.id = e.track_id WHERE e.vec IS NULL ORDER BY e.at DESC LIMIT 500")]}

def maintain():
    last_sync = last_weather = last_forget = 0; trained_day = None
    n = audio.forget_unreachable()
    if n:
        log(f"{n} songs that could not be fetched before are back in line")
    if engine.load():
        log(f"model loaded ({len(engine.meta['ids'])} songs on {engine.dev})")
    while True:
        try:
            now = time.time()
            rules = settings.refresh()
            features.refresh_tz()
            if config.SLOPIFY_URL and now - last_sync > config.SYNC_EVERY_S:
                state["phase"] = "syncing"; r = sync.run(); last_sync = now; state["unreachable"] = None
                if any(r.get(k) for k in ("tracks", "plays", "events", "gone")):
                    log(f"sync: {r}")
            if now - last_weather > 3600:
                state["place"] = weather.resolve(); last_weather = now
                if weather.enabled():
                    first = store.db().execute("SELECT MIN(at) FROM plays").fetchone()[0]
                    if first:
                        weather.backfill(first)
                    weather.refresh()
            if now - last_forget > 86400:
                if last_forget:
                    audio.forget_unreachable()
                last_forget = now
            if engine.ready and engine.dev != device.pick():
                engine.load(); log(f"recommending on {engine.dev} now")
            # Training: asked for (Slopify's Run now and schedule) goes now;
            # the nightly one (older Slopify) and "heard a fifth more" wait
            # for the rules like listening does.
            local = dt.datetime.now(features.tz())
            lt = store.kv_get("last_train") or {}
            heard = store.db().execute("SELECT COUNT(*) FROM emb WHERE vec IS NOT NULL").fetchone()[0]
            grown = heard > 1000 and heard > 1.2 * (lt.get("heard") or 0)
            nightly = not rules["from_slopify"] and local.hour == config.TRAIN_AT_HOUR and trained_day != local.date()
            why = gate.why(fresh=True)
            if state["train_now"] or ((nightly or not lt or grown) and not why):
                state["phase"] = "training"; state["paused"] = None; state["train_now"] = False; trained_day = local.date()
                meta = train.train(log=log)
                engine.load(); log(f"retrained: {meta['metrics']} vs old mix {meta['baselines']['old_mix']}")
                continue
            if config.SLOPIFY_URL and audio.todo(1):
                if why:
                    if state["paused"] != why:
                        log(f"listening {why}")
                    state["phase"] = "paused"; state["paused"] = why
                    audio.unload(); time.sleep(30); continue
                state["phase"] = "listening"; state["paused"] = None
                def prog(done, failed, total, secs):
                    state["embed"] = {"done": done, "failed": failed, "batch": total, "per_s": round(done / max(1, secs), 1)}
                r = audio.run(limit=500, stop=lambda: gate.why() is not None, progress=prog)
                log(f"listened to {r['done']} songs ({r['failed']} would not decode{', ' + str(r['later']) + ' could not be fetched, later' if r.get('later') else ''}) in {r.get('seconds')} s")
                if r.get("later"):
                    time.sleep(60)   # Slopify restarting: give it a minute
                continue
            gate.burst.idle(); audio.unload()
            state["phase"] = "idle"; state["paused"] = None; time.sleep(30)
        except httpx.TransportError as e:
            # Slopify down, restarting, or SLOPIFY_URL wrong: one line, not a traceback a minute.
            msg = f"can't reach Slopify at {config.SLOPIFY_URL} ({type(e).__name__}), trying again in a minute"
            if state.get("unreachable") != msg:
                log(msg)
            state["unreachable"] = msg; state["phase"] = "waiting for Slopify"; time.sleep(60)
        except Exception as e:  # noqa: BLE001 - the loop must survive anything; the error is logged
            state["errors"] += 1; log(f"maintainer: {e!r}"); traceback.print_exc(); time.sleep(60)


@app.on_event("startup")
def start():
    threading.Thread(target=maintain, daemon=True, name="maintainer").start()
