"""Everything from the environment; nothing about one house is in the code.
The household's rules (GPU power, hours, pauses, location) are set in
Slopify, Settings > Admin > Tasks > Brain, and read from it (settings.py)."""
import os

def env(k, d=""):
    return os.environ.get(k, d)

# The Slopify server as this box reaches it. The default fits the README's
# compose: both containers on host networking on the same machine.
SLOPIFY_URL = env("SLOPIFY_URL", "http://127.0.0.1:8080").rstrip("/")
BRAIN_KEY = env("BRAIN_KEY")                       # same value as Slopify's BRAIN_KEY
DATA_DIR = env("DATA_DIR", "/data")
DEVICE = env("DEVICE", "auto")                    # auto | xpu | cuda | cpu
# Where the listening happens, when Slopify's Location setting is empty:
# weather and local time. Unset = no weather; local time from Slopify.
LAT = float(env("LAT", "nan"))
LON = float(env("LON", "nan"))
TZ = env("TZ", "")
AUDIO_MODEL = env("AUDIO_MODEL", "laion/larger_clap_general")
EMBED_WORKERS = int(env("EMBED_WORKERS", "3"))   # songs decoded at once (each reads ~2 MB from Slopify)
SYNC_EVERY_S = int(env("SYNC_EVERY_S", "300"))
TRAIN_AT_HOUR = int(env("TRAIN_AT_HOUR", "4"))    # nightly retrain, only with a Slopify older than the Brain task
