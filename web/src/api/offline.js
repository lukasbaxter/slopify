// Songs saved for listening with no connection. Two keepers: the installed
// web app (or any browser with a service worker) keeps them itself
// (offline/store.js) and opens offline.html when the site will not load; the
// iPhone app shell keeps them natively (mobile/offline.js) and is asked over
// the bridge. This module hides which: save or remove a playlist/album/Liked
// Songs, show what is held, and report the plays made offline.
import { useEffect, useState } from 'react';
import * as store from '../offline/store.js';

const inShell = () => typeof window !== 'undefined' && !!window.ReactNativeWebView && !!window.slopifyShell?.offline;
// The desktop app loads the build from disk: no service worker there.
const inBrowser = () => typeof window !== 'undefined' && !window.conduit && !window.ReactNativeWebView && store.supported()
  && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
export const canSaveOffline = () => inShell() || inBrowser();

let last = { collections: [], bytes: 0, active: null, plays: [] };
const subs = new Set();
const emit = (detail) => { last = { ...last, ...detail }; subs.forEach((f) => f(last, detail)); };
const post = (m) => { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch { /* not in the app */ } };

if (typeof window !== 'undefined') {
  window.addEventListener('slopify:offline', (e) => emit(e.detail));
  // The browser keeper: re-read the library after every change it reports.
  if (inBrowser()) {
    const refresh = async (extra) => { const lib = await store.readLib(); emit({ ...store.summary(lib), active: store.getActive(), plays: lib.plays, ...(extra || {}) }); };
    store.subscribe(refresh);
    refresh();
  }
}

/** What is kept: { collections: [{ id, name, kind, total, have }], bytes, active }. */
export function useOffline() {
  const [s, set] = useState(last);
  useEffect(() => {
    if (!canSaveOffline()) return undefined;
    const f = (v) => set(v);
    subs.add(f);
    set(last);
    if (inShell()) post({ type: 'offline-list' });
    return () => { subs.delete(f); };
  }, []);
  return s;
}
export const subscribeOffline = (f) => { subs.add(f); return () => subs.delete(f); };

// About what a song takes at AAC 320 (the 'whole' file): 40 kB a second.
export const estimateBytes = (tracks) => tracks.reduce((n, t) => n + ((t.RunTimeTicks || 0) / 1e7) * 40000, 0);

/**
 * Save a collection. kind: 'playlist' | 'album' | 'liked'. Volume
 * normalization is baked in as the player would (album gain for an album,
 * track gain otherwise): the offline player cannot scale audio.
 */
export async function saveOffline(jf, item, kind, tracks) {
  const norm = jf.normalize === false ? null : kind === 'album' ? 'album' : 'track';
  const seen = new Set();
  const list = tracks.filter((t) => t?.Id && !seen.has(t.Id) && seen.add(t.Id)).map((t) => ({
    id: t.Id,
    title: t.Name,
    artist: (t.Artists || []).join(', ') || t.AlbumArtist || '',
    album: t.Album || '',
    albumId: t.AlbumId || null,
    durationMs: Math.round((t.RunTimeTicks || 0) / 1e4),
    url: jf._url(`/api/stream/${t.Id}/whole/aac-320`, norm ? { norm } : {}),
    coverUrl: t.AlbumId ? jf.imageUrl(t.AlbumId, { maxHeight: 320, full: true }) : null,
  }));
  const collection = { id: item.Id, name: item.Name, kind, coverUrl: kind === 'liked' || kind === 'album' ? null : jf.imageUrl(item.Id, { maxHeight: 320, full: true }) };
  if (inShell()) { post({ type: 'offline-save', collection, tracks: list }); return; }
  // Room for it? (Safari gives an installed app a large share of the disk.)
  try {
    const est = await navigator.storage?.estimate?.();
    const need = estimateBytes(tracks);
    if (est?.quota && est.quota - (est.usage || 0) < need) throw new Error(`Not enough room: needs about ${(need / 1e9).toFixed(1)} GB, ${((est.quota - (est.usage || 0)) / 1e9).toFixed(1)} GB free`);
  } catch (e) { if (/Not enough room/.test(e.message)) throw e; }
  await store.save(collection, list);
}

export async function removeOffline(id) {
  if (inShell()) { post({ type: 'offline-remove', id }); return; }
  await store.removeCollection(id);
}
export function openOffline() {
  if (inShell()) post({ type: 'offline-open' });
  else location.href = './offline.html';
}

// Plays made in the offline player, sent once online (the server keeps their
// time); the keeper forgets them once sent.
let flushing = false;
export async function flushOfflinePlays(jf, plays) {
  if (flushing || !plays?.length || !jf?.token) return;
  flushing = true;
  try {
    let upTo = 0;
    for (const p of [...plays].sort((a, b) => a.at - b.at)) {
      const r = await jf._fetch('/api/plays', { method: 'POST', body: JSON.stringify({ trackId: p.id, at: p.at, client: 'offline' }) }).catch(() => null);
      if (!r) break;
      upTo = p.at;
    }
    if (!upTo) return;
    if (inShell()) post({ type: 'offline-plays-sent', upTo });
    else { await store.dropPlays(upTo); last = { ...last, plays: (last.plays || []).filter((p) => p.at > upTo) }; }
  } finally { flushing = false; }
}
