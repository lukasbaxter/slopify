"""Train the brain on everyone's listening and measure it on the last 14
days it did not see, against two simple baselines (the household's most
played; the old mix: the same artist or genre as the song before)."""
import json, os, random, time
from collections import Counter, defaultdict
import numpy as np, torch, torch.nn.functional as F
from . import config, store, device, features
from .model import Brain

MAX_LEN = 64
HOLDOUT_DAYS = 14
OWN_MIN_PLAYS = 3
MODEL_DIR = os.path.join(config.DATA_DIR, "model")

def vocab():
    d = store.db()
    rows = d.execute("SELECT id, artist_ids, genres FROM tracks WHERE gone = 0 ORDER BY seq").fetchall()
    ids = [r[0] for r in rows]; index = {t: i + 1 for i, t in enumerate(ids)}
    first = lambda s: (json.loads(s or "[]") or [""])[0]
    art_names = sorted({first(r[1]) for r in rows})
    art_index = {a: i + 1 for i, a in enumerate(art_names)}
    artist_of = np.zeros(len(ids) + 1, np.int64)
    for r in rows:
        artist_of[index[r[0]]] = art_index[first(r[1])]
    audio = np.zeros((len(ids) + 1, 512), np.float32)
    eids, evecs = store.embeddings()
    for t, v in zip(eids, evecs):
        if t in index:
            audio[index[t]] = v
    plays = Counter(r[0] for r in d.execute("SELECT track_id FROM plays"))
    own = np.array([0] + [index[t] if plays[t] >= OWN_MIN_PLAYS else 0 for t in ids], np.int64)
    users = [r[0] for r in d.execute("SELECT DISTINCT user_id FROM plays")]
    genres = {r[0]: set(json.loads(r[2] or "[]")) for r in rows}
    return dict(ids=ids, index=index, artist_of=artist_of, audio=audio, own=own,
                users={u: i + 1 for i, u in enumerate(users)}, n_artists=len(art_index), genres=genres, plays=plays,
                has_audio=int((np.abs(audio).sum(1) > 0).sum()))

def timelines(v):
    """Per user, oldest first: (item, at, client, step features, context, positive?)."""
    d = store.db(); idx = v["index"]
    durs = dict(d.execute("SELECT id, duration_ms FROM tracks"))
    out = {}
    events = defaultdict(list)
    for u, t, at, ms, reason, dur, client in d.execute("SELECT user_id, track_id, at, ms_played, reason, duration_ms, client FROM events ORDER BY at"):
        events[(u, t)].append((at, ms, reason, dur, client))
    for u in v["users"]:
        tl = []
        for t, at, client in d.execute("SELECT track_id, at, client FROM plays WHERE user_id = ? ORDER BY at", (u,)):
            if t not in idx:
                continue
            ev = next((e for e in events.get((u, t), []) if abs(e[0] - at) < 120000), None)
            tl.append([idx[t], at, client, ev[1] if ev else None, ev[2] if ev else None, ev[3] if ev else durs.get(t)])
        # Skips too quick to count as a play (under 8 s) exist only as events.
        for (eu, t), evs in events.items():
            if eu != u or t not in idx:
                continue
            for at, ms, reason, dur, client in evs:
                if reason == "skipped" and (ms or 0) < 8000:
                    tl.append([idx[t], at, client, ms, reason, dur])
        tl.sort(key=lambda x: x[1])
        rows = []; prev = None
        for item, at, client, ms, reason, dur in tl:
            ctx = features.context(at, client, "history")
            st = features.step(prev, at, ms, reason, dur)
            rows.append((item, at, st + ctx, ctx, not (reason == "skipped" and (ms or 0) < 30000)))
            prev = at
        out[u] = rows
    return out

