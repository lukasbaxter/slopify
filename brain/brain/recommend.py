"""Answering 'what next': the trained model scores every song for this
listener at this moment, then house rules shape the list:
  - continue (the queue ran out) stays near the last song;
  - smart (smart shuffle) mixes songs they know with new ones, 50/50;
  - radio follows the seed song closely;
  - now (Home's 'right now') is the moment alone: time, weather, device.
Home's Daily Mixes (similar) skip the model: CLAP closeness to seed songs.
Picks are sampled from the top, not the strict top, so the same moment does
not always give the same list; at most two songs per artist and none of the
odd versions (karaoke, sped up...) unless the seed is one."""
import json, os, re, threading, time
import numpy as np, torch
from . import config, store, device, features
from .model import Brain
from .train import MODEL_DIR, MAX_LEN

ODD = re.compile(r"\b(instrumental|karaoke|a ?cappella|sped[ -]?up|slowed|nightcore|8d audio|skit|interlude|commentary)\b", re.I)
SEED_PULL = {"continue": 0.6, "smart": 0.35, "radio": 1.2, "now": 0.0}
SESSION_PULL = {"continue": 0.8, "smart": 0.6, "radio": 0.5, "now": 0.3}
KNOWN_SHARE = {"continue": 0.6, "smart": 0.5, "radio": 0.3, "now": 0.7}

def similar(audio, ids, index, info, seeds, n, skip=(), per_artist=3, seed=None):
    """Songs that sound like the seeds, by CLAP alone: the seeds' audio
    averaged, every song heard so far ranked by cosine to it. Sampled from the
    best, weighted by closeness (seed: the same draw for the same seed), then
    closest first; no seed, nothing in skip, no odd versions unless a seed
    is one, per_artist songs per artist at most."""
    rows = [index[s] for s in seeds if s in index and np.abs(audio[index[s]]).sum() > 0]
    if not rows:
        return []
    q = audio[rows].mean(0); q = q / (np.linalg.norm(q) + 1e-9)
    sound = audio @ q
    sound[np.abs(audio).sum(1) == 0] = -9; sound[0] = -9
    seed_odd = any(ODD.search((info.get(s) or ("",))[0] or "") for s in seeds)
    skip = set(skip) | set(seeds)
    cand = []
    for i in np.argsort(-sound)[:max(n * 20, 2000)]:
        if sound[i] <= -9:
            break
        t = ids[i - 1]
        if t in skip:
            continue
        title, artist, _ = info.get(t, ("", "", ""))
        if not seed_odd and ODD.search(title or ""):
            continue
        cand.append((t, float(sound[i]), (artist or "").lower()))
    if not cand:
        return []
    pool = cand[:max(n * 3, 60)]
    w = np.maximum(np.exp((np.array([s for _, s, _ in pool]) - pool[0][1]) / 0.03), 1e-12)
    order = np.random.default_rng(seed).choice(len(pool), size=len(pool), replace=False, p=w / w.sum())
    out, per = [], {}
    for j in list(order) + list(range(len(pool), len(cand))):   # a short pool: the rest, best first
        t, sc, a = (pool[j] if j < len(pool) else cand[j])
        if per.get(a, 0) >= per_artist:
            continue
        per[a] = per.get(a, 0) + 1; out.append((t, sc))
        if len(out) >= n:
            break
    return [t for t, _ in sorted(out, key=lambda x: -x[1])]

