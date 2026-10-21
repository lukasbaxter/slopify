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
// The silent stand-in (web/src/player/keepalive.js): 9.6 MB of silence the
// phone plays, by range requests, whenever it holds the lock screen after a
// pause. Always the same bytes, so it is kept with the app and served from
// here: not fetched again for every hold (29 MB an hour on a phone plan),
// and there with no connection.
const WAV = new URL('./keepalive.wav', SCOPE).href;

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
  const want = new Set([INDEX, WAV, ...assets]);
  for (const k of await c.keys()) if (!want.has(k.url)) await c.delete(k);
  if (!(await c.match(WAV))) await keepWav(c).catch(() => {});
}
async function keepWav(c) {
  const r = await fetch(WAV, { cache: 'no-store' });
  if (r.ok && /audio/i.test(r.headers.get('Content-Type') || '') && !portalPage(r)) await c.put(WAV, r);
}
// The stand-in's media, from the kept copy: the player asks for byte ranges
// (the OS seeks it), answered as a server would (206 + Content-Range).
async function wav(req) {
  const c = await caches.open(SHELL);
  let hit = await c.match(WAV);
  if (!hit) { await keepWav(c).catch(() => {}); hit = await c.match(WAV); }
  if (!hit) return fetch(req);
  const blob = await hit.blob();
  const size = blob.size;
  const common = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || '');
  if (!m) return new Response(blob, { headers: { ...common, 'Content-Length': String(size) } });
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!(start <= end && start < size)) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...common, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
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
  if (e.data === 'cache-app-shell') e.waitUntil(cacheShell().catch(() => {}).then(pruneApi));
  if (e.data === 'clear-api') e.waitUntil(caches.delete(API)); // logged out
});

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  p.then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
});
const marked = async (r, header = 'X-Slopify-Offline') => new Response(await r.blob(), { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json', [header]: '1' } });
// The kept copies of API answers, pruned when they pile up (a long listen
// keeps lyrics for every song): Safari evicts a whole origin under quota
// pressure, downloaded songs included.
const API_MAX_KEYS = 1500;
async function pruneApi() {
  try {
    const c = await caches.open(API);
    const keys = await c.keys();
    if (keys.length <= API_MAX_KEYS) return;
    for (const k of keys.slice(0, keys.length - API_MAX_KEYS + 300)) await c.delete(k);
  } catch { /* best effort */ }
}
// A captive portal (a plane's or a hotel's Wi-Fi before signing in) answers
// every URL with its own sign-in page, status 200: that is no answer from
// the server. The API never answers HTML; covers are never HTML.
const portalPage = (res) => res.ok && /text\/html/i.test(res.headers.get('Content-Type') || '');
const offlineJson = () => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Slopify-Offline': '1' } });

// What the API answers that is worth keeping for offline: the library and
// its pages. Not media, not searches, not admin or job polling.
const SKIP = /^\/api\/(stream|image|art|download|ws|search|gsearch|jobs|admin|downloads|auth\/|users|ai\/|relay|prefs|history)/;
const apiKey = (url) => { const u = new URL(url); u.searchParams.delete('token'); return u.href; };

// Slow is not offline. A server that is merely slow to answer (a phone on a
// weak link) gets its kept copy back marked X-Slopify-Stale: the page shows
// it, nothing else changes. Only no answer at all (the fetch failing), the
// proxy answering for a server that is down (502/503/504) or a captive
// portal's page count as offline (X-Slopify-Offline). Marking slowness as
// offline used to hide every playlist not downloaded until the next answer
// arrived, then bring them back, then hide them again.
async function api(req) {
  const key = apiKey(req.url);
  const kept = () => caches.match(key, { cacheName: API });
  let has;
  try {
    // Kept answer at hand: do not hang on a dead connection for long.
    has = await kept();
    const res = await (has ? withTimeout(fetch(req), 10000) : fetch(req));
    if (portalPage(res)) return has ? marked(has) : offlineJson();
    if (res.ok && (res.headers.get('Content-Type') || '').includes('json')) {
      const copy = res.clone();
      caches.open(API).then((c) => c.put(key, copy)).catch(() => {});
    } else if ((res.status === 502 || res.status === 503 || res.status === 504) && has) return marked(has);
    return res;
  } catch (err) {
    if (err && err.message === 'timeout' && has) return marked(has, 'X-Slopify-Stale');
    if (has) return marked(has);
    // Nothing kept: an answer the app reads as offline, not a network error.
    return offlineJson();
  }
}

// A cover: the server's, else the copy saved with downloaded music
// (/offline/cover/<albumId> or /offline/cover/col-<playlistId>).
async function cover(req, id) {
  try {
    // What the server says goes (a 404 is "no cover", not "offline"); only
    // no answer, or the server erroring, falls back to the kept copy. A page
    // of 40 covers on a slow link shares one pipe, so a slow one is left to
    // arrive (the placeholder it used to get after 8 s was never retried).
    const res = await withTimeout(fetch(req), 45000);
    if (res.status < 500 && !portalPage(res)) return res;
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
    // The server down (a 5xx) or a captive portal's page in place of the
    // app (no built assets in it) both mean: the kept app, when there is one.
    const notTheApp = async (r) => r.status >= 500 || (portalPage(r) && !/\/assets\//.test(await r.clone().text()));
    e.respondWith(withTimeout(fetch(req), 8000).then(async (r) => ((await notTheApp(r)) && (await caches.match(INDEX, { cacheName: SHELL })) ? app() : r)).catch(app));
    return;
  }
  if (url.href === WAV) { e.respondWith(wav(req)); return; }
  if (url.pathname.includes('/assets/')) {
    // Built files are named by their content hash, so a kept one is the one
    // asked for: served first, with no network. A new one comes from the
    // server; a server answer that is not the file (a 404 for a hash this
    // deploy no longer has, a 5xx) or no answer falls back to the kept copy.
    // Passing a 404 through used to leave the page blank (black with the
    // old CSS, white without) after a deploy until a fast reload.
    const name = url.pathname.slice(url.pathname.lastIndexOf('/assets/'));
    const key = new URL(`.${name}`, SCOPE).href;
    e.respondWith((async () => {
      const kept = await caches.match(key, { cacheName: SHELL });
      if (kept) return kept;
      try {
        const r = await fetch(req);
        if (r.ok) return r;
        return (await caches.match(key, { cacheName: SHELL })) || r;
      } catch (err) {
        return (await caches.match(key, { cacheName: SHELL })) || Response.error();
      }
    })());
    return;
  }
  const img = /^\/api\/image\/([^/?]+)/.exec(url.pathname);
  if (img) { e.respondWith(cover(req, decodeURIComponent(img[1]))); return; }
  if (url.pathname === '/healthz') return;
  if (url.pathname.startsWith('/api/') && !SKIP.test(url.pathname)) e.respondWith(api(req));
  // Everything else (streams, downloads, the socket) goes straight to the network.
});
