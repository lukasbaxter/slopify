// The Slopify server client: everything the app reads and writes goes
// through here, over /api. The components keep the row/card shape they were
// written for (Id, Name, AlbumId, RunTimeTicks, ImageTags, UserData...), so
// the mapping from the server's JSON lives in this one file and nothing
// visual had to change.
//
// Stream and artwork URLs are handed to speakers, which fetch them over the
// network themselves, so they are absolute and carry the token in the URL.

const CACHE_PREFIX = 'slopify.cache.';
const SESSION_KEY = 'slopify.session';

function deviceId() {
  const KEY = 'slopify.deviceId';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; localStorage.setItem(KEY, id); }
    return id;
  } catch { return `d-${Math.random().toString(36).slice(2)}`; }
}

// --- the row shapes the components use ---------------------------------
const ticks = (ms) => Math.round((ms || 0) * 10000);
// Albums saved to Your Library, so any album row knows its heart state.
const savedAlbums = new Set();
const people = (names, ids) => (names || []).map((n, i) => ({ Name: n, Id: (ids || [])[i] || null })).filter((a) => a.Id);
export const rowTrack = (t) => ({
  Id: t.id, Name: t.title, Type: 'Audio',
  Artists: t.artists || [], ArtistItems: people(t.artists, t.artistIds),
  Album: t.album, AlbumId: t.albumId, AlbumArtist: t.albumArtist, AlbumArtists: t.albumArtistId ? [{ Name: t.albumArtist, Id: t.albumArtistId }] : people([t.albumArtist], [t.artistIds?.[0]]),
  ProductionYear: t.year, IndexNumber: t.trackNo, ParentIndexNumber: t.discNo, RunTimeTicks: ticks(t.durationMs),
  Genres: t.genres || [], Container: t.codec || null, DateCreated: t.addedAt ? new Date(t.addedAt).toISOString() : undefined,
  ImageTags: t.cover ? { Primary: t.cover } : {}, UserData: { IsFavorite: false }, _identity: t.identity || null,
});
export const rowAlbum = (a) => ({
  Id: a.id, Name: a.name, Type: 'MusicAlbum', AlbumArtist: a.artist, AlbumArtists: a.artistId ? [{ Name: a.artist, Id: a.artistId }] : [], ArtistItems: a.artistId ? [{ Name: a.artist, Id: a.artistId }] : [],
  ProductionYear: a.year, ChildCount: a.trackCount, RunTimeTicks: ticks(a.durationMs), DateCreated: a.addedAt ? new Date(a.addedAt).toISOString() : undefined,
  ImageTags: a.cover ? { Primary: a.cover } : {}, UserData: { IsFavorite: !!a.likedAt || savedAlbums.has(a.id) },
});
export const rowArtist = (a) => ({ Id: a.id, Name: a.name, Type: 'MusicArtist', ChildCount: a.albumCount, ImageTags: a.image ? { Primary: a.image } : {}, BackdropImageTags: a.image ? [a.image] : [], UserData: {} });
export const rowPlaylist = (p) => ({ Id: p.id, Name: p.name, Type: 'Playlist', ChildCount: p.trackCount, ImageTags: p.cover ? { Primary: p.cover } : {}, DateCreated: p.created ? new Date(p.created).toISOString() : undefined, UserData: {} });

const isPlaylistId = (id) => /^pl_/.test(id || '');

