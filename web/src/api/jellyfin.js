// Minimal Jellyfin client, scoped to what a music app actually needs.
//
// Important: stream and artwork URLs are handed to Chromecast and BluOS devices,
// which fetch them over the network themselves. They must therefore be absolute
// LAN URLs carrying their own api_key -- a relative path or a localhost address
// works in the app window and fails silently on the speaker.

import { lyricsFast, libraryFast, homeFast } from './search.js';

const CLIENT = 'Conduit';
const VERSION = '0.1.0';

function deviceId() {
  const KEY = 'conduit.deviceId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `conduit-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

function authHeader(token) {
  const parts = [
    `Client="${CLIENT}"`,
    // Real machine name from the main process; navigator.platform is just
    // "MacIntel" and makes every Mac look identical in Jellyfin's session list.
    `Device="${(typeof window !== 'undefined' && window.conduit?.deviceName) || navigator.platform || 'Desktop'}"`,
    `DeviceId="${deviceId()}"`,
    `Version="${VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

// Jellyfin creates one MusicArtist per distinct spelling in the tags ("Tones
// and I" / "Tones And I", a BOM-prefixed "Daft Punk", "JAY-Z" with a Unicode
// hyphen) yet matches songs to any of them case-insensitively, so showing
// more than one is pure noise. The library tags are normalised server-side
// (tools/library-hygiene), this guards against the next download.
const ARTIST_TYPO = /[\u2010-\u2015\u2212]/g;
export function artistKey(name) {
  return (name || '').replace(/[\uFEFF\u200B]/g, '').replace(ARTIST_TYPO, '-')
    .replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}
export function dedupeArtists(items) {
  const seen = new Map();
  for (const a of items) {
    const k = artistKey(a.Name);
    const prev = seen.get(k);
    // keep the one with a portrait; otherwise the first (sorted) spelling
    if (!prev || (!prev.ImageTags?.Primary && a.ImageTags?.Primary)) seen.set(k, a);
  }
  return items.filter((a) => seen.get(artistKey(a.Name)) === a);
}

export class Jellyfin {
  constructor({ baseUrl, token = null, userId = null }) {
    // Trailing slashes produce double-slash URLs that some reverse proxies 404.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.userId = userId;
    // Session cache for list reads. A click should never wait on a fetch for
    // something already shown once; mutations evict what they change.
    this._cache = new Map();
  }

  // Per-user localStorage namespace. Computed, not captured at construction:
  // login() builds the client BEFORE it knows the user id, so anything written
  // in that first session would otherwise land under a different prefix from
  // the one a restored session reads.
  get _lsPrefix() { return `conduit.cache.${this.userId || 'x'}.`; }

  // Read a persisted value written on a previous run (survives reload).
  persisted(key) {
    try {
      const raw = localStorage.getItem(this._lsPrefix + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  _persist(key, value) {
    try { localStorage.setItem(this._lsPrefix + key, JSON.stringify(value)); }
    catch { /* quota or private mode; the in-memory cache still works */ }
  }

  _cached(key, fn) {
    if (this._cache.has(key)) return Promise.resolve(this._cache.get(key));
    return fn().then((v) => { this._cache.set(key, v); return v; });
  }
  // Same, but only for `ms`: the play-history queries cost Jellyfin 1.5-3 s
  // each tonight and Home + every album page asked for them again.
  _cachedFor(key, ms, fn) {
    const hit = this._cache.get(key);
    if (hit && hit._at && Date.now() - hit._at < ms) return Promise.resolve(hit.v);
    return fn().then((v) => { this._cache.set(key, { _at: Date.now(), v }); return v; });
  }

  _evict(prefix) {
    for (const k of [...this._cache.keys()]) if (k.startsWith(prefix)) this._cache.delete(k);
  }

  async _fetch(path, options = {}) {
    const { retries = 0, timeoutMs = 45_000, ...opts } = options;
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...opts,
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader(this.token),
            ...(opts.headers || {}),
          },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`Jellyfin ${res.status} on ${path}${body ? `: ${body.slice(0, 180)}` : ''}`);
          err.status = res.status;
          // 5xx / 502-504 from the proxy while the server is busy: worth another go.
          if (res.status >= 500 && attempt < retries) throw Object.assign(err, { retry: true });
          throw err;
        }
        return res.status === 204 ? null : res.json();
      } catch (e) {
        // Network failure or timeout (a scan/refresh can make Jellyfin crawl):
        // retry the idempotent writes instead of reverting the user's action.
        const transient = e.retry || e.name === 'AbortError' || e instanceof TypeError;
        if (!transient || attempt >= retries) throw e;
        attempt += 1;
        await new Promise((r) => setTimeout(r, 800 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  static async login(baseUrl, username, password) {
    // The public host serves Jellyfin under /jf; typing just the host on the
    // desktop login posted to the static site (405) and read as a bad password.
    baseUrl = baseUrl.trim().replace(/\/+$/, '');
    if (/^https?:\/\/music\.baxtergroup\.io$/i.test(baseUrl)) baseUrl += '/jf';
    const client = new Jellyfin({ baseUrl });
    const data = await client._fetch('/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    client.token = data.AccessToken;
    client.userId = data.User.Id;
    return client;
  }

  // The signed-in user's profile picture, if they set one in Jellyfin.
  userImageUrl({ maxHeight = 96 } = {}) {
    const q = new URLSearchParams({ maxHeight: String(maxHeight), api_key: this.token });
    if (this._bust?.user) q.set('v', String(this._bust.user));
    return `${this.baseUrl}/Users/${this.userId}/Images/Primary?${q}`;
  }

  // Profile picture. A user may set their own; the body is base64.
  async uploadUserImage(file) {
    const buf = await file.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const res = await fetch(`${this.baseUrl}/Users/${this.userId}/Images/Primary`, {
      method: 'POST', body: btoa(bin),
      headers: { 'Content-Type': file.type || 'image/jpeg', Authorization: authHeader(this.token) },
    });
    if (!res.ok) throw new Error(`Jellyfin ${res.status} uploading profile picture`);
    (this._bust ||= {}).user = Date.now();
  }

  // --- account settings (Jellyfin DisplayPreferences, client "conduit") ----
  // CustomPrefs is a string->string map; structured values are JSON inside.
  async getPrefs() {
    const q = new URLSearchParams({ userId: this.userId, client: 'conduit' });
    const dp = await this._fetch(`/DisplayPreferences/conduit?${q}`);
    this._dp = dp;
    const out = {};
    for (const [k, v] of Object.entries(dp.CustomPrefs || {})) {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    }
    return out;
  }

  async setPrefs(patch) {
    // Jellyfin replaces the whole CustomPrefs blob on write, so re-read it
    // first: writing a stale copy from THIS client used to wipe keys other
    // clients had just saved (that is how likedAt kept vanishing).
    await this.getPrefs();
    const dp = { ...this._dp, Client: 'conduit', CustomPrefs: { ...(this._dp.CustomPrefs || {}) } };
    for (const [k, v] of Object.entries(patch)) dp.CustomPrefs[k] = typeof v === 'string' ? v : JSON.stringify(v);
    const q = new URLSearchParams({ userId: this.userId, client: 'conduit' });
    await this._fetch(`/DisplayPreferences/conduit?${q}`, { method: 'POST', body: JSON.stringify(dp), retries: 2 });
    this._dp = dp;
  }

  // What the local player streams: the original file unless the account asked
  // for a smaller transcode. Speakers always get the original (the transcoded
  // stream is unseekable on BluOS, see streamUrl).
  quality = 'original';
  // How the local element gets a transcode:
  //  'file'    original file, byte ranges, seeks natively;
  //  'hls'     Safari/iOS: Jellyfin's HLS (3-second AAC segments fetched as
  //            needed, seeks natively). iOS would not play the chunked
  //            transcode at all on cellular;
  //  'chunked' everything else: one progressive MP3 with no Content-Length and
  //            no byte ranges, so the player seeks by asking for a new stream
  //            that starts at `startAt` and keeps that as the stream's base.
  streamMode() {
    if (!{ high: 320000, normal: 160000, low: 96000 }[this.quality]) return 'file';
    const hls = typeof document !== 'undefined' && !!document.createElement('audio').canPlayType('application/vnd.apple.mpegurl');
    return hls ? 'hls' : 'chunked';
  }
  transcoded() { return this.streamMode() === 'chunked'; }
  // HLS only: asking for the playlist makes Jellyfin start the transcode, so
  // by the time the element asks, the playlist and first segments are warm
  // (~0.6 s of server work otherwise paid at the tap or the track change).
  _warm = new Map();
  prewarm(itemId) {
    if (!itemId || this.streamMode() !== 'hls') return;
    const at = this._warm.get(itemId); if (at && Date.now() - at < 60000) return;
    this._warm.set(itemId, Date.now());
    fetch(this.playbackUrl(itemId), { headers: { Authorization: authHeader(this.token) } }).then((r) => r.text()).catch(() => {});
  }
  playbackUrl(itemId, { startAt = 0 } = {}) {
    const q = { high: 320000, normal: 160000, low: 96000 }[this.quality];
    const mode = this.streamMode();
    if (mode === 'file') return this.streamUrl(itemId);
    if (mode === 'hls') {
      const p = new URLSearchParams({ audioCodec: 'aac', audioBitRate: String(q), segmentContainer: 'ts', api_key: this.token });
      return `${this.baseUrl}/Audio/${itemId}/main.m3u8?${p}`;
    }
    return this.transcodeUrl(itemId, { codec: 'mp3', bitrate: q, startAt });
  }

  async me() {
    return this._fetch(`/Users/${this.userId}`);
  }

  async publicInfo() {
    return this._fetch('/System/Info/Public');
  }

  // --- library ------------------------------------------------------------

  // Album and artist lists come from the relay's index (Jellyfin took 5-12 s
  // for the albums alone tonight); Jellyfin is the fallback.
  _library() { if (!this._libraryP) this._libraryP = this._cachedFor('library', 10 * 60 * 1000, () => libraryFast(this)).finally(() => { this._libraryP = null; }); return this._libraryP; }
  async albums(opts = {}) {
    if (!opts.search) { try { const l = await this._library(); if (l?.albums?.length) return { items: l.albums.slice(opts.startIndex || 0, (opts.startIndex || 0) + (opts.limit || l.albums.length)), total: l.albums.length }; } catch { /* relay down */ } }
    return this._albumsJf(opts);
  }
  async _albumsJf({ limit = 500, startIndex = 0, search = null } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      // No ChildCount: it nearly doubled the query (12.5 s vs 7 s for 500 albums); the album page counts its own tracks.
      Fields: 'PrimaryImageAspectRatio,ProductionYear',
      Limit: String(limit),
      StartIndex: String(startIndex),
      userId: this.userId,
    });
    if (search) q.set('searchTerm', search);
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  async artists(opts = {}) {
    if (!opts.search) { try { const l = await this._library(); if (l?.artists?.length) return { items: l.artists.slice(opts.startIndex || 0, (opts.startIndex || 0) + (opts.limit || l.artists.length)), total: l.artists.length }; } catch { /* relay down */ } }
    return this._artistsJf(opts);
  }
  async _artistsJf({ limit = 500, startIndex = 0, search = null } = {}) {
    const q = new URLSearchParams({
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: String(limit),
      StartIndex: String(startIndex),
      userId: this.userId,
    });
    if (search) q.set('searchTerm', search);
    const data = await this._fetch(`/Artists?${q}`);
    const items = dedupeArtists(data.Items || []);
    return { items, total: (data.TotalRecordCount ?? 0) - ((data.Items || []).length - items.length) };
  }

  // Albums this user has played most recently -- feeds the home shortcuts and
  // the "Recently played" shelf, both of which Spotify drives from history.
  _home() { return this._cachedFor('home', 3 * 60 * 1000, () => homeFast(this)); }
  recentlyPlayedAlbums(opts = {}) {
    return this._cachedFor(`recentAlbums:${opts.limit || 8}`, 5 * 60 * 1000, async () => {
      try { const h = await this._home(); if (h?.recentAlbums?.length) return { items: h.recentAlbums.slice(0, opts.limit || 8) }; } catch { /* relay down */ }
      return this._recentlyPlayedAlbums(opts);
    });
  }
  async _recentlyPlayedAlbums({ limit = 8 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Filters: 'IsPlayed',
      Fields: 'ParentId',
      Limit: '200',
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    // Collapse tracks to their albums, keeping play order.
    const seen = new Set();
    const ids = [];
    for (const t of data.Items || []) {
      const id = t.AlbumId;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      if (ids.length >= limit) break;
    }
    if (!ids.length) return { items: [] };
    const q2 = new URLSearchParams({ Ids: ids.join(','), userId: this.userId, Fields: 'ProductionYear' });
    const d2 = await this._fetch(`/Items?${q2}`);
    const byId = new Map((d2.Items || []).map((a) => [a.Id, a]));
    return { items: ids.map((id) => byId.get(id)).filter(Boolean) };
  }

  // The last track this account played anywhere (Jellyfin's own history), for
  // a client that has nothing remembered locally and no live session to mirror.
  async lastPlayedTrack() {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio', Recursive: 'true', SortBy: 'DatePlayed', SortOrder: 'Descending',
      Filters: 'IsPlayed', Fields: 'ParentId,ArtistItems,AlbumArtists,UserData', Limit: '1', userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return (data.Items || [])[0] || null;
  }

  // Most-played tracks (Spotify's "Top tracks this month" on the profile page).
  topTracks(opts = {}) {
    return this._cachedFor(`topTracks:${opts.limit || 50}`, 5 * 60 * 1000, async () => {
      try { const h = await this._home(); if (h?.topTracks?.length) return h.topTracks.slice(0, opts.limit || 50); } catch { /* relay down */ }
      return this._topTracks(opts);
    });
  }
  async _topTracks({ limit = 50 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio', Recursive: 'true', Filters: 'IsPlayed', SortBy: 'PlayCount,DatePlayed', SortOrder: 'Descending',
      Fields: 'ParentId,ArtistItems,AlbumArtists,UserData', Limit: String(limit), userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return data.Items || [];
  }

  async recentlyAddedAlbums({ limit = 8 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: 'true',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Fields: 'ProductionYear',
      Limit: String(limit),
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [] };
  }

  // Albums credited to an artist, newest first (Spotify's discography order).
  artistAlbums(artistId, opts = {}) {
    return this._cached(`artistAlbums:${artistId}`, () => this._artistAlbums(artistId, opts));
  }

  async _artistAlbums(artistId, { limit = 60 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: 'true',
      AlbumArtistIds: artistId,
      SortBy: 'ProductionYear,SortName',
      SortOrder: 'Descending',
      Fields: 'ProductionYear,ChildCount',
      Limit: String(limit),
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  tracks(opts = {}) {
    // Searches are not cached; everything else keyed on its arguments.
    if (opts.search) return this._tracks(opts);
    return this._cached(`tracks:${opts.albumId || ''}:${opts.artistId || ''}:${opts.limit || 500}`, () => this._tracks(opts));
  }

  async _tracks({ albumId = null, artistId = null, limit = 500, search = null } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      Fields: 'ParentId,ArtistItems,AlbumArtists,UserData',
      SortBy: albumId ? 'ParentIndexNumber,IndexNumber,SortName' : 'SortName',
      Limit: String(limit),
      userId: this.userId,
    });
    if (albumId) q.set('ParentId', albumId);
    if (artistId) q.set('ArtistIds', artistId);
    if (search) q.set('searchTerm', search);
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  // Playlists the user actually made. "Your Library" shows only these.
  async playlists({ limit = 200 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Playlist',
      Recursive: 'true',
      SortBy: 'SortName',
      Fields: 'ChildCount,Path',
      Limit: String(limit),
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    // Jellyfin imports stray .m3u/.info/.sfv files left behind by Soulseek rips
    // as empty playlists -- 86 of them in this library, things like "00.info".
    // Those live inside the music folders; playlists made in the app live under
    // Jellyfin's own data dir, so the path is the honest filter (an empty
    // playlist you just created must still show up).
    const items = (data.Items || []).filter(
      (p) =>
        ((p.Path || '').includes('/data/playlists/') || (p.ChildCount ?? 0) > 0) &&
        !/\.(m3u8?|info|sfv|nfo|txt|cue|log)$/i.test(p.Name || '') &&
        (!p.MediaType || p.MediaType === 'Audio' || p.MediaType === 'Unknown')
    );
    return { items, total: items.length };
  }

  playlistTracks(playlistId, opts = {}) {
    if (opts.startIndex != null) return this._playlistTracks(playlistId, opts); // paged, uncached
    return this._cached(`playlist:${playlistId}`, () => this._playlistTracks(playlistId, opts));
  }

  async _playlistTracks(playlistId, { limit = 500, startIndex = 0 } = {}) {
    // Jellyfin resolves playlist entries one by one, so latency scales with the
    // count: ~0.6s for 60, ~3.7s for 500. Callers page it to stay responsive.
    const q = new URLSearchParams({
      userId: this.userId,
      Limit: String(limit),
      StartIndex: String(startIndex),
      Fields: 'ParentId,ArtistItems,AlbumArtists,UserData',
    });
    const data = await this._fetch(`/Playlists/${playlistId}/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  /**
   * Lyrics for a track. Jellyfin 10.9+ serves .lrc sidecars and embedded tags
   * here; this library has ~19,000 .lrc files, which is why filetote carries
   * them alongside the audio during the beets reorganise.
   * Returns [{start: seconds|null, text}] -- start is null for unsynced lyrics.
   */
  async lyrics(itemId) {
    const shape = (data) => (data?.Lyrics || []).map((l) => ({
      start: l.Start != null ? l.Start / 10_000_000 : null,
      text: l.Text || '',
    }));
    // The relay holds every sidecar in RAM and answers in a few ms; Jellyfin
    // is the fallback (a track whose lyrics arrived since the last load).
    try {
      const fast = await lyricsFast(this, itemId);
      if (fast?.Lyrics?.length) return shape(fast);
    } catch { /* relay down or 404: ask Jellyfin */ }
    const q = new URLSearchParams({ api_key: this.token });
    const res = await fetch(`${this.baseUrl}/Audio/${itemId}/Lyrics?${q}`, {
      headers: { Authorization: authHeader(this.token) },
    });
    if (!res.ok) return [];
    return shape(await res.json());
  }

  // Fetch a single item (album, artist, track) by id.
  // Several items in one request (history rows -> playable tracks).
  async itemsByIds(ids) {
    if (!ids.length) return [];
    const q = new URLSearchParams({ Ids: ids.join(','), Fields: 'ParentId,ArtistItems,AlbumArtists,UserData', userId: this.userId });
    const data = await this._fetch(`/Items?${q}`);
    const by = new Map((data.Items || []).map((t) => [t.Id, t]));
    return ids.map((id) => by.get(id)).filter(Boolean);
  }

  itemById(id) {
    return this._cached(`item:${id}`, () => this._itemById(id));
  }

  async _itemById(id) {
    const q = new URLSearchParams({
      Ids: id,
      userId: this.userId,
      Fields: 'PrimaryImageAspectRatio,ProductionYear,ChildCount,Overview',
    });
    const data = await this._fetch(`/Items?${q}`);
    return (data.Items || [])[0] || null;
  }

  async search(term, limit = 40) {
    const [albums, artists, tracks, playlists] = await Promise.all([
      this.albums({ search: term, limit }),
      this.artists({ search: term, limit }),
      this.tracks({ search: term, limit }),
      this.playlists().then((p) => ({
        items: p.items.filter((x) => x.Name.toLowerCase().includes(term.toLowerCase())),
      })),
    ]);
    return { albums: albums.items, artists: artists.items, tracks: tracks.items, playlists: playlists.items };
  }

  // Jellyfin's own "more like this" -- no Last.fm key required. Tracks the
  // user excluded from their taste profile (thumbs-down) never come back here.
  async instantMix(itemId, limit = 100) {
    const q = new URLSearchParams({ userId: this.userId, Limit: String(limit), Fields: 'ParentId,ArtistItems,AlbumArtists,UserData' });
    const data = await this._fetch(`/Items/${itemId}/InstantMix?${q}`);
    return (data.Items || []).filter((t) => t.UserData?.Likes !== false);
  }

  // "Exclude from your taste profile": Jellyfin's per-item thumbs-down. Mixes
  // and smart shuffle skip anything with UserData.Likes === false.
  async setDislike(itemId, disliked) {
    this._evict('tracks:'); this._evict('playlist:'); this._evict('favorites:');
    const path = `/UserItems/${itemId}/Rating`;
    return this._fetch(disliked ? `${path}?likes=false` : path, { method: disliked ? 'POST' : 'DELETE', retries: 2 });
  }

  // Rename a playlist. The generic item update needs admin; the playlist
  // endpoint lets the owner do it.
  async renameItem(itemId, name) {
    this._evict(`item:${itemId}`);
    return this._fetch(`/Playlists/${itemId}`, { method: 'POST', body: JSON.stringify({ Name: name }) });
  }

  // New primary image from a File/Blob (playlist cover). Body is base64.
  async uploadPrimaryImage(itemId, file) {
    const buf = await file.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const res = await fetch(`${this.baseUrl}/Items/${itemId}/Images/Primary`, {
      method: 'POST', body: btoa(bin),
      headers: { 'Content-Type': file.type || 'image/jpeg', Authorization: authHeader(this.token) },
    });
    if (!res.ok) throw new Error(`Jellyfin ${res.status} uploading image`);
  }

  async deleteItem(itemId) {
    this._evict(`item:${itemId}`); this._evict(`playlist:${itemId}`);
    return this._fetch(`/Items/${itemId}`, { method: 'DELETE' });
  }

  // Download URLs. 'original' is the file as stored (with its real filename);
  // the rest are Jellyfin transcodes. WAV is assembled client-side (Jellyfin's
  // transcoder has no wav muxer), see downloadTrack().
  downloadUrl(itemId, fmt = 'original') {
    const key = `api_key=${encodeURIComponent(this.token)}`;
    const t = {
      flac: 'stream.flac?audioCodec=flac',
      mp3: 'stream.mp3?audioCodec=mp3&audioBitRate=320000',
      aac: 'stream.aac?audioCodec=aac&audioBitRate=256000',
      ogg: 'stream.ogg?audioCodec=libvorbis&audioBitRate=320000',
    }[fmt];
    if (!t) return `${this.baseUrl}/Items/${itemId}/Download?${key}`;
    return `${this.baseUrl}/Audio/${itemId}/${t}&${key}`;
  }

  // --- favourites ("Liked Songs") ----------------------------------------

  async setFavorite(itemId, liked) {
    this._evict('favorites:');
    // The track's UserData is embedded in every cached list that contains it.
    this._evict('tracks:'); this._evict('playlist:');
    return this._fetch(`/Users/${this.userId}/FavoriteItems/${itemId}`, {
      method: liked ? 'POST' : 'DELETE', retries: 2,
    });
  }

  // Albums saved to Your Library = Jellyfin favourites on album items.
  async favoriteAlbums({ limit = 500 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'MusicAlbum', Recursive: 'true', Filters: 'IsFavorite', SortBy: 'DateCreated', SortOrder: 'Descending',
      Fields: 'ChildCount,ProductionYear,AlbumArtists', Limit: String(limit), userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [] };
  }

  // Newest likes first, which is how Spotify orders Liked Songs.
  favoriteTracks(opts = {}) {
    return this._cached('favorites:all', () => this._favoriteTracks(opts));
  }

  async favoriteCount() {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio', Recursive: 'true', Filters: 'IsFavorite',
      Limit: '0', userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return data.TotalRecordCount ?? 0;
  }

  // When each track was liked, kept by the app (Jellyfin has no such
  // timestamp); set from account prefs. Anything unknown sorts behind, by the
  // date the file was added -- the old order.
  likedAt = {};
  async _favoriteTracks({ limit = 5000 } = {}) {
    // The whole list, not the first 500: a newly liked old track would land
    // past the cutoff and "vanish" the moment the server list replaced the
    // optimistic row.
    const items = [];
    let start = 0;
    while (items.length < limit) {
      const q = new URLSearchParams({
        IncludeItemTypes: 'Audio', Recursive: 'true', Filters: 'IsFavorite',
        SortBy: 'DateCreated', SortOrder: 'Descending',
        Fields: 'ParentId,ArtistItems,AlbumArtists,UserData',
        Limit: '1000', StartIndex: String(start), userId: this.userId,
      });
      const data = await this._fetch(`/Items?${q}`);
      items.push(...(data.Items || []));
      start += 1000;
      if (start >= (data.TotalRecordCount ?? 0)) break;
    }
    return { items: this.orderLiked(items), total: items.length };
  }

  orderLiked(items) {
    const at = this.likedAt || {};
    const known = items.filter((t) => at[t.Id]).sort((a, b) => at[b.Id] - at[a.Id]);
    const rest = items.filter((t) => !at[t.Id]);
    return [...known, ...rest];
  }

  // Container for one track, fetched lazily at play time so list fetches can
  // skip the heavy MediaSources field. Cached per id.
  async container(itemId) {
    return this._cached(`container:${itemId}`, async () => {
      const q = new URLSearchParams({ Ids: itemId, Fields: 'MediaSources', userId: this.userId });
      const d = await this._fetch(`/Items?${q}`);
      const c = d.Items?.[0]?.MediaSources?.[0]?.Container || '';
      return c.split(',')[0].toLowerCase();
    });
  }

  // --- playlist mutation ---------------------------------------------------

  async createPlaylist(name, itemIds = []) {
    return this._fetch('/Playlists', {
      method: 'POST',
      body: JSON.stringify({ Name: name, Ids: itemIds, UserId: this.userId, MediaType: 'Audio' }),
    });
  }

  async addToPlaylist(playlistId, itemIds) {
    this._evict(`playlist:${playlistId}`);
    const q = new URLSearchParams({ ids: itemIds.join(','), userId: this.userId });
    return this._fetch(`/Playlists/${playlistId}/Items?${q}`, { method: 'POST', retries: 2 });
  }

  // Jellyfin removes by the playlist ENTRY id (PlaylistItemId), not the track id,
  // so the same track added twice can be removed individually.
  async removeFromPlaylist(playlistId, entryIds) {
    this._evict(`playlist:${playlistId}`);
    const q = new URLSearchParams({ entryIds: entryIds.join(',') });
    return this._fetch(`/Playlists/${playlistId}/Items?${q}`, { method: 'DELETE', retries: 2 });
  }

  async movePlaylistItem(playlistId, entryId, newIndex) {
    this._evict(`playlist:${playlistId}`);
    return this._fetch(`/Playlists/${playlistId}/Items/${entryId}/Move/${newIndex}`, { method: 'POST' });
  }

  async deletePlaylist(playlistId) {
    this._evict(`playlist:${playlistId}`);
    return this._fetch(`/Items/${playlistId}`, { method: 'DELETE' });
  }

  async renamePlaylist(playlistId, name) {
    const item = await this._fetch(`/Users/${this.userId}/Items/${playlistId}`);
    return this._fetch(`/Items/${playlistId}`, {
      method: 'POST',
      body: JSON.stringify({ ...item, Name: name }),
    });
  }

  // --- urls handed to remote devices --------------------------------------

  /**
   * Always the static original file. Verified against Jellyfin 10.11 and a
   * Bluesound N125:
   *   - static=true returns Content-Length + Accept-Ranges, and BluOS then
   *     reports canSeek=1 and seeks natively via /Play?seek=N.
   *   - the transcoded offset stream is chunked with no Content-Length and
   *     Accept-Ranges: none, and BluOS SILENTLY REJECTS it -- the play command
   *     returns empty and the player never switches streams.
   * So offsets are applied as a seek after playback starts, never baked into
   * the URL. This also keeps playback bit-perfect instead of re-encoding.
   */
  streamUrl(itemId, { container = null } = {}) {
    const q = new URLSearchParams({ static: 'true', api_key: this.token });
    if (container) q.set('container', container);
    return `${this.baseUrl}/Audio/${itemId}/stream?${q}`;
  }

  // Transcode to MP3 for receivers that will not take FLAC.
  // `startAt` (seconds) makes ffmpeg begin the transcode exactly there -- the
  // only accurate way to start mid-track on a VBR rip (byte-range seeking on
  // the original lands seconds off and still reports the requested time).
  transcodeUrl(itemId, { codec = 'mp3', bitrate = 320000, startAt = 0 } = {}) {
    const q = new URLSearchParams({
      audioCodec: codec,
      audioBitRate: String(bitrate),
      api_key: this.token,
    });
    if (startAt > 0) q.set('startTimeTicks', String(Math.round(startAt * 1e7)));
    return `${this.baseUrl}/Audio/${itemId}/universal?${q}`;
  }

  // After a cover upload every <img> for that item must refetch: bumping a
  // per-item version in the URL beats any cache header.
  bustImage(itemId) { (this._bust ||= {})[itemId] = Date.now(); }

  // Wide artist banner: fanart backdrop when Jellyfin has one, else the portrait.
  bannerUrl(item, { maxWidth = 1600 } = {}) {
    const q = new URLSearchParams({ maxWidth: String(maxWidth), api_key: this.token });
    if (item?.BackdropImageTags?.length) return `${this.baseUrl}/Items/${item.Id}/Images/Backdrop/0?${q}`;
    if (item?.ImageTags?.Primary) return `${this.baseUrl}/Items/${item.Id}/Images/Primary?${q}`;
    return null;
  }

  // JPEG quality: Jellyfin's default is 90, which made an album page 7 MB of
  // covers on the phone (measured: 90 images at 5 Mbps). 72 on a phone, 82
  // elsewhere; both are cached by nginx per (size, quality).
  imageQuality = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches ? 72 : 82;
  imageUrl(itemId, { maxHeight = 480, tag = null, quality = null } = {}) {
    if (!itemId) return null;
    const q = new URLSearchParams({ maxHeight: String(maxHeight), quality: String(quality ?? this.imageQuality), api_key: this.token });
    if (tag) q.set('tag', tag);
    if (this._bust?.[itemId]) q.set('v', String(this._bust[itemId]));
    return `${this.baseUrl}/Items/${itemId}/Images/Primary?${q}`;
  }

  // --- playback reporting -------------------------------------------------
  // Keeps "resume where you left off" and play counts working across clients.

  reportStart(itemId) {
    return this._fetch('/Sessions/Playing', {
      method: 'POST',
      body: JSON.stringify({ ItemId: itemId, PlayMethod: 'DirectStream' }),
    }).catch(() => null);
  }

  reportProgress(itemId, positionSeconds, isPaused = false) {
    return this._fetch('/Sessions/Playing/Progress', {
      method: 'POST',
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: Math.round(positionSeconds * 10_000_000),
        IsPaused: isPaused,
        PlayMethod: 'DirectStream',
      }),
    }).catch(() => null);
  }

  reportStop(itemId, positionSeconds) {
    return this._fetch('/Sessions/Playing/Stopped', {
      method: 'POST',
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: Math.round(positionSeconds * 10_000_000),
      }),
    }).catch(() => null);
  }
}

export function persistSession(session) {
  localStorage.setItem('conduit.session', JSON.stringify(session));
}

export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('conduit.session') || 'null');
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem('conduit.session');
}
