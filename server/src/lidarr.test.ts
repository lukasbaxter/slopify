import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { lidarrClient, registerLidarrHook } from './lidarr.js';

// A tiny Lidarr: answers the API routes the client uses, remembers what was
// POSTed/PUT so the tests can assert the protocol.
function fakeLidarr() {
  const state = {
    artists: [] as any[],
    albums: [] as any[],
    queue: [] as any[],          // raw /queue records
    lookup: null as any[] | null, // overrides /artist/lookup when set
    calls: [] as string[],
    onRefresh: {} as Record<number, any[]>,
    mb: [] as any[],                // MusicBrainz release-group search answer
    albumLookup: null as any[] | null, // overrides /album/lookup when set // albums a RefreshArtist of that artist adds
    nextId: 1,
  };
  // /queue and /wanted/missing page like the real thing.
  const paged = (all: any[], u: URL) => {
    const page = Number(u.searchParams.get('page') || 1), size = Number(u.searchParams.get('pageSize') || 1000);
    return { records: all.slice((page - 1) * size, page * size), totalRecords: all.length };
  };
  const fetcher: any = async (url: string, init?: any) => {
    const u = new URL(url);
    if (u.hostname === 'coverartarchive.org') return { ok: !url.includes('rg-comp'), status: url.includes('rg-comp') ? 404 : 200 };
    if (u.hostname === 'musicbrainz.org') { state.calls.push(`MB ${u.searchParams.get('query')}`); return { ok: true, status: 200, json: async () => ({ 'release-groups': state.mb }) }; }
    const p = u.pathname.replace('/api/v1', '');
    const method = init?.method || 'GET';
    state.calls.push(`${method} ${p}${u.search}`);
    const json = (v: any) => ({ ok: true, status: 200, json: async () => v });
    if (p === '/qualityprofile') return json([{ id: 3, name: 'Strict' }, { id: 1, name: 'Any' }]);
    if (p === '/metadataprofile') return json([{ id: 2, name: 'All releases' }]);
    if (p === '/artist' && method === 'GET') return json(state.artists);
    if (p === '/artist' && method === 'POST') {
      const a = { ...JSON.parse(init.body), id: state.nextId++ };
      state.artists.push(a);
      state.albums.push({ id: state.nextId++, foreignAlbumId: 'mb-worlds', title: 'Worlds', albumType: 'Album', releaseDate: '2014-08-12', secondaryTypes: [], images: [{ coverType: 'cover', remoteUrl: 'http://img/worlds' }], monitored: false, statistics: { totalTrackCount: 12, trackFileCount: 0 }, artist: a });
      return json(a);
    }
    if (p.startsWith('/artist/lookup')) return json(state.lookup ?? [{ artistName: u.searchParams.get('term'), foreignArtistId: 'fa-1', images: [] }]);
    if (p.startsWith('/artist/') && method === 'PUT') { const id = Number(p.split('/')[2]); const a = state.artists.find((x) => x.id === id); Object.assign(a, JSON.parse(init.body)); return json(a); }
    if (p === '/album' && method === 'GET') {
      const fid = u.searchParams.get('foreignAlbumId');
      if (fid) return json(state.albums.filter((a) => a.foreignAlbumId === fid));
      const artistId = u.searchParams.get('artistId');
      if (artistId) return json(state.albums.filter((a) => a.artist.id === Number(artistId)));
      const ids = u.searchParams.getAll('albumIds').map(Number);
      return json(state.albums.filter((a) => ids.includes(a.id)));
    }
    if (p.startsWith('/album/lookup') && state.albumLookup) return json(state.albumLookup);
    if (p === '/album' && method === 'POST') { const a = { ...JSON.parse(init.body), id: state.nextId++, statistics: { totalTrackCount: 62, trackFileCount: 0 } }; state.albums.push(a); return json(a); }
    if (p.startsWith('/album/lookup')) return json(state.albums.length ? state.albums : [{ foreignAlbumId: 'mb-worlds', title: 'Worlds', artist: { artistName: 'Porter Robinson', foreignArtistId: 'fa-1', images: [] } }]);
    if (p === '/album/monitor') { const b = JSON.parse(init.body); for (const a of state.albums) if (b.albumIds.includes(a.id)) a.monitored = b.monitored; return json({}); }
    if (p === '/queue') return json(paged(state.queue, u));
    if (p === '/wanted/missing') return json(paged(state.albums.filter((a) => a.monitored && !a.statistics.trackFileCount).map((a) => ({ id: a.id, foreignAlbumId: a.foreignAlbumId })), u));
    if (p === '/command') {
      const b = JSON.parse(init.body);
      // A refresh brings in what the artist's (new) profile allows.
      if (b.name === 'RefreshArtist') for (const id of b.artistIds || []) for (const al of state.onRefresh[id] || []) state.albums.push(al);
      return json({ id: 99 });
    }
    if (p === '/command/99') return json({ id: 99, status: 'completed' });
    if (p.startsWith('/album/')) return json(state.albums.find((a) => a.id === Number(p.split('/')[2])));
    throw new Error(`unexpected ${method} ${p}`);
  };
  return { state, fetcher };
}

