// Songs kept in the browser for listening with no connection (the installed
// web app on a phone, or any browser). Everything lives in one Cache Storage
// cache, which the service worker leaves alone: songs at /offline/song/<id>,
// album covers at /offline/cover/<albumId>, a playlist's own cover at
// /offline/cover/col-<id>, and the library at /offline/library.json. The
// offline player (offline.html) reads the same cache. A song in two playlists
// is stored once; removing a playlist deletes only what nothing else holds.
// Download URLs carry the login token, so they are never stored.

export const CACHE = 'slopify-offline';
const LIB = '/offline/library.json';
export const songKey = (id) => `/offline/song/${encodeURIComponent(id)}`;
export const coverKey = (id) => `/offline/cover/${encodeURIComponent(id)}`;
const PARALLEL = 2;

export const supported = () => typeof window !== 'undefined' && 'caches' in window && 'serviceWorker' in navigator && !window.ReactNativeWebView;

// --- the library, as plain data (store.test.js) ---
// { collections: [{ id, name, kind, cover, trackIds, added }],
//   tracks: { id: { title, artist, album, albumId, durationMs, file, bytes, cover } },
//   plays: [{ id, at }] }
export const emptyLib = () => ({ collections: [], tracks: {}, plays: [] });

// Adds or replaces a collection; returns the track ids still to download.
export function upsert(lib, col, tracks) {
  const ids = tracks.map((t) => t.id);
  const at = lib.collections.findIndex((c) => c.id === col.id);
  const entry = { id: col.id, name: col.name, kind: col.kind || 'playlist', cover: col.cover || null, trackIds: ids, added: Date.now() };
  if (at >= 0) lib.collections[at] = entry; else lib.collections.unshift(entry);
  for (const t of tracks) {
    const was = lib.tracks[t.id];
    lib.tracks[t.id] = { title: t.title, artist: t.artist, album: t.album, albumId: t.albumId, durationMs: t.durationMs || 0, file: was?.file || null, bytes: was?.bytes || 0, cover: was?.cover || null };
  }
  return [...new Set(ids)].filter((id) => !lib.tracks[id].file);
}

// Drops a collection, the songs no other collection holds, and covers
// nothing left uses; returns the cache keys to delete.
export function remove(lib, id) {
  const col = lib.collections.find((c) => c.id === id);
  if (!col) return [];
  lib.collections = lib.collections.filter((c) => c.id !== id);
  const kept = new Set(lib.collections.flatMap((c) => c.trackIds));
  const files = [], covers = new Set();
  for (const t of col.trackIds) {
    if (kept.has(t) || !lib.tracks[t]) continue;
    if (lib.tracks[t].file) files.push(lib.tracks[t].file);
    if (lib.tracks[t].cover) covers.add(lib.tracks[t].cover);
    delete lib.tracks[t];
  }
  if (col.cover) covers.add(col.cover);
  const inUse = new Set([...Object.values(lib.tracks).map((t) => t.cover), ...lib.collections.map((c) => c.cover)]);
  return [...files, ...[...covers].filter((c) => !inUse.has(c))];
}

export function summary(lib) {
  const bytes = Object.values(lib.tracks).reduce((n, t) => n + (t.bytes || 0), 0);
  return {
    bytes,
    collections: lib.collections.map((c) => ({ id: c.id, name: c.name, kind: c.kind, total: c.trackIds.length, have: c.trackIds.filter((t) => lib.tracks[t]?.file).length })),
  };
}

export const hasSongs = (lib) => Object.values(lib.tracks).some((t) => t.file);

// --- in the browser ---
// Read-modify-write of the library, one at a time across tabs (Web Locks
// where there are any; the installed app is one page anyway).
async function locked(fn) {
  if (navigator.locks?.request) return navigator.locks.request('slopify-offline-lib', fn);
  return fn();
}
export async function readLib() {
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(LIB);
    const lib = r ? await r.json() : emptyLib();
    lib.plays = lib.plays || [];
    return lib;
  } catch { return emptyLib(); }
}
async function writeLib(lib) {
  const c = await caches.open(CACHE);
  await c.put(LIB, new Response(JSON.stringify(lib), { headers: { 'Content-Type': 'application/json' } }));
}
export async function update(fn) {
  return locked(async () => { const lib = await readLib(); const out = await fn(lib); await writeLib(lib); return out; });
}