export class Slopify {
  constructor({ baseUrl, token = null, userId = null }) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.userId = userId;
    // Session cache for list reads. A click should never wait on a fetch for
    // something already shown once; mutations evict what they change.
    this._cache = new Map();
  }

  // Per-user localStorage namespace, computed (login builds the client before it knows the user).
  get _lsPrefix() { return `${CACHE_PREFIX}${this.userId || 'x'}.`; }
  persisted(key) { try { const raw = localStorage.getItem(this._lsPrefix + key); return raw ? JSON.parse(raw) : null; } catch { return null; } }
  _persist(key, value) { try { localStorage.setItem(this._lsPrefix + key, JSON.stringify(value)); } catch { /* quota or private mode */ } }
  _cached(key, fn) { if (this._cache.has(key)) return Promise.resolve(this._cache.get(key)); return fn().then((v) => { this._cache.set(key, v); return v; }); }
  _cachedFor(key, ms, fn) {
    const hit = this._cache.get(key);
    if (hit && hit._at && Date.now() - hit._at < ms) return Promise.resolve(hit.v);
    return fn().then((v) => { this._cache.set(key, { _at: Date.now(), v }); return v; });
  }
  _evict(prefix) { for (const k of [...this._cache.keys()]) if (k.startsWith(prefix)) this._cache.delete(k); }

  async _fetch(path, options = {}) {
    const { retries = 0, timeoutMs = 45_000, raw = null, ...opts } = options;
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      // A caller's own signal (a superseded search) aborts too.
      opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      try {
        const headers = { Authorization: `Bearer ${this.token || ''}`, ...(opts.headers || {}) };
        if (!raw && opts.body) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${this.baseUrl}${path}`, { ...opts, body: raw || opts.body, signal: ctrl.signal, headers });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          let msg = body; try { msg = JSON.parse(body).error || body; } catch { /* plain */ }
          const err = new Error(`${res.status}${msg ? `: ${String(msg).slice(0, 180)}` : ''}`);
          err.status = res.status;
          if (res.status >= 500 && attempt < retries) throw Object.assign(err, { retry: true });
          throw err;
        }
        return res.status === 204 ? null : res.json();
      } catch (e) {
        const transient = e.retry || e.name === 'AbortError' || e instanceof TypeError;
        if (!transient || attempt >= retries) throw e;
        attempt += 1;
        await new Promise((r) => setTimeout(r, 800 * attempt));
      } finally { clearTimeout(timer); }
    }
  }
  _url(path, params = {}) {
    const q = new URLSearchParams({ ...params, token: this.token || '' });
    return `${this.baseUrl}${path}?${q}`;
  }

  static async login(baseUrl, username, password) {
    const client = new Slopify({ baseUrl: baseUrl.trim() });
    const data = await client._fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, device: (typeof window !== 'undefined' && window.conduit?.deviceName) || (typeof navigator !== 'undefined' && navigator.platform) || 'Browser', kind: typeof window !== 'undefined' && window.conduit ? 'desktop' : 'web', deviceId: deviceId() }),
    });
    client.token = data.token;
    client.userId = data.user.id;
    client.user = data.user;
    return client;
  }

  async me() {
    const u = await this._fetch('/api/auth/me');
    this.user = u;
    return { Id: u.id, Name: u.name, Policy: { IsAdministrator: u.role === 'admin' }, role: u.role, mustChangePassword: u.mustChangePassword };
  }
  get isAdmin() { return this.user?.role === 'admin'; }

  // --- profile picture ------------------------------------------------------
  userImageUrl({ maxHeight = 96 } = {}) {
    const q = { size: String(maxHeight) };
    if (this._bust?.user) q.v = String(this._bust.user);
    return this._url(`/api/users/${this.userId}/avatar`, q);
  }
  async uploadUserImage(file) {
    await this._fetch('/api/users/me/avatar', { method: 'POST', raw: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    (this._bust ||= {}).user = Date.now();
  }

  // --- account settings (a JSON blob per user, patched) --------------------
  async getPrefs() { return this._fetch('/api/prefs'); }
  async setPrefs(patch) { return this._fetch('/api/prefs', { method: 'PATCH', body: JSON.stringify(patch), retries: 2 }); }

  // --- what the local player streams ---------------------------------------
  // 'original' or a transcode. Speakers always get the original file.
  quality = 'original';
  // How the local element gets a transcode:
  //  'file'    original file, byte ranges, seeks natively;
  //  'hls'     Safari/iOS: AAC segments fetched as needed, seeks natively;
  //  'chunked' everything else: one progressive MP3 (no ranges), seeking by
  //            asking for a new stream that starts at `startAt`.
  streamMode() {
    if (!{ high: 320000, normal: 160000, low: 96000 }[this.quality]) return 'file';
    const hls = typeof document !== 'undefined' && !!document.createElement('audio').canPlayType('application/vnd.apple.mpegurl');
    return hls ? 'hls' : 'chunked';
  }
  transcoded() { return this.streamMode() === 'chunked'; }
  _warm = new Map();
  // HLS only: asking for the playlist starts the transcode, so the first
  // segments are ready by the time the element asks.
  prewarm(itemId) {
    if (!itemId || this.streamMode() !== 'hls') return;
    const at = this._warm.get(itemId); if (at && Date.now() - at < 60000) return;
    this._warm.set(itemId, Date.now());
    fetch(this.playbackUrl(itemId)).then((r) => r.text()).catch(() => {});
  }
  _profile() { return { high: 'aac-320', normal: 'aac-160', low: 'aac-96' }[this.quality] || 'aac-320'; }
  playbackUrl(itemId, { startAt = 0 } = {}) {
    const mode = this.streamMode();
    if (mode === 'file') return this.streamUrl(itemId);
    if (mode === 'hls') return this._url(`/api/stream/${itemId}/hls/${this._profile()}/index.m3u8`);
    return this.transcodeUrl(itemId, { codec: 'mp3', bitrate: { high: 320000, normal: 160000, low: 96000 }[this.quality], startAt });
  }
  streamUrl(itemId) { return this._url(`/api/stream/${itemId}`); }
  transcodeUrl(itemId, { bitrate = 320000, startAt = 0 } = {}) {
    const q = { bitrate: String(bitrate) };
    if (startAt > 0) q.startAt = String(Math.round(startAt * 1000) / 1000);
    return this._url(`/api/stream/${itemId}/mp3`, q);
  }
  downloadUrl(itemId, fmt = 'original') { return this._url(`/api/download/${itemId}`, { fmt }); }

  // --- library ----------------------------------------------------------------
  // Whole lists, held for 10 minutes (3,000 albums is one 400 KB response).
  _albums() { return this._cachedFor('albums', 10 * 60 * 1000, async () => ((await this._fetch('/api/albums?limit=20000')).items || []).map(rowAlbum)); }
  _artists() { return this._cachedFor('artists', 10 * 60 * 1000, async () => ((await this._fetch('/api/artists?limit=20000')).items || []).map(rowArtist)); }
  async albums({ limit, startIndex = 0, search = null } = {}) {
    if (search) { const r = await this.search(search, limit || 40); return { items: r.albums, total: r.albums.length }; }
    const all = await this._albums();
    return { items: all.slice(startIndex, limit ? startIndex + limit : undefined), total: all.length };
  }
  async artists({ limit, startIndex = 0, search = null } = {}) {
    if (search) { const r = await this.search(search, limit || 40); return { items: r.artists, total: r.artists.length }; }
    const all = await this._artists();
    return { items: all.slice(startIndex, limit ? startIndex + limit : undefined), total: all.length };
  }
  _home() { return this._cachedFor('home', 3 * 60 * 1000, () => this._fetch('/api/home')); }
  recentlyPlayedAlbums({ limit = 8 } = {}) { return this._home().then((h) => ({ items: (h.recentAlbums || []).slice(0, limit).map(rowAlbum) })); }
  topTracks({ limit = 50 } = {}) { return this._home().then((h) => (h.topTracks || []).slice(0, limit).map(rowTrack)); }
  recentlyAddedAlbums({ limit = 8 } = {}) { return this._home().then((h) => ({ items: (h.newestAlbums || []).slice(0, limit).map(rowAlbum) })); }
  async lastPlayedTrack() { const h = await this._fetch('/api/history?limit=1'); const t = h.items?.[0]?.track; return t ? rowTrack(t) : null; }

  _artist(artistId) { return this._cached(`artist:${artistId}`, () => this._fetch(`/api/artists/${artistId}`)); }
  // Albums credited to an artist, newest first, then the ones they appear on.
  artistAlbums(artistId, { limit = 60 } = {}) {
    return this._artist(artistId).then((a) => { const items = [...(a.albums || []), ...(a.appearsOn || [])].map(rowAlbum); return { items: items.slice(0, limit), total: items.length }; });
  }
  _album(albumId) { return this._cached(`album:${albumId}`, () => this._fetch(`/api/albums/${albumId}`)); }
  tracks(opts = {}) {
    if (opts.search) return this.search(opts.search, opts.limit || 40).then((r) => ({ items: r.tracks, total: r.tracks.length }));
    return this._cached(`tracks:${opts.albumId || ''}:${opts.artistId || ''}:${opts.limit || 500}`, () => this._tracks(opts));
  }
  async _tracks({ albumId = null, artistId = null, limit = 500 } = {}) {
    if (albumId) { const a = await this._album(albumId); const items = (a.tracks || []).map(rowTrack); return { items: items.slice(0, limit), total: items.length }; }
    if (artistId) { const a = await this._artist(artistId); const items = (a.tracks || []).map(rowTrack); return { items: items.slice(0, limit), total: items.length }; }
    return { items: [], total: 0 };
  }
  async genreTracks(name) { return ((await this._fetch(`/api/genres/${encodeURIComponent(name)}/tracks`)).items || []).map(rowTrack); }

  async playlists() { const items = ((await this._fetch('/api/playlists')).items || []).map(rowPlaylist); return { items, total: items.length }; }
  playlistTracks(playlistId, opts = {}) {
    if (opts.startIndex != null) return this._playlistTracks(playlistId, opts);
    return this._cached(`playlist:${playlistId}`, () => this._playlistTracks(playlistId, opts));
  }
  async _playlistTracks(playlistId, { limit = 100000, startIndex = 0 } = {}) {
    const p = await this._fetch(`/api/playlists/${playlistId}`);
    // The entry id is the row's position: the same track twice can be removed one at a time.
    const items = (p.tracks || []).map((t, i) => ({ ...rowTrack(t), PlaylistItemId: String(i) }));
    return { items: items.slice(startIndex, startIndex + limit), total: items.length };
  }

  // Lyrics: [{ start: seconds | null, text }]. Empty for none / instrumental.
  async lyrics(itemId) {
    try {
      const r = await this._fetch(`/api/lyrics/${itemId}`, { timeoutMs: 8000 });
      if (!r || r.kind === 'instrumental') return [];
      return (r.lines || []).map((l) => ({ start: l.start != null ? l.start / 1000 : null, text: l.text || '' }));
    } catch (e) { if (e.status === 404) return []; throw e; }
  }

  async itemsByIds(ids) {
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += 500) {
      const r = await this._fetch(`/api/tracks?ids=${ids.slice(i, i + 500).join(',')}`);
      out.push(...(r.items || []).map(rowTrack));
    }
    const by = new Map(out.map((t) => [t.Id, t]));
    return ids.map((id) => by.get(id)).filter(Boolean);
  }
  itemById(id) { return this._cached(`item:${id}`, () => this._itemById(id)); }
  async _itemById(id) {
    if (isPlaylistId(id)) return this._fetch(`/api/playlists/${id}`).then(rowPlaylist).catch((e) => { if (e?.status === 404) return null; throw e; });
    const r = await this._fetch(`/api/items/${id}`).catch((e) => { if (e?.status === 404) return null; throw e; });
    if (!r) return null;
    return r.kind === 'album' ? rowAlbum(r.item) : r.kind === 'artist' ? rowArtist(r.item) : rowTrack(r.item);
  }

  async search(term, limit = 40) {
    const r = await this._fetch(`/api/search?q=${encodeURIComponent(term)}&limit=${limit}`);
    const pls = await this.playlists().catch(() => ({ items: [] }));
    return {
      albums: (r.albums || []).map(rowAlbum), artists: (r.artists || []).map(rowArtist), tracks: (r.tracks || []).map(rowTrack),
      playlists: pls.items.filter((x) => x.Name.toLowerCase().includes(term.toLowerCase())),
    };
  }
  async instantMix(itemId, limit = 100) {
    const r = await this._fetch(`/api/tracks/${itemId}/mix?limit=${limit}`);
    const out = (r.items || []).map(rowTrack);
    const dis = this._dislikes || {};
    return out.filter((t) => !dis[t.Id]);
  }
  // "Exclude from your taste profile": kept in the account prefs.
  async setDislike(itemId, disliked) {
    const cur = { ...((await this.getPrefs()).dislikes || {}) };
    if (disliked) cur[itemId] = Date.now(); else delete cur[itemId];
    this._dislikes = cur;
    return this.setPrefs({ dislikes: cur });
  }

  // --- playlist edits -------------------------------------------------------
  async createPlaylist(name, itemIds = []) {
    const r = await this._fetch('/api/playlists', { method: 'POST', body: JSON.stringify({ name, trackIds: itemIds }) });
    return { Id: r.id, Name: r.name };
  }
  async addToPlaylist(playlistId, itemIds) { this._evict(`playlist:${playlistId}`); return this._fetch(`/api/playlists/${playlistId}/tracks`, { method: 'POST', body: JSON.stringify({ trackIds: itemIds }), retries: 2 }); }
  async removeFromPlaylist(playlistId, entryIds) {
    this._evict(`playlist:${playlistId}`);
    // Highest position first, so the earlier ones keep their numbers.
    for (const pos of entryIds.map(Number).sort((a, b) => b - a)) await this._fetch(`/api/playlists/${playlistId}/tracks/${pos}`, { method: 'DELETE', retries: 2 });
  }
  async movePlaylistItem(playlistId, entryId, newIndex) { this._evict(`playlist:${playlistId}`); return this._fetch(`/api/playlists/${playlistId}/move`, { method: 'POST', body: JSON.stringify({ from: Number(entryId), to: newIndex }) }); }
  async deletePlaylist(playlistId) { this._evict(`playlist:${playlistId}`); return this._fetch(`/api/playlists/${playlistId}`, { method: 'DELETE' }); }
  async renamePlaylist(playlistId, name) { this._evict(`item:${playlistId}`); return this._fetch(`/api/playlists/${playlistId}`, { method: 'PATCH', body: JSON.stringify({ name }) }); }
  renameItem(itemId, name) { return this.renamePlaylist(itemId, name); }
  async uploadPrimaryImage(itemId, file) {
    if (!isPlaylistId(itemId)) throw new Error('Only playlist covers can be changed here');
    await this._fetch(`/api/playlists/${itemId}/cover`, { method: 'POST', raw: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    this._evict('item:'); this.bustImage(itemId);
  }
  async deleteItem(itemId) {
    if (!isPlaylistId(itemId)) throw new Error('Files are managed on the server, not from here');
    return this.deletePlaylist(itemId);
  }

  // --- likes -------------------------------------------------------------------
  async setFavorite(itemId, liked) {
    this._evict('favorites:'); this._evict('tracks:'); this._evict('playlist:');
    const r = await this._fetch(`/api/likes/${itemId}`, { method: liked ? 'PUT' : 'DELETE', retries: 2 });
    if (r?.album) { if (liked) savedAlbums.add(itemId); else savedAlbums.delete(itemId); }
    return r;
  }
  async favoriteAlbums() {
    const items = (await this._fetch('/api/likes/albums')).items || [];
    savedAlbums.clear(); for (const a of items) savedAlbums.add(a.id);
    return { items: items.map(rowAlbum) };
  }
  favoriteTracks() { return this._cached('favorites:all', () => this._favoriteTracks()); }
  async favoriteCount() { return Object.keys((await this._fetch('/api/likes')).at || {}).length; }
  likedAt = {};
  async _favoriteTracks() {
    const r = await this._fetch('/api/likes?full=1');
    const items = (r.items || []).map((t) => { const row = rowTrack(t); row.UserData.IsFavorite = true; return row; });
    return { items: this.orderLiked(items), total: items.length };
  }
  orderLiked(items) {
    const at = this.likedAt || {};
    const known = items.filter((t) => at[t.Id]).sort((a, b) => at[b.Id] - at[a.Id]);
    return [...known, ...items.filter((t) => !at[t.Id])];
  }
  async container(itemId) { return this._cached(`container:${itemId}`, async () => ((await this.itemById(itemId))?.Container || '').toLowerCase()); }

  // --- pictures ------------------------------------------------------------------
  bustImage(itemId) { (this._bust ||= {})[itemId] = Date.now(); }
  imageQuality = 82;
  imageUrl(itemId, { maxHeight = 480 } = {}) {
    if (!itemId) return null;
    const q = { size: String(maxHeight) };
    if (this._bust?.[itemId]) q.v = String(this._bust[itemId]);
    return this._url(`/api/image/${itemId}`, q);
  }
  // Wide artist banner (the portrait cropped wide), or nothing.
  bannerUrl(item) {
    if (item?.BackdropImageTags?.length) return this._url(`/api/image/${item.Id}`, { kind: 'banner' });
    if (item?.ImageTags?.Primary) return this.imageUrl(item.Id, { maxHeight: 640 });
    return null;
  }

  // --- playback reporting ---------------------------------------------------------
  // Plays are logged from the session socket while it is connected; this is
  // the fallback for a client playing with no socket.
  reportStart(itemId) { return this._fetch('/api/plays', { method: 'POST', body: JSON.stringify({ trackId: itemId, at: Date.now(), client: 'web' }) }).catch(() => null); }
  reportProgress() { return Promise.resolve(null); }
  reportStop() { return Promise.resolve(null); }

  // --- admin -------------------------------------------------------------------------
  adminStatus() { return this._fetch('/api/admin/status'); }
  adminScan() { return this._fetch('/api/admin/scan', { method: 'POST' }); }
  adminEnrich() { return this._fetch('/api/admin/enrich', { method: 'POST' }); }
  users() { return this._fetch('/api/users'); }
  setRole(userId, role) { return this._fetch(`/api/users/${userId}/role`, { method: 'POST', body: JSON.stringify({ role }) }); }
  deleteUser(userId) { return this._fetch(`/api/users/${userId}`, { method: 'DELETE' }); }
  createInvite() { return this._fetch('/api/invites', { method: 'POST', body: '{}' }); }
  changePassword(current, password) { return this._fetch('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, password }) }); }
  devices() { return this._fetch('/api/auth/devices'); }
}

export function persistSession(session) { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
export function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
export function clearSession() { localStorage.removeItem(SESSION_KEY); }
