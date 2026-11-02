// Slopify on the phone: your Slopify server's web app inside a native
// WebView. The web app's mobile layout (bottom tabs, compact player) does the
// rest; this shell supplies media playback permissions, the server address,
// a screen for when the server cannot be reached, the system share sheet,
// and the one thing a web page cannot have: the hardware volume buttons. While
// the sound is on another device (the page says so over the bridge) a press
// becomes a volume step for that device and the phone's own level is put
// back, so it never drifts; while the phone itself plays, the buttons do
// what they always do. It draws full-bleed and the page pads for the notch /
// home indicator (viewport-fit=cover).
//
// Addresses. The app is set up with your server's address (release builds
// carry none). Once you are signed in, the server tells it its home-network
// address (server/src/addresses.ts), and the app uses that whenever the
// phone can reach it and it proves it is your server, so music streams
// straight over Wi-Fi at home. It checks at launch, the moment the network
// changes, when the app comes back, and when a load fails. Leaving home
// moves the running page to the main address without a reload, the song
// carrying on; coming home switches over only while nothing plays and the
// app is in the background. The two addresses are different origins, each
// with its own localStorage, so the app keeps a copy of the sign-in and
// hands it over: you sign in once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, ScrollView, Share, StyleSheet, Text, TextInput, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { WebView } from 'react-native-webview';
import { VolumeManager } from 'react-native-volume-manager';
import SlopifyMedia from './modules/slopify-media';
import { cleanAddress, originOf } from './address';
import { answers, askAddresses, canMoveLive, homeTryable, netKey, provesItself } from './servers';

// An address a self-built app can suggest on first launch. Release builds
// leave it empty: the public app never carries anyone's server.
const BUILT_URL = process.env.EXPO_PUBLIC_SLOPIFY_URL || '';
const SERVERS_KEY = 'slopify.servers'; // { main, home, homeAuto, homeOff }
const SIGNIN_KEY = 'slopify.shellSession'; // { main, session }: the page's sign-in, for the other address
const AUTH_KEY = 'slopify.serverKey'; // { main, userId, key, at, public }: from /api/server/addresses
const NETS_KEY = 'slopify.homeNets'; // networks the home address answered on (netKey)

// No reachability pings: NetInfo's default checks a Google address, which
// would be one more outside service the app talks to (docs/PRIVACY.md).
NetInfo.configure({ reachabilityShouldRun: () => false, shouldFetchWiFiSSID: false });

// Tells the shell which address is open and its sign-in, as the page starts
// and whenever the page signs in or out (api/slopify.js persistSession /
// clearSession). A removal carries the token it removed: a stale sign-in
// cleared on one address must not wipe the good copy from the other.
const SIGNIN_BRIDGE = `(function () {
  if (!window.ReactNativeWebView) return;
  var K = 'slopify.session', ls;
  try { ls = window.localStorage; } catch (e) { return; }
  var post = function (start, was) { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'signin', start: start, origin: location.origin, session: ls.getItem(K), was: was || null })); } catch (e) {} };
  var set = Storage.prototype.setItem, rem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k) { var r = set.apply(this, arguments); if (k === K && this === ls) post(false); return r; };
  Storage.prototype.removeItem = function (k) { var was = k === K && this === ls ? ls.getItem(K) : null; var r = rem.apply(this, arguments); if (was) post(false, was); return r; };
  post(true);
})();`;
const sessionField = (raw, f) => { try { return (typeof raw === 'string' ? JSON.parse(raw) : raw)?.[f] || null; } catch { return null; } };
const tokenOf = (raw) => sessionField(raw, 'token');

// The share sheet and the clipboard, which a page on a plain-http home
// address does not get (both need https) and Android's WebView never has
// the share sheet: the app's own, through the bridge.
const PAGE_HELPERS = `(function () {
  if (!window.ReactNativeWebView) return;
  var waiting = window.__slopifyShare = {};
  navigator.share = function (d) {
    d = d || {};
    return new Promise(function (res, rej) {
      var id = Math.random().toString(36).slice(2);
      waiting[id] = { res: res, rej: rej };
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'share', id: id, title: d.title || '', text: d.text || '', url: d.url || '' }));
    });
  };
  navigator.canShare = function () { return true; };
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    var cb = { writeText: function (t) { return new Promise(function (res, rej) {
      try {
        var a = document.createElement('textarea');
        a.value = String(t); a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.opacity = '0';
        document.body.appendChild(a); a.select(); var ok = document.execCommand('copy'); document.body.removeChild(a);
        if (ok) res(); else rej(new Error('copy failed'));
      } catch (e) { rej(e); }
    }); } };
    try { Object.defineProperty(navigator, 'clipboard', { value: cb, configurable: true }); } catch (e) {}
  }
})();`;

