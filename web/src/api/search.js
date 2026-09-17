// Search and the search page's helpers, over the server's own API.
//
// A search can be scoped with a `filter` (the open album, playlist, artist,
// Liked Songs, a genre tile): the scope's rows are fetched once through the
// client and matched here. Results keep the row shape the page renders.

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
const words = (q) => norm(q).split(/\s+/).filter(Boolean);
const rowText = (t) => norm(`${t.Name} ${(t.Artists || []).join(' ')} ${t.Album || ''} ${t.AlbumArtist || ''}`);
const matches = (t, q) => { const ws = words(q); const text = rowText(t); return ws.every((w) => text.includes(w)); };

// The rows a scope filter stands for.
async function scoped(jf, filter) {
  const m = /^(\w+)\s*=\s*"([^"]*)"$/.exec(filter || '');
  if (!m) { if (/^plays\s*>\s*0$/.test(filter || '')) return jf.topTracks({ limit: 100 }); return []; }
  const [, key, value] = m;
  if (key === 'artistIds') return (await jf.tracks({ artistId: value, limit: 500 })).items;
  if (key === 'albumId') return (await jf.tracks({ albumId: value, limit: 500 })).items;
  if (key === 'playlistIds') return (await jf.playlistTracks(value)).items;
  if (key === 'liked') return (await jf.favoriteTracks()).items;
  if (key === 'genre') return jf.genreTracks(value);
  return [];
}

export async function search(jf, q, { limit = 10, filter = null, signal } = {}) {
  const t0 = performance.now();
  if (filter) {
    const rows = await scoped(jf, filter);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const tracks = (q.trim() ? rows.filter((t) => matches(t, q)) : rows).slice(0, limit);
    return { engine: 'server', tookMs: Math.round(performance.now() - t0), chips: [], scoped: true, top: null, tracks, albums: [], artists: [], playlists: [] };
  }
  const r = await jf.search(q, limit);
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const ql = norm(q.trim());
  // Top result: an artist whose name starts with the query, else the best album, artist or song.
  const top = r.artists[0] && norm(r.artists[0].Name).startsWith(ql) ? { kind: 'Artist', item: r.artists[0] }
    : r.albums[0] && norm(r.albums[0].Name).startsWith(ql) ? { kind: 'Album', item: r.albums[0] }
    : r.tracks[0] && norm(r.tracks[0].Name).startsWith(ql) ? { kind: 'Song', item: r.tracks[0] }
    : r.artists[0] ? { kind: 'Artist', item: r.artists[0] }
    : r.albums[0] ? { kind: 'Album', item: r.albums[0] }
    : r.tracks[0] ? { kind: 'Song', item: r.tracks[0] } : null;
  return { engine: 'server', tookMs: Math.round(performance.now() - t0), chips: [], scoped: false, top, ...r };
}

// Tiles for the empty search page (genres from the library, with a cover).
export async function browse(jf) {
  const r = await jf._fetch('/api/browse', { timeoutMs: 8000 });
  return (r.tiles || []).map((t) => ({ ...t, filter: `genre = "${t.name.replace(/"/g, '')}"` }));
}

// Everything the server knows about a release/artist beyond the library
// (other releases, similar artists, popularity order, requests) is not part
// of Slopify yet; these answer empty so the pages render what the library has.
export const globalSearch = async () => ({ results: [], albums: [], artists: [] });
export const discography = async () => ({ releases: [] });
export const similar = async () => ({ artists: [] });
export const popular = async () => ({ ids: [] });
export const radar = async () => ({ releases: [] });
export async function requestAlbum() { throw new Error('Requests are not set up on this server yet'); }

// Liked Songs rows in one call (the like store's ids, newest first).
export const likedFast = (jf) => jf._favoriteTracks();
// When each track was liked.
export async function likes(jf) { return (await jf._fetch('/api/likes', { timeoutMs: 15000 })).at || {}; }
// A playlist's tracks in order.
export const playlistTracks = (jf, id) => jf._playlistTracks(id);
// Listening history: stats for a range, or a page of recent listens.
export const history = (jf, params) => jf._fetch(`/api/history?${new URLSearchParams({ tzo: String(new Date().getTimezoneOffset()), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })}`, { timeoutMs: 60000 });
