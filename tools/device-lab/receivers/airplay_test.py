#!/usr/bin/env python3
"""AirPlay 1 (RAOP) sender test using pyatv as an independent client.

Discovers the receiver over mDNS (_raop._tcp, instance name containing --name), builds a pyatv
service from the real TXT record, then streams a file with title/artist/album/artwork metadata
and changes volume mid-stream. Run it with the lab venv:

  ~/apps/slopify-lab/receivers/venv/bin/python airplay_test.py --name "Lab AirPlay" --file tone.mp3
  ... --name "Lab AirPlay Locked" --expect-auth-failure          (no password: must be refused)
  ... --name "Lab AirPlay Locked" --password labpass             (must play)

Instead of discovery you can pass --address and --port (then TXT defaults for shairport are used).
Check the receiver side with: run.sh logs airplay   (RMS + metadata logs).
"""
import argparse, asyncio, socket, sys, time

import pyatv
from pyatv.conf import AppleTV, ManualService
from pyatv.const import Protocol
from pyatv.interface import MediaMetadata
from zeroconf import ServiceBrowser, Zeroconf

RAOP = "_raop._tcp.local."
DEFAULT_TXT = {"tp": "TCP,UDP", "md": "0,1,2", "sr": "44100", "ss": "16", "ch": "2", "cn": "0,1",
               "et": "0,1", "ek": "1", "vn": "65537", "am": "ShairportSync", "pw": "false", "da": "true",
               "sf": "0x4", "txtvers": "1"}


def log(msg):
    print(f"{time.strftime('%H:%M:%S')}.{int(time.time() * 1000) % 1000:03d} {msg}", flush=True)


def discover(name, timeout):
    names = []

    class L:  # zeroconf callbacks run on its own thread: only collect names here
        def add_service(self, zc, t, n):
            if n[: -len(t) - 1].split("@", 1)[-1] == name and n not in names:
                names.append(n)

        update_service = add_service

        def remove_service(self, *a):
            pass

    zc = Zeroconf()
    try:
        ServiceBrowser(zc, RAOP, L())
        end = time.time() + timeout
        while time.time() < end:
            if names:
                info = zc.get_service_info(RAOP, names[0], 3000)
                if info and info.addresses:
                    break
            time.sleep(0.2)
        else:
            return None
    finally:
        zc.close()
    n = names[0]
    props = {k.decode(): (v or b"").decode() for k, v in info.properties.items()}
    addr = socket.inet_ntoa(info.addresses[0])
    return {"instance": n, "address": addr, "port": info.port, "props": props,
            "id": n.split("@", 1)[0]}


def locate(a):
    if a.address:
        d = {"instance": "(manual)", "address": a.address, "port": a.port, "props": dict(DEFAULT_TXT),
             "id": a.id or "000000000000"}
        if a.password or a.expect_auth_failure:
            d["props"]["pw"] = "true"
        return d
    return discover(a.name, a.timeout)  # sync zeroconf: must run outside the asyncio loop


async def run(a, d):
    log(f"found {d['instance']} at {d['address']}:{d['port']} pw={d['props'].get('pw')} "
        f"md={d['props'].get('md')} et={d['props'].get('et')} cn={d['props'].get('cn')}")

    conf = AppleTV(d["address"], a.name)
    svc = ManualService(d["id"], Protocol.RAOP, d["port"], d["props"], password=a.password,
                        requires_password=d["props"].get("pw") == "true")
    conf.add_service(svc)
    atv = await pyatv.connect(conf, asyncio.get_running_loop())
    try:
        art = open(a.artwork, "rb").read() if a.artwork else None
        md = MediaMetadata(title=a.title, artist=a.artist, album=a.album, artwork=art)
        t0 = time.time()
        task = asyncio.create_task(atv.stream.stream_file(a.file, metadata=md))
        log(f"stream_file started {a.file} (artwork {len(art) if art else 0} bytes)")
        for at, vol in ((5, 80.0), (10, 30.0)):
            await asyncio.sleep(max(0, t0 + at - time.time()))
            if task.done():
                break
            await atv.audio.set_volume(vol)
            log(f"set_volume {vol} -> device reports {atv.audio.volume}")
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=max(1, a.seconds - (time.time() - t0)))
            log(f"stream finished after {time.time() - t0:.1f}s")
        except asyncio.TimeoutError:
            log(f"stopping after {a.seconds}s")
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        if task.done() and not task.cancelled() and task.exception():
            raise task.exception()
    except Exception as e:
        if a.expect_auth_failure:
            log(f"PASS refused as expected: {type(e).__name__}: {e}")
            return 0
        log(f"FAIL {type(e).__name__}: {e}")
        return 1
    finally:
        atv.close()
    if a.expect_auth_failure:
        log("FAIL stream was accepted without a password")
        return 1
    log("PASS")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="Lab AirPlay")
    ap.add_argument("--address")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--id")
    ap.add_argument("--file", required=True)
    ap.add_argument("--artwork")
    ap.add_argument("--title", default="Lab Tone 440")
    ap.add_argument("--artist", default="Slopify Lab")
    ap.add_argument("--album", default="Receiver Tests")
    ap.add_argument("--password")
    ap.add_argument("--expect-auth-failure", action="store_true")
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--timeout", type=float, default=8)
    a = ap.parse_args()
    d = locate(a)
    if not d:
        log(f"FAIL no _raop._tcp service named {a.name!r} found in {a.timeout}s")
        sys.exit(1)
    sys.exit(asyncio.run(run(a, d)))


if __name__ == "__main__":
    main()