// What the page shows other devices this phone as: its model ("iPhone 16",
// "Pixel 8"). Android also knows the name the owner gave it; iOS keeps that
// behind an entitlement, so the model it is.
const DEVICE_NAME = (Platform.OS === 'android' && Device.deviceName) || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone');
const DEVICE_FORM = Device.deviceType === Device.DeviceType.TABLET ? 'tablet' : 'phone';
// Android's WebView has no navigator.mediaSession: this stand-in takes what
// the page tells it (the same calls it makes in Safari and Chrome) to the
// app, which puts it on the system's media session and notification
// (modules/slopify-media), and brings the lock-screen, notification and
// headset buttons back to the page's own action handlers.
const MEDIA_SESSION = `(function () {
  if (navigator.mediaSession || !window.ReactNativeWebView) return;
  var handlers = {}, metadata = null, state = 'none', position = null, t = null;
  var post = function () {
    clearTimeout(t);
    t = setTimeout(function () {
      var art = metadata && metadata.artwork && metadata.artwork[0] ? metadata.artwork[0].src : null;
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mediasession', state: metadata ? state : 'none', metadata: metadata ? { title: metadata.title, artist: metadata.artist, album: metadata.album, artwork: art ? new URL(art, location.href).href : null } : null, position: position, actions: Object.keys(handlers) })); } catch (e) {}
    }, 30);
  };
  window.MediaMetadata = function (o) { o = o || {}; this.title = o.title || ''; this.artist = o.artist || ''; this.album = o.album || ''; this.artwork = o.artwork || []; };
  var ms = {
    get metadata() { return metadata; }, set metadata(v) { metadata = v || null; post(); },
    get playbackState() { return state; }, set playbackState(v) { state = v || 'none'; post(); },
    setActionHandler: function (a, fn) { if (fn) handlers[a] = fn; else delete handlers[a]; post(); },
    setPositionState: function (p) { position = p ? { duration: p.duration, position: p.position, rate: p.playbackRate || 1, at: Date.now() } : null; post(); },
  };
  Object.defineProperty(navigator, 'mediaSession', { value: ms, configurable: true });
  window.addEventListener('slopify:mediaaction', function (e) {
    var d = e.detail || {}, fn = handlers[d.action];
    if (fn) fn(d.action === 'seekto' ? { action: 'seekto', seekTime: d.seekTime } : { action: d.action });
  });
})();`;
// main: links others open use it, not a home address (TrackRow.jsx linkBase).
// servers: the page may offer Settings > Server address (it posts { type: 'servers' }).
const shellScript = (main) => `window.slopifyShell = ${JSON.stringify({ deviceName: DEVICE_NAME, deviceForm: DEVICE_FORM, platform: Platform.OS, version: process.env.EXPO_PUBLIC_SLOPIFY_SHELL || 'dev', servers: true, main: main || null })};${SIGNIN_BRIDGE}${PAGE_HELPERS}${Platform.OS === 'android' && SlopifyMedia ? MEDIA_SESSION : ''} true;`;

const hostLabel = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// iOS: a music player's audio session. The volume listener switches the
// session to Ambient as the module starts (only then: VolumeManager init),
// which iOS silences when the phone locks (and with the ring switch);
// Playback keeps the music going with the screen off. Set once, after the
// listener. Mixable: this is the APP's session, not the one the music plays
// in (WebKit has its own). The library re-activates it each time the app
// comes forward, and as non-mixable Playback that activation interrupted
// WebKit's: the phone's log at an unlock read "Slopify(…) 'MediaPlayback'
// INTERRUPTING com.apple.WebKit(…)", then WebKit "stopping playing" (the
// pause and gap after unlocking).
const musicSession = () => {
  if (Platform.OS !== 'ios') return;
  VolumeManager.setCategory('Playback', true).catch(() => {});
};

