"""Weather where the listening happens, hour by hour (Open-Meteo: free, no
key). The history back to the first play is fetched once for training; the
last week and the next day are refreshed every hour for live requests.
Where: Slopify's Location setting (a city, looked up once by name), else
LAT/LON from the environment, else no weather."""
import datetime as dt, math, time, httpx
from . import config, store, settings

VARS = "temperature_2m,precipitation,cloud_cover,weather_code,is_day"
GEO = "https://geocoding-api.open-meteo.com/v1/search"

def lookup(name, get=None):
    """'London, ON' -> the best Open-Meteo match: the city, then whatever
    follows the comma has to name its region or country: the name, the
    start of it ("Ont"), its initials ("BC", "NSW") or the country code."""
    city, _, rest = name.partition(",")
    j = (get or httpx.get)(GEO, params={"name": city.strip(), "count": 10, "format": "json"}, timeout=15).raise_for_status().json()
    hits = j.get("results") or []
    want = [w.strip().lower() for w in rest.split(",") if w.strip()]
    def fits(h):
        where = " ".join(str(h.get(k, "")) for k in ("admin1", "admin2", "country", "country_code")).lower()
        regions = [str(h.get(k) or "").lower() for k in ("admin1", "admin2", "country")]
        initials = ["".join(p[0] for p in r.split() if p) for r in regions if " " in r]
        abbrev = {"uk": "united kingdom", "usa": "united states", "us": "united states"}
        def one(w):
            return (abbrev.get(w, w) in where or w == str(h.get("country_code", "")).lower() or w in initials
                    or (len(w) >= 2 and any(r.startswith(w) for r in regions)))
        return all(one(w) for w in want)
    for h in hits:
        if fits(h):
            label = ", ".join(x for x in (h.get("name"), h.get("admin1"), h.get("country")) if x)
            return {"name": name, "lat": round(h["latitude"], 2), "lon": round(h["longitude"], 2), "timezone": h.get("timezone"), "label": label}
    return {"name": name, "error": "not found"}

def resolve():
    """Look the Location setting up when it changed (the maintainer calls
    this; requests only read the result). A new place starts the weather
    history over."""
    name = (settings.rule("location") or "").strip()
    have = store.kv_get("place") or {}
    if name and have.get("name") != name:
        try:
            have = lookup(name)
        except Exception as e:  # noqa: BLE001 - offline: try again next hour
            return {"name": name, "error": str(e)[:200], "retry": True}
        store.kv_set("place", have)
    if not name and have:
        store.kv_delete("place"); have = {}
    p = place()
    key = None if p is None else f"{p['lat']},{p['lon']}"
    if store.kv_get("weather_at") is None and store.db().execute("SELECT 1 FROM weather LIMIT 1").fetchone():
        store.kv_set("weather_at", key)   # history from before places were remembered: it is this place's
    elif store.kv_get("weather_at") != key:
        d = store.db(); d.execute("DELETE FROM weather"); d.commit()
        store.kv_delete("weather_hist_until"); store.kv_set("weather_at", key)
    return have

def place():
    """{lat, lon, timezone?, label} or None: the looked-up Location, else
    LAT/LON from the environment."""
    have = store.kv_get("place") or {}
    if (settings.rule("location") or "").strip() and "lat" in have:
        return have
    if not (math.isnan(config.LAT) or math.isnan(config.LON)):
        return {"lat": config.LAT, "lon": config.LON, "timezone": None, "label": f"{config.LAT}, {config.LON}"}
    return None

def enabled():
    return place() is not None

def _save(j):
    h = j.get("hourly") or {}
    rows = []
    for i, t in enumerate(h.get("time", [])):
        hour = int(dt.datetime.fromisoformat(t).replace(tzinfo=dt.timezone.utc).timestamp() // 3600)
        vals = [h[k][i] for k in VARS.split(",")]
        if vals[0] is None:
            continue
        rows.append((hour, *vals))
    d = store.db()
    d.executemany("INSERT OR REPLACE INTO weather (hour, temp, precip, cloud, code, is_day) VALUES (?, ?, ?, ?, ?, ?)", rows); d.commit()
    return len(rows)

def backfill(since_ms):
    """History from the first play to a week ago, a year per request."""
    p = place()
    if p is None:
        return 0
    start = dt.datetime.fromtimestamp(since_ms / 1000, dt.timezone.utc).date()
    end = dt.date.today() - dt.timedelta(days=6)
    have = store.kv_get("weather_hist_until")
    if have:
        start = max(start, dt.date.fromisoformat(have))
    n = 0
    with httpx.Client(timeout=60) as c:
        while start < end:
            stop = min(end, start + dt.timedelta(days=365))
            j = c.get("https://archive-api.open-meteo.com/v1/archive", params={"latitude": p["lat"], "longitude": p["lon"],
                      "start_date": start.isoformat(), "end_date": stop.isoformat(), "hourly": VARS, "timezone": "UTC"}).raise_for_status().json()
            n += _save(j); store.kv_set("weather_hist_until", stop.isoformat()); start = stop
            time.sleep(1)
    return n

def refresh():
    p = place()
    if p is None:
        return 0
    with httpx.Client(timeout=30) as c:
        j = c.get("https://api.open-meteo.com/v1/forecast", params={"latitude": p["lat"], "longitude": p["lon"], "hourly": VARS,
                  "past_days": 7, "forecast_days": 2, "timezone": "UTC"}).raise_for_status().json()
    return _save(j)

def at(ms):
    """(temp C, precip mm, cloud %, code, is_day) for that hour, or None."""
    r = store.db().execute("SELECT temp, precip, cloud, code, is_day FROM weather WHERE hour = ?", (int(ms // 3600000),)).fetchone()
    return r

def words(w):
    """The hour's weather in words, for logs and the 'right now' prompt."""
    if not w:
        return None
    temp, precip, cloud, code, is_day = w
    sky = "snowing" if code in (71, 73, 75, 77, 85, 86) else "raining" if (precip or 0) > 0.2 or code in (51, 53, 55, 61, 63, 65, 80, 81, 82) else \
          "stormy" if code in (95, 96, 99) else "foggy" if code in (45, 48) else "overcast" if (cloud or 0) > 70 else "sunny" if is_day else "clear"
    return f"{sky}, {round(temp)} C"
