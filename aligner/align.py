#!/usr/bin/env python3
"""Slopify's lyric aligner.

A long-lived worker the server spawns for the "Sync lyrics" task. It loads
Whisper once (and Demucs, to isolate the vocals), then answers one JSON
request per stdin line with one JSON reply per stdout line.

Given a song and its lyric lines it finds when each line is sung. This is
forced alignment: the words are already known and only their timing is
searched for, so nothing is transcribed and nothing can be invented.

Requests:
  {"id": 1, "path": "/music/a.flac", "lines": ["first line", ...], "language": null}
  {"id": 2, "cmd": "vram"}
Replies:
  {"id": 1, "ok": true, "lines": [{"start": ms|null, "end": ms|null, "prob": 0..1|null}, ...],
   "score": 0..1, "lang": "en", "ms": 1234}
  {"id": 1, "ok": false, "error": "..."}
"""
import json
import os
import re
import sys
import time

WORD = re.compile(r"\w", re.UNICODE)

# The aligner must be told the language. The lyrics themselves say it far
# more reliably than a song's opening seconds (often an instrumental intro):
# the writing system first, then common words for the Latin-script languages.
SCRIPTS = [
    (re.compile(r"[가-힯]"), "ko"),
    (re.compile(r"[぀-ヿ]"), "ja"),
    (re.compile(r"[一-鿿]"), "zh"),
    (re.compile(r"[Ѐ-ӿ]"), "ru"),
    (re.compile(r"[؀-ۿ]"), "ar"),
    (re.compile(r"[֐-׿]"), "he"),
    (re.compile(r"[฀-๿]"), "th"),
    (re.compile(r"[ऀ-ॿ]"), "hi"),
    (re.compile(r"[Ͱ-Ͽ]"), "el"),
]
STOPWORDS = {
    "en": "the and you i to a it me my in that is of your on we be all don't i'm love know".split(),
    "es": "que de no la el y en me tu te lo mi es un una por con para yo".split(),
    "fr": "je de la le et tu les pas que un une moi est des dans c'est on".split(),
    "de": "ich die und der nicht du das ist mich ein es zu mir dich wir".split(),
    "pt": "que não eu de você me o a e um uma do da meu com".split(),
    "it": "che non di il la e mi ti un una io sei per con è".split(),
    "nl": "ik de het en je een niet van is dat me mijn wat".split(),
    "sv": "jag och det du inte en är på att som mig vi".split(),
}


def guess_language(text):
    for pat, lang in SCRIPTS:
        if len(pat.findall(text)) >= 5:
            return lang
    words = re.findall(r"[\w']+", text.lower())
    if not words:
        return "en"
    best, best_n = "en", 0
    for lang, sw in STOPWORDS.items():
        s = set(sw)
        n = sum(1 for w in words if w in s)
        if n > best_n:
            best, best_n = lang, n
    return best


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def align(model, req, separate):
    lines = [str(t or "") for t in req.get("lines") or []]
    # Lines with no word in them ("♪", "...") cannot be aligned and would
    # shift every later line onto the wrong segment: align the worded ones,
    # report the rest as null for the server to place.
    worded = [i for i, t in enumerate(lines) if WORD.search(t)]
    if not worded:
        raise ValueError("no words to align")
    text = "\n".join(lines[i].strip() for i in worded)
    language = req.get("language") or guess_language(text)
    t0 = time.time()
    res = model.align(
        req["path"], text,
        language=language,
        original_split=True,   # one segment per lyric line
        regroup=False,         # and keep it that way
        denoiser="demucs" if separate else None,
        verbose=None,
    )
    if res is None:
        raise ValueError("alignment failed")
    segs = list(res.segments)
    if len(segs) != len(worded):
        raise ValueError(f"segment mismatch: {len(segs)} segments for {len(worded)} lines")
    out = [{"start": None, "end": None, "prob": None} for _ in lines]
    probs = []
    for i, seg in zip(worded, segs):
        words = [w for w in (seg.words or []) if w.word.strip()]
        p = [float(w.probability) for w in words if w.probability is not None]
        probs += p
        out[i] = {
            "start": int(round(float(seg.start) * 1000)),
            "end": int(round(float(seg.end) * 1000)),
            "prob": (sum(p) / len(p)) if p else None,
        }
    return {
        "lines": out,
        "score": (sum(probs) / len(probs)) if probs else 0.0,
        "lang": language,
        "ms": int((time.time() - t0) * 1000),
    }


def main():
    import torch
    device = os.environ.get("ALIGN_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
    if device == "cuda" and not torch.cuda.is_available():
        reply({"ready": False, "error": "CUDA requested but no GPU is visible to the container"})
        return
    model_name = os.environ.get("ALIGN_MODEL", "turbo")
    separate = os.environ.get("ALIGN_SEPARATE", "1") != "0"
    import stable_whisper
    loaded = {}

    def get_model(name):
        if name not in loaded:
            loaded.clear()
            if device == "cuda":
                torch.cuda.empty_cache()
            m = stable_whisper.load_model(name, device="cpu")
            if device == "cuda":
                # Whisper keeps fp32 weights and casts them to fp16 at every
                # layer anyway; storing them in fp16 is the same arithmetic in
                # half the memory, leaving more of a shared card to Jellyfin.
                # Its LayerNorm upcasts its input to fp32, so those stay fp32.
                for mod in m.modules():
                    if isinstance(mod, torch.nn.LayerNorm):
                        continue
                    for prm in mod.parameters(recurse=False):
                        prm.data = prm.data.half()
                m = m.to(device)
            loaded[name] = m
        return loaded[name]

    t0 = time.time()
    get_model(model_name)
    reply({
        "ready": True, "device": device, "model": model_name, "separate": separate,
        "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
        "loadMs": int((time.time() - t0) * 1000),
    })
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except ValueError:
            continue
        rid = req.get("id")
        if req.get("cmd") == "vram":
            free, total = torch.cuda.mem_get_info() if device == "cuda" else (0, 0)
            reply({"id": rid, "ok": True, "free": free, "total": total})
            continue
        try:
            reply({"id": rid, "ok": True, **align(get_model(model_name), req, separate)})
        except Exception as e:  # one bad song must not end the run
            reply({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"[:500]})
        finally:
            if device == "cuda":
                torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
