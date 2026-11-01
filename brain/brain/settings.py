"""The household's rules for the brain, set in Slopify (Settings > Admin >
Tasks > Brain) and read from it every 30 s along with Slopify's time zone and
whether anyone is listening. A Slopify too old to have them, or one that is
down, leaves the last rules read (the defaults at first)."""
import time, httpx
from . import config

DEFAULTS = {"enabled": True, "power": "normal", "fromHour": 0, "toHour": 0, "pauseListening": False,
            "otherGb": 0, "pauseEncoding": False, "location": ""}
_s = {"at": 0.0, "rules": dict(DEFAULTS), "tz": None, "listening": False, "from_slopify": False}

def merge(got):
    """Known keys of the right type over the defaults; anything else ignored."""
    out = dict(DEFAULTS)
    for k, v in (got or {}).items():
        if k in DEFAULTS and type(v) is type(DEFAULTS[k]):
            out[k] = v
    return out

def refresh(force=False, get=None):
    if not force and time.time() - _s["at"] < 30:
        return _s
    _s["at"] = time.time()
    try:
        r = (get or httpx.get)(f"{config.SLOPIFY_URL}/api/brain/settings", headers={"X-Brain-Key": config.BRAIN_KEY}, timeout=5)
        if r.status_code == 404:          # a Slopify from before the Brain task
            _s["from_slopify"] = False
            return _s
        j = r.raise_for_status().json()
        _s.update(rules=merge(j.get("settings")), tz=j.get("tz") or None, listening=bool(j.get("listening")), from_slopify=True)
    except Exception:  # noqa: BLE001 - down or busy: keep the last rules
        pass
    return _s

def rule(k):
    return refresh()["rules"][k]