export default function App() {
  const web = useRef(null);
  // { offline, host } while the server cannot be reached, else null.
  const [error, setError] = useState(null);
  const errorRef = useRef(null);
  const [trying, setTrying] = useState(false);
  // { main, home, homeAuto, homeOff } once known; false = none saved yet (first launch).
  const [servers, setServers] = useState(null);
  const serversRef = useRef(null);
  // The address the WebView has open, and the one the page's API uses: the
  // same, until a move under the running page (leaving home) parts them.
  const [page, setPage] = useState(null);
  const pageRef = useRef(null);
  const apiRef = useRef(null);
  // An address to reload into at the next quiet moment (in the background, nothing playing).
  const pending = useRef(null);
  // This page load can move to the other address without a reload (it said 'caps').
  const canMove = useRef(false);
  const moveWait = useRef(null); // { base, timer } until the page says 'moved'
  const [editing, setEditing] = useState(false);
  // Is the page playing? (its 'session' message). null until it says.
  const playing = useRef(null);
  const appState = useRef(AppState.currentState);
  const net = useRef(null);
  // The sign-in the page last had, on whichever address: { main, session }.
  const signin = useRef(null);
  // The key for checking the home address, and the server's internet addresses.
  const auth = useRef(null);
  const homeNets = useRef(new Set());
  // Origin + token already handed over this run, so a failing hand-over never loops.
  const handed = useRef(new Set());
  const httpFailed = useRef(false);

  const store = (k, v) => { AsyncStorage.setItem(k, JSON.stringify(v)).catch(() => {}); };
  const inject = (js) => web.current?.injectJavaScript(`${js}; true;`);
  const showError = (e) => { errorRef.current = e; setError(e); setTrying(false); };
  const signedIn = () => !!tokenOf(signin.current?.session);

  // A retry keeps the can't-reach screen up until the page really loads
  // (onLoad), so it never flashes between attempts.
  const load = useCallback((url) => {
    pending.current = null; canMove.current = false; apiRef.current = url;
    clearTimeout(moveWait.current?.timer); moveWait.current = null;
    if (url === pageRef.current && web.current) web.current.reload();
    else { pageRef.current = url; setPage(url); }
  }, []);

  // The home address, if this network can reach it and it proves it is your
  // server. Remembers the networks it worked on, to wait for it a little
  // longer there at the next launch.
  const homeVerified = useCallback(async () => {
    const s = serversRef.current; const st = net.current; const a = auth.current;
    if (!s?.home || !homeTryable(s.home, st) || !a || a.main !== s.main) return false;
    const k = netKey(st);
    const ok = await provesItself(s.home, a, k && homeNets.current.has(k) ? 1500 : 700);
    if (ok && k && !homeNets.current.has(k)) { homeNets.current.add(k); store(NETS_KEY, [...homeNets.current].slice(-20)); }
    return ok;
  }, []);

  // The next quiet moment: app in the background, nothing playing.
  const quiet = useCallback(() => {
    if (pending.current && appState.current !== 'active' && playing.current === false) load(pending.current);
  }, [load]);

  // Move the running page's API (and the song, if its address is gone) to the other address.
  const move = useCallback((target, lost) => {
    clearTimeout(moveWait.current?.timer);
    const timer = setTimeout(() => {
      if (moveWait.current?.base !== target) return;
      moveWait.current = null;
      // The page did not answer: reload there now if the old address is gone, else later.
      if (lost) load(target); else { pending.current = target; quiet(); }
    }, 2500);
    moveWait.current = { base: target, timer };
    inject(`window.dispatchEvent(new CustomEvent('slopify:server', { detail: ${JSON.stringify({ base: target, lost })} }))`);
  }, [load, quiet]);

  // Where should the app be now? One check at a time; a reason arriving
  // meanwhile runs it again afterwards.
  const busy = useRef(false); const again = useRef(null);
  const evaluate = useCallback(async (why) => {
    if (busy.current) { again.current = why; return; }
    busy.current = true;
    try {
      const s = serversRef.current;
      if (!s?.main || !pageRef.current) return;
      if (net.current?.isConnected === false) { if (errorRef.current) showError({ ...errorRef.current, offline: true }); return; }
      const target = (await homeVerified()) ? s.home : s.main;
      // The page could not load: another address now, or the same again when
      // asked (a retry, the network back).
      if (errorRef.current) { if (target !== pageRef.current || why !== 'error') load(target); return; }
      const api = apiRef.current;
      if (target === api) { pending.current = target === pageRef.current ? null : target; quiet(); return; }
      const lost = api === s.home && target === s.main;
      if (canMove.current && signedIn() && canMoveLive(pageRef.current, target)) { move(target, lost); return; }
      if (lost) { load(target); return; }
      pending.current = target; quiet();
    } finally {
      busy.current = false;
      if (again.current) { const w = again.current; again.current = null; evaluate(w); }
    }
  }, [homeVerified, load, move, quiet]);

  const keepSignin = (session) => {
    signin.current = session ? { main: serversRef.current?.main, session } : null;
    store(SIGNIN_KEY, signin.current);
  };
  const keepServers = (next) => { serversRef.current = next; setServers(next); store(SERVERS_KEY, next); };

  // Signed in: ask the server for the key, its home address and its internet
  // addresses (every few hours, they rarely change).
  const learn = useCallback(async (force) => {
    const s = serversRef.current; const session = signin.current?.session;
    const tok = tokenOf(session); const userId = sessionField(session, 'userId');
    if (!s?.main || !tok || !userId) return;
    const a = auth.current;
    if (!force && a && a.main === s.main && a.userId === userId && Date.now() - (a.at || 0) < 6 * 3600e3) return;
    const r = await askAddresses(apiRef.current || s.main, tok);
    if (!r?.key) return;
    auth.current = { main: s.main, userId, key: r.key, at: Date.now(), public: Array.isArray(r.public) ? r.public.filter((u) => cleanAddress(u)) : [] };
    store(AUTH_KEY, auth.current);
    const cur = serversRef.current;
    const lan = cleanAddress(r.lan || '');
    if (lan && cur && !cur.homeOff && (!cur.home || cur.homeAuto) && originOf(lan) !== originOf(cur.main) && lan !== cur.home) keepServers({ ...cur, home: lan, homeAuto: true });
    evaluate('learned');
  }, [evaluate]);

  useEffect(() => {
    (async () => {
      let r = [];
      try { r = await AsyncStorage.multiGet([SERVERS_KEY, SIGNIN_KEY, AUTH_KEY, NETS_KEY]); } catch { /* nothing saved */ }
      const got = (i) => { try { return r[i]?.[1] ? JSON.parse(r[i][1]) : null; } catch { return null; } };
      let saved = got(0); const si = got(1); const au = got(2); const nets = got(3);
      homeNets.current = new Set(Array.isArray(nets) ? nets : []);
      try { net.current = await NetInfo.fetch(); } catch { /* unknown network */ }
      // A self-built app with an address in it opens it straight away;
      // release builds have none and ask.
      if (!saved?.main && cleanAddress(BUILT_URL)) saved = { main: cleanAddress(BUILT_URL), home: '' };
      if (!saved?.main) { serversRef.current = false; setServers(false); setEditing(true); return; }
      keepServers(saved);
      if (si?.main === saved.main && si.session) signin.current = si;
      if (au?.main === saved.main) auth.current = au;
      load((await homeVerified()) ? saved.home : saved.main);
      learn();
    })();
  }, [homeVerified, learn, load]);

  // The network changed (Wi-Fi joined or left, cellular, offline and back):
  // check right away, no waiting for it to settle; the next change checks again.
  useEffect(() => {
    let last = null;
    return NetInfo.addEventListener((st) => {
      net.current = st;
      const k = `${st.isConnected}|${netKey(st)}`;
      if (k === last) return;
      last = k;
      evaluate('network');
    });
  }, [evaluate]);

  // The server could not be reached: try again by itself, sooner at first.
  useEffect(() => {
    if (!error) return undefined;
    let wait = 5000; let timer = null;
    const tick = () => { evaluate('retry'); wait = Math.min(wait * 2, 60000); timer = setTimeout(tick, wait); };
    timer = setTimeout(tick, wait);
    return () => clearTimeout(timer);
  }, [error, evaluate]);

  const saveServers = async (next) => {
    const prev = serversRef.current;
    // Another server: the sign-in and key kept for the old one are no good there.
    const same = prev && [prev.main, prev.home].filter(Boolean).map(originOf).some((o) => o === originOf(next.main) || (next.home && o === originOf(next.home)));
    if (!same) { keepSignin(null); auth.current = null; store(AUTH_KEY, null); handed.current.clear(); }
    else if (auth.current && auth.current.main !== next.main) { auth.current = { ...auth.current, main: next.main }; store(AUTH_KEY, auth.current); }
    if (signin.current) signin.current = { ...signin.current, main: next.main };
    keepServers(next);
    setEditing(false);
    load((await homeVerified()) ? next.home : next.main);
  };

  // Android's back button closes the server screen when there is a page behind it.
  useEffect(() => {
    if (!editing || !servers) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setEditing(false); return true; });
    return () => sub.remove();
  }, [editing, servers]);

  // The shell shows your server and nothing else: any other page (a link to
  // the source code, a song's page elsewhere) opens in the phone's browser,
  // so no other site ever runs where the bridge and the sign-in are.
  const stayIn = (req) => {
    const u = req.url || '';
    if (u.startsWith('about:') || u.startsWith('blob:') || u.startsWith('data:')) return true;
    const s = serversRef.current;
    const o = originOf(u);
    if (o && s && (o === originOf(s.main) || (s.home && o === originOf(s.home)))) return true;
    if (/^https?:/i.test(u) && req.isTopFrame !== false) Linking.openURL(u).catch(() => {});
    return false;
  };
  // What the page last told us: is the sound elsewhere?
  const remote = useRef(false);
  // The phone's own level while the sound is elsewhere; presses are measured
  // against it and it is restored after each one.
  const base = useRef(null);
  // The level we just put back: its change event is our own, not a press.
  // Recognised by value, not by a quiet period after each press, so presses
  // in quick succession all count.
  const echo = useRef(null);
  const echoAt = useRef(0);
  // Shown in the page's diag report: what the shell heard and dropped.
  const note = (msg) => web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('slopify:shellnote', { detail: { msg: ${JSON.stringify(msg)} } })); true;`);
  const putBack = (level) => {
    echo.current = level; echoAt.current = Date.now();
    // Android sets the level as (int)(value * steps): a value read back from
    // a step (2/15 = 0.1333...) can land one step lower. A hair more lands
    // on the step itself, whatever the phone's number of steps.
    VolumeManager.setVolume(Platform.OS === 'android' ? Math.min(1, level + 0.01) : level, { showUI: false }).catch(() => {});
  };

  useEffect(() => {
    let sub = null;
    (async () => {
      try { const v = await VolumeManager.getVolume(); base.current = typeof v === 'number' ? v : v?.volume ?? null; } catch { /* no audio yet */ }
      musicSession();
      sub = VolumeManager.addVolumeListener((ev) => {
        const vol = typeof ev === 'number' ? ev : ev?.volume;
        if (typeof vol !== 'number') return;
        const reason = typeof ev === 'object' ? ev?.reason || '' : '';
        // Android reports every stream (ring, alarms, calls): only music's
        // level is the one the buttons move while music plays.
        if (Platform.OS === 'android' && typeof ev === 'object' && ev?.type && ev.type !== 'music') return;
        // Our own put-back. iOS rounds the level to its own steps (1/16), so
        // the echo can come back a little off the value we set: matched
        // within a third of a press (Android's steps are smaller, 1/25 on
        // some phones, so no wider than that). Android does not always report
        // a level the app set itself: an echo not heard within a second and a
        // half is not waited for, or it swallowed the next real press.
        if (echo.current != null && Date.now() - echoAt.current > 1500) echo.current = null;
        if (echo.current != null && Math.abs(vol - echo.current) < 0.02) { echo.current = null; return; }
        if (!remote.current || base.current == null) { base.current = vol; return; }
        // Only a button press counts. iOS also reports volume changes when
        // the audio route or category switches (the silent stand-in starting
        // or stopping), with another reason: those were taken for presses,
        // 4 at a time, and stepped a speaker group from 18 to 83 unasked.
        if (reason && reason !== 'ExplicitVolumeChange') { note(`ignored ${reason} ${vol.toFixed(3)} (base ${base.current.toFixed(3)})`); return; }
        const step = vol > base.current + 0.02 ? 1 : vol < base.current - 0.02 ? -1 : 0;
        if (!step) return;
        web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('conduit:volumestep', { detail: { step: ${step}, reason: ${JSON.stringify(reason || 'kvo')} } })); true;`);
        // Put the phone's own level back, quietly, so the next press measures from the same place.
        putBack(base.current);
      });
      // The listener sets Ambient as it starts observing: put Playback back after it.
      setTimeout(musicSession, 300);
    })();
    const appSub = AppState.addEventListener('change', (s) => {
      appState.current = s;
      // The page holds lock-screen play/pause for other devices briefly and
      // drops it when the app is leaving (iOS pauses that session on close).
      web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('slopify:appstate', { detail: { state: ${JSON.stringify(s)} } })); true;`);
      // Back from somewhere: maybe left home, or got back. Going away: a
      // switch that waited for a quiet moment can happen now.
      if (s === 'active') { evaluate('foreground'); learn(); } else quiet();
    });
    // Lock screen, notification and headset buttons, to the page's handlers.
    const media = SlopifyMedia?.addListener?.('onAction', (e) => {
      web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('slopify:mediaaction', { detail: ${JSON.stringify({ action: e?.action, seekTime: e?.seekTime ?? null })} })); true;`);
    });
    return () => { try { sub?.remove(); } catch { /* gone */ } try { media?.remove(); } catch { /* gone */ } appSub.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const share = (msg) => {
    const done = (ok) => inject(`(function () { var w = window.__slopifyShare || {}, s = w[${JSON.stringify(msg.id)}]; if (!s) return; delete w[${JSON.stringify(msg.id)}]; ${ok ? 's.res()' : "s.rej(new DOMException('Share dismissed', 'AbortError'))"}; })()`);
    const what = Platform.OS === 'ios'
      ? { url: msg.url || undefined, message: msg.url ? (msg.title || msg.text || undefined) : (msg.text || msg.title) }
      : { title: msg.title || undefined, message: [msg.title || msg.text, msg.url].filter(Boolean).join('\n') };
    Share.share(what, { dialogTitle: msg.title || undefined }).then((r) => done(r?.action !== Share.dismissedAction)).catch(() => done(false));
  };

  const onMessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (msg?.type === 'mediasession' && SlopifyMedia) {
      try { if (msg.state === 'none') SlopifyMedia.stop(); else SlopifyMedia.update(msg); } catch { /* module gone */ }
      return;
    }
    if (msg?.type === 'servers') { setEditing(true); return; }
    if (msg?.type === 'share') { share(msg); return; }
    // A page (re)loaded and can be moved: where should it be? (a reload puts it back on its own address)
    if (msg?.type === 'caps') { canMove.current = !!msg.move; evaluate('page'); return; }
    if (msg?.type === 'moved') {
      if (moveWait.current?.base !== msg.base) return;
      clearTimeout(moveWait.current.timer); moveWait.current = null;
      apiRef.current = msg.base;
      // The page itself still comes from the old address: line it up at the next quiet moment.
      pending.current = msg.base === pageRef.current ? null : msg.base;
      quiet();
      return;
    }
    if (msg?.type === 'signin') {
      const mine = signin.current?.session || null;
      const myTok = tokenOf(mine); const pageTok = tokenOf(msg.session);
      if (msg.start) {
        // A page (re)loaded: it talks to its own address until it is moved.
        apiRef.current = pageRef.current; canMove.current = false;
        // This address has no sign-in, or an older one: give it the one the
        // other address has (same server, same account) and start it again.
        if (myTok && pageTok !== myTok && msg.origin && msg.origin === originOf(pageRef.current)) {
          const key = `${msg.origin} ${myTok}`;
          if (!handed.current.has(key)) {
            handed.current.add(key);
            let s = null; try { s = { ...JSON.parse(mine), baseUrl: msg.origin }; } catch { /* unreadable copy */ }
            if (s) { inject(`try { localStorage.setItem('slopify.session', ${JSON.stringify(JSON.stringify(s))}); location.reload(); } catch (e) {}`); return; }
          }
        }
        if (pageTok && pageTok !== myTok) { keepSignin(msg.session); learn(true); }
        return;
      }
      if (msg.session) { const fresh = tokenOf(msg.session) !== myTok; keepSignin(msg.session); if (fresh) learn(true); }
      // Signed out, or a dead sign-in cleared: forget it only if it is the one kept.
      else if (myTok && tokenOf(msg.was) === myTok) keepSignin(null);
      return;
    }
    if (msg?.type === 'session') {
      if (typeof msg.playing === 'boolean') { playing.current = msg.playing; if (!msg.playing) quiet(); }
      const was = remote.current; remote.current = !!msg.remote;
      if (remote.current && !was) {
        // A press at the top or bottom of the range produces no change to
        // measure, so park the phone's own level away from the ends.
        VolumeManager.getVolume().then((v) => {
          let b = typeof v === 'number' ? v : v?.volume;
          if (typeof b !== 'number') return;
          // On one of iOS's own steps (sixteenths), so a put-back reads back
          // exactly. Android's steps vary by phone: its level stays as it is.
          const q = Platform.OS === 'ios' ? Math.round(b * 16) / 16 : b;
          if (b > 0.95 || b < 0.05) b = b > 0.95 ? 0.8125 : 0.1875; else b = q;
          if (Math.abs(b - (typeof v === 'number' ? v : v?.volume)) > 0.001) putBack(b);
          base.current = b;
        }).catch(() => {});
      }
      // The phone's own volume bar would show presses that are not changing
      // its sound: hide it while the buttons drive another device.
      if (remote.current !== was && Platform.OS === 'ios') VolumeManager.showNativeVolumeUI({ enabled: !remote.current }).catch(() => {});
    }
  };

  // A load failed: the other address may answer (left home with the home
  // address open, or the main one is down at home). Else the screen that
  // says so and keeps trying by itself.
  const failed = () => {
    showError({ offline: net.current?.isConnected === false, host: hostLabel(pageRef.current) });
    evaluate('error');
  };

  const shell = useMemo(() => shellScript(servers ? servers.main : null), [servers]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      {editing && servers !== null ? (
        <ServerForm initial={servers || { main: BUILT_URL, home: '' }} hint={auth.current?.public?.[0] || null}
          onSave={saveServers} onCancel={servers ? () => setEditing(false) : null} />
      ) : null}
      {servers === null || (!page && !editing) ? <View style={styles.err}><ActivityIndicator color="#b3b3b3" /></View> : null}
      {error ? (
        <View style={styles.err}>
          <Text style={styles.errTitle}>{error.offline ? 'You are offline' : 'Can’t reach your server'}</Text>
          <Text style={styles.errText}>{error.offline ? 'Slopify opens again by itself when you are back online.' : `${error.host} is not answering. Slopify keeps trying.`}</Text>
          <TouchableOpacity style={[styles.btn, styles.btnWide]} disabled={trying} onPress={() => { setTrying(true); evaluate('retry'); setTimeout(() => setTrying(false), 8000); }}>
            {trying ? <ActivityIndicator color="#000" /> : <Text style={styles.btnText}>Try again</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.link} onPress={() => setEditing(true)}><Text style={styles.linkText}>Server address</Text></TouchableOpacity>
        </View>
      ) : null}
      {page ? (
      <WebView
        ref={web}
        source={{ uri: page }}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={stayIn}
        style={styles.web}
        // Tell the page it is the phone app, and which phone, before its scripts run.
        injectedJavaScriptBeforeContentLoaded={shell}
        // Safari's Web Inspector can attach (Develop menu) to debug the page.
        webviewDebuggingEnabled
        onMessage={onMessage}
        // Audio keeps playing with the screen off; inline (no forced fullscreen video UI).
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        // The page runs its own edge-swipe-back (a navigation stack of its own);
        // the WebView's history gesture would swallow it and go nowhere.
        allowsBackForwardNavigationGestures={false}
        // The web app decides the layout; tell it it is inside the shell.
        applicationNameForUserAgent="SlopifyMobile/0.1"
        // Full-bleed under the notch and home indicator; the page pads with env(safe-area-inset-*).
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        // Never leave the app for our own links; open anything else in the browser.
        setSupportMultipleWindows={false}
        pullToRefreshEnabled={Platform.OS === 'android'}
        onLoadStart={() => { httpFailed.current = false; }}
        onLoad={() => { if (!httpFailed.current) showError(null); }}
        onError={failed}
        onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500 && e.nativeEvent.isTopFrame !== false) { httpFailed.current = true; failed(); } }}
        // Never the WebView's own (white) error page: the can't-reach screen covers it.
        renderError={() => <View style={styles.web} />}
        backgroundColor="#000"
        overScrollMode="never"
        bounces={false}
      />
      ) : null}
    </View>
  );
}

