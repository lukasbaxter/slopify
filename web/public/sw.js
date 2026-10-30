// Slopify's service worker: makes the app installable, quick to open on a
// bad connection, and lets it work with no connection. What it kept comes
// first; the network refreshes it in the background:
//   - the app (index.html and its files): the kept copy opens at once, and
//     every visit refreshes it (the page asks: 'cache-app-shell'), all or
//     nothing. A newer build reaches an open app through its auto-update
//     (App.jsx), which has the copy here refreshed before it reloads.
//   - the API's JSON answers as last seen (library, playlists, likes...):
//     the server gets a moment to answer (fresh on a good link); past that
//     the kept copy is used and the answer refreshes it in the background,
//     and the app is told when it changed ('api-fresh') to show it. Right
//     after the app changed something (a write), the server is waited for.
//     No connection: the kept copy, marked X-Slopify-Offline.
//   - covers: kept as they load, served from here, checked again after a
//     day; with nothing kept, the copy saved with downloaded music.
// Network-first opens took 2.6 s (page) and 5 to 9 s (Home's data) on a
// 2.5 s round-trip link with everything kept (10-30, a throttled proxy).
// Downloaded songs live in 'slopify-offline' (web/src/offline/store.js) and
// are played from there by the app, not through here.
const SHELL = 'slopify-app-shell';
const API = 'slopify-api';
const SONGS = 'slopify-offline';
const COVERS = 'slopify-covers';
// API answers are kept per account (slopify-api-<user id>, the id rides in
// the X-Slopify-User header the app sends): one person's playlists and
// history were served to the next person signing in on the same phone.
const keepCache = (k) => k === SHELL || k === SONGS || k === COVERS || k.startsWith(API);
const apiCacheOf = (req) => { const u = req.headers.get('X-Slopify-User'); return u && /^[\w-]{1,64}$/.test(u) ? `${API}-${u}` : API; };
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
// Read from Cache Storage once and then kept in memory: every range used to
// read the whole 9.6 MB again. And Cache Storage does not answer at all while
// the app is in the background (the phone locked: caches.keys() and match()
// never settle; tools/ios-sim, 10-26), so a stand-in that had to load again
// there (a locked hand-off to another device) got no data, never played, and
// the lock screen lost the session. A read that has not answered in 1.5 s
// gives way to the server.
let wavBlob = null;
async function keptWav() {
  if (wavBlob) return wavBlob;
  const c = await caches.open(SHELL);
  let hit = await c.match(WAV);
  if (!hit) { await keepWav(c).catch(() => {}); hit = await c.match(WAV); }
  if (!hit) return null;
  wavBlob = await hit.blob();
  return wavBlob;
}
async function wav(req) {
  const blob = await Promise.race([keptWav().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (!blob) return fetch(req);
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
      .then((keys) => Promise.all(keys.filter((k) => !keepCache(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('message', (e) => {
  // With a port: the auto-update waits for the new build to be kept before it reloads.
  if (e.data === 'cache-app-shell') e.waitUntil(cacheShell().catch(() => {}).then(() => e.ports?.[0]?.postMessage('done')).then(pruneApi).then(pruneCovers));
  if (e.data === 'clear-api') e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(API)).map((k) => caches.delete(k))))); // logged out
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
    for (const name of (await caches.keys()).filter((k) => k.startsWith(API))) {
      const c = await caches.open(name);
      const keys = await c.keys();
      if (keys.length <= API_MAX_KEYS) continue;
      for (const k of keys.slice(0, keys.length - API_MAX_KEYS + 300)) await c.delete(k);
    }
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

// Background work (refreshing kept answers and covers) goes a couple at a
// time, so it never crowds out what the app is asking for now.
const BG_MAX = 2;
let bgRunning = 0;
const bgQueue = [];
const bgPump = () => {
  while (bgRunning < BG_MAX && bgQueue.length) {
    const [job, done] = bgQueue.shift();
    bgRunning++;
    job().catch(() => {}).finally(() => { bgRunning--; done(); bgPump(); });
  }
};
const background = (job) => new Promise((done) => { bgQueue.push([job, done]); bgPump(); });

// The app changed something (a POST/PATCH/PUT/DELETE went by): for a few
// seconds the server's answer is waited for, so the change shows.
let lastWrite = 0;
const WRITE_FRESH_MS = 8000;
// Posts that change nothing the pages show (a play logged, a stream warmed): not writes here.
const NOT_WRITES = /\/api\/(plays|stream|lyrics|reports|auth|relay|ai\/|jobs)/;
// How long the server gets before the kept copy is used: a good link
// answers inside it, so the page is fresh there; a bad one does not wait.
const API_GRACE_MS = 350;

const tellClients = async (msg) => { for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage(msg); };

// Fetch, keep, and tell the app when the answer differs from the kept one.
async function refreshApi(req, key, cacheName, kept) {
  const res = await withTimeout(fetch(req), 60000);
  if (portalPage(res) || !res.ok || !(res.headers.get('Content-Type') || '').includes('json')) return res;
  const body = await res.clone().text();
  await (await caches.open(cacheName)).put(key, res.clone());
  if (kept && (await kept.clone().text()) !== body) tellClients({ type: 'api-fresh', path: new URL(key).pathname });
  return res;
}

// Slow is not offline: an answer from the kept copy because the server was
// slow is marked X-Slopify-Stale (the app shows it, nothing else changes);
// only no answer at all, the proxy answering for a server that is down
// (502/503/504) or a captive portal's page mark it X-Slopify-Offline.
async function api(e, req) {
  const key = apiKey(req.url);
  const cacheName = apiCacheOf(req);
  const has = await caches.match(key, { cacheName }).catch(() => null);
  const live = refreshApi(req, key, cacheName, has?.clone());
  const offline = async () => (has ? marked(has.clone()) : offlineJson());
  const fromServer = live.then(async (res) => {
    if (portalPage(res)) return offline();
    if ((res.status === 502 || res.status === 503 || res.status === 504) && has) return marked(has.clone());
    return res;
  }, offline);
  if (!has || Date.now() - lastWrite < WRITE_FRESH_MS) return fromServer;
  // Kept: the server gets its moment, then the kept copy; the answer keeps
  // coming in the background and refreshes it.
  const late = new Promise((r) => setTimeout(() => r(null), API_GRACE_MS));
  const first = await Promise.race([fromServer, late]);
  if (first) return first;
  e.waitUntil(live.catch(() => {}));
  return marked(has.clone(), 'X-Slopify-Stale');
}

// The copy saved with downloaded music: /offline/cover/<albumId> or
// /offline/cover/col-<playlistId>, or for a song's own id (track rows and
// the lock screen ask by track id) the cover its library entry names.
const LIB_KEY = /\/offline\/(?:[^/]+\/)?library\.json$/;
let songCovers = null; // { at, map: track id -> cover key }, re-read after 30 s (5 s for an id not in it)
async function keptCover(id) {
  const c = await caches.open(SONGS);
  const hit = (await c.match(`/offline/cover/${encodeURIComponent(id)}`)) || (await c.match(`/offline/cover/${encodeURIComponent(`col-${id}`)}`));
  if (hit) return hit;
  if (!songCovers || Date.now() - songCovers.at > (songCovers.map.has(id) ? 30000 : 5000)) {
    const map = new Map();
    for (const k of await c.keys()) {
      if (!LIB_KEY.test(new URL(k.url).pathname)) continue;
      const lib = await (await c.match(k)).json().catch(() => null);
      for (const [tid, t] of Object.entries(lib?.tracks || {})) if (t?.cover) map.set(tid, t.cover);
    }
    songCovers = { at: Date.now(), map };
  }
  const key = songCovers.map.get(id);
  return key ? (await c.match(key)) || null : null;
}

// Covers as they load, by URL without the token and the back-online marker
// (the same picture). Served from here; checked again in the background once
// a day old. A new cover from the app (a picture changed) has a new URL.
const COVER_MAX = 4000;
const COVER_DAY = 86400000;
const coverKey = (url) => { const u = new URL(url); u.searchParams.delete('token'); u.searchParams.delete('n'); return u.href; };
async function keepCover(key, res) {
  if (!res.ok || portalPage(res)) return;
  const h = new Headers(res.headers); h.set('X-Slopify-Kept', String(Date.now()));
  await (await caches.open(COVERS)).put(key, new Response(await res.blob(), { status: 200, headers: h }));
}
async function pruneCovers() {
  try {
    const c = await caches.open(COVERS);
    const keys = await c.keys();
    if (keys.length > COVER_MAX) for (const k of keys.slice(0, keys.length - COVER_MAX + 500)) await c.delete(k);
  } catch { /* best effort */ }
}
async function cover(e, req, id) {
  const key = coverKey(req.url);
  const kept = await caches.match(key, { cacheName: COVERS }).catch(() => null);
  if (kept) {
    if (Date.now() - Number(kept.headers.get('X-Slopify-Kept') || 0) > COVER_DAY) {
      e.waitUntil(background(async () => { const r = await withTimeout(fetch(req, { cache: 'no-cache' }), 60000); if (r.status === 404) await (await caches.open(COVERS)).delete(key); else await keepCover(key, r); }));
    }
    return kept;
  }
  const res = await coverFromServer(req, id);
  if (res.ok && !res.headers.get('X-Slopify-Offline')) e.waitUntil(keepCover(key, res.clone()).catch(() => {}));
  return res;
}
// A cover: the server's, else the copy saved with downloaded music.
async function coverFromServer(req, id) {
  try {
    // What the server says goes (a 404 is "no cover", not "offline"); only
    // no answer, or the server erroring, falls back to the kept copy. A page
    // of 40 covers on a slow link shares one pipe, so a slow one is left to
    // arrive (the placeholder it used to get after 8 s was never retried).
    const res = await withTimeout(fetch(req), 45000);
    if (res.status === 404) {
      // "No cover" from the server: still the copy saved with downloaded
      // music, if there is one (a downloaded album keeps its old id after the
      // library retagged it; the server no longer knows that id).
      return (id && (await keptCover(id))) || res;
    }
    if (res.status < 500 && !portalPage(res)) return res;
    throw new Error(String(res.status));
  } catch (err) {
    const hit = id ? await keptCover(id) : null; // no id: a profile picture
    // None kept: a plain dark square with a note (Spotify's empty cover), the
    // same box as any cover, instead of the browser's broken-image glyph.
    // Not cached anywhere; back online the app asks again with new URLs.
    return hit || new Response(PLACEHOLDER, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Slopify-Offline': '1' } });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') { if (/\/api\//.test(req.url) && !NOT_WRITES.test(new URL(req.url).pathname)) lastWrite = Date.now(); return; }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // The server down (a 5xx from the proxy) counts as unreachable too.
    const app = async () => (await caches.match(INDEX, { cacheName: SHELL })) || Response.error();
    // The server down (a 5xx) or a captive portal's page in place of the
    // app (no built assets in it) both mean: the kept app, when there is one.
    const notTheApp = async (r) => r.status >= 500 || (portalPage(r) && !/\/assets\//.test(await r.clone().text()));
    // The kept app opens at once (the page then asks for it to be refreshed);
    // with none kept yet, the server's, as before.
    e.respondWith((async () => {
      const kept = await caches.match(INDEX, { cacheName: SHELL }).catch(() => null);
      if (kept) return kept;
      return withTimeout(fetch(req), 8000).then(async (r) => ((await notTheApp(r)) && (await caches.match(INDEX, { cacheName: SHELL })) ? app() : r)).catch(app);
    })());
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
  if (img) { e.respondWith(cover(e, req, decodeURIComponent(img[1]))); return; }
  if (/^\/api\/users\/[^/]+\/avatar$/.test(url.pathname)) { e.respondWith(cover(e, req, null)); return; } // profile pictures, kept like covers
  if (url.pathname === '/healthz') return;
  if (url.pathname.startsWith('/api/') && !SKIP.test(url.pathname)) e.respondWith(api(e, req));
  // Everything else (streams, downloads, the socket) goes straight to the network.
});
