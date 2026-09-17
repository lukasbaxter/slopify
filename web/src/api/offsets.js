// Per-speaker visualizer timing offsets, in seconds.
//
// A speaker reports the position it is DECODING; the sound leaves it some
// buffer later. Nothing in the Cast or BluOS protocols says how much, so the
// number comes from the person listening: the calibration in the full-screen
// visualizer has them tap along and measures it (src/components/Calibrate.jsx).
// The relay keeps the result per device id for everyone on the server; this
// is the client's live copy. Unknown device = 0 (nothing assumed).
import { useSyncExternalStore } from 'react';

const map = new Map();          // deviceId -> seconds
const listeners = new Set();
let version = 0;

function bump() { version += 1; for (const fn of listeners) fn(); }

/** Merge offsets from the relay (hello-ok map, or one `offset` message). */
export function offsetsMerge(obj) {
  for (const [id, v] of Object.entries(obj || {})) { if (v == null) map.delete(id); else map.set(id, Number(v) || 0); }
  bump();
}
export function offsetOf(id) { return (id && map.get(id)) || 0; }
export function hasOffset(id) { return !!id && map.has(id); }

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export function useOffset(id) { return useSyncExternalStore(subscribe, () => (id && map.has(id) ? map.get(id) : null), () => null); }
export function useOffsetsVersion() { return useSyncExternalStore(subscribe, () => version, () => 0); }
