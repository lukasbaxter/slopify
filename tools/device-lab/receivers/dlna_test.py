#!/usr/bin/env python3
"""UPnP AV control point test (Python stdlib only).

Discovers a MediaRenderer by SSDP M-SEARCH (friendly name match), serves a local audio file over
HTTP from this machine, then drives AVTransport / RenderingControl / ConnectionManager:
GetProtocolInfo, SetAVTransportURI, Play, GetPositionInfo (must advance in real time), Pause
(must hold), Seek, SetVolume/GetVolume, Stop. Prints PASS/FAIL per step; exit code = failures.

  python3 dlna_test.py --file tone.mp3                       # name defaults to "Lab DLNA"
  python3 dlna_test.py --file tone.mp3 --serve-mode plain    # no Range support (like http.server)
  python3 dlna_test.py --file tone.mp3 --serve-mode nolength # no Content-Length, no Range
  python3 dlna_test.py --url http://some/stream.mp3          # use an existing URL instead
  python3 dlna_test.py --location http://host:port/description.xml   # skip discovery
"""
import argparse, html, http.server, mimetypes, os, re, socket, socketserver, sys, threading, time
import urllib.request, urllib.parse
from xml.etree import ElementTree as ET

SSDP = ("239.255.255.250", 1900)
NS = {"d": "urn:schemas-upnp-org:device-1-0"}
fails = 0


def log(msg):
    print(f"{time.strftime('%H:%M:%S')}.{int(time.time() * 1000) % 1000:03d} {msg}", flush=True)


def check(ok, what):
    global fails
    if not ok:
        fails += 1
    log(f"{'PASS' if ok else 'FAIL'} {what}")
    return ok


def ssdp_search(st, wait):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.settimeout(0.5)
    msg = (f"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\n"
           f"MX: 2\r\nST: {st}\r\n\r\n").encode()
    locs = set()
    end = time.time() + wait
    nxt = 0
    while time.time() < end:
        if time.time() >= nxt:
            s.sendto(msg, SSDP)
            nxt = time.time() + 1.0
        try:
            data, _ = s.recvfrom(65536)
        except socket.timeout:
            continue
        m = re.search(rb"(?im)^location:\s*(\S+)", data)
        if m:
            locs.add(m.group(1).decode())
    return locs


def describe(loc):
    x = ET.fromstring(urllib.request.urlopen(loc, timeout=5).read())
    dev = x.find("d:device", NS)
    base = x.findtext("d:URLBase", default=loc, namespaces=NS)
    svcs = {}
    for sv in dev.iter("{urn:schemas-upnp-org:device-1-0}service"):
        t = sv.findtext("d:serviceType", namespaces=NS)
        svcs[t.split(":")[-2]] = (t, urllib.parse.urljoin(base, sv.findtext("d:controlURL", namespaces=NS)))
    return {"name": dev.findtext("d:friendlyName", namespaces=NS), "udn": dev.findtext("d:UDN", namespaces=NS),
            "model": dev.findtext("d:modelName", namespaces=NS), "services": svcs, "location": loc}


class Renderer:
    def __init__(self, info):
        self.info = info

    def call(self, svc, action, **args):
        stype, url = self.info["services"][svc]
        body = "".join(f"<{k}>{html.escape(str(v))}</{k}>" for k, v in args.items())
        env = (f'<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
               f's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{stype}">'
               f"{body}</u:{action}></s:Body></s:Envelope>").encode()
        req = urllib.request.Request(url, env, {"Content-Type": 'text/xml; charset="utf-8"',
                                                "SOAPACTION": f'"{stype}#{action}"'})
        t0 = time.time()
        try:
            resp = urllib.request.urlopen(req, timeout=10).read()
        except urllib.error.HTTPError as e:
            err = e.read().decode(errors="replace")
            code = re.search(r"<errorCode>(\d+)</errorCode>", err)
            desc = re.search(r"<errorDescription>(.*?)</errorDescription>", err)
            raise RuntimeError(f"{action} -> HTTP {e.code} UPnPError {code and code.group(1)} {desc and desc.group(1)}")
        out = {}
        for el in ET.fromstring(resp).iter():
            if el.tag.endswith("Response"):
                out = {c.tag: (c.text or "") for c in el}
        out["_ms"] = int((time.time() - t0) * 1000)
        return out

    def av(self, action, **a):
        return self.call("AVTransport", action, InstanceID=0, **a)

    def rc(self, action, **a):
        return self.call("RenderingControl", action, InstanceID=0, Channel="Master", **a)


