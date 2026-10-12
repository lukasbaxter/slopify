// Songs downloaded for listening with no connection, Spotify's way: the app
// itself keeps working offline (sw.js keeps a copy of it and of what the
// server last answered), downloaded songs always play from the device
// (offline/local.js), and whatever is not downloaded greys out while
// offline (offline/net.js). This module is what the screens use: save or
// remove a playlist/album/Liked Songs, what is kept, and the plays made
// offline (reported once back online).
import { useEffect, useState, useSyncExternalStore } from 'react';
import * as store from '../offline/store.js';

// The desktop app loads the build from disk (no service worker); the old
// phone app's WebView has none either.
export const canSaveOffline = () => typeof window !== 'undefined' && !window.conduit && store.supported()
  && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

let last = { collections: [], bytes: 0, active: null, plays: [] };
let kept = new Set(); // ids of downloaded songs
const subs = new Set();
const emit = (detail) => {
  last = { ...last, ...detail };
  if (Array.isArray(detail?.ids)) kept = new Set(detail.ids);
  subs.forEach((f) => f(last, detail));
};
export const isKept = (id) => kept.has(id);

if (typeof window !== 'undefined' && canSaveOffline()) {
  const refresh = async (extra) => {
    const lib = await store.readLib();
    emit({ ...store.summary(lib), ids: Object.keys(lib.tracks).filter((id) => lib.tracks[id].file), active: store.getActive(), plays: lib.plays, ...(extra || {}) });
  };
  store.subscribe(refresh);
  refresh();
}

/** What is kept: { collections: [{ id, name, kind, total, have }], bytes, active }. */
export function useOffline() {
  const [s, set] = useState(last);
  useEffect(() => { const f = (v) => set(v); subs.add(f); set(last); return () => { subs.delete(f); }; }, []);
  return s;
}
export const subscribeOffline = (f) => { subs.add(f); return () => subs.delete(f); };
/** Is this song downloaded? */
export function useDownloaded(id) { return useSyncExternalStore(subscribeOffline, () => (id ? kept.has(id) : false), () => false); }

// About what a song takes: AAC 320 (the 'whole' file) is 40 kB a second;
// an original FLAC averages about 3x that (much more for hi-res).
export const estimateBytes = (tracks, lossless = false) => tracks.reduce((n, t) => n + ((t.RunTimeTicks || 0) / 1e7) * (lossless ? 120000 : 40000), 0);
// What Safari can play from the original file; anything else is saved as AAC.
const PLAYS_ORIGINAL = /flac|layer 3|mp3|aac|alac|pcm|wav|aiff/i;
/** Downloads follow the streaming quality: Lossless keeps the original files. */
export const savesLossless = (jf) => jf?.quality === 'original';

/**
 * Save a collection. kind: 'playlist' | 'album' | 'liked'. Lossless keeps
 * the file itself (bit-perfect, so no normalization baked in); otherwise
 * AAC at the chosen quality with the gain baked in as the player would
 * (album gain for an album, track gain otherwise).
 */
export async function saveOffline(jf, item, kind, tracks) {
  const norm = jf.normalize === false ? null : kind === 'album' ? 'album' : 'track';
  const lossless = savesLossless(jf);
  const profile = jf._profile();
  const seen = new Set();
  const list = tracks.filter((t) => t?.Id && !seen.has(t.Id) && seen.add(t.Id)).map((t) => ({
    id: t.Id,
    title: t.Name,
    artist: (t.Artists || []).join(', ') || t.AlbumArtist || '',
    album: t.Album || '',
    albumId: t.AlbumId || null,
    durationMs: Math.round((t.RunTimeTicks || 0) / 1e4),
    ...(lossless && PLAYS_ORIGINAL.test(t.Container || '')
      ? { q: 'original', url: jf.downloadUrl(t.Id, 'original') }
      : { q: profile, url: jf._url(`/api/stream/${t.Id}/whole/${profile}`, norm ? { norm } : {}) }),
    coverUrl: t.AlbumId ? jf.imageUrl(t.AlbumId, { maxHeight: 320, full: true }) : null,
  }));
  const collection = { id: item.Id, name: item.Name, kind, coverUrl: kind === 'liked' || kind === 'album' ? null : jf.imageUrl(item.Id, { maxHeight: 320, full: true }) };
  // Room for it? (Safari gives an installed app a large share of the disk.)
  try {
    const est = await navigator.storage?.estimate?.();
    const need = estimateBytes(tracks, lossless);
    if (est?.quota && est.quota - (est.usage || 0) < need) throw new Error(`Not enough room: needs about ${(need / 1e9).toFixed(1)} GB, ${((est.quota - (est.usage || 0)) / 1e9).toFixed(1)} GB free`);
  } catch (e) { if (/Not enough room/.test(e.message)) throw e; }
  await store.save(collection, list);
}

export const removeOffline = (id) => store.removeCollection(id);

// Plays made offline, sent once the server answers again (it keeps their time).
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
    await store.dropPlays(upTo);
    last = { ...last, plays: (last.plays || []).filter((p) => p.at > upTo) };
  } finally { flushing = false; }
}
