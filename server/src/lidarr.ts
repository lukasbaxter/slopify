// Lidarr, spoken natively. Lidarr owns the catalog beyond the library
// (MusicBrainz release groups through its metadata proxy) and the download
// machinery (indexers, download clients, import). This module is the one
// place that talks to its API; discover.ts, downloads.ts and ai.ts consume
// it. Release ids everywhere are MusicBrainz release-group ids
// (Lidarr's foreignAlbumId), so a request survives either side restarting.
//
// Imports land instantly through the webhook route registered below:
// a Webhook notification in Lidarr pointed at
//   POST <slopify>/api/hooks/lidarr?key=<api key>
// scans just the folders an import touched.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

export type LidarrOptions = {
  url: string; apiKey: string;
  root?: string;             // the library as Lidarr's container sees it
  qualityProfile?: string;   // name or id for artists we add; blank = first
  metadataProfile?: string;
  searchOnRequest?: boolean; // also fire AlbumSearch on every request
  fetcher?: typeof fetch; log?: (m: string) => void;
};

// A release as the discover/search/radar pages show it.
export type Release = { album_id: string; artist: string; title: string; rtype: string; year: string; date: string; image: string | null; total_tracks: number };

// An album's live state for the Downloads page.
export type AlbumState = {
  id: number; album_id: string; artist: string; title: string; rtype: string; year: string; image: string | null;
  total: number; done: number; monitored: boolean; hasFiles: boolean;
  queue: { state: 'downloading' | 'failed'; detail: string | null } | null;
};

const norm = (s: string) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Only real URLs leave this module: Lidarr swaps an added artist's remote
// image for its own /MediaCover path, which no browser here can reach.
const webImage = (images: any[] | undefined, kind: string) => {
  const u = images?.find((i: any) => i.coverType === kind)?.remoteUrl || images?.[0]?.remoteUrl || null;
  return u && /^https?:/.test(u) ? u : null;
};

const releaseOf = (a: any): Release => ({
  album_id: a.foreignAlbumId,
  artist: a.artist?.artistName || '',
  title: a.title,
  rtype: (a.secondaryTypes || []).includes('Compilation') ? 'Compilation' : a.albumType || 'Album',
  year: String(a.releaseDate || '').slice(0, 4),
  date: String(a.releaseDate || '').slice(0, 10),
  image: webImage(a.images, 'cover'),
  total_tracks: a.statistics?.totalTrackCount ?? 0,
});

const stateOf = (a: any, queue: Map<number, { state: 'downloading' | 'failed'; detail: string | null }>): AlbumState => ({
  id: a.id, ...releaseOf(a),
  total: a.statistics?.totalTrackCount ?? 0, done: a.statistics?.trackFileCount ?? 0,
  monitored: Boolean(a.monitored), hasFiles: (a.statistics?.trackFileCount ?? 0) > 0,
  queue: queue.get(a.id) ?? null,
});