// The server screen: first launch, Settings > Server address in the page,
// or the can't-reach screen. Saved once an address answers as a Slopify server.
function ServerForm({ initial, hint, onSave, onCancel }) {
  const [main, setMain] = useState(initial.main || '');
  const [home, setHome] = useState(initial.home || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Found by the app (from the server) rather than typed: shown, and kept up to date unless changed here.
  const auto = !!initial.homeAuto && home === initial.home;
  // Set up on the home address only: the server knows its internet address.
  const away = hint && !String(main).startsWith('https:') && cleanAddress(hint) !== cleanAddress(main) ? cleanAddress(hint) : null;
  const useAway = () => { if (!home.trim()) setHome(main); setMain(away); };
  const submit = async () => {
    const m = cleanAddress(main); const h = cleanAddress(home);
    if (!m) { setErr(m === null ? 'That server address doesn’t look right. Try something like music.example.com.' : 'Enter the address of your Slopify server.'); return; }
    if (h === null) { setErr('That home address doesn’t look right. Try something like 192.168.1.10:8080.'); return; }
    setBusy(true); setErr(null);
    const typedHome = h && h !== initial.home;
    const [mOk, hOk] = await Promise.all([answers(m, 6000), typedHome ? answers(h, 3000) : Promise.resolve(false)]);
    setBusy(false);
    // Either one is enough: set up at home, the main address may only
    // answer from outside (and the other way round).
    if (!mOk && !hOk) { setErr(`No Slopify server answered at ${hostLabel(m)}. Check the address, and that the phone can reach it.`); return; }
    const homeOut = h && h !== m ? h : '';
    onSave({ main: m, home: homeOut, homeAuto: !!homeOut && homeOut === initial.home && !!initial.homeAuto, homeOff: !homeOut && !!initial.home });
  };
  return (
    <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.formBody} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Your Slopify server</Text>
        <Text style={styles.label}>Server address</Text>
        <TextInput style={styles.input} value={main} onChangeText={setMain} placeholder="music.example.com" placeholderTextColor="#6a6a6a"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={submit} editable={!busy} autoFocus={!initial.main} />
        {away ? (
          <TouchableOpacity onPress={useAway} disabled={busy}><Text style={styles.suggest}>Away from home your server is at {hostLabel(away)}. <Text style={styles.suggestLink}>Use it</Text></Text></TouchableOpacity>
        ) : null}
        <Text style={styles.label}>Home network address</Text>
        <TextInput style={styles.input} value={home} onChangeText={setHome} placeholder="Filled in for you after you sign in" placeholderTextColor="#6a6a6a"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={submit} editable={!busy} />
        <Text style={styles.hint}>{auto ? 'Found by the app. ' : ''}At home, Slopify streams straight over your Wi-Fi from this address, and switches by itself when you leave. Leave it empty to always use the server address.</Text>
        {err ? <Text style={styles.formErr}>{err}</Text> : null}
        <View style={styles.row}>
          {onCancel ? <TouchableOpacity style={styles.link} onPress={onCancel} disabled={busy}><Text style={styles.linkText}>Cancel</Text></TouchableOpacity> : null}
          <TouchableOpacity style={[styles.btn, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
            {busy ? <ActivityIndicator color="#000" /> : <Text style={styles.btnText}>Connect</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  err: { position: 'absolute', zIndex: 2, top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', gap: 16 },
  errTitle: { color: '#fff', textAlign: 'center', fontSize: 20, fontWeight: '700', paddingHorizontal: 32 },
  errText: { color: '#b3b3b3', textAlign: 'center', fontSize: 15, lineHeight: 21, paddingHorizontal: 32, marginBottom: 8 },
  btn: { backgroundColor: '#1ed760', paddingHorizontal: 22, paddingVertical: 10, borderRadius: 500 },
  btnText: { color: '#000', fontWeight: '700' },
  btnWide: { minWidth: 140, alignItems: 'center' },
  link: { paddingHorizontal: 16, paddingVertical: 10 },
  linkText: { color: '#b3b3b3', fontWeight: '600' },
  form: { position: 'absolute', zIndex: 3, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  formBody: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 64, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 24 },
  label: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  input: { color: '#fff', backgroundColor: '#1f1f1f', borderRadius: 6, borderWidth: 1, borderColor: '#3e3e3e', paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, marginBottom: 20 },
  hint: { color: '#b3b3b3', fontSize: 13, lineHeight: 18, marginBottom: 20 },
  suggest: { color: '#b3b3b3', fontSize: 13, lineHeight: 18, marginTop: -8, marginBottom: 20 },
  suggestLink: { color: '#1ed760', fontWeight: '700' },
  formErr: { color: '#f3727f', fontSize: 14, marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
});