class Data:
    def __init__(self, tls, users):
        self.u = []; self.items = []; self.feats = []; self.ctx = []; self.pos = []; self.at = []
        for u, rows in tls.items():
            self.u.append(users[u])
            self.items.append(np.array([r[0] for r in rows], np.int64))
            self.at.append(np.array([r[1] for r in rows], np.int64))
            self.feats.append(np.array([r[2] for r in rows], np.float32))
            self.ctx.append(np.array([r[3] for r in rows], np.float32))
            self.pos.append(np.array([r[4] for r in rows], bool))

    def examples(self, cutoff_ms, test=False):
        ex = []
        for k in range(len(self.u)):
            for t in range(1, len(self.items[k])):
                after = self.at[k][t] >= cutoff_ms
                if after == test:
                    ex.append((k, t))
        return ex

    def batch(self, ex, dev):
        B = len(ex); L = MAX_LEN
        hi = np.zeros((B, L), np.int64); hf = np.zeros((B, L, self.feats[0].shape[1]), np.float32); mask = np.ones((B, L), bool)
        u = np.zeros(B, np.int64); ctx = np.zeros((B, self.ctx[0].shape[1]), np.float32); tgt = np.zeros(B, np.int64); pos = np.zeros(B, bool)
        for b, (k, t) in enumerate(ex):
            s = max(0, t - L); n = t - s
            hi[b, :n] = self.items[k][s:t]; hf[b, :n] = self.feats[k][s:t]; mask[b, :n] = False
            u[b] = self.u[k]; ctx[b] = self.ctx[k][t]; tgt[b] = self.items[k][t]; pos[b] = self.pos[k][t]
        T = lambda x: torch.from_numpy(x).to(dev)
        return T(hi), T(hf), T(mask), T(u), T(ctx), T(tgt), T(pos)

def item_vecs(model, v, idx, dev):
    idx = idx.to(dev)
    return model.items(v["audio_t"][idx], v["artist_t"][idx], v["own_t"][idx])

def all_item_vecs(model, v, dev, chunk=32768):
    with torch.no_grad():
        n = len(v["ids"]) + 1
        return torch.cat([item_vecs(model, v, torch.arange(i, min(n, i + chunk)), dev) for i in range(0, n, chunk)])

def evaluate(model, data, v, ex, dev, ks=(10, 50)):
    model.eval(); hits = {k: 0 for k in ks}; n = 0
    with torch.no_grad():
        allv = all_item_vecs(model, v, dev)
        for i in range(0, len(ex), 512):
            b = [e for e in ex[i:i + 512] if data.pos[e[0]][e[1]]]
            if not b:
                continue
            hi, hf, mask, u, ctx, tgt, _ = data.batch(b, dev)
            q = model.query(allv[hi], hf, mask, u, ctx)
            s = q @ allv.T; s[:, 0] = -9
            rank = (s > s.gather(1, tgt[:, None])).sum(1)
            for k in ks:
                hits[k] += int((rank < k).sum())
            n += len(b)
    return {f"hit@{k}": round(hits[k] / max(1, n), 4) for k in ks} | {"n": n}

def baselines(data, v, ex, ks=(10, 50)):
    """Household most-played; and the old mix (same artist or genre as the song before, at random)."""
    top = [v["index"][t] for t, _ in v["plays"].most_common(max(ks)) if t in v["index"]]
    by_artist = defaultdict(list); by_genre = defaultdict(list)
    for t, i in v["index"].items():
        by_artist[v["artist_of"][i]].append(i)
        for g in v["genres"].get(t, ()):
            by_genre[g].append(i)
    rnd = random.Random(1); pop = {k: 0 for k in ks}; old = {k: 0 for k in ks}; n = 0
    for k_, t in ex:
        if not data.pos[k_][t]:
            continue
        tgt = data.items[k_][t]; prev = data.items[k_][t - 1]; n += 1
        for k in ks:
            pop[k] += tgt in top[:k]
        pool = list(set(by_artist[v["artist_of"][prev]] + [i for g in v["genres"].get(v["ids"][prev - 1], ()) for i in by_genre[g][:2000]]))
        pick = rnd.sample(pool, min(len(pool), max(ks)))
        for k in ks:
            old[k] += tgt in pick[:k]
    f = lambda h: {f"hit@{k}": round(h[k] / max(1, n), 4) for k in ks}
    return {"most_played": f(pop), "old_mix": f(old), "n": n}

