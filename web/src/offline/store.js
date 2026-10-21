// Songs kept in the browser for listening with no connection (the installed
// web app on a phone, or any browser). Everything lives in one Cache Storage
// cache, which the service worker leaves alone: songs at /offline/song/<id>,
// album covers at /offline/cover/<albumId>, a playlist's own cover at
// /offline/cover/col-<id>, and the library at /offline/library.json. The
// offline player (offline.html) reads the same cache. A song in two playlists
// is stored once; removing a playlist deletes only what nothing else holds.
// Download URLs carry the login token, so they are never stored.

export const CACHE = 'slopify-offline';
// The library is per account (two people sharing a phone each see their own
// downloads); the song and cover files are shared by id, and a removal
// deletes only what no account's library still holds.
const SESSION_KEY = 'slopify.session'; // api/slopify.js writes it: { baseUrl, token, userId }
const uid = () => { try { return String(JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')?.userId || 'x').replace(/[^\w-]/g, '_'); } catch { return 'x'; } };
const LEGACY_LIB = '/offline/library.json';
const libKey = () => `/offline/${uid()}/library.json`;
const LIB_RE = /^\/offline\/[^/]+\/library\.json$/;
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
    // q: the quality it was saved at; saving again at another quality
    // downloads it again (the new file replaces the old under the same key).
    const was = lib.tracks[t.id];
    const same = was?.file && (was.q || 'aac-320') === (t.q || 'aac-320');
    lib.tracks[t.id] = { title: t.title, artist: t.artist, album: t.album, albumId: t.albumId, durationMs: t.durationMs || 0, q: same ? was.q : t.q || null, norm: t.norm || null, file: same ? was.file : null, bytes: same ? was.bytes : 0, cover: was?.cover || null };
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
    let r = await c.match(libKey());
    // Downloads made before libraries were per account: the first account
    // to look takes them over (the files are shared anyway).
    if (!r && uid() !== 'x') { const old = await c.match(LEGACY_LIB); if (old) { await c.put(libKey(), new Response(await old.clone().text(), { headers: { 'Content-Type': 'application/json' } })); await c.delete(LEGACY_LIB); r = await c.match(libKey()); } }
    const lib = r ? await r.json() : emptyLib();
    lib.plays = lib.plays || [];
    return lib;
  } catch { return emptyLib(); }
}
async function writeLib(lib) {
  const c = await caches.open(CACHE);
  await c.put(libKey(), new Response(JSON.stringify(lib), { headers: { 'Content-Type': 'application/json' } }));
}
// Files (songs, covers) some other account's library on this device still holds.
async function heldElsewhere(c) {
  const held = new Set();
  try {
    for (const k of await c.keys()) {
      const p = new URL(k.url).pathname;
      if (!LIB_RE.test(p) || p === new URL(libKey(), location.href).pathname) continue;
      const lib = await (await c.match(k)).json().catch(() => null);
      if (!lib) continue;
      for (const t of Object.values(lib.tracks || {})) { if (t.file) held.add(t.file); if (t.cover) held.add(t.cover); }
      for (const col of lib.collections || []) if (col.cover) held.add(col.cover);
    }
  } catch { /* none */ }
  return held;
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
  const held = await heldElsewhere(c);
  await Promise.all(keys.filter((k) => !held.has(k)).map((k) => c.delete(k)));
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
      // The song's lyrics: fetched through the service worker, which keeps the
      // answer like any API answer (sw.js), so they show offline too.
      if (bytes && u.lyrics) await fetch(u.lyrics).catch(() => {});
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

// Downloads cut short (the app closed, the connection dropped): queued again
// with URLs built for each song from what the library remembers (urlFor:
// (id, track) => { song, cover }). Nothing to do when all are here.
export async function resume(urlFor) {
  const lib = await readLib();
  for (const c of lib.collections) {
    if (jobs.some((j) => j.col.id === c.id) || active?.id === c.id) continue;
    const ids = [...new Set(c.trackIds)].filter((id) => lib.tracks[id] && !lib.tracks[id].file);
    if (!ids.length) continue;
    const urls = Object.fromEntries(ids.map((id) => [id, { ...urlFor(id, lib.tracks[id]), albumId: lib.tracks[id].albumId }]));
    jobs.push({ col: { id: c.id, name: c.name, kind: c.kind, cover: c.cover, coverUrl: null }, ids, urls, total: new Set(c.trackIds).size });
  }
  changed();
  pump();
}

// Every downloaded song's album cover, kept small: the ones missing (a
// failed fetch, or saved before covers were) are fetched now.
export async function backfillCovers(coverUrlFor) {
  const lib = await readLib();
  const cache = await caches.open(CACHE);
  const albums = new Map();
  for (const [id, t] of Object.entries(lib.tracks)) if (t.file && t.albumId) (albums.get(t.albumId) || albums.set(t.albumId, []).get(t.albumId)).push(id);
  let got = 0;
  for (const [albumId, ids] of albums) {
    const key = coverKey(albumId);
    if (!(await cache.match(key))) { try { await fetchInto(cache, coverUrlFor(albumId), key); } catch { continue; } }
    if (ids.some((id) => lib.tracks[id].cover !== key)) got++;
    await update((l) => { for (const id of ids) if (l.tracks[id]) l.tracks[id].cover = key; });
  }
  if (got) changed();
}

// col: { id, name, kind, coverUrl }; tracks: [{ id, title, artist, album, albumId, durationMs, q, norm, url, coverUrl }]
// defer: only remember it (offline); resume() downloads it once online.
export async function save(col, tracks, { defer = false } = {}) {
  // Ask the browser not to clear these under storage pressure.
  try { await navigator.storage?.persist?.(); } catch { /* not offered */ }
  const entry = { ...col, cover: col.coverUrl ? coverKey(`col-${col.id}`) : null };
  const missing = await update((lib) => upsert(lib, entry, tracks));
  const urls = Object.fromEntries(tracks.map((t) => [t.id, { song: t.url, cover: t.coverUrl, albumId: t.albumId, lyrics: t.lyricsUrl }]));
  if (defer) { changed(); return; }
  const job = { col: entry, ids: missing, urls, total: new Set(tracks.map((t) => t.id)).size };
  const queued = jobs.findIndex((j) => j.col.id === col.id);
  if (queued >= 0) jobs[queued] = job; else jobs.push(job);
  changed();
  pump();
}
