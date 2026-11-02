"""How each song sounds: a CLAP embedding (audio and text share one space, so
"rainy Sunday morning" can be compared with a song). Two 10 s clips per song,
at 35% and 70% of it (an intro says little), read from Slopify by byte range.
A song that will not decode is remembered with the error: the maintainer
report lists them (a damaged file on the NAS). One that could not be fetched
(Slopify restarting, the network) is not: it is tried again later."""
import gc, queue, re, subprocess, threading, time
import httpx, numpy as np, torch
from concurrent.futures import ThreadPoolExecutor
from . import config, store, device

SR = 48000
_model = None
# ffmpeg's words for "could not get the bytes", as opposed to "got bytes
# that are not audio".
NETWORK = re.compile(r"Connection refused|Connection reset|timed out|Timeout|No route to host|Network is unreachable|"
                     r"Name or service not known|Temporary failure in name resolution|Server returned 5\d\d|"
                     r"Server returned 429|HTTP error 5\d\d|HTTP error 429|Broken pipe|Unknown error occurred|End of file", re.I)

class Unreachable(Exception):
    pass

def model():
    global _model
    dev = device.pick()
    if _model is not None and _model[2] != dev:
        unload()   # the household moved it off (or back onto) the GPU
    if _model is None:
        from transformers import ClapModel, ClapProcessor
        m = ClapModel.from_pretrained(config.AUDIO_MODEL).to(dev).eval()
        _model = (m, ClapProcessor.from_pretrained(config.AUDIO_MODEL), dev)
    return _model

def unload():
    """Give the GPU memory back (resting, paused)."""
    global _model
    if _model is not None:
        _model = None; gc.collect(); device.free_cache()

def slopify_up():
    try:
        return httpx.get(f"{config.SLOPIFY_URL}/healthz", timeout=5).status_code == 200
    except Exception:  # noqa: BLE001
        return False

def forget_unreachable():
    """Songs recorded as failed because they could not be fetched (by an
    older brain, or a Slopify restart): back in line."""
    d = store.db()
    rows = [r[0] for r in d.execute("SELECT track_id, err FROM emb WHERE vec IS NULL").fetchall() if NETWORK.search(r[1] or "")]
    d.executemany("DELETE FROM emb WHERE track_id = ?", [(t,) for t in rows]); d.commit()
    return len(rows)

def clip(track_id, start_s, secs=10):
    url = f"{config.SLOPIFY_URL}/api/brain/audio/{track_id}"
    try:
        p = subprocess.run(["ffmpeg", "-v", "error", "-headers", f"X-Brain-Key: {config.BRAIN_KEY}\r\n", "-ss", f"{start_s:.2f}", "-t", str(secs),
                            "-i", url, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as e:
        raise Unreachable("timed out") from e
    if p.returncode != 0:
        msg = (p.stderr.decode(errors="replace").strip().splitlines() or ["ffmpeg failed"])[-1][:300]
        raise Unreachable(msg) if NETWORK.search(msg) else RuntimeError(msg)
    return np.frombuffer(p.stdout, np.float32)

def clips_for(track_id, duration_ms):
    dur = (duration_ms or 0) / 1000
    starts = [max(0.0, dur * f - 5) for f in (0.35, 0.7)] if dur > 25 else [0.0]
    out = [c for c in (clip(track_id, s) for s in starts) if len(c) > SR]
    if not out and starts != [0.0]:
        # Nothing there: the length Slopify has is longer than the audio (an
        # MP3 whose header lies, a file cut short). Whatever the start holds.
        out = [c for c in [clip(track_id, 0.0, 20)] if len(c) > SR]
    if not out:
        raise RuntimeError("no audio decoded")
    return out

@torch.no_grad()
def embed_audio(clips):
    m, p, dev = model()
    inp = p(audio=clips, sampling_rate=SR, return_tensors="pt").to(dev)
    return torch.nn.functional.normalize(m.get_audio_features(**inp).float(), dim=-1).cpu().numpy()

@torch.no_grad()
def embed_text(texts):
    m, p, dev = model()
    inp = p(text=texts, return_tensors="pt", padding=True).to(dev)
    return torch.nn.functional.normalize(m.get_text_features(**inp).float(), dim=-1).cpu().numpy()

def todo(limit=None):
    """Songs not heard yet: the ones people play and like first (training
    needs them), then newest first."""
    q = """SELECT t.id, t.duration_ms FROM tracks t LEFT JOIN emb e ON e.track_id = t.id
           LEFT JOIN (SELECT track_id, COUNT(*) n FROM plays GROUP BY track_id) p ON p.track_id = t.id
           LEFT JOIN (SELECT track_id, 1 AS liked FROM taste WHERE kind = 'like' GROUP BY track_id) l ON l.track_id = t.id
           WHERE e.track_id IS NULL AND t.gone = 0
           ORDER BY COALESCE(l.liked, 0) DESC, COALESCE(p.n, 0) DESC, t.added_at DESC"""
    return store.db().execute(q + (f" LIMIT {int(limit)}" if limit else "")).fetchall()

def run(limit=None, stop=lambda: False, progress=None):
    """Embed what is missing. Decoding (network + ffmpeg) runs on threads,
    the GPU takes batches as they fill."""
    rows = todo(limit)
    if not rows:
        return {"done": 0, "failed": 0}
    ready = queue.Queue(maxsize=256)
    done = failed = later = 0
    t0 = time.time()
    cut = threading.Event()   # Slopify went away: stop asking, try later

    def work(row):
        tid, dur = row
        if cut.is_set() or stop():
            return
        try:
            ready.put((tid, clips_for(tid, dur), None))
        except Exception as e:  # noqa: BLE001 - every failure is recorded per song
            # With Slopify down every song fails and none of them is damaged:
            # stop and try later. With it up, the failure is this song's (a
            # network-looking one is recorded too, so one bad file cannot
            # stop the line; forget_unreachable gives those another go daily).
            ready.put((tid, None, str(e)) if slopify_up() else (tid, None, None))

    def feeder():
        with ThreadPoolExecutor(config.EMBED_WORKERS) as ex:
            list(ex.map(work, rows))
        ready.put(None)

    threading.Thread(target=feeder, daemon=True).start()
    d = store.db(); batch = []

    def flush():
        nonlocal done
        if not batch:
            return
        flat = [c for _, cs in batch for c in cs]
        vecs = embed_audio(flat); i = 0; now = int(time.time() * 1000)
        for tid, cs in batch:
            v = vecs[i:i + len(cs)].mean(0); i += len(cs)
            v = v / (np.linalg.norm(v) + 1e-9)
            d.execute("INSERT OR REPLACE INTO emb (track_id, vec, err, at) VALUES (?, ?, NULL, ?)", (tid, v.astype(np.float16).tobytes(), now))
        d.commit(); done += len(batch); batch.clear()
        if progress:
            progress(done, failed, len(rows), time.time() - t0)

    while True:
        item = ready.get()
        if item is None:
            break
        tid, cs, err = item
        if cs is None and err is None:
            later += 1; cut.set()
            continue
        if err:
            failed += 1
            d.execute("INSERT OR REPLACE INTO emb (track_id, vec, err, at) VALUES (?, NULL, ?, ?)", (tid, err, int(time.time() * 1000))); d.commit()
            continue
        batch.append((tid, cs))
        if sum(len(c) for _, c in batch) >= 64:
            flush()
    flush()
    return {"done": done, "failed": failed, "later": later, "seconds": round(time.time() - t0)}
