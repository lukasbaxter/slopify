// Passthrough service worker. Its only job is to make Conduit installable as a
// PWA -- it deliberately caches NOTHING. Shell caching was serving stale app
// bundles after a redeploy (old JS hash, blank or outdated app), so the app is
// always fetched fresh from the network instead. On activation it purges any
// caches a previous version of this worker created.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// No fetch handler that caches. A bare listener keeps the app install-eligible
// without intercepting responses.
self.addEventListener('fetch', () => {});
