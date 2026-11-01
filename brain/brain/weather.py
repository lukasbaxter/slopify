"""Weather where the listening happens, hour by hour (Open-Meteo: free, no
key). The history back to the first play is fetched once for training; the
last week and the next day are refreshed every hour for live requests."""
import datetime as dt, math, time, httpx
from . import config, store

VARS = "temperature_2m,precipitation,cloud_cover,weather_code,is_day"

def enabled():
    return not (math.isnan(config.LAT) or math.isnan(config.LON))

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
    if not enabled():
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
            j = c.get("https://archive-api.open-meteo.com/v1/archive", params={"latitude": config.LAT, "longitude": config.LON,
                      "start_date": start.isoformat(), "end_date": stop.isoformat(), "hourly": VARS, "timezone": "UTC"}).raise_for_status().json()
            n += _save(j); store.kv_set("weather_hist_until", stop.isoformat()); start = stop
            time.sleep(1)
    return n

def refresh():
    if not enabled():
        return 0
    with httpx.Client(timeout=30) as c:
        j = c.get("https://api.open-meteo.com/v1/forecast", params={"latitude": config.LAT, "longitude": config.LON, "hourly": VARS,
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
