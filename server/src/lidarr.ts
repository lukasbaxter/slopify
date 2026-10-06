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
import crypto from 'node:crypto';
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
export type Release = { album_id: string; artist: string; title: string; rtype: string; year: string; date: string; image: string | null; total_tracks: number; secondary: string[] };

// An album's live state for the Downloads page.
export type AlbumState = {
  id: number; album_id: string; artist: string; artistId?: number; title: string; rtype: string; year: string; image: string | null;
  total: number; done: number; monitored: boolean; hasFiles: boolean;
  queue: { state: 'downloading' | 'failed'; detail: string | null; protocol?: string | null } | null;
};

type QueueEntry = { state: 'downloading' | 'failed'; detail: string | null; protocol?: string | null };

// MusicBrainz's "Various Artists". Lidarr's album search leaves its releases
// out (movie and game soundtracks, compilations), and no artist refresh ever
// lists them: they exist in Lidarr only once added one by one.
export const VARIOUS_ARTISTS = '89ad4ac3-39f7-470e-963a-56509c546377';
const MB_UA = 'Slopify/0.1 (self-hosted music server; https://github.com/lukasbaxter/slopify)';

// Words people add to a soundtrack search that no release title carries.
const SOUNDTRACK_WORDS = /\b(original\s+)?(motion\s+picture\s+|video\s+game\s+|game\s+)?(soundtracks?|ost|score)\b/gi;

// Game series people search by their initials; titles spell them out.
const ABBREVIATIONS: Record<string, string> = {
  gta: 'grand theft auto', nfs: 'need for speed', cod: 'call of duty', rdr: 'red dead redemption',
  ff: 'final fantasy', mgs: 'metal gear solid', gow: 'god of war', tlou: 'the last of us', botw: 'breath of the wild', totk: 'tears of the kingdom',
};
const ROMAN = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

// A MusicBrainz title query in which every word must match (any-word
// matching let a lone "V" find every album called "V"); a number also
// matches its roman numeral, and series initials their full name.
export function titleQuery(q: string): string {
  const words = q.replace(SOUNDTRACK_WORDS, ' ').replace(/[+\-&|!(){}[\]^"~*?:\\/.,']/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  const terms: string[] = [];
  for (const w of words) {
    const m = /^([a-z]+?)(\d{1,2})$/.exec(w); // "gta5"
    for (const part of m && ABBREVIATIONS[m[1]] ? [m[1], m[2]] : [w]) {
      if (ABBREVIATIONS[part]) terms.push(`"${ABBREVIATIONS[part]}"`);
      else if (/^\d+$/.test(part) && Number(part) >= 1 && Number(part) <= 10) terms.push(`(${part} OR ${ROMAN[Number(part)]})`);
      else if (ROMAN.includes(part) && part) terms.push(`(${part} OR ${ROMAN.indexOf(part)})`);
      else if (part === 'and' || part === 'or' || part === 'not') continue; // operators to Lucene
      else terms.push(part);
    }
  }
  return terms.join(' AND ');
}

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
  secondary: a.secondaryTypes || [],
});

