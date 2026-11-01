"""May the brain do heavy work (listen to songs, retrain) right now? By the
household's rules from Slopify. Answering what plays next is never held: it
takes milliseconds and next to no memory."""
import shutil, subprocess, time, datetime as dt

# Work, then rest (seconds), with the audio model unloaded while resting.
POWER = {"full": (None, 0), "normal": (600, 600), "light": (300, 900), "cpu": (None, 0)}

def in_hours(f, t, hour):
    """from == until means any time; 22 to 6 wraps past midnight."""
    if f == t:
        return True
    return f <= hour < t if f < t else hour >= f or hour < t

class Burst:
    def __init__(self):
        self.start = None; self.rest_until = 0.0

    def blocked(self, power, now):
        work, rest = POWER.get(power, POWER["normal"])
        if now < self.rest_until:
            return f"resting until {dt.datetime.fromtimestamp(self.rest_until):%H:%M} ({power} GPU power)"
        if work is None:
            self.start = None
            return None
        if self.start is None:
            self.start = now
        if now - self.start >= work:
            self.start = None; self.rest_until = now + rest
            return f"resting until {dt.datetime.fromtimestamp(self.rest_until):%H:%M} ({power} GPU power)"
        return None

    def idle(self):
        """Nothing to do: the next work starts a fresh burst."""
        self.start = None

def blocked(r, *, hour, listening, others_gb, encoding, burst, now):
    """None when heavy work may go on, else why not, in words for Slopify."""
    f, t = r["fromHour"], r["toHour"]
    if not in_hours(f, t, hour):
        return f"waiting for {f:02d}:00 (works {f:02d}:00 to {t:02d}:00)"
    if r["pauseListening"] and listening:
        return "paused while someone is listening"
    if r["power"] != "cpu":
        if r["otherGb"] and others_gb is not None and others_gb > r["otherGb"]:
            return f"paused: other programs use {others_gb:.1f} GB of GPU memory"
        if r["pauseEncoding"] and encoding:
            return "paused while the GPU encodes video"
    return burst.blocked(r["power"], now)

def others_gb(dev):
    """GPU memory in use by everything but this process, or None when the
    card cannot say (CPU, an old driver)."""
    try:
        import torch
        mod = {"xpu": getattr(torch, "xpu", None), "cuda": torch.cuda}.get(dev)
        if mod is None:
            return None
        free, total = mod.mem_get_info()
        return max(0, total - free - mod.memory_reserved()) / 2**30
    except Exception:  # noqa: BLE001
        return None

def encoding():
    """Video encode sessions on an NVIDIA card (Jellyfin, Plex, Immich).
    Other cards cannot say from inside a container: False."""
    if not shutil.which("nvidia-smi"):
        return False
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=encoder.stats.sessionCount", "--format=csv,noheader"], capture_output=True, text=True, timeout=5).stdout
        return any(int(x) > 0 for x in out.split() if x.strip().isdigit())
    except Exception:  # noqa: BLE001
        return False

class Gate:
    """blocked() with the live readings, cached a few seconds: it is asked
    before every song."""
    def __init__(self, rules, listening, device, hour, clock=time.time):
        self.rules, self.listening, self.device, self.hour, self.clock = rules, listening, device, hour, clock
        self.burst = Burst(); self._at = -1e9; self._why = None

    def why(self, fresh=False):
        now = self.clock()
        if fresh or now - self._at > 5:
            r = self.rules(); dev = self.device()
            self._why = blocked(r, hour=self.hour(),
                                listening=self.listening(), others_gb=others_gb(dev) if r["otherGb"] else None,
                                encoding=encoding() if r["pauseEncoding"] else False, burst=self.burst, now=now)
            self._at = now
        return self._why
