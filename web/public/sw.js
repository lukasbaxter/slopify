// Slopify's service worker: makes the app installable, and opens the offline
// player when the site cannot be reached. It never serves the main app from
// a cache (shell caching once served stale bundles after a redeploy: old JS
// hash, blank or outdated app), so pages always come from the network. Only
// when a page load FAILS (no connection, or no answer in 8 s) does it answer
// with offline.html, the offline player, kept in its own small cache with its
// assets and refreshed on every visit (the page asks: 'cache-offline-shell').
// Songs saved for offline live in 'slopify-offline' (web/src/offline/store.js),
// which this worker only ever keeps: activation clears every OTHER cache.
const SHELL = 'slopify-offline-shell';
const KEEP = new Set([SHELL, 'slopify-offline']);
const PAGE = new URL('offline.html', self.registration.scope).href;

async function cacheShell() {
  const res = await fetch(PAGE, { cache: 'no-store' });
  if (!res.ok) return;
  const html = await res.clone().text();
  // Its scripts, styles and preloads, as the build named them (./assets/...).
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((m) => new URL(m[1], PAGE).href))];
  const got = await Promise.all(assets.map((u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? [u, r] : null)).catch(() => null)));
  if (got.some((g) => !g)) return; // all or nothing: keep the last complete copy
  const c = await caches.open(SHELL);
  await c.put(PAGE, res);
  for (const [u, r] of got) await c.put(u, r);
  const want = new Set([PAGE, ...assets]);
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
self.addEventListener('message', (e) => { if (e.data === 'cache-offline-shell') e.waitUntil(cacheShell().catch(() => {})); });

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  p.then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // The server down (a 5xx from the proxy) counts as unreachable too.
    const offline = async () => (await caches.match(PAGE, { cacheName: SHELL })) || Response.error();
    e.respondWith(withTimeout(fetch(req), 8000).then(async (r) => (r.status >= 500 && (await caches.match(PAGE, { cacheName: SHELL })) ? offline() : r)).catch(offline));
    return;
  }
  // The offline player's own files, when the network cannot give them.
  if (url.pathname.includes('/assets/')) {
    e.respondWith(fetch(req).catch(async () => (await caches.match(req.url, { cacheName: SHELL })) || Response.error()));
  }
  // Everything else (the API, streams, images) goes straight to the network.
});