class Engine:
    def __init__(self):
        self.lock = threading.Lock(); self.ready = False; self.loaded_at = 0

    def load(self):
        meta_p = os.path.join(MODEL_DIR, "meta.json")
        if not os.path.exists(meta_p):
            return False
        dev = device.pick()
        with open(meta_p) as f:
            meta = json.load(f)
        ids = meta["ids"]; index = {t: i + 1 for i, t in enumerate(ids)}
        m = Brain(len(ids), meta["n_artists"], len(meta["users"]), max_len=MAX_LEN)
        m.load_state_dict(torch.load(os.path.join(MODEL_DIR, "brain.pt"), map_location="cpu")); m.to(dev).eval()
        from .train import vocab
        v = vocab()   # the catalog as it is now; songs added since training get sound + artist only
        audio = torch.from_numpy(v["audio"]).to(dev)
        art = torch.from_numpy(v["artist_of"]).clamp(max=meta["n_artists"]).to(dev)
        own = torch.tensor([0] + [index.get(t, 0) for t in v["ids"]], device=dev)
        with torch.no_grad():
            vecs = torch.cat([m.items(audio[i:i + 32768], art[i:i + 32768], own[i:i + 32768]) for i in range(0, len(v["ids"]) + 1, 32768)])
        d = store.db()
        info = {r[0]: (r[1], r[2], r[3]) for r in d.execute("SELECT id, title, artist, artist_ids FROM tracks")}
        with self.lock:
            self.m, self.dev, self.meta, self.v, self.vecs, self.info = m, dev, meta, v, vecs, info
            self.ready = True; self.loaded_at = int(time.time() * 1000)
        return True

    def _known(self, user):
        d = store.db()
        played = {r[0] for r in d.execute("SELECT DISTINCT track_id FROM plays WHERE user_id = ?", (user,))}
        liked = {r[0] for r in d.execute("SELECT track_id FROM taste WHERE user_id = ? AND kind = 'like'", (user,))}
        disliked = {r[0] for r in d.execute("SELECT track_id FROM taste WHERE user_id = ? AND kind = 'dislike'", (user,))}
        return played | liked, disliked

    def recommend(self, ask):
        if not self.ready:
            return None
        with self.lock:
            m, dev, v, vecs, info = self.m, self.dev, self.v, self.vecs, self.info
        idx = v["index"]; mode = ask.get("mode", "continue"); n = max(1, min(200, int(ask.get("n", 25))))
        now = int(ask.get("now") or time.time() * 1000); client = ask.get("client") or ""
        recent = [r for r in (ask.get("recent") or []) if r.get("id") in idx][-MAX_LEN:]
        seeds = [s for s in (ask.get("seeds") or []) if s in idx]
        # History: what they just did (from Slopify, newest last), the seed last if it is not already.
        if seeds and (not recent or recent[-1]["id"] != seeds[0]):
            recent = (recent + [{"id": seeds[0], "at": now}])[-MAX_LEN:]
        hi = torch.zeros((1, MAX_LEN), dtype=torch.long); hf = torch.zeros((1, MAX_LEN, features.N_STEP + features.N_CTX)); mask = torch.ones((1, MAX_LEN), dtype=torch.bool)
        prev = None
        for j, r in enumerate(recent):
            at = int(r.get("at") or now)
            hi[0, j] = idx[r["id"]]; mask[0, j] = False
            hf[0, j] = torch.tensor(features.step(prev, at, r.get("ms"), r.get("reason"), None) + features.context(at, client, "history"))
            prev = at
        users = self.meta["users"]; u = torch.tensor([users.get(ask.get("user"), 0)])
        ctx = torch.tensor([features.context(now, client, mode)], dtype=torch.float32)
        with torch.no_grad():
            q = m.query(vecs[hi.to(dev)], hf.to(dev), mask.to(dev), u.to(dev), ctx.to(dev))[0]
            if seeds and SEED_PULL.get(mode, 0):
                q = torch.nn.functional.normalize(q + SEED_PULL[mode] * vecs[idx[seeds[0]]], dim=-1)
            scores = (vecs @ q)
            # Stay with the session: closeness to the last few songs counts
            # too (a new song has to suit what is playing, not only the
            # listener in general).
            live = [idx[r["id"]] for r in recent[-5:]]
            if live and SESSION_PULL.get(mode, 0):
                c = torch.nn.functional.normalize(vecs[torch.tensor(live, device=dev)].mean(0), dim=-1)
                scores = scores + SESSION_PULL[mode] * (vecs @ c)
            scores = scores.float().cpu().numpy()
        scores[0] = -9
        if ask.get("_scores"):
            return scores
        known, disliked = self._known(ask.get("user"))
        skip = set(ask.get("exclude") or []) | disliked | {r["id"] for r in recent}
        seed_odd = any(ODD.search(info.get(s, ("", "", ""))[0] or "") for s in seeds)
        order = np.argsort(-scores)[:4000]
        known_c, new_c = [], []
        for i in order:
            t = v["ids"][i - 1]
            if t in skip:
                continue
            title, artist, _ = info.get(t, ("", "", ""))
            if not seed_odd and ODD.search(title or ""):
                continue
            (known_c if t in known else new_c).append((t, float(scores[i]), artist))
        # Sample within the best, weighted by score: varied, still on target.
        rng = np.random.default_rng()
        def sample(c, k):
            c = c[:max(k * 4, 40)]
            if not c:
                return []
            w = np.exp((np.array([s for _, s, _ in c]) - c[0][1]) / 0.03)
            pick = rng.choice(len(c), size=min(len(c), k * 2), replace=False, p=w / w.sum())
            return [c[j] for j in sorted(pick)]
        k_known = round(n * KNOWN_SHARE.get(mode, 0.5))
        a, b = sample(known_c, k_known), sample(new_c, n - k_known)
        out, per_artist = [], {}
        # interleave by share so knowns and news alternate, two per artist at most
        ia = ib = 0
        while len(out) < n and (ia < len(a) or ib < len(b)):
            take_a = ib >= len(b) or (ia < len(a) and (len([1 for x in out if x[0] in known]) < round((len(out) + 1) * KNOWN_SHARE.get(mode, 0.5))))
            t, s, artist = a[ia] if take_a else b[ib]
            if take_a:
                ia += 1
            else:
                ib += 1
            key = (artist or "").lower()
            if per_artist.get(key, 0) >= 2:
                continue
            per_artist[key] = per_artist.get(key, 0) + 1; out.append((t, s, artist))
        # Short (a small pool, one artist everywhere): fill from the rest, best first, three per artist.
        if len(out) < n:
            have = {t for t, _, _ in out}
            for t, sc, artist in sorted(known_c + new_c, key=lambda x: -x[1]):
                key = (artist or "").lower()
                if t in have or per_artist.get(key, 0) >= 3:
                    continue
                per_artist[key] = per_artist.get(key, 0) + 1; out.append((t, sc, artist)); have.add(t)
                if len(out) >= n:
                    break
        return {"items": [t for t, _, _ in out], "model": self.meta.get("trained_at")}

    def similar(self, ask):
        """Home's Daily Mixes, when Slopify opts in: songs that sound like the
        artist's songs the listener plays most (see similar())."""
        if not self.ready:
            return None
        with self.lock:
            v, info = self.v, self.info
        _, disliked = self._known(ask.get("user"))
        n = max(1, min(200, int(ask.get("n", 100))))
        seed = ask.get("seed")
        items = similar(v["audio"], v["ids"], v["index"], info, [str(s) for s in (ask.get("seeds") or [])][:20], n,
                        skip=set(ask.get("exclude") or []) | disliked, seed=int(seed) if isinstance(seed, (int, float)) else None)
        return {"items": items}

    def search(self, ask):
        """Songs that sound like words ('rainy sunday morning, soft acoustic
        guitar'), for generated playlists: CLAP compares the words with each
        song's audio, and the listener's taste right now (the 'now' scores)
        breaks ties toward what they would like. Odd versions only when the
        words ask for them; three per artist at most."""
        if not self.ready:
            return None
        from . import audio
        text = str(ask.get("text") or "").strip()[:500]
        if not text:
            return {"items": []}
        with self.lock:
            v, info = self.v, self.info
        tv = audio.embed_text([text])[0]
        A = v["audio"]
        has = np.abs(A).sum(1) > 0
        sound = A @ tv
        sound[~has] = -9; sound[0] = -9
        n = max(1, min(400, int(ask.get("n", 150))))
        top = np.argsort(-sound)[:max(3000, n * 10)]
        taste = self.recommend({**ask, "mode": "now", "n": 1, "_scores": True})
        def z(x):
            return (x - x.mean()) / (x.std() + 1e-6)
        score = z(sound[top]) + (0.5 * z(taste[top]) if taste is not None else 0)
        odd_ok = bool(ODD.search(text))
        known, disliked = self._known(ask.get("user"))
        skip = set(ask.get("exclude") or []) | disliked
        out, per = [], {}
        for j in np.argsort(-score):
            t = v["ids"][top[j] - 1]
            if t in skip:
                continue
            title, artist, _ = info.get(t, ("", "", ""))
            if not odd_ok and ODD.search(title or ""):
                continue
            k = (artist or "").lower()
            if per.get(k, 0) >= 3:
                continue
            per[k] = per.get(k, 0) + 1
            out.append({"id": t, "sound": round(float(sound[top[j]]), 4), "known": t in known})
            if len(out) >= n:
                break
        return {"items": out}
