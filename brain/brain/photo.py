"""Artist photos for playlist covers (Slopify's typecover.ts):
  - is this "artist photo" really a photo of the artist? Many are their
    album cover, a logo or a drawing; CLIP (LAION ViT-B/32) says which;
  - the person cut out of the background (BiRefNet), as a PNG with alpha.
Both models load on the first ask and unload after IDLE_S without one, so
the card's memory goes back to listening and training (about 2.3 GB while
loaded). Asks are handled one at a time."""
import base64, io, threading, time
import numpy as np
import torch
from . import device

CLIP = ("laion/CLIP-ViT-B-32-laion2B-s34B-b79K", "1a25a446712ba5ee05982a381eed697ef9b435cf")
SEG = ("ZhengPeng7/BiRefNet", "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4")  # pinned: it runs its own code
KINDS = ["person", "band", "cover", "logo", "drawing", "painting"]
PROMPTS = ["a photo of a person", "a photo of a band of musicians", "an album cover with printed text",
           "a logo or lettering", "an illustration or drawing", "a painting"]
IDLE_S = 120
MAX_SIDE = 1600

_lock = threading.Lock()
_m = {"clip": None, "proc": None, "seg": None, "dev": None, "used": 0.0}

def _load():
    from transformers import AutoModelForImageSegmentation, CLIPModel, CLIPProcessor
    dev = device.pick()
    half = dev in ("cuda", "xpu")
    _m["clip"] = CLIPModel.from_pretrained(CLIP[0], revision=CLIP[1]).to(dev).eval()
    _m["proc"] = CLIPProcessor.from_pretrained(CLIP[0], revision=CLIP[1])
    seg = AutoModelForImageSegmentation.from_pretrained(SEG[0], revision=SEG[1], trust_remote_code=True).to(dev).eval()
    _m["seg"] = seg.half() if half else seg
    _m["dev"] = dev

def unload_if_idle(now=None):
    with _lock:
        if _m["seg"] is not None and (now or time.time()) - _m["used"] > IDLE_S:
            _m.update(clip=None, proc=None, seg=None, dev=None)
            device.free_cache()
            return True
    return False

def _cutout(im):
    dev, seg = _m["dev"], _m["seg"]
    x = torch.from_numpy(np.asarray(im.resize((1024, 1024)), dtype=np.float32) / 255).permute(2, 0, 1)
    mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1); std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
    x = ((x - mean) / std).unsqueeze(0).to(dev)
    if next(seg.parameters()).dtype == torch.float16:
        x = x.half()
    m = seg(x)[-1].sigmoid()[0, 0].float().cpu().numpy()
    from PIL import Image
    a = Image.fromarray((m * 255).astype(np.uint8)).resize(im.size)
    out = im.copy(); out.putalpha(a)
    buf = io.BytesIO(); out.save(buf, "PNG")
    return buf.getvalue()

def judge(image_bytes, want_cutout=True):
    """{"kind", "photo": P(person or band), "scores", "png": base64 or None}.
    The cutout only comes back for a real photo."""
    from PIL import Image
    im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    if max(im.size) > MAX_SIDE:
        im.thumbnail((MAX_SIDE, MAX_SIDE))
    with _lock, torch.no_grad():
        if _m["seg"] is None:
            _load()
        _m["used"] = time.time()
        inp = _m["proc"](text=PROMPTS, images=im, return_tensors="pt", padding=True).to(_m["dev"])
        p = _m["clip"](**inp).logits_per_image.softmax(-1)[0].float().cpu().tolist()
        scores = {k: round(v, 3) for k, v in zip(KINDS, p)}
        photo = scores["person"] + scores["band"]
        png = _cutout(im) if want_cutout and photo >= 0.6 else None
        _m["used"] = time.time()
    return {"kind": max(scores, key=scores.get), "photo": round(photo, 3), "scores": scores,
            "png": base64.b64encode(png).decode() if png else None}
