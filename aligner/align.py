#!/usr/bin/env python3
"""Slopify's lyric aligner.

A long-lived worker the server spawns for the "Sync lyrics" task. It loads
Whisper once (and Demucs, to isolate the vocals), then answers one JSON
request per stdin line with one JSON reply per stdout line.

Given a song and its lyric lines it finds when each line is sung. This is
forced alignment: the words are already known and only their timing is
searched for, so nothing is transcribed and nothing can be invented.

It can also write lyrics for a song that has none (cmd "transcribe"): the
large model, slower and more careful, with Whisper's known hallucinations
("Thank you." in an instrumental gap, a line repeated forever) filtered out.

Requests:
  {"id": 1, "path": "/music/a.flac", "lines": ["first line", ...], "language": null}
  {"id": 2, "cmd": "transcribe", "path": "/music/a.flac", "language": null}
  {"id": 3, "cmd": "vram"}
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


# Whisper fills silence and instrumental breaks with stock phrases learned
# from subtitled video; none of these is ever a lyric line on its own.
STOCK = re.compile(r"^(?:thank(?:s| you)(?: (?:so much|very much|for (?:watching|listening)))?|bye(?: bye)?|you|"
                   r"(?:please )?subscribe.*|music|outro|intro|)$")


def isolate_vocals(path, device):
    """Demucs on its own, before Whisper's large model runs: together with
    beam search they do not fit an 8 GB card, one after the other they do.
    Returns 16 kHz mono vocals as Whisper takes them."""
    import subprocess
    import numpy as np
    import torch
    import torchaudio
    from demucs.apply import apply_model
    from demucs.pretrained import get_model as demucs_model
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", "44100", "-"],
                         capture_output=True, check=True).stdout
    wav = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy()).view(-1, 2).T
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    m = demucs_model("htdemucs").to(device).eval()
    try:
        with torch.no_grad():
            src = apply_model(m, ((wav - mean) / std)[None].to(device), device=device, split=True, overlap=0.25, progress=False)[0]
        vocals = (src[m.sources.index("vocals")] * std.to(device) + mean.to(device)).mean(0)
        mono = torchaudio.functional.resample(vocals, 44100, 16000).float().cpu().numpy()
    finally:
        del m
        if device == "cuda":
            torch.cuda.empty_cache()
    return mono


def transcribe(model, req, separate, device):
    t0 = time.time()
    audio = isolate_vocals(req["path"], device) if separate else req["path"]
    res = model.transcribe(
        audio,
        language=req.get("language"),
        denoiser=None,
        vad=True,                         # skip what is not voice at all
        word_timestamps=True,
        beam_size=5, best_of=5,           # slow and careful
        temperature=(0.0, 0.2, 0.4),
        condition_on_previous_text=False, # the cause of endless repeat loops
        verbose=None,
    )
    if res is None:
        raise ValueError("transcription failed")
    res.split_by_length(max_words=14)     # lyric-sized lines; 10 cut phrases in half
    lines, words = [], 0
    run_text, run_len = None, 0
    for seg in res.segments:
        text = seg.text.strip()
        key = re.sub(r"[^\w' ]+", "", text.lower()).strip()
        ws = [w for w in (seg.words or []) if w.word.strip()]
        probs = [float(w.probability) for w in ws if w.probability is not None]
        p = sum(probs) / len(probs) if probs else 0.0
        if not text or STOCK.match(key) or p < 0.45:
            continue
        # A chorus repeats; a line coming back nine times in a row is a loop.
        run_len = run_len + 1 if key == run_text else 1
        run_text = key
        if run_len > 8:
            continue
        lines.append({"start": int(round(float(seg.start) * 1000)), "end": int(round(float(seg.end) * 1000)), "text": text, "prob": p})
        words += len(ws)
    return {"lines": lines, "words": words, "lang": getattr(res, "language", None), "ms": int((time.time() - t0) * 1000)}


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
    gen_name = os.environ.get("ALIGN_GEN_MODEL", "large-v3")
    separate = os.environ.get("ALIGN_SEPARATE", "1") != "0"
    import stable_whisper
    loaded = {}

    # One model on the card at a time: aligning uses the fast one, writing
    # lyrics the large one, and the 8 GB card holds only one of them alongside
    # Demucs and whatever else is running.
    def get_model(name):
        if name not in loaded:
            loaded.clear()
            if device == "cuda":
                torch.cuda.empty_cache()
            m = stable_whisper.load_model(name, device="cpu")
            if device == "cuda":
                # Whisper keeps fp32 weights and casts them to fp16 at every
                # layer anyway; storing them in fp16 is the same arithmetic in
                # half the memory (large-v3 alone is 6.2 GB in fp32). Its
                # LayerNorm upcasts its input to fp32, so those stay fp32.
                for mod in m.modules():
                    if isinstance(mod, torch.nn.LayerNorm):
                        continue
                    for prm in mod.parameters(recurse=False):
                        prm.data = prm.data.half()
                m = m.to(device)
            loaded[name] = m
        return loaded[name]

    t0 = time.time()
    # A worker started only to write lyrics skips loading the align model.
    if os.environ.get("ALIGN_PRELOAD", "1") != "0":
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
            if req.get("cmd") == "transcribe":
                reply({"id": rid, "ok": True, **transcribe(get_model(gen_name), req, separate, device)})
            else:
                reply({"id": rid, "ok": True, **align(get_model(model_name), req, separate)})
        except Exception as e:  # one bad song must not end the run
            reply({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"[:500]})
        finally:
            if device == "cuda":
                torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