export function lidarrClient(opts: LidarrOptions) {
  const base = (opts.url || '').replace(/\/+$/, '');
  const f = opts.fetcher ?? fetch;
  const log = opts.log ?? (() => {});
  const cache = new Map<string, { at: number; v: any }>();
  const cached = (k: string, ttl: number) => { const e = cache.get(k); return e && Date.now() - e.at < ttl ? e.v : null; };
  const remember = <T>(k: string, v: T): T => { cache.set(k, { at: Date.now(), v }); return v; };

  const api = async (p: string, init?: RequestInit & { timeoutMs?: number }) => {
    const r = await f(`${base}/api/v1${p}`, {
      ...init,
      headers: { 'X-Api-Key': opts.apiKey, ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
      signal: AbortSignal.timeout(init?.timeoutMs ?? 20000),
    });
    if (!r.ok) throw new Error(`Lidarr ${p.split('?')[0]} ${r.status}`);
    return r.status === 204 ? null : r.json() as Promise<any>;
  };

  // A profile given as a name or an id; blank means Lidarr's first.
  const profileId = async (kind: 'qualityprofile' | 'metadataprofile', want: string | undefined) => {
    const all = cached(kind, 10 * 60 * 1000) || remember(kind, await api(`/${kind}`));
    if (want) {
      const hit = all.find((p: any) => String(p.id) === want || norm(p.name) === norm(want));
      if (hit) return hit.id;
      log(`lidarr: no ${kind} "${want}", using ${all[0]?.name}`);
    }
    return all[0]?.id;
  };

  const allArtists = async () => cached('artists', 60 * 1000) || remember('artists', await api('/artist'));

  // The artist in Lidarr, added (unmonitored) from a lookup result when it
  // is not there yet. `from` skips the lookup when a caller already has the
  // full lookup artist (a request for an album of a brand-new artist).
  const ensureArtist = async (name: string, from?: any) => {
    const have = (await allArtists()).find((a: any) =>
      (from?.foreignArtistId && a.foreignArtistId === from.foreignArtistId) || norm(a.artistName) === norm(name));
    if (have) return have;
    const cand = from ?? await api(`/artist/lookup?term=${encodeURIComponent(name)}`, { timeoutMs: 30000 })
      .then((r: any[]) => (r || []).find((a) => norm(a.artistName) === norm(name)) || (r || [])[0]);
    if (!cand) return null;
    if (cand.id) return cand; // the lookup already knew it
    const added = await api('/artist', {
      method: 'POST',
      body: JSON.stringify({
        ...cand,
        rootFolderPath: opts.root || '/music',
        qualityProfileId: await profileId('qualityprofile', opts.qualityProfile),
        metadataProfileId: await profileId('metadataprofile', opts.metadataProfile),
        monitored: false, monitorNewItems: 'none',
        addOptions: { monitor: 'none', searchForMissingAlbums: false, searchForCutoffUnmetAlbums: false },
      }),
      timeoutMs: 60000,
    });
    cache.delete('artists');
    log(`lidarr: added ${added.artistName} (unmonitored)`);
    return added;
  };

  // A fresh artist's albums arrive with its first metadata refresh: poll a bit.
  const artistAlbums = async (artistId: number, waitMs = 30000) => {
    const until = Date.now() + waitMs;
    for (;;) {
      const albums = await api(`/album?artistId=${artistId}`);
      if (albums?.length || Date.now() > until) return albums || [];
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  const albumByForeign = async (fid: string) => ((await api(`/album?foreignAlbumId=${encodeURIComponent(fid)}`)) || [])[0] || null;

  // What is on the way or waiting, keyed by Lidarr's album id and by
  // release-group id. Cached a few seconds: every open page polls this.
  const activity = async (): Promise<{ queue: Map<number, { state: 'downloading' | 'failed'; detail: string | null }>; wanted: Map<string, number> }> => {
    const hit = cached('activity', 5 * 1000); if (hit) return hit;
    const [q, w] = await Promise.all([
      api('/queue?pageSize=1000&includeAlbum=true').catch(() => ({ records: [] })),
      api('/wanted/missing?pageSize=1000').catch(() => ({ records: [] })),
    ]);
    const queue = new Map<number, { state: 'downloading' | 'failed'; detail: string | null }>();
    for (const r of q.records || []) {
      if (!r.albumId) continue;
      const bad = r.trackedDownloadStatus === 'warning' || r.status === 'failed';
      queue.set(r.albumId, { state: bad ? 'failed' : 'downloading', detail: r.errorMessage || r.status || null });
    }
    const wanted = new Map<string, number>((w.records || []).map((r: any) => [r.foreignAlbumId, r.id]));
    return remember('activity', { queue, wanted });
  };

  return {
    enabled: Boolean(base && opts.apiKey),

    // The full discography for an artist name: every release group Lidarr's
    // metadata knows, plus the artist's picture. Adds the artist to Lidarr
    // (unmonitored) when it is new there - that is what makes Lidarr fetch
    // and keep the discography.
    async discography(name: string): Promise<{ artist: { name: string; image: string | null } | null; releases: Release[] }> {
      const artist = await ensureArtist(name);
      if (!artist?.id) return { artist: null, releases: [] };
      const albums = await artistAlbums(artist.id);
      return {
        artist: { name: artist.artistName, image: webImage(artist.images, 'poster') },
        releases: albums.map(releaseOf),
      };
    },

    // Album search across Lidarr's metadata (the search page's "Everywhere").
    async search(q: string): Promise<Release[]> {
      const r = await api(`/album/lookup?term=${encodeURIComponent(q)}`, { timeoutMs: 30000 }).catch((e: any) => { log(`lidarr search "${q}": ${e.message}`); return []; });
      return (r || []).map(releaseOf);
    },

    // Request a release group: make sure its artist is in Lidarr, monitor the
    // album (that puts it on the wanted list every downloader watches), and
    // optionally fire Lidarr's own indexer search.
    async request(fid: string): Promise<{ id?: number; album_id: string; artist: string; title: string; status: string }> {
      let album = await albumByForeign(fid);
      if (!album) {
        const look = ((await api(`/album/lookup?term=lidarr:${encodeURIComponent(fid)}`, { timeoutMs: 30000 })) || [])[0];
        if (!look) throw new Error('no such release');
        await ensureArtist(look.artist?.artistName || '', look.artist);
        const until = Date.now() + 30000;
        while (!album && Date.now() < until) { await new Promise((r) => setTimeout(r, 2000)); album = await albumByForeign(fid); }
        if (!album) throw new Error('Lidarr is still fetching the artist, try again shortly');
      }
      const out = { id: album.id as number, album_id: fid, artist: album.artist?.artistName || '', title: album.title as string };
      if ((album.statistics?.trackFileCount ?? 0) >= (album.statistics?.totalTrackCount || 1)) return { ...out, status: 'exists' };
      if (!album.monitored) await api('/album/monitor', { method: 'PUT', body: JSON.stringify({ albumIds: [album.id], monitored: true }) });
      // The wanted list only lists albums of monitored artists.
      if (!album.artist?.monitored) {
        await api(`/artist/${album.artist.id}`, { method: 'PUT', body: JSON.stringify({ ...album.artist, monitored: true, monitorNewItems: 'none' }) });
        cache.delete('artists');
      }
      if (opts.searchOnRequest) await api('/command', { method: 'POST', body: JSON.stringify({ name: 'AlbumSearch', albumIds: [album.id] }) }).catch((e: any) => log(`lidarr search cmd: ${e.message}`));
      cache.delete('activity');
      return { ...out, status: 'queued' };
    },

    // release-group id -> request state, for flagging discographies and search
    // results ('queued' | 'downloading' | 'failed').
    async statuses(): Promise<Map<string, { status: string; updated: number }>> {
      if (!this.enabled) return new Map();
      const { queue, wanted } = await activity();
      const out = new Map<string, { status: string; updated: number }>();
      for (const fid of wanted.keys()) out.set(fid, { status: 'queued', updated: 0 });
      for (const [albumId, s] of queue) {
        const a = cached(`fid:${albumId}`, 10 * 60 * 1000) || remember(`fid:${albumId}`, await api(`/album/${albumId}`).catch(() => null));
        if (a?.foreignAlbumId) out.set(a.foreignAlbumId, { status: s.state === 'failed' ? 'failed' : 'downloading', updated: 0 });
      }
      return out;
    },

    // Live state of specific albums (the Downloads page's "Yours").
    async albums(ids: number[]): Promise<AlbumState[]> {
      if (!ids.length) return [];
      const { queue } = await activity();
      const q = ids.map((i) => `albumIds=${i}`).join('&');
      return (((await api(`/album?${q}`)) || []) as any[]).map((a) => stateOf(a, queue));
    },

    // Everything wanted or moving, whoever asked (the Downloads page's "Everyone").
    async all(): Promise<AlbumState[]> {
      const { queue, wanted } = await activity();
      const ids = new Set<number>([...queue.keys()]);
      for (const id of wanted.values()) ids.add(id);
      return this.albums([...ids]);
    },

    // Try again: make sure it is monitored and fire an indexer search now.
    async retry(albumId: number) {
      const a = await api(`/album/${albumId}`);
      if (!a) throw new Error('no such album');
      if (!a.monitored) await api('/album/monitor', { method: 'PUT', body: JSON.stringify({ albumIds: [albumId], monitored: true }) });
      if (!a.artist?.monitored) await api(`/artist/${a.artist.id}`, { method: 'PUT', body: JSON.stringify({ ...a.artist, monitored: true, monitorNewItems: 'none' }) });
      await api('/command', { method: 'POST', body: JSON.stringify({ name: 'AlbumSearch', albumIds: [albumId] }) });
      cache.delete('activity');
    },

    // The release group a loose song belongs to: Deezer finds the album for
    // the artist+title (no key needed), Lidarr's metadata search pins the
    // release group. For generated playlists' missing songs.
    async releaseForTrack(artist: string, title: string): Promise<{ album_id: string; artist: string; title: string } | null> {
      const dz = await f(`https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}&limit=5`, { signal: AbortSignal.timeout(10000) })
        .then((r) => r.json() as any).catch(() => null);
      const hit = (dz?.data || []).find((t: any) => norm(t.artist?.name) === norm(artist)) || (dz?.data || [])[0];
      if (!hit?.album?.title) return null;
      const found = await this.search(`${hit.artist?.name || artist} ${hit.album.title}`);
      const best = found.find((r) => norm(r.title) === norm(hit.album.title) && norm(r.artist) === norm(hit.artist?.name || artist)) || found.find((r) => norm(r.title) === norm(hit.album.title));
      return best ? { album_id: best.album_id, artist: best.artist, title: best.title } : null;
    },
  };
}

export type Lidarr = ReturnType<typeof lidarrClient>;

// Lidarr tells us the moment it imports: scan just those folders so the
// album is playable seconds later. Point a Lidarr Webhook notification
// (on Release Import + on Upgrade) at /api/hooks/lidarr?key=<LIDARR_API_KEY>.
export function registerLidarrHook(app: FastifyInstance, opts: { apiKey: string; musicDir: string; lidarrRoot: string }) {
  app.post('/api/hooks/lidarr', async (req: any, reply) => {
    if (!opts.apiKey || String(req.query?.key || '') !== opts.apiKey) return reply.code(401).send({ error: 'bad key' });
    const b = req.body || {};
    if (b.eventType === 'Test') return { ok: true };
    const root = path.posix.resolve(opts.lidarrRoot || '/music');
    const dirs = [...new Set<string>(((b.trackFiles || []) as any[])
      .map((t) => path.posix.dirname(String(t.path || '')))
      .filter((d) => d.startsWith(root + '/'))
      .map((d) => path.posix.relative(root, d)))];
    if (!dirs.length) return { ok: true, scanned: [] };
    app.log.info(`lidarr import: ${b.artist?.name || ''} - ${b.album?.title || ''} (${dirs.join(', ')})`);
    const scan = (app as any).scanFolders;
    if (scan) await scan(dirs).catch((e: any) => app.log.error(`lidarr import scan: ${e.message}`));
    return { ok: true, scanned: dirs };
  });
}
