// Slopify's service worker: makes the app installable and lets it work with
// no connection. Network first, always: pages, the app's files and the API
// come from the server whenever it answers, so a deploy is never hidden
// behind an old copy (shell caching once served stale bundles after a
// redeploy: old JS hash, blank or outdated app). Only when a request FAILS
// (no connection, no answer in time, or the server erroring) does it answer
// from what it kept:
//   - the app (index.html and its files), refreshed on every visit (the page
//     asks: 'cache-app-shell'), all or nothing;
//   - the API's JSON answers as last seen (library, playlists, likes...),
//     marked X-Slopify-Offline so the app knows it is offline;
//   - covers of downloaded music, from the songs' own cache.
// Downloaded songs live in 'slopify-offline' (web/src/offline/store.js) and
// are played from there by the app, not through here.
const SHELL = 'slopify-app-shell';
const API = 'slopify-api';
const SONGS = 'slopify-offline';
const KEEP = new Set([SHELL, API, SONGS]);
const SCOPE = self.registration.scope;
const PLACEHOLDER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#282828"/><path d="M58 30v30.5a9 9 0 1 1-4-7.5V36l-14 3.5v25a9 9 0 1 1-4-7.5V35.5L58 30z" fill="#7f7f7f"/></svg>';
const INDEX = new URL('./', SCOPE).href;

async function cacheShell() {
  const res = await fetch(INDEX, { cache: 'no-store' });
  if (!res.ok) return;
  const html = await res.clone().text();
  // Its scripts, styles and preloads, as the build named them (./assets/...).
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((m) => new URL(m[1], INDEX).href))];
  const got = await Promise.all(assets.map((u) => fetch(u).then((r) => (r.ok ? [u, r] : null)).catch(() => null)));
  if (got.some((g) => !g)) return; // all or nothing: keep the last complete copy
  const c = await caches.open(SHELL);
  for (const [u, r] of got) await c.put(u, r);
  await c.put(INDEX, res);
  const want = new Set([INDEX, ...assets]);
  for (const k of await c.keys()) if (!want.has(k.url)) await c.delete(k);
}

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(cacheShell().catch(() => {})); });
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('message', (e) => {
  if (e.data === 'cache-app-shell') e.waitUntil(cacheShell().catch(() => {}));
  if (e.data === 'clear-api') e.waitUntil(caches.delete(API)); // logged out
});

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  p.then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
});
const marked = async (r) => new Response(await r.blob(), { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json', 'X-Slopify-Offline': '1' } });

// What the API answers that is worth keeping for offline: the library and
// its pages. Not media, not searches, not admin or job polling.
const SKIP = /^\/api\/(stream|image|art|download|ws|search|gsearch|jobs|admin|downloads|auth\/(login|devices)|users|ai\/|relay)/;
const apiKey = (url) => { const u = new URL(url); u.searchParams.delete('token'); return u.href; };

async function api(req) {
  const key = apiKey(req.url);
  const kept = () => caches.match(key, { cacheName: API });
  try {
    // Kept answer at hand: do not hang on a dead connection for long.
    const has = await kept();
    const res = await (has ? withTimeout(fetch(req), 10000) : fetch(req));
    if (res.ok && (res.headers.get('Content-Type') || '').includes('json')) {
      const copy = res.clone();
      caches.open(API).then((c) => c.put(key, copy)).catch(() => {});
    } else if (res.status >= 500 && has) return marked(has);
    return res;
  } catch (err) {
    const has = await kept();
    if (has) return marked(has);
    // Nothing kept: an answer the app reads as offline, not a network error.
    return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Slopify-Offline': '1' } });
  }
}

// A cover: the server's, else the copy saved with downloaded music
// (/offline/cover/<albumId> or /offline/cover/col-<playlistId>).
async function cover(req, id) {
  try {
    // What the server says goes (a 404 is "no cover", not "offline"); only
    // no answer, or the server erroring, falls back to the kept copy.
    const res = await withTimeout(fetch(req), 8000);
    if (res.status < 500) return res;
    throw new Error(String(res.status));
  } catch (err) {
    const c = await caches.open(SONGS);
    const hit = (await c.match(`/offline/cover/${encodeURIComponent(id)}`)) || (await c.match(`/offline/cover/${encodeURIComponent(`col-${id}`)}`));
    // None kept: a plain dark square with a note (Spotify's empty cover), the
    // same box as any cover, instead of the browser's broken-image glyph.
    // Not cached anywhere; back online the app asks again with new URLs.
    return hit || new Response(PLACEHOLDER, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Slopify-Offline': '1' } });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // The server down (a 5xx from the proxy) counts as unreachable too.
    const app = async () => (await caches.match(INDEX, { cacheName: SHELL })) || Response.error();
    e.respondWith(withTimeout(fetch(req), 8000).then(async (r) => (r.status >= 500 && (await caches.match(INDEX, { cacheName: SHELL })) ? app() : r)).catch(app));
    return;
  }
  if (url.pathname.includes('/assets/')) {
    const name = url.pathname.slice(url.pathname.lastIndexOf('/assets/'));
    e.respondWith(fetch(req).catch(async () => (await caches.match(new URL(`.${name}`, SCOPE).href, { cacheName: SHELL })) || Response.error()));
    return;
  }
  const img = /^\/api\/image\/([^/?]+)/.exec(url.pathname);
  if (img) { e.respondWith(cover(req, decodeURIComponent(img[1]))); return; }
  if (url.pathname === '/healthz') return;
  if (url.pathname.startsWith('/api/') && !SKIP.test(url.pathname)) e.respondWith(api(req));
  // Everything else (streams, downloads, the socket) goes straight to the network.
});
