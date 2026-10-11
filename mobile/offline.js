// Songs saved on the phone, for playing with no connection. The web app asks
// for a playlist/album/Liked Songs to be saved (it sends the tracks with
// their download URLs); this keeps them in the app's Documents under
// offline/: t/<track>.m4a, c/<album>.jpg, library.json, and index.html (the
// offline player, offlinePage.js), written fresh each launch so an app
// update brings the new page. A song in two playlists is stored once;
// removing a playlist deletes only the songs nothing else still holds.
// Download URLs carry the login token, so they live in memory only.
import * as FS from 'expo-file-system/legacy';
import PAGE from './offlinePage';

export const DIR = `${FS.documentDirectory}offline/`;
export const PAGE_URI = `${DIR}index.html`;
const LIB = `${DIR}library.json`;
const PARALLEL = 2;

// --- the library, as plain data (offline.test.mjs) ---
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

// Drops a collection (and songs no other collection holds, then their
// album covers when no song left uses them); returns the files to delete.
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

// What the web app shows: per collection, how many songs are on the phone.
export function summary(lib) {
  const bytes = Object.values(lib.tracks).reduce((n, t) => n + (t.bytes || 0), 0);
  return {
    bytes,
    collections: lib.collections.map((c) => ({ id: c.id, name: c.name, kind: c.kind, total: c.trackIds.length, have: c.trackIds.filter((t) => lib.tracks[t]?.file).length })),
  };
}

// What the offline page gets: only songs that are on the phone.
export function pageData(lib, note) {
  const tracks = {};
  for (const [id, t] of Object.entries(lib.tracks)) if (t.file) tracks[id] = { title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs, file: t.file, cover: t.cover };
  return { note: note || null, collections: lib.collections.map((c) => ({ id: c.id, name: c.name, kind: c.kind, cover: c.cover, trackIds: c.trackIds })), tracks };
}

export const hasSongs = (lib) => Object.values(lib.tracks).some((t) => t.file);

// --- on the phone ---
export async function loadLib() {
  try {
    await FS.makeDirectoryAsync(`${DIR}t/`, { intermediates: true }).catch(() => {});
    await FS.makeDirectoryAsync(`${DIR}c/`, { intermediates: true }).catch(() => {});
    await FS.writeAsStringAsync(PAGE_URI, PAGE);
    const raw = await FS.readAsStringAsync(LIB).catch(() => null);
    const lib = raw ? JSON.parse(raw) : emptyLib();
    lib.plays = lib.plays || [];
    return lib;
  } catch { return emptyLib(); }
}

let saving = Promise.resolve();
export function saveLib(lib) {
  // One write at a time, whole file to a temp name then moved over.
  const json = JSON.stringify(lib);
  saving = saving.then(async () => {
    const tmp = `${LIB}.tmp`;
    await FS.writeAsStringAsync(tmp, json);
    await FS.deleteAsync(LIB, { idempotent: true });
    await FS.moveAsync({ from: tmp, to: LIB });
  }).catch(() => {});
  return saving;
}

export async function deleteFiles(files) {
  for (const f of files) await FS.deleteAsync(DIR + f, { idempotent: true }).catch(() => {});
}

async function fetchTo(url, rel) {
  const tmp = `${DIR + rel}.part`;
  const r = await FS.downloadAsync(url, tmp);
  if (r.status !== 200) { await FS.deleteAsync(tmp, { idempotent: true }); throw new Error(`HTTP ${r.status}`); }
  await FS.deleteAsync(DIR + rel, { idempotent: true });
  await FS.moveAsync({ from: tmp, to: DIR + rel });
  const info = await FS.getInfoAsync(DIR + rel);
  return info.size || 0;
}

// The download queue: one job per collection, songs two at a time. onChange
// is told after every song (for the web app's progress and the library file).
export function createDownloader(lib, onChange) {
  const jobs = [];
  let running = false;
  const state = { active: null };

  async function runJob(job) {
    const { col, urls } = job;
    if (col.cover && col.coverUrl) {
      try { await fetchTo(col.coverUrl, col.cover); } catch { /* a missing cover is fine */ }
    }
    const todo = job.ids.slice();
    let done = job.total - todo.length, failed = 0;
    state.active = { id: col.id, name: col.name, done, total: job.total, failed };
    onChange();
    const worker = async () => {
      while (todo.length) {
        if (!lib.collections.some((c) => c.id === col.id)) return; // removed meanwhile
        const id = todo.shift();
        const u = urls[id];
        const t = lib.tracks[id];
        if (!t || t.file) { done++; continue; }
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const bytes = await fetchTo(u.song, `t/${id}.m4a`);
            t.file = `t/${id}.m4a`; t.bytes = bytes; ok = true;
          } catch { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
        }
        if (ok && u.cover && t.albumId) {
          const rel = `c/${t.albumId}.jpg`;
          const have = Object.values(lib.tracks).some((x) => x.cover === rel);
          if (have) t.cover = rel;
          else { try { await fetchTo(u.cover, rel); t.cover = rel; } catch { /* no cover */ } }
        }
        if (ok) done++; else failed++;
        state.active = { id: col.id, name: col.name, done, total: job.total, failed };
        onChange();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    state.active = null;
    onChange({ finished: { id: col.id, name: col.name, done, total: job.total, failed } });
  }

  async function pump() {
    if (running) return;
    running = true;
    try { while (jobs.length) await runJob(jobs.shift()); } finally { running = false; }
  }

  return {
    state,
    // col: { id, name, kind, cover (rel path or null), coverUrl }; tracks: [{ id, title, artist, album, albumId, durationMs, url, coverUrl }]
    add(col, tracks) {
      const cover = col.coverUrl ? `c/col-${String(col.id).replace(/[^\w-]/g, '_')}.jpg` : null;
      const entry = { ...col, cover };
      const missing = upsert(lib, entry, tracks);
      const urls = Object.fromEntries(tracks.map((t) => [t.id, { song: t.url, cover: t.coverUrl }]));
      const queued = jobs.findIndex((j) => j.col.id === col.id);
      const job = { col: entry, ids: missing, urls, total: new Set(tracks.map((t) => t.id)).size };
      if (queued >= 0) jobs[queued] = job; else jobs.push(job);
      onChange();
      pump();
    },
    cancel(id) { const i = jobs.findIndex((j) => j.col.id === id); if (i >= 0) jobs.splice(i, 1); },
  };
}
