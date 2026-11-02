// Slopify on the phone: your Slopify server's web app inside a native
// WebView. The web app's mobile layout (bottom tabs, compact player) does the
// rest; this shell supplies media playback permissions, a retry screen, the
// server address, and the one thing a web page cannot have: the hardware
// volume buttons. While
// the sound is on another device (the page says so over the bridge) a press
// becomes a volume step for that device and the phone's own level is put
// back, so it never drifts; while the phone itself plays, the buttons do
// what they always do. It draws full-bleed and the page pads for the notch /
// home indicator (viewport-fit=cover).
//
// The server address is asked for on first launch (pre-filled with the one
// the build was made with, EXPO_PUBLIC_SLOPIFY_URL, if any) and kept on the
// phone; Settings > Server address in the page, or the retry screen, open it
// again. An optional home address is used whenever it answers (/api/healthz),
// so music streams straight over Wi-Fi at home; anywhere else the main one is.
// The two are different origins, each with its own localStorage, so the
// shell keeps a copy of the sign-in and hands it over: you sign in once.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { VolumeManager } from 'react-native-volume-manager';
import SlopifyMedia from './modules/slopify-media';
import { cleanAddress, originOf } from './address';

// An address a self-built app can suggest on first launch. Release builds
// leave it empty: the public app never carries anyone's server.
const BUILT_URL = process.env.EXPO_PUBLIC_SLOPIFY_URL || '';
const SERVERS_KEY = 'slopify.servers'; // { main, home }
const SIGNIN_KEY = 'slopify.shellSession'; // { main, session }: the page's sign-in, for the other address

