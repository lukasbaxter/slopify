#!/usr/bin/env python3
"""Read raw PCM (S16LE, interleaved) from stdin or a FIFO and log one line per wall-clock second.

Line format (space separated key=value, easy to grep/parse):
  2026-10-31T10:40:01.000 label=dlna state=audio frames=44100 rms_dbfs=-9.0 peak_dbfs=-6.0 total_s=12.00

state: audio (RMS above -85 dBFS; shairport applies AirPlay volume in software), silence (data flowing but quiet), idle (no data that second).
Idle seconds are only logged on the transition and then every --idle-every seconds, to keep logs small.
frames per second close to the sample rate proves the source is paced in real time.
"""
import argparse, array, math, os, select, sys, time
from datetime import datetime


def ts(t):
    return datetime.fromtimestamp(t).isoformat(timespec="milliseconds")


def db(x):
    return -120.0 if x <= 0 else max(-120.0, 20 * math.log10(x / 32768.0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="pcm")
    ap.add_argument("--rate", type=int, default=44100)
    ap.add_argument("--channels", type=int, default=2)
    ap.add_argument("--idle-every", type=int, default=60)
    ap.add_argument("--silence-dbfs", type=float, default=-85.0)
    ap.add_argument("source", nargs="?", help="FIFO/file path; default stdin")
    a = ap.parse_args()

    fd = os.open(a.source, os.O_RDONLY) if a.source else sys.stdin.fileno()
    frame_bytes = 2 * a.channels
    out = sys.stdout
    total_frames = 0
    carry = b""
    sec_start = time.time()
    n = 0
    sumsq = 0.0
    peak = 0
    idle_since = None
    last_idle_log = 0.0
    eof = False
    print(f"{ts(time.time())} label={a.label} state=start rate={a.rate} channels={a.channels}", file=out, flush=True)

    while True:
        now = time.time()
        wait = max(0.0, sec_start + 1.0 - now)
        r = []
        if not eof:
            r, _, _ = select.select([fd], [], [], wait)
        else:
            time.sleep(wait)
        if r:
            chunk = os.read(fd, 65536)
            if not chunk:
                eof = True
                if a.source:  # FIFO writer went away: reopen and keep going
                    os.close(fd)
                    fd = os.open(a.source, os.O_RDONLY)
                    eof = False
            else:
                buf = carry + chunk
                usable = len(buf) - (len(buf) % frame_bytes)
                carry = buf[usable:]
                s = array.array("h")
                s.frombytes(buf[:usable])
                if sys.byteorder == "big":
                    s.byteswap()
                n += len(s) // a.channels
                for v in s:
                    sumsq += v * v
                if s:
                    peak = max(peak, max(s), -min(s))
        now = time.time()
        if now >= sec_start + 1.0:
            if n:
                total_frames += n
                rms = math.sqrt(sumsq / (n * a.channels))
                rd = db(rms)
                state = "audio" if rd > a.silence_dbfs else "silence"
                print(f"{ts(sec_start)} label={a.label} state={state} frames={n} rms_dbfs={rd:.1f} "
                      f"peak_dbfs={db(peak):.1f} total_s={total_frames / a.rate:.2f}", file=out, flush=True)
                idle_since = None
            else:
                if idle_since is None or now - last_idle_log >= a.idle_every:
                    if idle_since is None:
                        idle_since = sec_start
                    last_idle_log = now
                    print(f"{ts(sec_start)} label={a.label} state=idle since={ts(idle_since)} "
                          f"total_s={total_frames / a.rate:.2f}", file=out, flush=True)
            sec_start += 1.0
            if now - sec_start > 2:  # fell behind (suspend etc.): resync
                sec_start = now
            n, sumsq, peak = 0, 0.0, 0


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
