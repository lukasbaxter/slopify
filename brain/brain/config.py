"""Everything from the environment; nothing about one house is in the code."""
import os

def env(k, d=""):
    return os.environ.get(k, d)

SLOPIFY_URL = env("SLOPIFY_URL").rstrip("/")      # the Slopify server, as this box reaches it
BRAIN_KEY = env("BRAIN_KEY")                       # same value as Slopify's BRAIN_KEY
DATA_DIR = env("DATA_DIR", "/data")
DEVICE = env("DEVICE", "auto")                    # auto | xpu | cuda | cpu
# Where the listening happens: weather and local time. Unset = no weather.
LAT = float(env("LAT", "nan"))
LON = float(env("LON", "nan"))
TZ = env("TZ", "UTC")
AUDIO_MODEL = env("AUDIO_MODEL", "laion/larger_clap_general")
EMBED_WORKERS = int(env("EMBED_WORKERS", "3"))   # songs decoded at once (each reads ~2 MB from Slopify)
SYNC_EVERY_S = int(env("SYNC_EVERY_S", "300"))
TRAIN_AT_HOUR = int(env("TRAIN_AT_HOUR", "4"))    # local hour of the nightly retrain