const stateOf = (a: any, queue: Map<number, QueueEntry>): AlbumState => ({
  id: a.id, ...releaseOf(a), artistId: a.artistId ?? a.artist?.id,
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
  // Two concurrent calls for the same artist share one run: Lidarr answers
  // the second POST /artist with a 400 for the duplicate.
  const addingArtist = new Map<string, Promise<any>>();
  const ensureArtist = (name: string, from?: any): Promise<any> => {
    const key = String(from?.foreignArtistId || norm(name));
    let p = addingArtist.get(key);
    if (!p) {
      p = ensureArtistNow(name, from).finally(() => addingArtist.delete(key));
      addingArtist.set(key, p);
    }
    return p;
  };
  const ensureArtistNow = async (name: string, from?: any) => {
    // With `from` in hand the foreignArtistId decides: a namesake already in
    // Lidarr is a different artist, and the `from` one still gets added.
    const have = (await allArtists()).find((a: any) => from?.foreignArtistId
      ? a.foreignArtistId === from.foreignArtistId || (norm(a.artistName) === norm(name) && !a.foreignArtistId)
      : norm(a.artistName) === norm(name));
    if (have) return fitProfile(have);
    // The lookup's first result is only trusted when its name at least
    // contains (or is contained by) the requested one; anything farther off
    // would add a stranger to the library.
    const close = (a: any) => { const c = norm(a?.artistName), w = norm(name); return Boolean(c && w && (c.includes(w) || w.includes(c))); };
    const cand = from ?? await api(`/artist/lookup?term=${encodeURIComponent(name)}`, { timeoutMs: 30000 })
      .then((r: any[]) => (r || []).find((a) => norm(a.artistName) === norm(name)) || (r || []).find(close) || null);
    if (!cand) return null;
    if (cand.id) return fitProfile(cand); // the lookup already knew it
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

  // An artist already in Lidarr (added by hand, or an older setup) may sit
  // on another metadata profile than the configured one - Lidarr's default
  // lists studio albums only, so the artist page's "not in your library"
  // came up empty for an artist whose albums were all here. When a profile
  // is configured, move the artist onto it and wait for the refresh that
  // fetches the releases it now allows (they are read right after).
  const fitProfile = async (artist: any) => {
    if (!opts.metadataProfile || !artist?.id) return artist;
    const want = await profileId('metadataprofile', opts.metadataProfile);
    if (!want || artist.metadataProfileId === want) return artist;
    const moved = await api(`/artist/${artist.id}`, { method: 'PUT', body: JSON.stringify({ ...artist, metadataProfileId: want }) });
    cache.delete('artists');
    log(`lidarr: ${artist.artistName} moved to metadata profile ${want}`);
    try {
      const cmd = await api('/command', { method: 'POST', body: JSON.stringify({ name: 'RefreshArtist', artistIds: [artist.id] }) });
      const until = Date.now() + 60000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1500));
        const c = await api(`/command/${cmd.id}`);
        if (['completed', 'failed', 'aborted', 'cancelled'].includes(c?.status)) break;
      }
    } catch (e: any) { log(`lidarr refresh ${artist.artistName}: ${e.message}`); }
    return moved ?? artist;
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

  // Albums by Lidarr id, in chunks: the ids ride the query string and
  // Lidarr's request line tops out near 8KB (~550 ids), so 100 per GET,
  // a few in flight at once.
  const albumsByIds = async (ids: number[]): Promise<any[]> => {
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    const out: any[] = [];
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      for (let c = chunks.shift(); c; c = chunks.shift()) out.push(...(((await api(`/album?${c.map((i) => `albumIds=${i}`).join('&')}`)) || []) as any[]));
    }));
    return out;
  };

  // Every record of a paged endpoint: page 1 was a silent cap, so follow
  // pages until totalRecords is in hand - 5000 at most, past that the maps
  // below stop meaning anything anyway.
  const allRecords = async (p: string, max = 5000): Promise<any[]> => {
    const sep = p.includes('?') ? '&' : '?';
    const records: any[] = [];
    for (let page = 1; records.length < max; page++) {
      const r = await api(`${p}${sep}page=${page}&pageSize=1000`);
      records.push(...(r?.records || []));
      if (!r?.records?.length || records.length >= (r?.totalRecords ?? 0)) break;
    }
    return records;
  };

  // What is on the way or waiting, keyed by Lidarr's album id and by
  // release-group id. Cached a few seconds: every open page polls this.
  const activity = async (): Promise<{ queue: Map<number, QueueEntry>; wanted: Map<string, number> }> => {
    const hit = cached('activity', 5 * 1000); if (hit) return hit;
    const [q, w] = await Promise.all([
      allRecords('/queue?includeAlbum=true').catch(() => []),
      allRecords('/wanted/missing').catch(() => []),
    ]);
    const queue = new Map<number, QueueEntry>();
    for (const r of q) {
      if (!r.albumId) continue;
      const bad = r.trackedDownloadStatus === 'warning' || r.trackedDownloadStatus === 'error'
        || r.trackedDownloadState === 'importFailed' || r.trackedDownloadState === 'failedPending' || r.status === 'failed';
      queue.set(r.albumId, { state: bad ? 'failed' : 'downloading', detail: r.errorMessage || r.status || null, protocol: r.protocol || null });
    }
    const wanted = new Map<string, number>(w.map((r: any) => [r.foreignAlbumId, r.id]));
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

    // Album search across Lidarr's metadata (the search page's "Everywhere"),
    // plus the Various Artists releases it leaves out, straight from
    // MusicBrainz: soundtracks first. Lidarr knows those by id, so a
    // request for one goes through the same path.
    async search(q: string): Promise<Release[]> {
      const [own, va] = await Promise.all([
        api(`/album/lookup?term=${encodeURIComponent(q)}`, { timeoutMs: 30000 }).catch((e: any) => { log(`lidarr search "${q}": ${e.message}`); return []; }),
        this.compilations(q),
      ]);
      const out: Release[] = (own || []).map(releaseOf);
      const seen = new Set(out.map((r) => r.album_id));
      return [...out, ...va.filter((r) => !seen.has(r.album_id))];
    },

    async compilations(q: string): Promise<Release[]> {
      const words = titleQuery(q);
      if (!words) return [];
      const lucene = `releasegroup:(${words}) AND arid:${VARIOUS_ARTISTS}`;
      try {
        const r = await f(`https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(lucene)}&limit=15&fmt=json`, {
          headers: { 'User-Agent': MB_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`musicbrainz ${r.status}`);
        const j = await r.json() as any;
        const st = (g: any) => Number((g['secondary-types'] || []).includes('Soundtrack'));
        const groups = ((j['release-groups'] || []) as any[])
          .filter((g) => (g.score ?? 0) >= 60)
          .sort((a, b) => st(b) - st(a) || (b.score ?? 0) - (a.score ?? 0))
          .slice(0, 8);
        // Many compilations have no cover in the archive: a dead link would
        // show as a broken image, so only covers that answer are kept.
        const covers = await Promise.all(groups.map((g) => f(`https://coverartarchive.org/release-group/${g.id}/front-250`, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
          .then((r) => r.ok).catch(() => false)));
        return groups
          .map((g, i) => {
            const secondary: string[] = g['secondary-types'] || [];
            const date = String(g['first-release-date'] || '');
            return {
              album_id: g.id, artist: 'Various Artists', title: g.title,
              rtype: secondary.includes('Soundtrack') ? 'Soundtrack' : secondary.includes('Compilation') ? 'Compilation' : g['primary-type'] || 'Album',
              year: date.slice(0, 4), date, image: covers[i] ? `https://coverartarchive.org/release-group/${g.id}/front-250` : null,
              total_tracks: 0, secondary,
            };
          });
      } catch (e: any) { log(`musicbrainz search "${q}": ${e.message}`); return []; }
    },

    // Request a release group: make sure its artist is in Lidarr, monitor the
    // album (that puts it on the wanted list every downloader watches), and
    // optionally fire Lidarr's own indexer search.
    async request(fid: string): Promise<{ id?: number; album_id: string; artist: string; title: string; status: string }> {
      let album = await albumByForeign(fid);
      if (!album) {
        const look = ((await api(`/album/lookup?term=lidarr:${encodeURIComponent(fid)}`, { timeoutMs: 30000 })) || [])[0];
        if (!look) throw new Error('no such release');
        const artist = await ensureArtist(look.artist?.artistName || '', look.artist);
        // A Various Artists release is in no artist's catalog: add it
        // itself. Anyone else's albums arrive with the artist's refresh.
        if (artist?.id && look.artist?.foreignArtistId === VARIOUS_ARTISTS) {
          await api('/album', { method: 'POST', body: JSON.stringify({ ...look, artistId: artist.id, artist, monitored: false, addOptions: { searchForNewAlbum: false } }), timeoutMs: 60000 });
          log(`lidarr: added ${look.title} (Various Artists)`);
        }
        const until = Date.now() + 30000;
        album = await albumByForeign(fid);
        while (!album && Date.now() < until) { await new Promise((r) => setTimeout(r, 2000)); album = await albumByForeign(fid); }
        if (!album) throw new Error('Lidarr is still fetching the artist, try again shortly');
      }
      const out = { id: album.id as number, album_id: fid, artist: album.artist?.artistName || '', title: album.title as string };
      if ((album.statistics?.trackFileCount ?? 0) >= (album.statistics?.totalTrackCount || 1)) return { ...out, status: 'exists' };
      // The wanted list only lists albums of monitored artists. The artist
      // first: updating it afterwards reset the album's own flag (a first
      // request for a new artist came back "queued" with nothing wanted).
      if (!album.artist?.monitored) {
        await api(`/artist/${album.artist.id}`, { method: 'PUT', body: JSON.stringify({ ...album.artist, monitored: true, monitorNewItems: 'none' }) });
        cache.delete('artists');
      }
      // Then the album, read back until Lidarr says it stuck.
      for (let i = 0; i < 3; i++) {
        await api('/album/monitor', { method: 'PUT', body: JSON.stringify({ albumIds: [album.id], monitored: true }) });
        const now = await api(`/album/${album.id}`).catch(() => null);
        if (now?.monitored) break;
        if (i === 2) { log(`lidarr: ${out.artist} - ${out.title} would not stay monitored`); throw new Error('Lidarr did not take the request, try again shortly'); }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (opts.searchOnRequest) await api('/command', { method: 'POST', body: JSON.stringify({ name: 'AlbumSearch', albumIds: [album.id] }) }).catch((e: any) => log(`lidarr search cmd: ${e.message}`));
      cache.delete('activity');
      return { ...out, status: 'queued' };
    },

    // How long the line is (albums monitored and still missing).
    async wantedCount(): Promise<number> {
      if (!this.enabled) return 0;
      return (await activity()).wanted.size;
    },

    // release-group id -> request state, for flagging discographies and search
    // results ('queued' | 'downloading' | 'failed').
    async statuses(): Promise<Map<string, { status: string; updated: number }>> {
      if (!this.enabled) return new Map();
      const { queue, wanted } = await activity();
      const out = new Map<string, { status: string; updated: number }>();
      for (const fid of wanted.keys()) out.set(fid, { status: 'queued', updated: 0 });
      // Queue records carry only Lidarr's album id: the unknown ones are
      // resolved in one chunked batch, and an id Lidarr no longer knows (a
      // deleted album) is remembered as a missing sentinel so it is not
      // refetched on every poll.
      const fidTtl = 10 * 60 * 1000;
      const unknown = [...queue.keys()].filter((id) => !cached(`fid:${id}`, fidTtl));
      if (unknown.length) {
        const got = await albumsByIds(unknown).catch(() => null);
        if (got) {
          const byId = new Map(got.map((a: any) => [a.id, a]));
          for (const id of unknown) remember(`fid:${id}`, byId.get(id) ?? { missing: true });
        }
      }
      for (const [albumId, s] of queue) {
        const a = cached(`fid:${albumId}`, fidTtl);
        if (a?.foreignAlbumId) out.set(a.foreignAlbumId, { status: s.state === 'failed' ? 'failed' : 'downloading', updated: 0 });
      }
      return out;
    },

    // Live state of specific albums (the Downloads page's "Yours").
    async albums(ids: number[]): Promise<AlbumState[]> {
      if (!ids.length) return [];
      const { queue } = await activity();
      return (await albumsByIds(ids)).map((a) => stateOf(a, queue));
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

    // Stop wanting an album (the watcher gave up on it): off the wanted
    // list, so the Soulseek watcher stops searching for it.
    async unmonitor(albumId: number) {
      await api('/album/monitor', { method: 'PUT', body: JSON.stringify({ albumIds: [albumId], monitored: false }) });
      cache.delete('activity');
    },

    // Files Lidarr imported for an artist since a moment, with the album
    // each landed in. How the watcher spots a downloader that keeps
    // fetching a different album than the one asked for.
    async importsSince(artistId: number, since: number): Promise<{ albumId: number; album: string; at: number }[]> {
      const h = (await api(`/history/artist?artistId=${artistId}&eventType=3&includeAlbum=true`, { timeoutMs: 30000 })) || [];
      return (h as any[])
        .filter((r) => r.eventType === 'trackFileImported' && Date.parse(r.date) >= since)
        .map((r) => ({ albumId: r.albumId, album: r.album?.title || '', at: Date.parse(r.date) }));
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
  // Constant-time compare (hashed first so lengths always match); the key
  // may come as an X-Api-Key header - preferred, keeps it out of access
  // logs - or in the query string for notifications set up before that.
  const keyOk = (given: string) => {
    if (!opts.apiKey || !given) return false;
    const h = (s: string) => crypto.createHash('sha256').update(s).digest();
    return crypto.timingSafeEqual(h(given), h(opts.apiKey));
  };
  app.post('/api/hooks/lidarr', async (req: any, reply) => {
    if (!keyOk(String(req.headers['x-api-key'] || req.query?.key || ''))) return reply.code(401).send({ error: 'bad key' });
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
