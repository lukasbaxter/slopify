// IndexedDB cache for the big lists, keyed by the library version the
// server reports. localStorage silently drops big values; this does not.
const DB = 'slopify', STORE = 'kv';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
export async function cacheGet<T>(key: string, version: string): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => { const t = db.transaction(STORE).objectStore(STORE).get(key); t.onsuccess = () => { const v = t.result; resolve(v && v.version === version ? (v.value as T) : null); }; t.onerror = () => resolve(null); });
  } catch { return null; }
}
export async function cacheSet(key: string, version: string, value: unknown) {
  try { const db = await open(); db.transaction(STORE, 'readwrite').objectStore(STORE).put({ version, value }, key); } catch { /* quota / private */ }
}
