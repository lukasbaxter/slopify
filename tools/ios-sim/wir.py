#!/usr/bin/env python3
"""Minimal Web Inspector (WIR) client for a booted iOS Simulator.

Talks straight to the simulator's webinspectord unix socket (the same thing
Safari's Develop menu and ios_webkit_debug_proxy use), so it needs no Xcode
project, no Safari "Remote Automation" switch and nothing on screen. Stdlib only.

  wir.py pages                       list inspectable pages (Safari tabs, web apps)
  wir.py js 'JS expression'        evaluate in the page, print the JSON result
  wir.py js --await 'promise'      same, awaiting a promise
  wir.py js --gesture 'a.play()'   run as if from a user tap (emulateUserGesture)
  wir.py console [seconds]           stream console messages

Page selection: --url-substr / --title-substr (default: first page whose URL
starts with http). --app-substr narrows the app (e.g. "webapp" for a home-screen
web app, "mobilesafari" for Safari).
"""
import argparse, glob, json, os, plistlib, socket, struct, sys, time, uuid


def find_socket():
    env = os.environ.get('WIR_SOCKET')
    if env:
        return env
    # One simulator booted -> one webinspectord_sim.socket. With several, set WIR_SOCKET.
    socks = sorted(glob.glob('/private/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket') +
                   glob.glob('/private/var/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket'),
                   key=os.path.getmtime, reverse=True)
    if not socks:
        sys.exit('no webinspectord_sim.socket found: is a simulator booted?')
    return socks[0]


class WIR:
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(path)
        self.s.settimeout(0.5)
        self.buf = b''
        self.conn = str(uuid.uuid4()).upper()
        self.sender = str(uuid.uuid4()).upper()
        self.apps = {}
        self.listings = {}
        self.inbox = []  # inspector JSON messages from the page
        self.send('_rpc_reportIdentifier:', {})

    def send(self, sel, arg):
        arg = dict(arg)
        arg['WIRConnectionIdentifierKey'] = self.conn
        data = plistlib.dumps({'__selector': sel, '__argument': arg}, fmt=plistlib.FMT_BINARY)
        self.s.sendall(struct.pack('>I', len(data)) + data)

    def pump(self, timeout=0.5):
        end = time.time() + timeout
        got = False
        while time.time() < end:
            try:
                chunk = self.s.recv(1 << 20)
            except socket.timeout:
                continue
            if not chunk:
                raise ConnectionError('webinspectord closed the socket')
            self.buf += chunk
            while len(self.buf) >= 4:
                n = struct.unpack('>I', self.buf[:4])[0]
                if len(self.buf) < 4 + n:
                    break
                msg = plistlib.loads(self.buf[4:4 + n])
                self.buf = self.buf[4 + n:]
                self.handle(msg)
                got = True
            if got:
                end = min(end, time.time() + 0.15)
        return got

    def handle(self, m):
        sel, a = m.get('__selector'), m.get('__argument', {})
        if sel == '_rpc_reportConnectedApplicationList:':
            self.apps = a.get('WIRApplicationDictionaryKey', {})
        elif sel in ('_rpc_applicationConnected:', '_rpc_applicationUpdated:'):
            self.apps[a['WIRApplicationIdentifierKey']] = a
        elif sel == '_rpc_applicationDisconnected:':
            self.apps.pop(a.get('WIRApplicationIdentifierKey'), None)
        elif sel == '_rpc_applicationSentListing:':
            self.listings[a['WIRApplicationIdentifierKey']] = a.get('WIRListingKey', {})
        elif sel == '_rpc_applicationSentData:':
            self.inbox.append(json.loads(a['WIRMessageDataKey']))

    def pages(self):
        # Replies arrive at their own pace (an app that was suspended answers
        # late): ask again until every app has sent a listing, up to ~6 s.
        end = time.time() + 6
        self.send('_rpc_getConnectedApplications:', {})
        while time.time() < end:
            self.pump(0.5)
            missing = [app for app in self.apps if app not in self.listings]
            if self.apps and not missing and any(self.listings.values()):
                break
            for app in missing or list(self.apps):
                self.send('_rpc_forwardGetListing:', {'WIRApplicationIdentifierKey': app})
            if not self.apps:
                self.send('_rpc_getConnectedApplications:', {})
        out = []
        for app, listing in self.listings.items():
            info = self.apps.get(app, {})
            for p in listing.values():
                out.append({'app': app, 'bundle': info.get('WIRApplicationBundleIdentifierKey'),
                            'appName': info.get('WIRApplicationNameKey'), 'page': p.get('WIRPageIdentifierKey'),
                            'type': p.get('WIRTypeKey'), 'title': p.get('WIRTitleKey'), 'url': p.get('WIRURLKey')})
        return out

    def attach(self, page):
        self.app, self.page = page['app'], page['page']
        self.send('_rpc_forwardSocketSetup:', {'WIRApplicationIdentifierKey': self.app, 'WIRPageIdentifierKey': self.page,
                                               'WIRSenderKey': self.sender, 'WIRAutomaticallyPause': False,
                                               'WIRMessageDataTypeChunkSupportedKey': 0})
        # Modern WebKit multiplexes through the Target domain: wait for targetCreated.
        self.target = None
        end = time.time() + 5
        while time.time() < end and not self.target:
            self.pump(0.3)
            for m in self.inbox:
                if m.get('method') == 'Target.targetCreated':
                    ti = m['params']['targetInfo']
                    if ti.get('type') == 'page':
                        self.target = ti['targetId']
            self.inbox = [m for m in self.inbox if m.get('method') != 'Target.targetCreated']
        self.mid = 0
        return self.target

    def raw(self, obj):
        self.send('_rpc_forwardSocketData:', {'WIRApplicationIdentifierKey': self.app, 'WIRPageIdentifierKey': self.page,
                                              'WIRSenderKey': self.sender,
                                              'WIRSocketDataKey': json.dumps(obj).encode()})

    def call(self, method, params=None, timeout=15):
        self.mid += 1
        inner = {'id': self.mid, 'method': method, 'params': params or {}}
        if self.target:
            self.mid += 1
            self.raw({'id': self.mid, 'method': 'Target.sendMessageToTarget',
                      'params': {'targetId': self.target, 'message': json.dumps(inner)}})
        else:
            self.raw(inner)
        want = inner['id']
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            for m in list(self.inbox):
                msg = m
                if m.get('method') == 'Target.dispatchMessageFromTarget':
                    msg = json.loads(m['params']['message'])
                if msg.get('id') == want:
                    self.inbox.remove(m)
                    return msg
        raise TimeoutError(method)

    def events(self):
        out = []
        for m in self.inbox:
            if m.get('method') == 'Target.dispatchMessageFromTarget':
                m = json.loads(m['params']['message'])
            out.append(m)
        self.inbox = []
        return out


