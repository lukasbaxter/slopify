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
export function setOffline(v) {
  v = !!v;
  if (v === offline) return;
  offline = v;
  subs.forEach((f) => f());
  clearInterval(timer); timer = null;
  if (offline && typeof window !== 'undefined') timer = setInterval(probe, 15000);
}
async function probe() {
  try {
    const r = await fetch('/healthz', { cache: 'no-store' });
    // The server's own answer only: a captive portal (a plane's or a hotel's
    // Wi-Fi before signing in) answers every URL with its sign-in page, 200.
    if (!r.ok || r.headers.get('X-Slopify-Offline') || !(r.headers.get('Content-Type') || '').includes('json')) return;
    if ((await r.json())?.ok === true) setOffline(false);
  } catch { /* still offline */ }
}
/** After every API response: was it the live server or the worker's copy? */
export const noteResponse = (res) => setOffline(!!res.headers.get('X-Slopify-Offline'));
export const subscribeNet = (f) => { subs.add(f); return () => subs.delete(f); };
export const useOfflineMode = () => useSyncExternalStore(subscribeNet, isOffline, () => false);

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => probe());
  if (offline) timer = setInterval(probe, 15000);
}
