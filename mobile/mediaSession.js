// Android: the page's media session (App.js's navigator.mediaSession
// stand-in) to the playback service (modules/slopify-media). The page says
// "none" whenever it has no song, and it has none for a moment between
// songs too: stopping the service then tore it down mid-queue, and Android
// 12+ refuses to start it again from the background. So "none" stops it only
// once nothing has played for NONE_GRACE_MS; signing out (stop()) stops it at
// once. Plain functions: server/src/mobilemedia.test.ts tests them in Node.
export const NONE_GRACE_MS = 10000;

export function mediaSessionRelay(media, grace = NONE_GRACE_MS) {
  let timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const stop = () => { cancel(); try { media.stop(); } catch { /* module gone */ } };
  return {
    message(msg) {
      if (msg?.state === 'none') {
        if (!timer) timer = setTimeout(stop, grace);
        return;
      }
      cancel();
      try { media.update(msg); } catch { /* module gone */ }
    },
    stop,
  };
}