def pick(pages, a):
    # Pages before service workers (--sw targets the worker instead); newest
    # page (highest id) first, so the tab just opened wins.
    want_sw = getattr(a, 'sw', False)
    c = [p for p in pages if (p['type'] == 'WIRTypeServiceWorker') == want_sw]
    c.sort(key=lambda p: -(p['page'] or 0))
    if a.app_substr:
        c = [p for p in c if a.app_substr in (p['bundle'] or '') or a.app_substr in (p['appName'] or '')]
    if a.url_substr:
        c = [p for p in c if a.url_substr in (p['url'] or '')]
    if a.title_substr:
        c = [p for p in c if a.title_substr in (p['title'] or '')]
    c = [p for p in c if (p['url'] or '').startswith('http')] or c
    if not c:
        sys.exit('no matching page; pages: ' + json.dumps(pages, indent=1))
    return c[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['pages', 'js', 'console', 'hold'])
    ap.add_argument('arg', nargs='?')
    ap.add_argument('--url-substr'); ap.add_argument('--title-substr'); ap.add_argument('--app-substr')
    ap.add_argument('--await', dest='await_', action='store_true')
    ap.add_argument('--sw', action='store_true', help='target the service worker instead of the page')
    ap.add_argument('--gesture', action='store_true', help='emulateUserGesture: lets play() pass the autoplay gate')
    a = ap.parse_intermixed_args()
    if a.cmd == 'hold':
        # The simulator's webinspectord quits when its last client leaves, and
        # a client connecting while it restarts sees no pages. ios-sim.sh up
        # keeps this one connected in the background so it stays up.
        while True:
            try:
                w = WIR(find_socket())
                w.send('_rpc_getConnectedApplications:', {})
                while True:
                    w.pump(5)
            except (ConnectionError, OSError):
                time.sleep(1)
    pages = []
    for attempt in range(4):
        try:
            w = WIR(find_socket())
            w.pump(0.5)
            pages = w.pages()
        except (ConnectionError, OSError):
            pages = []
        if pages:
            break
        time.sleep(1)
    if a.cmd == 'pages':
        print(json.dumps(pages, indent=1)); return
    p = pick(pages, a)
    w.attach(p)
    if a.cmd == 'js':
        # WebKit's Runtime.evaluate has no awaitPromise: get the promise as an
        # object, then Runtime.awaitPromise on it.
        r = w.call('Runtime.evaluate', {'expression': a.arg, 'returnByValue': not a.await_,
                                        'emulateUserGesture': a.gesture, 'objectGroup': 'harness'})
        res = r.get('result', {})
        obj = res.get('result', {})
        if a.await_ and not res.get('wasThrown') and obj.get('objectId'):
            r = w.call('Runtime.awaitPromise', {'promiseObjectId': obj['objectId'], 'returnByValue': True}, timeout=60)
            res = r.get('result', {})
        if 'error' in r:
            print(json.dumps(r['error'])); sys.exit(1)
        if res.get('wasThrown'):
            print('THROWN', json.dumps(res.get('result'))); sys.exit(1)
        v = res.get('result', {})
        print(json.dumps(v.get('value', v.get('description')), indent=1))
    elif a.cmd == 'console':
        w.call('Console.enable')
        end = time.time() + float(a.arg or 30)
        while time.time() < end:
            w.pump(0.5)
            for m in w.events():
                if m.get('method') == 'Console.messageAdded':
                    c = m['params']['message']
                    print(f"[{c.get('level')}] {c.get('text')}", flush=True)


if __name__ == '__main__':
    main()
