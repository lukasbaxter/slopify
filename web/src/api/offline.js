// Songs saved on the phone for listening with no connection. The phone app
// (mobile/offline.js) does the downloading and plays them in its own offline
// player; this side asks it to save or remove a playlist/album/Liked Songs,
// shows what it holds, and reports the plays it made offline. Only in a
// phone app new enough to say so (slopifyShell.offline); elsewhere the
// playlist zip (download.js) is the way to take music along.
import { useEffect, useState } from 'react';

export const canSaveOffline = () => typeof window !== 'undefined' && !!window.ReactNativeWebView && !!window.slopifyShell?.offline;

let last = { collections: [], bytes: 0, active: null, plays: [] };
const subs = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('slopify:offline', (e) => { last = { ...last, ...e.detail }; subs.forEach((f) => f(last, e.detail)); });
}
const post = (m) => { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch { /* not in the app */ } };

/** What the phone holds: { collections: [{ id, name, kind, total, have }], bytes, active }. */
export function useOffline() {
  const [s, set] = useState(last);
  useEffect(() => {
    if (!canSaveOffline()) return undefined;
    const f = (v) => set(v);
    subs.add(f);
    post({ type: 'offline-list' });
    return () => { subs.delete(f); };
  }, []);
  return s;
}
export const subscribeOffline = (f) => { subs.add(f); return () => subs.delete(f); };

// About what a song takes at AAC 320 (the 'whole' file): 40 kB a second.
export const estimateBytes = (tracks) => tracks.reduce((n, t) => n + ((t.RunTimeTicks || 0) / 1e7) * 40000, 0);

/**
 * Save a collection on the phone. kind: 'playlist' | 'album' | 'liked'.
 * Volume normalization is baked in as the player would (album gain for an
 * album, track gain otherwise), since the offline player cannot scale audio.
 */
export function saveOffline(jf, item, kind, tracks) {
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
  post({
    type: 'offline-save',
    collection: { id: item.Id, name: item.Name, kind, coverUrl: kind === 'liked' ? null : jf.imageUrl(item.Id, { maxHeight: 320, full: true }) },
    tracks: list,
  });
}

export const removeOffline = (id) => post({ type: 'offline-remove', id });
export const openOffline = () => post({ type: 'offline-open' });

// Plays made in the offline player, sent once online (the server keeps their
// time); the phone forgets them when told how far it got.
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
    if (upTo) post({ type: 'offline-plays-sent', upTo });
  } finally { flushing = false; }
}
