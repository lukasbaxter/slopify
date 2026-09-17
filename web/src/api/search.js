// Search goes to the relay's /search (Meilisearch behind it: typo-tolerant,
// prefix, lyrics, ~20 ms). Results come back as Jellyfin-shaped items so
// every existing row/card/player path works unchanged. If the relay or the
// engine is down we fall back to Jellyfin's own search so search never
// breaks -- it just gets slow and literal again.

const IS_DESKTOP = typeof window !== 'undefined' && !!window.conduit;
function relayBase() {
  if (IS_DESKTOP) return 'https://music.baxtergroup.io/relay';
  return `${window.location.origin}/relay`;
}

function track(t, userId) {
  return {
    Id: t.id, Name: t.name, Type: 'Audio',
    Artists: t.artists || [], ArtistItems: (t.artists || []).map((n, i) => ({ Name: n, Id: (t.artistIds || [])[i] })).filter((a) => a.Id),
    Album: t.album, AlbumId: t.albumId, AlbumArtist: t.albumArtist, ProductionYear: t.year,
    RunTimeTicks: t.durationTicks, UserData: { IsFavorite: Array.isArray(t.liked) ? t.liked.includes(userId) : false },
    _snippet: t.snippet || null, _snippetAt: t.snippetAt ?? null, _plays: t.plays || 0,
  };
}
const album = (a) => ({ Id: a.id, Name: a.name, Type: 'MusicAlbum', AlbumArtist: (a.artists || []).join(', '), AlbumArtists: (a.artists || []).map((n, i) => ({ Name: n, Id: (a.artistIds || [])[i] })), ProductionYear: a.year, ChildCount: a.trackCount, _type: a.type });
const artist = (a) => ({ Id: a.id, Name: a.name, Type: 'MusicArtist', ImageTags: a.hasImage ? { Primary: '1' } : {}, _aliases: a.aliases || [] });
const playlist = (p) => ({ Id: p.id, Name: p.name, Type: 'Playlist', ChildCount: p.trackCount });

function mapTop(top, userId) {
  if (!top) return null;
  const m = { Artist: artist, Album: album, Song: (t) => track(t, userId), Playlist: playlist }[top.kind];
  return m ? { kind: top.kind, item: m(top.item) } : null;
}

export async function search(jf, q, { limit = 10, filter = null, signal } = {}) {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (filter) params.set('filter', filter);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    signal?.addEventListener('abort', () => ctrl.abort());
    const res = await fetch(`${relayBase()}/search?${params}`, { headers: { 'X-Emby-Token': jf.token }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`search ${res.status}`);
    const r = await res.json();
    return {
      engine: 'meili', tookMs: r.tookMs, chips: r.chips || [], scoped: Boolean(r.scoped),
      top: mapTop(r.top, jf.userId),
      tracks: (r.tracks || []).map((x) => track(x, jf.userId)),
      albums: (r.albums || []).map(album),
      artists: (r.artists || []).map(artist),
      playlists: (r.playlists || []).map(playlist),
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    // Fallback: Jellyfin's literal search, with the old client-side Top pick.
    const r = await jf.search(q, limit);
    const ql = q.trim().toLowerCase();
    const top = r.artists[0] && r.artists[0].Name.toLowerCase().startsWith(ql) ? { kind: 'Artist', item: r.artists[0] }
      : r.albums[0] ? { kind: 'Album', item: r.albums[0] }
      : r.artists[0] ? { kind: 'Artist', item: r.artists[0] }
      : r.tracks[0] ? { kind: 'Song', item: r.tracks[0] } : null;
    return { engine: 'jellyfin', top, chips: [], scoped: false, ...r };
  }
}

// Tiles for the empty search page (genre buckets from the index, with a cover).
export async function browse(jf) {
  const res = await fetch(`${relayBase()}/browse`, { headers: { 'X-Emby-Token': jf.token }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`browse ${res.status}`);
  return (await res.json()).tiles || [];
}

async function relayGet(jf, path, params = {}, timeout = 30000, signal = null) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${relayBase()}${path}?${q}`, { headers: { 'X-Emby-Token': jf.token }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}
// Everything Spotify knows for a query (albums, EPs, singles), each flagged with
// the library album it matches or its download-request state.
export const globalSearch = (jf, q, signal) => relayGet(jf, '/gsearch', { q }, 20000, signal);
// Every release Spotify lists for an artist, flagged with what the library has.
export const discography = (jf, artistId, name) => relayGet(jf, '/discography', { artistId, name });
export const similar = (jf, artistId, name) => relayGet(jf, '/similar', { artistId, name }, 15000);
// The artist's tracks in popularity order (Deezer top-100 matched to the library), as ids.
export const popular = (jf, artistId, name) => relayGet(jf, '/popular', { artistId, name }, 15000);
export const radar = (jf) => relayGet(jf, '/radar', {}, 120000);
// Lyrics from the relay's RAM copy of every sidecar (relay/lyrics.js); the
// same shape Jellyfin's endpoint returns. 404 = none there.
// Liked Songs rows in one call from the relay (likes table joined to the index).
export const likedFast = (jf) => relayGet(jf, '/liked', {}, 15000);
// Whole album + artist lists from the index (0.5 s for 3,200 + 4,400) and
// Home's recently played / most played from the relay's own play log.
export const libraryFast = (jf) => relayGet(jf, '/library', {}, 20000);
export const homeFast = (jf) => relayGet(jf, '/home', {}, 20000);
export const lyricsFast = (jf, itemId) => relayGet(jf, '/lyrics', { id: itemId }, 4000);
// When each track was liked (relay store). `seed` = old prefs timestamps, sent once.
export async function likes(jf, seed = null) {
  const res = await fetch(`${relayBase()}/likes`, seed
    ? { method: 'POST', headers: { 'X-Emby-Token': jf.token, 'Content-Type': 'application/json' }, body: JSON.stringify(seed), signal: AbortSignal.timeout(10000) }
    : { headers: { 'X-Emby-Token': jf.token }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`likes ${res.status}`);
  return (await res.json()).at || {};
}
// A playlist's tracks in order, from playlist.xml + the search index (fast).
export const playlistTracks = (jf, id) => relayGet(jf, "/playlist", { id }, 8000);
// Listening history (ListenBrainz mirrored by the relay): stats for a range, or a page of recent listens.
export const history = (jf, params) => relayGet(jf, '/history', { tzo: new Date().getTimezoneOffset(), ...params }, 180000);
export async function requestAlbum(jf, albumId) {
  const res = await fetch(`${relayBase()}/request`, { method: 'POST', headers: { 'X-Emby-Token': jf.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ album_id: albumId }), signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `request ${res.status}`);
  return j;
}