const fakeAlbum = (id: number, extra: any = {}) => ({
  id, foreignAlbumId: `mb-${id}`, title: `Album ${id}`, albumType: 'Album', releaseDate: '2020-01-01', secondaryTypes: [], images: [],
  monitored: false, statistics: { totalTrackCount: 10, trackFileCount: 0 }, artist: { id: 10000, artistName: 'Someone' }, ...extra,
});

const client = (f: any) => lidarrClient({ url: 'http://lidarr', apiKey: 'k', root: '/music', qualityProfile: 'Strict', metadataProfile: 'All releases', fetcher: f });

describe('lidarr client', () => {
  it('discography adds an unknown artist unmonitored with the configured profiles, then lists its albums', async () => {
    const { state, fetcher } = fakeLidarr();
    const l = client(fetcher);
    const d = await l.discography('Porter Robinson');
    expect(state.artists[0]).toMatchObject({ monitored: false, rootFolderPath: '/music', qualityProfileId: 3, metadataProfileId: 2, addOptions: { monitor: 'none', searchForMissingAlbums: false } });
    expect(d.releases).toEqual([{ album_id: 'mb-worlds', artist: 'Porter Robinson', title: 'Worlds', rtype: 'Album', year: '2014', date: '2014-08-12', image: 'http://img/worlds', total_tracks: 12, secondary: [] }]);
  });

  it('an artist already in Lidarr on another metadata profile moves onto the configured one and is refreshed before its releases are read', async () => {
    const { state, fetcher } = fakeLidarr();
    const artist = { id: 50, artistName: 'AWOLNATION', foreignArtistId: 'fa-awol', metadataProfileId: 1, images: [] };
    state.artists.push(artist);
    state.albums.push(fakeAlbum(51, { title: 'Run', artist }));
    state.onRefresh[50] = [fakeAlbum(52, { title: 'Back From Earth', albumType: 'EP', artist })];
    const d = await client(fetcher).discography('AWOLNATION');
    expect(state.artists[0].metadataProfileId).toBe(2);
    expect(state.calls).toContain('PUT /artist/50');
    expect(d.releases.map((r) => r.title).sort()).toEqual(['Back From Earth', 'Run']);
    // already on it: left alone
    state.calls.length = 0;
    await client(fetcher).discography('AWOLNATION');
    expect(state.calls.filter((c) => c.startsWith('PUT') || c.startsWith('POST'))).toEqual([]);
  });

  it('search adds Various Artists soundtracks from MusicBrainz (Lidarr leaves them out), soundtrack words stripped, soundtracks first', async () => {
    const { state, fetcher } = fakeLidarr();
    state.albums.push(fakeAlbum(1, { foreignAlbumId: 'mb-own', title: 'Grand Theft Auto V', artist: { id: 2, artistName: 'Frank Ocean' } }));
    state.mb = [
      { id: 'rg-comp', title: 'The Music of Grand Theft Auto V', score: 100, 'primary-type': 'Album', 'secondary-types': ['Compilation'], 'first-release-date': '2013-09-24' },
      { id: 'rg-ost', title: 'The Music of Grand Theft Auto V, Volume 3: The Soundtrack', score: 90, 'primary-type': 'Album', 'secondary-types': ['Soundtrack'], 'first-release-date': '2013-12-17' },
      { id: 'rg-weak', title: 'Unrelated', score: 40, 'secondary-types': ['Compilation'] },
    ];
    const r = await client(fetcher).search('grand theft auto v soundtrack');
    expect(state.calls).toContain('MB releasegroup:(grand theft auto v) AND arid:89ad4ac3-39f7-470e-963a-56509c546377');
    expect(r.map((x) => [x.album_id, x.artist, x.rtype])).toEqual([['mb-own', 'Frank Ocean', 'Album'], ['rg-ost', 'Various Artists', 'Soundtrack'], ['rg-comp', 'Various Artists', 'Compilation']]);
    expect(r[1]).toMatchObject({ year: '2013', image: 'https://coverartarchive.org/release-group/rg-ost/front-250' });
    expect(r[2].image).toBeNull(); // no cover in the archive
  });

  it('a request for a Various Artists release adds the album itself (no artist refresh lists it) and monitors it', async () => {
    const { state, fetcher } = fakeLidarr();
    const va = { id: 7, artistName: 'Various Artists', foreignArtistId: '89ad4ac3-39f7-470e-963a-56509c546377', metadataProfileId: 2, monitored: false, images: [] };
    state.artists.push(va);
    state.albumLookup = [{ foreignAlbumId: 'rg-gta', title: 'The Music of Grand Theft Auto V', artist: { artistName: 'Various Artists', foreignArtistId: va.foreignArtistId, images: [] } }];
    const r = await client(fetcher).request('rg-gta');
    expect(r).toMatchObject({ status: 'queued', artist: 'Various Artists', title: 'The Music of Grand Theft Auto V' });
    expect(state.calls).toContain('POST /album');
    expect(state.albums.find((a) => a.foreignAlbumId === 'rg-gta')).toMatchObject({ artistId: 7, monitored: true, addOptions: { searchForNewAlbum: false } });
    expect(state.artists[0].monitored).toBe(true);
  });

  it('request monitors the album AND its artist (the wanted list needs both), and reports what is already on disk as exists', async () => {
    const { state, fetcher } = fakeLidarr();
    const l = client(fetcher);
    await l.discography('Porter Robinson'); // seeds the artist + album
    const r = await l.request('mb-worlds');
    expect(r).toMatchObject({ album_id: 'mb-worlds', status: 'queued', title: 'Worlds' });
    expect(state.albums[0].monitored).toBe(true);
    expect(state.artists[0].monitored).toBe(true);
    expect(state.artists[0].monitorNewItems).toBe('none');
    expect(state.calls.filter((c) => c.startsWith('POST /command'))).toEqual([]); // soulseek-first: no indexer search unless configured
    expect((await l.statuses()).get('mb-worlds')).toMatchObject({ status: 'queued' });
    state.albums[0].statistics.trackFileCount = 12;
    const again = await l.request('mb-worlds');
    expect(again.status).toBe('exists');
  });

  it('a first request for a new artist stays wanted even though updating the artist resets its albums (as Lidarr does)', async () => {
    const { state, fetcher } = fakeLidarr();
    // Lidarr: saving an artist re-applies its monitoring to every album.
    const resetting: any = async (url: string, init?: any) => {
      const r = await fetcher(url, init);
      const p = new URL(url).pathname.replace('/api/v1', '');
      if (p.startsWith('/artist/') && init?.method === 'PUT') for (const a of state.albums) a.monitored = false;
      return r;
    };
    const l = client(resetting);
    await l.discography('Porter Robinson'); // the artist is new to Lidarr, unmonitored
    const r = await l.request('mb-worlds');
    expect(r.status).toBe('queued');
    expect(state.albums[0].monitored).toBe(true);
    expect(state.artists[0].monitored).toBe(true);
  });

  it('retry fires AlbumSearch', async () => {
    const { state, fetcher } = fakeLidarr();
    const l = client(fetcher);
    await l.discography('Porter Robinson');
    await l.request('mb-worlds');
    await l.retry(state.albums[0].id);
    expect(state.calls.some((c) => c.startsWith('POST /command'))).toBe(true);
  });

  it('albums() fetches ids in chunks of 100 (Lidarr\'s request line tops out near 8KB) and merges', async () => {
    const { state, fetcher } = fakeLidarr();
    for (let i = 1; i <= 160; i++) state.albums.push(fakeAlbum(i));
    const l = client(fetcher);
    const out = await l.albums(state.albums.map((a) => a.id));
    expect(out.length).toBe(160);
    const chunked = state.calls.filter((c) => c.includes('albumIds='));
    expect(chunked.length).toBe(2);
    for (const c of chunked) expect(c.split('albumIds=').length - 1).toBeLessThanOrEqual(100);
  });

  it('follows wanted/queue pages past 1000 records', async () => {
    const { state, fetcher } = fakeLidarr();
    for (let i = 1; i <= 1500; i++) state.albums.push(fakeAlbum(i, { monitored: true }));
    const l = client(fetcher);
    expect(await l.wantedCount()).toBe(1500);
    expect(state.calls.filter((c) => c.startsWith('GET /wanted/missing')).length).toBe(2);
  });

  it('statuses resolves queue album ids in one chunked batch and remembers deleted albums so a 404 is not refetched', async () => {
    vi.useFakeTimers();
    try {
      const { state, fetcher } = fakeLidarr();
      state.albums.push(fakeAlbum(1), fakeAlbum(2));
      state.queue = [
        { albumId: 1, status: 'downloading' },
        { albumId: 2, trackedDownloadStatus: 'error' }, // Lidarr's other spelling of broken
        { albumId: 999 },                               // deleted in Lidarr since it queued
      ];
      const l = client(fetcher);
      const s = await l.statuses();
      expect(s.get('mb-1')).toMatchObject({ status: 'downloading' });
      expect(s.get('mb-2')).toMatchObject({ status: 'failed' });
      expect([...s.keys()]).not.toContain('mb-999');
      const batches = () => state.calls.filter((c) => c.includes('albumIds=')).length;
      const perId = () => state.calls.filter((c) => /GET \/album\/\d/.test(c)).length;
      expect(batches()).toBe(1); // one batch, not one GET /album/{id} per queue row
      expect(perId()).toBe(0);
      vi.advanceTimersByTime(6000); // past the activity cache, inside the fid cache
      await l.statuses();
      expect(batches()).toBe(1); // the missing 999 is a sentinel now, not a refetch
    } finally { vi.useRealTimers(); }
  });

  it('refuses the lookup fallback when the first result is a different artist, accepts a close one', async () => {
    const { state, fetcher } = fakeLidarr();
    state.lookup = [{ artistName: 'Completely Other Band', foreignArtistId: 'fa-9', images: [] }];
    const l = client(fetcher);
    expect(await l.discography('Porter Robinson')).toEqual({ artist: null, releases: [] });
    expect(state.artists.length).toBe(0);
    state.lookup = [{ artistName: 'Porter Robinson Band', foreignArtistId: 'fa-2', images: [] }];
    await l.discography('Porter Robinson'); // name containment is close enough
    expect(state.artists.map((a) => a.foreignArtistId)).toEqual(['fa-2']);
  });

  it('a request for a brand-new artist adds it even when a namesake with another foreignArtistId exists', async () => {
    const { state, fetcher } = fakeLidarr();
    state.artists.push({ id: 500, artistName: 'Porter Robinson', foreignArtistId: 'fa-other', monitored: true });
    const l = client(fetcher);
    await l.request('mb-worlds'); // album lookup hands over the fa-1 artist
    expect(state.artists.map((a) => a.foreignArtistId).sort()).toEqual(['fa-1', 'fa-other']);
  });

  it('two concurrent requests for the same new artist share one POST /artist', async () => {
    const { state, fetcher } = fakeLidarr();
    const l = client(fetcher);
    await Promise.all([l.discography('Porter Robinson'), l.discography('Porter Robinson')]);
    expect(state.calls.filter((c) => c.startsWith('POST /artist')).length).toBe(1);
    expect(state.artists.length).toBe(1);
  });
});

