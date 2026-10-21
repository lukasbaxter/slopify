// Is the server reachable? Offline when the browser says so, when a request
// fails to connect, or when the service worker answered from its copy
// (sw.js marks those X-Slopify-Offline). While offline, /healthz is tried
// every 15 s; the first answer (or any live API response) ends it. The app
// uses this to play only downloaded songs, keep play commands on this
// device, and grey out what cannot play.
import { useSyncExternalStore } from 'react';

let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
const subs = new Set();
let timer = null;
export const isOffline = () => offline;
let confirming = null;
export function setOffline(v) {
  v = !!v;
  if (v === offline) return;
  // Going offline is confirmed first: one failed or kept answer on a jittery
  // link used to flip the whole app (Your Library down to the downloads,
  // every row greyed) and the next live answer flipped it back, over and
  // over. Now a health check must fail too, within a few seconds.
  if (v) { confirmOffline(); return; }
  offline = false;
  subs.forEach((f) => f());
  clearInterval(timer); timer = null;
}
function goOffline() {
  if (offline) return;
  offline = true;
  subs.forEach((f) => f());
  clearInterval(timer); timer = null;
  if (typeof window !== 'undefined') timer = setInterval(probe, 15000);
}
function confirmOffline() {
  if (confirming || offline) return;
  confirming = probe(4000).then((ok) => { confirming = null; if (!ok) goOffline(); }, () => { confirming = null; goOffline(); });
}
// true: the server answered; false: it did not.
async function probe(timeoutMs = 8000) {
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl && setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try { r = await fetch('/healthz', { cache: 'no-store', signal: ctrl?.signal }); } finally { if (t) clearTimeout(t); }
    // The server's own answer only: a captive portal (a plane's or a hotel's
    // Wi-Fi before signing in) answers every URL with its sign-in page, 200.
    if (!r.ok || r.headers.get('X-Slopify-Offline') || !(r.headers.get('Content-Type') || '').includes('json')) return false;
    if ((await r.json())?.ok === true) { setOffline(false); return true; }
    return false;
  } catch { return false; }
}
/** After every API response: was it the live server or the worker's copy?
 * A stale copy (the worker answering for a slow server) says nothing. */
export const noteResponse = (res) => { if (res.headers.get('X-Slopify-Stale')) return; setOffline(!!res.headers.get('X-Slopify-Offline')); };
export const subscribeNet = (f) => { subs.add(f); return () => subs.delete(f); };
export const useOfflineMode = () => useSyncExternalStore(subscribeNet, isOffline, () => false);

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => goOffline());
  window.addEventListener('online', () => probe());
  if (offline) timer = setInterval(probe, 15000);
}
