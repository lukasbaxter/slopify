// Slopify on the phone: the web build (music.baxtergroup.io) inside a native
// WebView. The web app's mobile layout (bottom tabs, compact player) does the
// rest; this shell supplies media playback permissions, a retry screen, and
// the one thing a web page cannot have: the hardware volume buttons. While
// the sound is on another device (the page says so over the bridge) a press
// becomes a volume step for that device and the phone's own level is put
// back, so it never drifts; while the phone itself plays, the buttons do
// what they always do. It draws full-bleed and the page pads for the notch /
// home indicator (viewport-fit=cover). It also keeps songs on the phone for
// when there is no connection (offline.js): the page asks for a playlist to
// be saved, and when the site cannot load (or on request) the WebView shows
// the offline player instead.
import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Device from 'expo-device';
import { WebView } from 'react-native-webview';
import { VolumeManager } from 'react-native-volume-manager';
import { DIR, PAGE_URI, createDownloader, deleteFiles, hasSongs, loadLib, pageData, remove, saveLib, summary } from './offline';

const URL = process.env.EXPO_PUBLIC_SLOPIFY_URL || 'https://music.baxtergroup.io/';

// What the page shows other devices this phone as: its model ("iPhone 16",
// "Pixel 8"). Android also knows the name the owner gave it; iOS keeps that
// behind an entitlement, so the model it is.
const DEVICE_NAME = (Platform.OS === 'android' && Device.deviceName) || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone');
const DEVICE_FORM = Device.deviceType === Device.DeviceType.TABLET ? 'tablet' : 'phone';
const SHELL = `window.slopifyShell = ${JSON.stringify({ deviceName: DEVICE_NAME, deviceForm: DEVICE_FORM, platform: Platform.OS, offline: 1, version: process.env.EXPO_PUBLIC_SLOPIFY_SHELL || 'dev' })}; true;`;

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
  // 'online' = the site; 'offline' = the offline player over the saved songs.
  const [mode, setMode] = useState('online');
  const [offlineNote, setOfflineNote] = useState(null);
  const [offlineKey, setOfflineKey] = useState(0);
  const lib = useRef(null);
  const downloader = useRef(null);
  const modeRef = useRef('online'); modeRef.current = mode;
  // The saved songs as the site shows them: per playlist, how many are here,
  // the download in progress, and plays made offline still to report.
  const tellPage = (extra = {}) => {
    if (modeRef.current !== 'online' || !lib.current) return;
    const detail = { ...summary(lib.current), active: downloader.current?.state.active || null, plays: lib.current.plays, ...extra };
    web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('slopify:offline', { detail: ${JSON.stringify(detail)} })); true;`);
  };
  const goOffline = (note) => {
    setOfflineNote(note || null); setError(null); setMode('offline'); setOfflineKey((k) => k + 1);
  };
  // The site failed to load: the saved songs if there are any, else the retry screen.
  const failed = (why) => {
    if (modeRef.current !== 'online') return;
    if (lib.current && hasSongs(lib.current)) goOffline(`Could not reach Slopify (${why}). Playing what is on this phone.`);
    else setError(why);
  };
  useEffect(() => {
    loadLib().then((l) => {
      lib.current = l;
      downloader.current = createDownloader(l, (extra) => { saveLib(l); tellPage(extra); });
      tellPage();
    });
  }, []);
  // What the page last told us: is the sound elsewhere?
  const remote = useRef(false);
  // The phone's own level while the sound is elsewhere; presses are measured
  // against it and it is restored after each one.
  const base = useRef(null);
  // The level we just put back: its change event is our own, not a press.
  // Recognised by value, not by a quiet period after each press, so presses
  // in quick succession all count.
  const echo = useRef(null);
  // Shown in the page's diag report: what the shell heard and dropped.
  const note = (msg) => web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('slopify:shellnote', { detail: { msg: ${JSON.stringify(msg)} } })); true;`);
  const putBack = (level) => {
    echo.current = level;
    VolumeManager.setVolume(level, { showUI: false }).catch(() => {});
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
        // Our own put-back. iOS rounds the level to its own steps, so the
        // echo can come back a little off the value we set: matched within
        // a third of a press (one press is 1/16 = 0.0625).
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
    });
    return () => { try { sub?.remove(); } catch { /* gone */ } appState.remove(); };
  }, []);

  const onMessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (msg?.type === 'offline-save' && downloader.current && msg.collection && Array.isArray(msg.tracks)) { downloader.current.add(msg.collection, msg.tracks); return; }
    if (msg?.type === 'offline-list') { tellPage(); return; }
    if (msg?.type === 'offline-remove' && lib.current) {
      downloader.current?.cancel(msg.id);
      const files = remove(lib.current, msg.id);
      saveLib(lib.current).then(() => deleteFiles(files));
      if (modeRef.current === 'offline') setOfflineKey((k) => k + 1); else tellPage();
      return;
    }
    if (msg?.type === 'offline-open') { goOffline(null); return; }
    if (msg?.type === 'online') { setError(null); setMode('online'); return; }
    if (msg?.type === 'offline-play' && lib.current) { lib.current.plays.push({ id: msg.id, at: msg.at }); saveLib(lib.current); return; }
    if (msg?.type === 'offline-plays-sent' && lib.current) {
      lib.current.plays = lib.current.plays.filter((p) => p.at > msg.upTo); saveLib(lib.current); return;
    }
    if (msg?.type === 'session') {
      const was = remote.current; remote.current = !!msg.remote;
      if (remote.current && !was) {
        // A press at the top or bottom of the range produces no change to
        // measure, so park the phone's own level away from the ends.
        VolumeManager.getVolume().then((v) => {
          let b = typeof v === 'number' ? v : v?.volume;
          if (typeof b !== 'number') return;
          // On one of iOS's own steps (sixteenths), so a put-back reads back exactly.
          const q = Math.round(b * 16) / 16;
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

  return (
    <View style={styles.root}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      {error ? (
        <View style={styles.err}>
          <Text style={styles.errText}>Slopify could not load{'\n'}{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => { setError(null); web.current?.reload(); }}><Text style={styles.btnText}>Retry</Text></TouchableOpacity>
          {lib.current && hasSongs(lib.current) ? <TouchableOpacity style={styles.btn} onPress={() => goOffline(null)}><Text style={styles.btnText}>Play downloads</Text></TouchableOpacity> : null}
        </View>
      ) : null}
      <WebView
        ref={web}
        key={mode === 'online' ? 'online' : `offline-${offlineKey}`}
        source={{ uri: mode === 'online' ? URL : PAGE_URI }}
        style={styles.web}
        // Tell the page it is the phone app, and which phone, before its
        // scripts run; the offline player also gets the saved songs.
        injectedJavaScriptBeforeContentLoaded={mode === 'online' || !lib.current ? SHELL : `${SHELL} window.__offline = ${JSON.stringify(pageData(lib.current, offlineNote))}; true;`}
        // The offline player reads the songs next to it (file://).
        allowingReadAccessToURL={mode === 'online' ? undefined : DIR}
        allowFileAccess={mode !== 'online'}
        originWhitelist={['*']}
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
        onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500) failed(`HTTP ${e.nativeEvent.statusCode}`); }}
        backgroundColor="#000"
        overScrollMode="never"
        bounces={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  err: { position: 'absolute', zIndex: 2, top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', gap: 16 },
  errText: { color: '#b3b3b3', textAlign: 'center', fontSize: 15 },
  btn: { backgroundColor: '#1ed760', paddingHorizontal: 22, paddingVertical: 10, borderRadius: 500 },
  btnText: { color: '#000', fontWeight: '700' },
});
