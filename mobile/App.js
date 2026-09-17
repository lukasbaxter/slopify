// Slopify on the phone: the web build (music.baxtergroup.io) inside a native
// WebView. The web app's mobile layout (bottom tabs, compact player) does the
// rest; this shell supplies media playback permissions, a retry screen, and
// the one thing a web page cannot have: the hardware volume buttons. While
// the sound is on another device (the page says so over the bridge) a press
// becomes a volume step for that device and the phone's own level is put
// back, so it never drifts; while the phone itself plays, the buttons do
// what they always do. It draws full-bleed and the page pads for the notch /
// home indicator (viewport-fit=cover).
import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { VolumeManager } from 'react-native-volume-manager';

const URL = process.env.EXPO_PUBLIC_SLOPIFY_URL || 'https://music.baxtergroup.io/';

export default function App() {
  const web = useRef(null);
  const [error, setError] = useState(null);
  // What the page last told us: is the sound elsewhere?
  const remote = useRef(false);
  // The phone's own level while the sound is elsewhere; presses are measured
  // against it and it is restored after each one.
  const base = useRef(null);
  const restoring = useRef(0);

  useEffect(() => {
    let sub = null;
    (async () => {
      try { const v = await VolumeManager.getVolume(); base.current = typeof v === 'number' ? v : v?.volume ?? null; } catch { /* no audio yet */ }
      sub = VolumeManager.addVolumeListener((ev) => {
        const vol = typeof ev === 'number' ? ev : ev?.volume;
        if (typeof vol !== 'number') return;
        if (Date.now() < restoring.current) { base.current = vol; return; } // our own restore echoing back
        if (!remote.current || base.current == null) { base.current = vol; return; }
        const step = vol > base.current + 0.001 ? 1 : vol < base.current - 0.001 ? -1 : 0;
        if (!step) return;
        web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('conduit:volumestep', { detail: { step: ${step} } })); true;`);
        // Put the phone's own level back, quietly, so the next press measures from the same place.
        restoring.current = Date.now() + 700;
        VolumeManager.setVolume(base.current, { showUI: false }).catch(() => {});
      });
    })();
    return () => { try { sub?.remove(); } catch { /* gone */ } };
  }, []);

  const onMessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (msg?.type === 'session') {
      const was = remote.current; remote.current = !!msg.remote;
      if (remote.current && !was) {
        // A press at the top or bottom of the range produces no change to
        // measure, so park the phone's own level away from the ends.
        VolumeManager.getVolume().then((v) => {
          let b = typeof v === 'number' ? v : v?.volume;
          if (typeof b !== 'number') return;
          if (b > 0.95 || b < 0.05) { b = b > 0.95 ? 0.8 : 0.2; restoring.current = Date.now() + 700; VolumeManager.setVolume(b, { showUI: false }).catch(() => {}); }
          base.current = b;
        }).catch(() => {});
      }
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      {error ? (
        <View style={styles.err}>
          <Text style={styles.errText}>Slopify could not load{'\n'}{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => { setError(null); web.current?.reload(); }}><Text style={styles.btnText}>Retry</Text></TouchableOpacity>
        </View>
      ) : null}
      <WebView
        ref={web}
        source={{ uri: URL }}
        style={styles.web}
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
        onError={(e) => setError(e.nativeEvent.description || 'network error')}
        onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500) setError(`HTTP ${e.nativeEvent.statusCode}`); }}
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