def train(epochs=None, log=print):
    t0 = time.time(); dev = device.pick()
    v = vocab(); tls = timelines(v); data = Data(tls, v["users"])
    last = max(int(a.max()) for a in data.at if len(a))
    cutoff = last - HOLDOUT_DAYS * 86400000
    tr, te = data.examples(cutoff), data.examples(cutoff, test=True)
    log(f"songs {len(v['ids'])} (heard {v['has_audio']}), artists {v['n_artists']}, listeners {len(v['users'])}, train {len(tr)}, test {len(te)}")
    v["audio_t"] = torch.from_numpy(v["audio"]).to(dev); v["artist_t"] = torch.from_numpy(v["artist_of"]).to(dev); v["own_t"] = torch.from_numpy(v["own"]).to(dev)
    model = Brain(len(v["ids"]), v["n_artists"], len(v["users"]), max_len=MAX_LEN).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.01)
    epochs = epochs or int(os.environ.get("EPOCHS", "6")); tau = 0.05; n_items = len(v["ids"])
    for ep in range(epochs):
        model.train(); random.shuffle(tr); tot = 0.0; steps = 0
        for i in range(0, len(tr), 512):
            hi, hf, mask, u, ctx, tgt, pos = data.batch(tr[i:i + 512], dev)
            neg = torch.randint(1, n_items + 1, (4096,), device=dev)
            uniq, inv = torch.unique(torch.cat([hi.flatten(), tgt, neg]), return_inverse=True)
            vecs = item_vecs(model, v, uniq, dev)
            hv = vecs[inv[:hi.numel()]].view(*hi.shape, -1)
            tv = vecs[inv[hi.numel():hi.numel() + len(tgt)]]; nv = vecs[inv[hi.numel() + len(tgt):]]
            q = model.query(hv, hf, mask, u, ctx)
            cand = torch.cat([tv, nv]); logits = q @ cand.T / tau
            # another row's target that is this row's own target is not a negative
            same = torch.cat([tgt[None, :] == tgt[:, None], neg[None, :] == tgt[:, None]], 1)
            same.fill_diagonal_(False); logits = logits.masked_fill(same, -1e4)
            ce = F.cross_entropy(logits, torch.arange(len(tgt), device=dev), reduction="none")
            loss = (ce * pos).sum() / pos.sum().clamp(min=1)
            if (~pos).any():   # a skip: that song should score low for that moment
                loss = loss + 0.5 * F.softplus(((q * tv).sum(-1) - 0.2) / tau)[~pos].mean()
            opt.zero_grad(); loss.backward(); opt.step(); tot += float(loss); steps += 1
        m = evaluate(model, data, v, te, dev)
        log(f"epoch {ep + 1}/{epochs} loss {tot / max(1, steps):.3f} test {m}")
    base = baselines(data, v, te)
    log(f"baselines {base}")
    os.makedirs(MODEL_DIR, exist_ok=True)
    meta = {"ids": v["ids"], "users": v["users"], "n_artists": v["n_artists"], "trained_at": int(time.time() * 1000),
            "metrics": m, "baselines": base, "seconds": round(time.time() - t0), "heard": v["has_audio"]}
    torch.save(model.state_dict(), os.path.join(MODEL_DIR, "brain.pt.tmp"))
    os.replace(os.path.join(MODEL_DIR, "brain.pt.tmp"), os.path.join(MODEL_DIR, "brain.pt"))
    with open(os.path.join(MODEL_DIR, "meta.json"), "w") as f:
        json.dump(meta, f)
    store.kv_set("last_train", {k: meta[k] for k in ("trained_at", "metrics", "baselines", "seconds", "heard")})
    return meta

if __name__ == "__main__":
    train()