def hms(s):
    try:
        h, m, sec = s.split(":")
        return int(h) * 3600 + int(m) * 60 + float(sec)
    except Exception:
        return None


def make_server(path, mode, bind_ip):
    data = open(path, "rb").read()
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    hits = []

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def do_HEAD(self):
            self.do_GET(head=True)

        def do_GET(self, head=False):
            rng = self.headers.get("Range")
            hits.append((time.time(), self.command, rng))
            start, end = 0, len(data) - 1
            m = re.match(r"bytes=(\d*)-(\d*)", rng or "") if mode == "range" else None
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else end
                else:
                    start = len(data) - int(m.group(2))
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
            else:
                self.send_response(200)
            self.send_header("Content-Type", ctype)
            if mode == "range":
                self.send_header("Accept-Ranges", "bytes")
            if mode == "nolength":
                self.send_header("Connection", "close")
            else:
                self.send_header("Content-Length", str(end - start + 1))
            self.send_header("transferMode.dlna.org", "Streaming")
            self.end_headers()
            if head:
                return
            try:
                chunk = data[start:end + 1]
                for i in range(0, len(chunk), 65536):
                    self.wfile.write(chunk[i:i + 65536])
            except (BrokenPipeError, ConnectionResetError):
                pass
            if mode == "nolength":
                self.close_connection = True

    class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

        def handle_error(self, request, client_address):
            pass  # renderer dropping a connection on seek/stop is normal

    srv = S((bind_ip, 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, ctype, hits


def local_ip_towards(host):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect((host, 9))
    ip = s.getsockname()[0]
    s.close()
    return ip


def didl(url, ctype, title):
    return ('<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1">'
            f"<dc:title>{html.escape(title)}</dc:title><dc:creator>Slopify Lab</dc:creator>"
            "<upnp:artist>Slopify Lab</upnp:artist><upnp:album>Receiver Tests</upnp:album>"
            "<upnp:class>object.item.audioItem.musicTrack</upnp:class>"
            f'<res protocolInfo="http-get:*:{ctype}:*">{html.escape(url)}</res></item></DIDL-Lite>')


def poll(r, secs, label):
    pts = []
    for _ in range(int(secs)):
        p = r.av("GetPositionInfo")
        t = r.av("GetTransportInfo")
        pts.append((time.time(), hms(p.get("RelTime", "")), t.get("CurrentTransportState")))
        log(f"  {label}: RelTime={p.get('RelTime')} TrackDuration={p.get('TrackDuration')} "
            f"state={t.get('CurrentTransportState')} status={t.get('CurrentTransportStatus')}")
        time.sleep(1)
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="Lab DLNA")
    ap.add_argument("--location", help="device description URL (skips SSDP)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--file", help="local audio file to serve")
    g.add_argument("--url", help="existing http URL to play")
    ap.add_argument("--mime", default="audio/mpeg", help="protocolInfo mime for --url")
    ap.add_argument("--serve-mode", choices=["range", "plain", "nolength"], default="range")
    ap.add_argument("--seek-to", default="00:00:30")
    ap.add_argument("--wait", type=float, default=4)
    a = ap.parse_args()

    if a.location:
        info = describe(a.location)
    else:
        locs = ssdp_search("urn:schemas-upnp-org:device:MediaRenderer:1", a.wait)
        info = None
        for l in sorted(locs):
            try:
                d = describe(l)
            except Exception:
                continue
            if d["name"] == a.name:
                info = d
                break
        if not check(info is not None, f"SSDP discovery of {a.name!r} ({len(locs)} renderers answered)"):
            return 1
    log(f"renderer {info['name']} {info['udn']} model={info['model']} at {info['location']}")
    for k, (t, u) in info["services"].items():
        log(f"  service {t} control={u}")
    r = Renderer(info)

    pi = r.call("ConnectionManager", "GetProtocolInfo")
    sinks = [x for x in pi.get("Sink", "").split(",") if x]
    check(any("audio/mpeg" in x for x in sinks), f"GetProtocolInfo: {len(sinks)} sink formats, audio/mpeg present")

    hits = []
    if a.file:
        host = urllib.parse.urlparse(info["location"]).hostname
        ip = local_ip_towards(host)
        srv, ctype, hits = make_server(a.file, a.serve_mode, ip)
        url = f"http://{ip}:{srv.server_address[1]}/{urllib.parse.quote(os.path.basename(a.file))}"
        log(f"serving {a.file} at {url} mode={a.serve_mode}")
    else:
        url, ctype = a.url, a.mime

    try:
        r.av("Stop")
    except RuntimeError:
        pass
    res = r.av("SetAVTransportURI", CurrentURI=url, CurrentURIMetaData=didl(url, ctype, "Lab Tone 440"))
    check(True, f"SetAVTransportURI ({res['_ms']} ms)")
    t_play = time.time()
    res = r.av("Play", Speed=1)
    check(True, f"Play ({res['_ms']} ms)")
    pts = poll(r, 6, "playing")
    moving = [p for p in pts if p[1] is not None and p[2] == "PLAYING"]
    if check(len(moving) >= 3, "transport reaches PLAYING"):
        (t1, p1, _), (t2, p2, _) = moving[1], moving[-1]
        rate = (p2 - p1) / (t2 - t1) if t2 > t1 else 0
        check(0.8 <= rate <= 1.2, f"position advances in real time ({rate:.2f} s/s)")
        first = next((p for p in pts if p[1] and p[1] > 0), None)
        if first:
            log(f"  first non-zero position {first[1]:.0f}s at +{first[0] - t_play:.2f}s after Play")

    try:
        r.av("Pause")
        pp = poll(r, 3, "paused")
        held = [p[1] for p in pp if p[1] is not None]
        check(pp[-1][2] == "PAUSED_PLAYBACK" and len(set(held)) == 1, f"Pause holds position at {held[-1] if held else None}")
        r.av("Play", Speed=1)

    except RuntimeError as e:
        check(False, f"Pause: {e}")
    target = hms(a.seek_to)
    try:
        res = r.av("Seek", Unit="REL_TIME", Target=a.seek_to)
        log(f"  Seek accepted ({res['_ms']} ms)")
        sp = poll(r, 3, "after seek")
        pos = sp[-1][1]
        check(pos is not None and target - 1 <= pos <= target + 4, f"Seek REL_TIME {a.seek_to} -> position {pos}")
    except RuntimeError as e:
        check(False, f"Seek: {e}")

    try:
        r.rc("SetVolume", DesiredVolume=30)
        v = r.rc("GetVolume").get("CurrentVolume")
        check(v == "30", f"SetVolume 30 -> GetVolume {v}")
        m = r.rc("GetMute").get("CurrentMute")
        log(f"  GetMute -> {m}")
        time.sleep(2)
        r.rc("SetVolume", DesiredVolume=100)

    except RuntimeError as e:
        check(False, f"Volume: {e}")
    try:
        r.av("Stop")
        time.sleep(0.5)
        st = r.av("GetTransportInfo").get("CurrentTransportState")
        check(st == "STOPPED", f"Stop -> {st}")
    except RuntimeError as e:
        check(False, f"Stop: {e}")
    if hits:
        log("HTTP requests from renderer: " + ", ".join(f"{c} Range={rg}" for _, c, rg in hits))
    log(f"done, {fails} failure(s)")
    return fails


if __name__ == "__main__":
    sys.exit(main())
