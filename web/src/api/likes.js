// The one place the client knows which tracks are liked, and when.
//
// Loaded from the relay's store (`GET /likes`), changed by likesSet() (the
// user's own click) and by the relay's `like` broadcasts (this or any other
// client, echoed back with the server's timestamp). Every heart reads it via
// useLiked(); Liked Songs is built from likedIds(). Rows' UserData.IsFavorite
// -- stale from the search index, stale from cached lists, a render behind
// after a click -- is never consulted for tracks, which is what kept making
// likes "disappear".
import { useSyncExternalStore } from 'react';

const map = new Map();          // itemId -> likedAt (ms)
const listeners = new Set();
let version = 0;
let ready = false;

function bump() { version += 1; for (const fn of listeners) fn(); }

export function likesLoad(obj) {
  map.clear();
  for (const [id, at] of Object.entries(obj || {})) map.set(id, Number(at) || 0);
  ready = true; bump();
}
export function likesSet(id, liked, at = Date.now()) {
  if (!id) return;
  if (liked) map.set(id, at); else map.delete(id);
  bump();
}
export function likesReady() { return ready; }
export function isLiked(id) { return map.has(id); }
export function likedAtOf(id) { return map.get(id); }
export function likedCount() { return map.size; }
/** Liked track ids, newest first. */
export function likedIds() { return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id); }
export function likesSnapshot() { return Object.fromEntries(map); }

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Heart state for one track; re-renders when it changes anywhere. */
export function useLiked(id) { return useSyncExternalStore(subscribe, () => (id ? map.has(id) : false), () => false); }
/** A counter that changes on any like change (for lists that depend on the set). */
export function useLikesVersion() { return useSyncExternalStore(subscribe, () => version, () => 0); }
