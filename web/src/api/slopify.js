import { linkTier } from './linkSpeed.js';
import { clientIdentity } from './deviceName.js';
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
// Artists this account follows, so any artist row knows its Follow state.
const followedArtists = new Set();
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
export const rowArtist = (a) => ({ Id: a.id, Name: a.name, Type: 'MusicArtist', ChildCount: a.albumCount, ImageTags: a.image ? { Primary: a.image } : {}, BackdropImageTags: a.banner || a.image ? [a.banner || a.image] : [], UserData: { IsFavorite: !!a.followed || followedArtists.has(a.id) } });
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
        // Awaited here so the timeout also covers the body: a response whose
        // body stalls (a phone changing networks) would otherwise hang forever.
        return res.status === 204 ? null : await res.json();
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
      body: JSON.stringify({ username, password, device: clientIdentity().name, kind: clientIdentity().kind, deviceId: deviceId() }),
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
  userImageUrl() {
    // One URL for every spot (the server has a single 512px rendition anyway):
    // per-size URLs cached as separate images and drifted apart after a change.
    const q = {};
    if (this._bust?.user) q.v = String(this._bust.user);
    return this._url(`/api/users/${this.userId}/avatar`, q);
  }
  async uploadUserImage(file) {
    await this._fetch('/api/users/me/avatar', { method: 'POST', raw: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    (this._bust ||= {}).user = Date.now();
  }

  // --- account settings (a JSON blob per user, patched) --------------------
  serverInfo() { return this._cachedFor('serverInfo', 10 * 60 * 1000, () => this._fetch('/api/server')); }
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
  // HLS only. Two things at once: the server transcodes the track (and the
  // playlist comes back complete once it has), and the first segments are
  // fetched so they sit in the browser's disk cache. iOS's native HLS loader
  // reads that cache (it never writes it), so a warmed track starts without
  // a round trip per segment. ~300 KB per warmed track at 320k.
  prewarm(itemId, { segments = 2 } = {}) {
    if (!itemId || this.streamMode() !== 'hls') return;
    const at = this._warm.get(itemId); if (at && Date.now() - at < 60000) return;
    this._warm.set(itemId, Date.now());
    const url = this._url(`/api/stream/${itemId}/hls/${this._profile()}/index.m3u8`);
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    const tok = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    const pull = (tries) => fetch(url).then((r) => r.text()).then((txt) => {
      if (!/#EXT-X-ENDLIST/.test(txt)) { if (tries > 0) setTimeout(() => pull(tries - 1), 2500); return; }
      const segs = (txt.match(/^s\d+\.ts$/gm) || []).slice(0, segments);
      for (const sg of segs) fetch(`${base}${sg}${tok}`).then((r) => r.arrayBuffer()).catch(() => {});
    }).catch(() => {});
    pull(3);
  }
  // Ask the server to transcode these (low priority, in the background).
  warm(itemIds) {
    const ids = (itemIds || []).filter(Boolean).slice(0, 10);
    if (!ids.length || this.streamMode() !== 'hls') return Promise.resolve(null);
    return this._fetch('/api/stream/warm', { method: 'POST', body: JSON.stringify({ ids, profile: this._profile() }), timeoutMs: 8000 }).catch(() => null);
  }
  _profile() { return { high: 'aac-320', normal: 'aac-160', low: 'aac-96' }[this.quality] || 'aac-320'; }
  playbackUrl(itemId, { startAt = 0 } = {}) {
    const mode = this.streamMode();
    if (mode === 'file') return this.streamUrl(itemId);
    // Adaptive up to the chosen quality: on a weak signal iOS drops to a
    // lower one instead of stopping to buffer. (The first segments of the
    // top quality are what prewarm() puts in the cache, so starts stay fast.)
    if (mode === 'hls') return this._url(`/api/stream/${itemId}/hls/master.m3u8`, { max: this._profile() });
    return this.transcodeUrl(itemId, { codec: 'mp3', bitrate: { high: 320000, normal: 160000, low: 96000 }[this.quality], startAt });
  }
  streamUrl(itemId) { return this._url(`/api/stream/${itemId}`); }
  // The whole song as one AAC file at the phone's quality (HLS mode only):
  // what the player keeps in memory to ride out dead zones.
  wholeUrl(itemId) { return this._url(`/api/stream/${itemId}/whole/${this._profile()}`); }
  transcodeUrl(itemId, { bitrate = 320000, startAt = 0 } = {}) {
    const q = { bitrate: String(bitrate) };
    if (startAt > 0) q.startAt = String(Math.round(startAt * 1000) / 1000);
    return this._url(`/api/stream/${itemId}/mp3`, q);
  }
  downloadUrl(itemId, fmt = 'original') { return this._url(`/api/download/${itemId}`, { fmt }); }

  // --- library ----------------------------------------------------------------
  // Whole lists, held for 10 minutes (3,000 albums is one 400 KB response).
  // A track's file format ({ codec, lossless, bitrate, sampleRate, bitDepth }), held for the session.
  trackFormat(id) {
    this._formats = this._formats || new Map();
    if (!this._formats.has(id)) this._formats.set(id, this._fetch(`/api/tracks/${id}`).then((t) => t?.format || null).catch((e) => { this._formats.delete(id); throw e; }));
    return this._formats.get(id);
  }
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
  // "Your Top Songs <year>" from the account's own plays (live + imported).
  topSongYears() {
    return this._cachedFor('topSongs', 10 * 60 * 1000, () => this._fetch(`/api/top-songs?tzo=${new Date().getTimezoneOffset()}`))
      .then((r) => (r.years || []).map((y) => ({ year: y.year, songs: y.songs, plays: y.plays, top: y.top ? rowTrack(y.top) : null })));
  }
  async topSongs(year) { return ((await this._fetch(`/api/top-songs/${year}?tzo=${new Date().getTimezoneOffset()}`)).items || []).map(rowTrack); }
  async lastPlayedTrack() { const h = await this._fetch('/api/history?limit=1'); const t = h.items?.[0]?.track; return t ? rowTrack(t) : null; }

  _artist(artistId) { return this._cached(`artist:${artistId}`, () => this._fetch(`/api/artists/${artistId}`)); }
  // The artist's own albums and collabs, newest first; albums by others they
  // only feature on come separately (the page's Appears On row).
  artistAlbums(artistId, { limit = 60 } = {}) {
    return this._artist(artistId).then((a) => {
      const items = (a.albums || []).map(rowAlbum);
      return { items: items.slice(0, limit), total: items.length, appearsOn: (a.appearsOn || []).map(rowAlbum).slice(0, limit) };
    });
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
  async genreHub(name) { return this._fetch(`/api/genres/${encodeURIComponent(name)}`); }
  async genreMix(name) { return ((await this._fetch(`/api/genres/${encodeURIComponent(name)}/mix`)).items || []).map(rowTrack); }

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

  syncLyrics(itemId) { return this._fetch(`/api/lyrics/${itemId}/sync`, { method: 'POST' }); }
  lyricJobs(ids, { mine = false } = {}) { return this._fetch(mine ? '/api/lyrics/sync?mine=1' : `/api/lyrics/sync?ids=${ids.map(encodeURIComponent).join(',')}`); }
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
    // 100 ids a request (about 3.3 KB of URL). 500 made a 16.5 KB URL: past
    // Node's 16 KB header limit (431) and nginx's 8 KB buffers, which over
    // HTTP/2 can fail the whole connection, the requests beside it included.
    for (let i = 0; i < ids.length; i += 100) {
      const r = await this._fetch(`/api/tracks?ids=${ids.slice(i, i + 100).join(',')}`);
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
  // Songs for a playlist's "Recommended", from the playlist's circle of
  // artists (server: playlistreco.ts). seed = the Refresh generation.
  async playlistRecommended(playlistId, { limit = 10, seed = 0 } = {}) {
    const r = await this._fetch(`/api/playlists/${playlistId}/recommended?limit=${limit}&seed=${seed}`);
    const dis = this._dislikes || {};
    return (r.items || []).map(rowTrack).filter((t) => !dis[t.Id]);
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

  // --- downloads (albums requested through Lidarr) ---------------------------
  downloads(scope = 'mine') { return this._fetch(`/api/downloads?scope=${scope}`, { timeoutMs: 35000 }); }
  retryDownload(id) { return this._fetch(`/api/downloads/${id}/retry`, { method: 'POST' }); }

  // --- generated playlists + Spotify import (server jobs, polled) -----------
  aiStatus() { return this._fetch('/api/ai/status'); }
  generatePlaylist(prompt) { return this._fetch('/api/ai/playlists', { method: 'POST', body: JSON.stringify({ prompt }) }); }
  job(id) { return this._fetch(`/api/jobs/${id}`, { retries: 2 }); }
  // Poll a job until it ends; onStep sees every state on the way.
  async waitJob(job, onStep, signal) {
    let j = job;
    while (j.state === 'running' || j.state === 'queued') {
      onStep?.(j);
      await new Promise((r) => setTimeout(r, 1000));
      if (signal?.aborted) throw new Error('cancelled');
      j = await this.job(j.id);
    }
    onStep?.(j);
    if (j.state === 'error') throw new Error(j.error || 'failed');
    return j.result;
  }
  // XHR, not fetch: an export zip can be hundreds of MB and fetch cannot report upload progress.
  uploadSpotifyFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${this.baseUrl}/api/import/spotify/upload`);
      x.setRequestHeader('Authorization', `Bearer ${this.token || ''}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.setRequestHeader('X-Filename', file.name.replace(/[^\x20-\x7e]/g, '_'));
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      x.onload = () => {
        let body = {}; try { body = JSON.parse(x.responseText); } catch { /* plain */ }
        if (x.status >= 200 && x.status < 300) resolve(body); else reject(new Error(body.error || `upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error('upload failed (network)'));
      x.send(file);
    });
  }
  async importSpotify(fileIds) { const j = await this._fetch('/api/import/spotify', { method: 'POST', body: JSON.stringify({ fileIds }) }); this._cache.clear(); return j; }

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
    if (r?.artist) { if (liked) followedArtists.add(itemId); else followedArtists.delete(itemId); this._evict(`artist:${itemId}`); }
    return r;
  }
  async followedArtists() {
    const items = (await this._fetch('/api/likes/artists')).items || [];
    followedArtists.clear(); for (const a of items) followedArtists.add(a.id);
    return { items: items.map(rowArtist) };
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
  // On a phone, list, grid and mini-player pictures follow the link: the
  // 64 px copy on a slow one (about 1 KB, so a screen of them costs less than
  // one cover), 160 px on a middling one, and on a fast one the size the
  // spot asks for up to 320 px (sharp on a 3x screen). Only the big views ask
  // for `full`: the full-screen player and a page's own header, which paint
  // the small copy first and swap the sharp one in once it has downloaded.
  imageUrl(itemId, { maxHeight = 480, full = false } = {}) {
    if (!itemId) return null;
    const small = !full && typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches;
    let size = maxHeight;
    if (small) { const t = linkTier(); size = t === 'slow' ? 64 : t === 'medium' ? 160 : Math.min(320, Math.max(160, maxHeight)); }
    const q = { size: String(size) };
    if (this._bust?.[itemId]) q.v = String(this._bust[itemId]);
    return this._url(`/api/image/${itemId}`, q);
  }
  // Wide artist banner (the portrait cropped wide), or nothing.
  // The artist page banner, sized for this screen and connection: the full
  // 1280 px photo on a fast link (measured, see linkSpeed.js), 640 px on a
  // small screen, a slower link or with Data Saver on (a quarter of the bytes).
  bannerWidth() {
    const metered = linkTier() !== 'fast';
    const need = (typeof window !== 'undefined' ? window.innerWidth * (window.devicePixelRatio || 1) : 1280);
    return metered || need <= 800 ? 640 : 1280;
  }

  bannerUrl(item) {
    if (item?.BackdropImageTags?.length) return this._url(`/api/image/${item.Id}`, { kind: 'banner', w: this.bannerWidth(), v: String(item.BackdropImageTags[0]).slice(0, 8) });
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
