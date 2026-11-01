"""Context as numbers: local time, weather, device, how a play went."""
import datetime as dt, math, re
from zoneinfo import ZoneInfo
from . import config, weather, settings

_tz = {"name": None, "zone": dt.timezone.utc}

def tz():
    """Local time where the listening happens: the Location's time zone,
    else TZ from the environment, else Slopify's, else UTC. Read on every
    context, so it is cached; the maintainer refreshes it (refresh_tz)."""
    return _tz["zone"]

def refresh_tz():
    p = weather.place() or {}
    name = p.get("timezone") or config.TZ or settings.refresh()["tz"] or "UTC"
    if name != _tz["name"]:
        try:
            _tz.update(name=name, zone=ZoneInfo(name))
        except Exception:  # noqa: BLE001 - an unknown name: keep the last one
            pass
    return _tz["name"]
DEVICES = ["unknown", "phone", "computer", "speaker", "tv", "car"]
MODES = ["history", "continue", "smart", "radio", "now"]
N_CTX = 2 + 2 + 7 + 5 + len(DEVICES) + len(MODES)   # hour sin/cos, year-day sin/cos, weekday, weather, device, mode

def device_of(client):
    c = (client or "").lower()
    if not c or c in ("spotify", "import", "conduit"):
        return "unknown"
    if re.search(r"car|carplay|android auto", c):
        return "car"
    if re.search(r"iphone|android|pixel|phone|galaxy|offline", c):
        return "phone"
    if re.search(r"\btv\b|tv app|fire|roku|chromecast|shield", c):
        return "tv"
    if re.search(r"mac|windows|linux|kubuntu|desktop|laptop|web player|chrome on|safari on mac|firefox|edge", c):
        return "computer"
    return "speaker"   # BluOS, Sonos, DLNA, AirPlay, Cast speakers, named rooms

def context(ms, client=None, mode="history"):
    t = dt.datetime.fromtimestamp(ms / 1000, tz())
    h = (t.hour + t.minute / 60) / 24 * 2 * math.pi
    yd = t.timetuple().tm_yday / 366 * 2 * math.pi
    wk = [0.0] * 7; wk[t.weekday()] = 1.0
    w = weather.at(ms)
    if w:
        temp, precip, cloud, code, is_day = w
        wx = [(temp or 0) / 20, min(3.0, (precip or 0)) / 3, (cloud or 0) / 100, float(is_day or 0), 1.0]
    else:
        wx = [0.0, 0.0, 0.0, 0.0, 0.0]   # last = "weather known"
    dv = [0.0] * len(DEVICES); dv[DEVICES.index(device_of(client))] = 1.0
    md = [0.0] * len(MODES); md[MODES.index(mode if mode in MODES else "history")] = 1.0
    return [math.sin(h), math.cos(h), math.sin(yd), math.cos(yd), *wk, *wx, *dv, *md]

def step(prev_ms, ms, ms_played=None, reason=None, duration_ms=None):
    """Per history step: hours since the previous play (log), skipped, how much of it played."""
    gap = 0.0 if prev_ms is None else math.log1p(max(0, ms - prev_ms) / 3600000)
    skipped = 1.0 if reason == "skipped" and (ms_played or 0) < 30000 else 0.0
    frac = min(1.0, (ms_played or 0) / duration_ms) if ms_played is not None and duration_ms else 1.0
    return [gap, skipped, frac]
N_STEP = 3
