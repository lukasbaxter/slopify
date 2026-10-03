// Whole songs held in memory on the phone, so a dead zone on the road does
// not stop the music. The song playing and the next one are downloaded in
// full (one AAC file each, the same frames as the HLS stream) while there
// is signal; a track that starts from here needs no network at all.
//
// Downloads resume where they stopped: a connection that goes quiet for
// 15 s is dropped and picked up again with a Range request, as many times
// as it takes (backing off to 30 s between tries). Kept to the few tracks
// asked for; everything else is released.
const IDLE_MS = 15000;
const MAX_MS = 20 * 60 * 1000; // longer mixes stream only (a 60-minute set is 150 MB)

export function createTrackCache(urlFor, { onReady } = {}) {
  const ready = new Map(); // id -> object URL
  const loading = new Map(); // id -> { abort } (one at a time)
  const failed = new Set(); // gave up (404, or ~5 straight failures): no retry until re-requested
  let wanted = new Set();

  let order = [];
  const pump = () => {
    if (loading.size) return;
    const id = order.find((x) => wanted.has(x) && !ready.has(x) && !failed.has(x));
    if (!id) return;
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    loading.set(id, { abort });
    download(id, ctrl.signal).then((blob) => {
      if (loading.get(id)?.abort !== abort) return; // released meanwhile
      loading.delete(id);
      if (blob && wanted.has(id)) { const url = URL.createObjectURL(blob); ready.set(id, url); onReady?.(id, url); }
      else { if (wanted.has(id)) failed.add(id); order = order.filter((x) => x !== id); } // gone or hopeless: do not retry
      pump();
    });
  };

  const release = (id) => {
    const u = ready.get(id); if (u) { URL.revokeObjectURL(u); ready.delete(id); }
    const l = loading.get(id); if (l) { l.abort(); loading.delete(id); pump(); }
  };

  async function download(id, signal) {
    const parts = []; let got = 0; let total = null; let tries = 0;
    while (!signal.aborted) {
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      signal.addEventListener('abort', stop, { once: true });
      let idle = setTimeout(stop, IDLE_MS * 4); // the first bytes may wait on a transcode
      try {
        const res = await fetch(urlFor(id), { signal: ctrl.signal, headers: got ? { Range: `bytes=${got}-` } : {} });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (got && res.status !== 206) { parts.length = 0; got = 0; } // server ignored the range: start over
        if (total == null) {
          const cr = /\/(\d+)$/.exec(res.headers.get('Content-Range') || '');
          total = cr ? Number(cr[1]) : Number(res.headers.get('Content-Length')) || null;
        }
        const reader = res.body.getReader();
        for (;;) {
          clearTimeout(idle); idle = setTimeout(stop, IDLE_MS);
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); got += value.length; tries = 0;
        }
        if (total == null || got >= total) return new Blob(parts, { type: 'audio/mp4' });
      } catch (e) {
        if (signal.aborted) return null;
      } finally { clearTimeout(idle); signal.removeEventListener('abort', stop); }
      tries += 1;
      // ~5 straight failures with no bytes in between: the server is saying
      // no, not the signal. Give up until the track is asked for again.
      if (tries >= 5) return null;
      await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** Math.min(tries, 5))));
    }
    return null;
  }

  return {
    // The object URL for a fully downloaded track, or null.
    get: (id) => ready.get(id) || null,
    // Keep exactly these tracks (the current one, then the next); download
    // what is missing one at a time, in that order, so the song that matters
    // first gets the whole connection.
    keep(tracks) {
      const list = tracks.filter((t) => t && t.id && !(t.durationMs > MAX_MS));
      const next = new Set(list.map((t) => t.id));
      // A track asked for anew (it left the wanted set in between) gets a
      // fresh chance; one that merely stays wanted does not retry-loop.
      for (const id of next) if (!wanted.has(id)) failed.delete(id);
      wanted = next;
      for (const id of [...ready.keys(), ...loading.keys()]) if (!wanted.has(id)) release(id);
      order = list.map((t) => t.id);
      pump();
    },
    clear() { wanted = new Set(); order = []; failed.clear(); for (const id of [...ready.keys(), ...loading.keys()]) release(id); },
  };
}