// Does a Slopify server answer here? /api/healthz is public and says { ok: true }.
const probe = async (base, ms) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${base}/api/healthz`, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch { return false; } finally { clearTimeout(timer); }
};
// The home address when it answers quickly, else the main one.
const choose = async (servers) => (servers.home && await probe(servers.home, 1500) ? servers.home : servers.main);

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
const tokenOf = (raw) => { try { return (typeof raw === 'string' ? JSON.parse(raw) : raw)?.token || null; } catch { return null; } };

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
// servers: the page may offer Settings > Server address (it posts { type: 'servers' }).
const SHELL = `window.slopifyShell = ${JSON.stringify({ deviceName: DEVICE_NAME, deviceForm: DEVICE_FORM, platform: Platform.OS, version: process.env.EXPO_PUBLIC_SLOPIFY_SHELL || 'dev', servers: true })};${SIGNIN_BRIDGE}${Platform.OS === 'android' && SlopifyMedia ? MEDIA_SESSION : ''} true;`;

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
  const [error, setError] = useState(null);
  // { main, home } once known; false = none saved yet (first launch).
  const [servers, setServers] = useState(null);
  const serversRef = useRef(null);
  // The address the WebView has open (servers.main or servers.home).
  const [active, setActive] = useState(null);
  const activeRef = useRef(null);
  const [editing, setEditing] = useState(false);
  // Is the page playing? (its 'session' message). null until it says:
  // switching addresses reloads the page, so never mid-song.
  const playing = useRef(null);
  // The sign-in the page last had, on whichever address: { main, session }.
  const signin = useRef(null);
  // Origin + token already handed over this run, so a failing hand-over never loops.
  const handed = useRef(new Set());

  const open = useCallback((url) => { activeRef.current = url; setActive(url); setError(null); }, []);
  const keepSignin = (session) => {
    signin.current = session ? { main: serversRef.current?.main, session } : null;
    AsyncStorage.setItem(SIGNIN_KEY, JSON.stringify(signin.current)).catch(() => {});
  };

  useEffect(() => {
    (async () => {
      let saved = null; let si = null;
      try {
        const [[, a], [, b]] = await AsyncStorage.multiGet([SERVERS_KEY, SIGNIN_KEY]);
        saved = a ? JSON.parse(a) : null; si = b ? JSON.parse(b) : null;
      } catch { /* nothing saved */ }
      if (!saved?.main) { serversRef.current = false; setServers(false); setEditing(true); return; }
      serversRef.current = saved; setServers(saved);
      if (si?.main === saved.main && si.session) signin.current = si;
      open(await choose(saved));
    })();
  }, [open]);

  // At home or away? Checked when the app comes forward and when a load
  // fails. Home stops answering: the main address. Home answers again: back
  // to it, but only while nothing plays (it reloads the page).
  const recheck = useCallback(async (why) => {
    const s = serversRef.current;
    if (!s?.home || !activeRef.current) return false;
    const cur = activeRef.current;
    const homeUp = await probe(s.home, 1500);
    let next = cur;
    if (cur === s.home && !homeUp) next = s.main;
    else if (cur !== s.home && homeUp && (why === 'error' || playing.current === false)) next = s.home;
    if (next === cur) return false;
    open(next);
    return true;
  }, [open]);

  const saveServers = async (next) => {
    const prev = serversRef.current;
    // Another server: the sign-in kept for the old one is no good there.
    if (!prev || prev.main !== next.main) keepSignin(null);
    serversRef.current = next; setServers(next);
    AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(next)).catch(() => {});
    setEditing(false);
    const url = await choose(next);
    if (url === activeRef.current) { setError(null); web.current?.reload(); } else open(url);
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
    const appState = AppState.addEventListener('change', (s) => {
      // The page holds lock-screen play/pause for other devices briefly and
      // drops it when the app is leaving (iOS pauses that session on close).
      web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('slopify:appstate', { detail: { state: ${JSON.stringify(s)} } })); true;`);
      // Back from somewhere: maybe left home, or got back.
      if (s === 'active') recheck('foreground');
    });
    // Lock screen, notification and headset buttons, to the page's handlers.
    const media = SlopifyMedia?.addListener?.('onAction', (e) => {
      web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('slopify:mediaaction', { detail: ${JSON.stringify({ action: e?.action, seekTime: e?.seekTime ?? null })} })); true;`);
    });
    return () => { try { sub?.remove(); } catch { /* gone */ } try { media?.remove(); } catch { /* gone */ } appState.remove(); };
  }, []);

  const onMessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (msg?.type === 'mediasession' && SlopifyMedia) {
      try { if (msg.state === 'none') SlopifyMedia.stop(); else SlopifyMedia.update(msg); } catch { /* module gone */ }
      return;
    }
    if (msg?.type === 'servers') { setEditing(true); return; }
    if (msg?.type === 'signin') {
      const mine = signin.current?.session || null;
      const myTok = tokenOf(mine); const pageTok = tokenOf(msg.session);
      if (msg.start) {
        // This address has no sign-in, or an older one: give it the one the
        // other address has (same server, same account) and start it again.
        if (myTok && pageTok !== myTok && msg.origin) {
          const key = `${msg.origin} ${myTok}`;
          if (!handed.current.has(key)) {
            handed.current.add(key);
            let s = null; try { s = { ...JSON.parse(mine), baseUrl: msg.origin }; } catch { /* unreadable copy */ }
            if (s) {
              web.current?.injectJavaScript(`try { localStorage.setItem('slopify.session', ${JSON.stringify(JSON.stringify(s))}); location.reload(); } catch (e) {} true;`);
              return;
            }
          }
        }
        if (pageTok && !myTok) keepSignin(msg.session);
        return;
      }
      if (msg.session) keepSignin(msg.session);
      // Signed out, or a dead sign-in cleared: forget it only if it is the one kept.
      else if (myTok && tokenOf(msg.was) === myTok) keepSignin(null);
      return;
    }
    if (msg?.type === 'session') {
      if (typeof msg.playing === 'boolean') playing.current = msg.playing;
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
  // address open, or the main one is down at home). Else the retry screen.
  const failed = (why) => { recheck('error').then((switched) => { if (!switched) setError(why); }); };

  return (
    <View style={styles.root}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      {editing && servers !== null ? (
        <ServerForm initial={servers || { main: BUILT_URL, home: '' }} onSave={saveServers} onCancel={servers ? () => setEditing(false) : null} />
      ) : null}
      {servers === null || (!active && !editing) ? <View style={styles.err}><ActivityIndicator color="#b3b3b3" /></View> : null}
      {error ? (
        <View style={styles.err}>
          <Text style={styles.errText}>Slopify could not load{'\n'}{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => { setError(null); web.current?.reload(); }}><Text style={styles.btnText}>Retry</Text></TouchableOpacity>
          <TouchableOpacity style={styles.link} onPress={() => setEditing(true)}><Text style={styles.linkText}>Server address</Text></TouchableOpacity>
        </View>
      ) : null}
      {active ? (
      <WebView
        ref={web}
        source={{ uri: active }}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={stayIn}
        style={styles.web}
        // Tell the page it is the phone app, and which phone, before its scripts run.
        injectedJavaScriptBeforeContentLoaded={SHELL}
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
        onError={(e) => failed(e.nativeEvent.description || 'network error')}
        onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500 && e.nativeEvent.isTopFrame !== false) failed(`HTTP ${e.nativeEvent.statusCode}`); }}
        backgroundColor="#000"
        overScrollMode="never"
        bounces={false}
      />
      ) : null}
    </View>
  );
}

// The server screen: first launch, Settings > Server address in the page,
// or the retry screen. Saved once an address answers as a Slopify server.
function ServerForm({ initial, onSave, onCancel }) {
  const [main, setMain] = useState(initial.main || '');
  const [home, setHome] = useState(initial.home || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async () => {
    const m = cleanAddress(main); const h = cleanAddress(home);
    if (!m) { setErr(m === null ? 'The server address is not a web address.' : 'Enter the address of your Slopify server.'); return; }
    if (h === null) { setErr('The home address is not a web address.'); return; }
    setBusy(true); setErr(null);
    const [mOk, hOk] = await Promise.all([probe(m, 6000), h ? probe(h, 3000) : Promise.resolve(false)]);
    setBusy(false);
    // Either one is enough: set up at home, the main address may only
    // answer from outside (and the other way round).
    if (!mOk && !hOk) { setErr(`No Slopify server answered at ${m}${h ? ` or ${h}` : ''}.`); return; }
    onSave({ main: m, home: h && h !== m ? h : '' });
  };
  return (
    <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.formBody} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Your Slopify server</Text>
        <Text style={styles.label}>Server address</Text>
        <TextInput style={styles.input} value={main} onChangeText={setMain} placeholder="https://music.example.com" placeholderTextColor="#6a6a6a"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={submit} editable={!busy} />
        <Text style={styles.label}>Home network address (optional)</Text>
        <TextInput style={styles.input} value={home} onChangeText={setHome} placeholder="http://192.168.1.10:8080" placeholderTextColor="#6a6a6a"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={submit} editable={!busy} />
        <Text style={styles.hint}>When the home address answers, the app uses it, so music comes straight over your Wi-Fi. Anywhere else it uses the server address. You sign in once for both.</Text>
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
  errText: { color: '#b3b3b3', textAlign: 'center', fontSize: 15 },
  btn: { backgroundColor: '#1ed760', paddingHorizontal: 22, paddingVertical: 10, borderRadius: 500 },
  btnText: { color: '#000', fontWeight: '700' },
  link: { paddingHorizontal: 16, paddingVertical: 10 },
  linkText: { color: '#b3b3b3', fontWeight: '600' },
  form: { position: 'absolute', zIndex: 3, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  formBody: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 64, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 24 },
  label: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  input: { color: '#fff', backgroundColor: '#1f1f1f', borderRadius: 6, borderWidth: 1, borderColor: '#3e3e3e', paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, marginBottom: 20 },
  hint: { color: '#b3b3b3', fontSize: 13, lineHeight: 18, marginBottom: 20 },
  formErr: { color: '#f3727f', fontSize: 14, marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
});
