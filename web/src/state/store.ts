// Tiny external store for React (useSyncExternalStore): one object, one
// subscribe, immutable updates. No reducer ceremony.
import { useSyncExternalStore } from 'react';
export function createStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  const get = () => state;
  const set = (patch: Partial<T> | ((s: T) => Partial<T>)) => { const p = typeof patch === 'function' ? patch(state) : patch; state = { ...state, ...p }; for (const s of subs) s(); };
  const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
  const use = <U>(sel: (s: T) => U): U => useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
  return { get, set, subscribe, use };
}
