import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { lidarrClient, registerLidarrHook } from './lidarr.js';

// A tiny Lidarr: answers the API routes the client uses, remembers what was
// POSTed/PUT so the tests can assert the protocol.
function fakeLidarr() {
  const state = {
    artists: [] as any[],
    albums: [] as any[],
    calls: [] as string[],
    nextId: 1,
  };
  const fetcher: any = async (url: string, init?: any) => {
    const u = new URL(url);
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
    if (p.startsWith('/artist/lookup')) return json([{ artistName: u.searchParams.get('term'), foreignArtistId: 'fa-1', images: [] }]);
    if (p.startsWith('/artist/') && method === 'PUT') { const id = Number(p.split('/')[2]); const a = state.artists.find((x) => x.id === id); Object.assign(a, JSON.parse(init.body)); return json(a); }
    if (p === '/album' && method === 'GET') {
      const fid = u.searchParams.get('foreignAlbumId');
      if (fid) return json(state.albums.filter((a) => a.foreignAlbumId === fid));
      const artistId = u.searchParams.get('artistId');
      if (artistId) return json(state.albums.filter((a) => a.artist.id === Number(artistId)));
      const ids = u.searchParams.getAll('albumIds').map(Number);
      return json(state.albums.filter((a) => ids.includes(a.id)));
    }
    if (p.startsWith('/album/lookup')) return json(state.albums);
    if (p === '/album/monitor') { const b = JSON.parse(init.body); for (const a of state.albums) if (b.albumIds.includes(a.id)) a.monitored = b.monitored; return json({}); }
    if (p === '/queue') return json({ records: [] });
    if (p === '/wanted/missing') return json({ records: state.albums.filter((a) => a.monitored && !a.statistics.trackFileCount).map((a) => ({ id: a.id, foreignAlbumId: a.foreignAlbumId })) });
    if (p === '/command') return json({ id: 99 });
    if (p.startsWith('/album/')) return json(state.albums.find((a) => a.id === Number(p.split('/')[2])));
    throw new Error(`unexpected ${method} ${p}`);
  };
  return { state, fetcher };
}

const client = (f: any) => lidarrClient({ url: 'http://lidarr', apiKey: 'k', root: '/music', qualityProfile: 'Strict', metadataProfile: 'All releases', fetcher: f });

describe('lidarr client', () => {
  it('discography adds an unknown artist unmonitored with the configured profiles, then lists its albums', async () => {
    const { state, fetcher } = fakeLidarr();
    const l = client(fetcher);
    const d = await l.discography('Porter Robinson');
    expect(state.artists[0]).toMatchObject({ monitored: false, rootFolderPath: '/music', qualityProfileId: 3, metadataProfileId: 2, addOptions: { monitor: 'none', searchForMissingAlbums: false } });
    expect(d.releases).toEqual([{ album_id: 'mb-worlds', artist: 'Porter Robinson', title: 'Worlds', rtype: 'Album', year: '2014', date: '2014-08-12', image: 'http://img/worlds', total_tracks: 12 }]);
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

  it('retry fires AlbumSearch', async () => {
    const { state, fetcher } = fakeLidarr();
    const l = client(fetcher);
    await l.discography('Porter Robinson');
    await l.request('mb-worlds');
    await l.retry(state.albums[0].id);
    expect(state.calls.some((c) => c.startsWith('POST /command'))).toBe(true);
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
    await app.close();
  });
});