export async function blobUrl(key) {
  if (!key) return null;
  try { const r = await (await caches.open(CACHE)).match(key); return r ? URL.createObjectURL(await r.blob()) : null; } catch { return null; }
}

export async function removeCollection(id) {
  const keys = await update((lib) => remove(lib, id));
  const c = await caches.open(CACHE);
  await Promise.all(keys.map((k) => c.delete(k)));
  changed();
}
export const addPlay = (id, at) => update((lib) => { lib.plays.push({ id, at }); });
export const dropPlays = (upTo) => update((lib) => { lib.plays = lib.plays.filter((p) => p.at > upTo); });

// --- downloading ---
const listeners = new Set();
let active = null;
export const getActive = () => active;
export function subscribe(f) { listeners.add(f); return () => listeners.delete(f); }
function changed(extra) { listeners.forEach((f) => f(extra)); }

async function fetchInto(cache, url, key) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  await cache.put(key, new Response(blob, { headers: { 'Content-Type': r.headers.get('Content-Type') || blob.type || 'application/octet-stream' } }));
  return blob.size;
}

const jobs = [];
let running = false;
async function runJob(job) {
  const { col, urls } = job;
  const cache = await caches.open(CACHE);
  if (col.cover && col.coverUrl) { try { await fetchInto(cache, col.coverUrl, col.cover); } catch { /* no cover is fine */ } }
  const todo = job.ids.slice();
  let done = job.total - todo.length, failed = 0;
  active = { id: col.id, name: col.name, done, total: job.total, failed };
  changed();
  const worker = async () => {
    while (todo.length) {
      const id = todo.shift();
      const still = await readLib();
      if (!still.collections.some((c) => c.id === col.id)) return; // removed meanwhile
      if (still.tracks[id]?.file) { done++; continue; }
      const u = urls[id];
      let bytes = 0;
      for (let attempt = 0; attempt < 3 && !bytes; attempt++) {
        try { bytes = await fetchInto(cache, u.song, songKey(id)); } catch { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
      }
      let cover = null;
      if (bytes && u.cover && u.albumId) {
        cover = coverKey(u.albumId);
        if (!(await cache.match(cover))) { try { await fetchInto(cache, u.cover, cover); } catch { cover = null; } }
      }
      if (bytes) {
        await update((lib) => { const t = lib.tracks[id]; if (t) { t.file = songKey(id); t.bytes = bytes; t.cover = cover; } });
        done++;
      } else failed++;
      active = { id: col.id, name: col.name, done, total: job.total, failed };
      changed();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  active = null;
  changed({ finished: { id: col.id, name: col.name, done, total: job.total, failed } });
}
async function pump() {
  if (running) return;
  running = true;
  try { while (jobs.length) await runJob(jobs.shift()); } finally { running = false; }
}

// col: { id, name, kind, coverUrl }; tracks: [{ id, title, artist, album, albumId, durationMs, url, coverUrl }]
export async function save(col, tracks) {
  // Ask the browser not to clear these under storage pressure.
  try { await navigator.storage?.persist?.(); } catch { /* not offered */ }
  const entry = { ...col, cover: col.coverUrl ? coverKey(`col-${col.id}`) : null };
  const missing = await update((lib) => upsert(lib, entry, tracks));
  const urls = Object.fromEntries(tracks.map((t) => [t.id, { song: t.url, cover: t.coverUrl, albumId: t.albumId }]));
  const job = { col: entry, ids: missing, urls, total: new Set(tracks.map((t) => t.id)).size };
  const queued = jobs.findIndex((j) => j.col.id === col.id);
  if (queued >= 0) jobs[queued] = job; else jobs.push(job);
  changed();
  pump();
}