describe('lidarr import webhook', () => {
  it('maps imported track paths from Lidarr\'s root and scans just those folders, behind the key', async () => {
    const app = Fastify();
    const scanned: string[][] = [];
    app.decorate('scanFolders', async (rels: string[]) => { scanned.push(rels); });
    registerLidarrHook(app, { apiKey: 'sekret', musicDir: '/music', lidarrRoot: '/music' });
    const body = { eventType: 'Download', artist: { name: 'Tycho' }, album: { title: 'Dive' }, trackFiles: [{ path: '/music/Tycho/Dive/01. A Walk.flac' }, { path: '/music/Tycho/Dive/02. Hours.flac' }] };
    expect((await app.inject({ method: 'POST', url: '/api/hooks/lidarr', payload: body })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/hooks/lidarr?key=sekret', payload: body });
    expect(ok.json()).toEqual({ ok: true, scanned: ['Tycho/Dive'] });
    expect(scanned).toEqual([['Tycho/Dive']]);
    expect((await app.inject({ method: 'POST', url: '/api/hooks/lidarr?key=sekret', payload: { eventType: 'Test' } })).json()).toEqual({ ok: true });
    // the key is also taken as a header, so it can move out of the URL
    expect((await app.inject({ method: 'POST', url: '/api/hooks/lidarr', headers: { 'x-api-key': 'sekret' }, payload: { eventType: 'Test' } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'POST', url: '/api/hooks/lidarr', headers: { 'x-api-key': 'wrong' }, payload: { eventType: 'Test' } })).statusCode).toBe(401);
    await app.close();
  });
});
