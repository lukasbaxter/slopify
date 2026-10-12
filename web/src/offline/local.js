// Downloaded songs as the player's source: an object URL made from the copy
// in Cache Storage (store.js), online or not, so a downloaded song never
// uses the network. Kept for the few songs around the playhead (the one
// playing and the next ones); the rest are released.
import { blobUrl, songKey } from './store.js';
import { isKept } from '../api/offline.js';

const urls = new Map(); // id -> object URL
const pending = new Map(); // id -> Promise

/** The object URL for a downloaded song, if it is loaded. */
export const localUrl = (id) => urls.get(id) || null;

/** Load a downloaded song (a few ms from the cache); null when it is not downloaded. */
export function ensureLocal(id) {
  if (!id || !isKept(id)) return Promise.resolve(null);
  if (urls.has(id)) return Promise.resolve(urls.get(id));
  if (!pending.has(id)) {
    pending.set(id, blobUrl(songKey(id)).then((u) => { pending.delete(id); if (u) urls.set(id, u); return u; }));
  }
  return pending.get(id);
}

/** Keep these loaded (and load them); release the others. */
export function keepLocal(ids) {
  const want = new Set(ids.filter(Boolean));
  for (const [id, u] of urls) if (!want.has(id)) { URL.revokeObjectURL(u); urls.delete(id); }
  for (const id of want) ensureLocal(id);
}
