#!/usr/bin/env python3
"""Decode the shairport-sync metadata pipe and log one readable line per item.

  2026-10-31T10:41:02.120 core/minm title="Lab Tone 440"
  2026-10-31T10:41:02.300 ssnc/prgr progress elapsed=0.00s duration=60.00s raw=...
  2026-10-31T10:41:02.400 ssnc/PICT artwork image/jpeg 12345 bytes -> <dir>/artwork-latest.jpg
  2026-10-31T10:41:05.000 ssnc/pvol volume airplay=-15.00 out=-30.00 (min -60.00, max 0.00)

Artwork is written to --art-dir (latest + timestamped copy).
"""
import argparse, base64, os, re, struct, sys, time
from datetime import datetime

NAMES = {
    "core/minm": "title", "core/asar": "artist", "core/asal": "album", "core/asgn": "genre",
    "core/ascp": "composer", "core/asaa": "album_artist", "core/astm": "duration_ms",
    "core/caps": "play_state", "core/mper": "persistent_id", "core/astn": "track_number",
    "core/asdk": "song_data_kind", "core/asyr": "year",
    "ssnc/pbeg": "play_begin", "ssnc/pend": "play_end", "ssnc/pfls": "flush", "ssnc/prsm": "resume",
    "ssnc/paus": "pause", "ssnc/pres": "resume_play",
    "ssnc/pvol": "volume", "ssnc/prgr": "progress", "ssnc/PICT": "artwork",
    "ssnc/mdst": "metadata_start", "ssnc/mden": "metadata_end",
    "ssnc/pcst": "picture_start", "ssnc/pcen": "picture_end",
    "ssnc/snam": "client_name", "ssnc/snua": "user_agent", "ssnc/clip": "client_ip",
    "ssnc/svip": "server_ip", "ssnc/conn": "connection_ip", "ssnc/disc": "disconnect",
    "ssnc/acre": "active_remote", "ssnc/daid": "dacp_id", "ssnc/styp": "stream_type",
    "ssnc/ofmt": "output_format", "ssnc/ofps": "output_rate", "ssnc/abeg": "active_begin",
    "ssnc/aend": "active_end", "ssnc/phb0": "first_frame", "ssnc/phbt": "frame_time",
    "ssnc/stal": "stalled", "ssnc/srvr": "server_version", "ssnc/asul": "url",
    "ssnc/dapo": "dacp_port", "ssnc/cdid": "client_device_id", "ssnc/cmod": "client_model",
    "ssnc/cmac": "client_mac", "ssnc/clnt": "client", "ssnc/ptxt": "progress_text",
}
ITEM = re.compile(rb"<item><type>([0-9a-f]{8})</type><code>([0-9a-f]{8})</code><length>(\d+)</length>"
                  rb"(?:\s*<data encoding=\"base64\">\s*([A-Za-z0-9+/=\s]*?)</data>)?\s*</item>", re.S)
last_rate = 44100


def ts():
    return datetime.now().isoformat(timespec="milliseconds")


def fourcc(h):
    return bytes.fromhex(h.decode()).decode("latin-1")


def describe(key, data, art_dir):
    name = NAMES.get(key, "")
    if key == "ssnc/PICT":
        if not data:
            return "artwork (empty)"
        kind, ext = ("image/png", "png") if data[:8] == b"\x89PNG\r\n\x1a\n" else \
                    ("image/jpeg", "jpg") if data[:3] == b"\xff\xd8\xff" else ("unknown", "bin")
        os.makedirs(art_dir, exist_ok=True)
        latest = os.path.join(art_dir, f"artwork-latest.{ext}")
        with open(latest, "wb") as f:
            f.write(data)
        with open(os.path.join(art_dir, f"artwork-{int(time.time())}.{ext}"), "wb") as f:
            f.write(data)
        return f"artwork {kind} {len(data)} bytes -> {latest}"
    if key == "ssnc/prgr":
        try:
            s, c, e = (int(x) for x in data.decode().split("/"))
            m = 1 << 32
            return (f"progress elapsed={((c - s) % m) / last_rate:.2f}s duration={((e - s) % m) / last_rate:.2f}s "
                    f"raw={data.decode()}")
        except Exception:
            pass
    if key == "ssnc/pvol":
        try:
            av, ov, lo, hi = (float(x) for x in data.decode().split(","))
            return f"volume airplay={av:.2f} out={ov:.2f} (min {lo:.2f}, max {hi:.2f})" + (" MUTE" if av <= -144 else "")
        except Exception:
            pass
    if key in ("core/astm", "core/caps", "core/astn", "core/asyr") and len(data) in (1, 2, 4, 8):
        v = int.from_bytes(data, "big")
        return f"{name}={v}" + (f" ({v / 1000:.2f}s)" if key == "core/astm" else "")
    if key == "core/mper" and len(data) == 8:
        return f"{name}={struct.unpack('>Q', data)[0]:016x}"
    if not data:
        return name or "event"
    try:
        txt = data.decode("utf-8")
        if txt.isprintable():
            return f'{name or "value"}="{txt}"'
    except UnicodeDecodeError:
        pass
    return f"{name or 'value'} {len(data)} bytes hex={data[:32].hex()}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pipe")
    ap.add_argument("--art-dir", required=True)
    ap.add_argument("--quiet-frames", action="store_true", default=True,
                    help="skip ssnc/phbt per-frame timing items (default on)")
    a = ap.parse_args()
    if not os.path.exists(a.pipe):
        os.mkfifo(a.pipe, 0o600)
    print(f"{ts()} reader start pipe={a.pipe}", flush=True)
    global last_rate
    while True:
        with open(a.pipe, "rb", buffering=0) as f:
            buf = b""
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                buf += chunk
                while True:
                    m = ITEM.search(buf)
                    if not m:
                        if len(buf) > 8 << 20:  # garbage guard
                            buf = buf[-(1 << 20):]
                        break
                    buf = buf[m.end():]
                    key = f"{fourcc(m.group(1))}/{fourcc(m.group(2))}"
                    data = base64.b64decode(re.sub(rb"\s", b"", m.group(4))) if m.group(4) else b""
                    if key == "ssnc/ofps":
                        try:
                            last_rate = int(data.decode()) or 44100
                        except Exception:
                            pass
                    if a.quiet_frames and key == "ssnc/phbt":
                        continue
                    print(f"{ts()} {key} {describe(key, data, a.art_dir)}", flush=True)
        time.sleep(0.2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
