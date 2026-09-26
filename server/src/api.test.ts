import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import WebSocket from 'ws';
import { scanLibrary } from './scanner.js';

const MUSIC = path.resolve(process.env.MUSIC_DIR || path.join(process.cwd(), '..', 'fixtures', 'music'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-api-'));
let app: Awaited<ReturnType<typeof buildServer>>; let tok = '';
const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}` } });
const send = (method: any, url: string, payload?: any) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok}` } });

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: MUSIC });
  await scanLibrary((app as any).db, { musicDir: MUSIC, dataDir: DATA });
  tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
}, 120000);
afterAll(async () => { await app.close(); });

describe('library API', () => {
  it('lists albums and artists in one query each', async () => {
    const a = (await get('/api/albums?limit=3')).json(); expect(a.total).toBe(5); expect(a.items.length).toBe(3); expect(a.items[0].cover).toBeTruthy();
    const r = (await get('/api/artists')).json(); expect(r.items.find((x: any) => x.name === 'The Fixture Band').albumCount).toBe(2);
  });
  it('album detail carries ordered tracks; artist detail carries albums', async () => {
    const a = (await get('/api/albums?limit=100')).json().items.find((x: any) => x.name === 'First Light');
    const d = (await get(`/api/albums/${a.id}`)).json(); expect(d.tracks.length).toBe(8); expect(d.tracks[0].trackNo).toBe(1);
    const art = (await get(`/api/artists/${a.artistId}`)).json(); expect(art.albums.length).toBe(2);
    expect((await get('/api/albums/nope')).statusCode).toBe(404);
  });
  it('searches by prefix across tracks, albums and artists', async () => {
    const s = (await get('/api/search?q=harb')).json(); expect(s.tracks.length).toBeGreaterThan(0); expect(s.tracks[0].title.toLowerCase()).toContain('harbour');
    expect((await get('/api/search?q=fixture')).json().artists[0].name).toBe('The Fixture Band');
    // album + artist words together still find the album
    const both = (await get('/api/search?q=first%20light%20fixture')).json(); expect(both.albums[0].name).toBe('First Light');
    expect((await get('/api/search?q=')).json().tracks).toEqual([]);
  });
  it('serves lyrics and immutable artwork', async () => {
    const withL = ((app as any).db.prepare('SELECT track_id FROM lyrics LIMIT 1').get() as any).track_id;
    const l = (await get(`/api/lyrics/${withL}`)).json(); expect(l.kind).toBe('synced'); expect(l.lines[0].text).toMatch(/line 1/);
    const cover = (await get('/api/albums?limit=1')).json().items[0].cover;
    const img = await app.inject({ method: 'GET', url: `/api/art/${cover}/320.webp` });
    expect(img.statusCode).toBe(200); expect(img.headers['content-type']).toBe('image/webp'); expect(img.headers['cache-control']).toContain('immutable');
    expect((await app.inject({ method: 'GET', url: `/api/art/${cover}/999.jpg` })).statusCode).toBe(200); // nearest size
  });
  it('requires a login', async () => { expect((await app.inject({ method: 'GET', url: '/api/albums' })).statusCode).toBe(401); });
});

describe('streaming', () => {
  it('serves the original with byte ranges', async () => {
    const t = (await get('/api/albums?limit=1')).json().items[0];
    const id = (await get(`/api/albums/${t.id}`)).json().tracks[0].id;
    const full = await get(`/api/stream/${id}`); expect(full.statusCode).toBe(200); expect(full.headers['accept-ranges']).toBe('bytes'); expect(full.headers['content-type']).toBe('audio/mpeg');
    const part = await app.inject({ method: 'GET', url: `/api/stream/${id}?token=${tok}`, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206); expect(part.headers['content-length']).toBe('100'); expect(part.headers['content-range']).toMatch(/^bytes 0-99\//);
    expect((await app.inject({ method: 'GET', url: `/api/stream/${id}?token=${tok}`, headers: { range: 'bytes=999999999-' } })).statusCode).toBe(416);
    // BluOS seeks with bytes=N-SIZE (one past the end): clamped, not refused
    const size = Number(full.headers['content-length']);
    const blu = await app.inject({ method: 'GET', url: `/api/stream/${id}?token=${tok}`, headers: { range: `bytes=${size - 50}-${size}` } });
    expect(blu.statusCode).toBe(206); expect(blu.headers['content-range']).toBe(`bytes ${size - 50}-${size - 1}/${size}`);
  });
  it('transcodes to HLS, once, and serves segments', async () => {
    const id = (await get('/api/albums?limit=1')).json().items[0];
    const tid = (await get(`/api/albums/${id.id}`)).json().tracks[1].id;
    const pl = await get(`/api/stream/${tid}/hls/aac-160/index.m3u8?token=${tok}`);
    expect(pl.statusCode).toBe(200); expect(pl.body).toContain('#EXTM3U'); expect(pl.body).toMatch(/s0000\.ts\?token=/);
    const seg = await get(`/api/stream/${tid}/hls/aac-160/s0000.ts`); expect(seg.statusCode).toBe(200); expect(seg.headers['content-type']).toBe('video/mp2t');
    await new Promise((r) => setTimeout(r, 1500));
    const again = await get(`/api/stream/${tid}/hls/aac-160/index.m3u8`); expect(again.body).toContain('#EXT-X-ENDLIST');
    expect(fs.existsSync(path.join(DATA, 'transcodes', tid, 'aac-160', 'done'))).toBe(true);
    expect((await get(`/api/stream/${tid}/hls/mp3-999/index.m3u8`)).statusCode).toBe(404);
  }, 60000);
  it('offers every quality up to the chosen one, best first, carrying the token', async () => {
    const id = (await get('/api/albums?limit=1')).json().items[0];
    const tid = (await get(`/api/albums/${id.id}`)).json().tracks[1].id;
    const top = (await get(`/api/stream/${tid}/hls/master.m3u8?max=aac-320&token=${tok}`)).body;
    expect(top.match(/^aac-\d+/gm)).toEqual(['aac-320', 'aac-160', 'aac-96']);
    expect(top).toContain(`aac-320/index.m3u8?token=${tok}&abr=1`);
    expect((await get(`/api/stream/${tid}/hls/master.m3u8?max=aac-160`)).body.match(/^aac-\d+/gm)).toEqual(['aac-160', 'aac-96']);
    expect((await get('/api/stream/nope/hls/master.m3u8')).statusCode).toBe(404);
  });
});

describe('likes, playlists, plays, home, prefs', () => {
  let ids: string[] = [];
  beforeAll(async () => { const a = (await get('/api/albums?limit=1')).json().items[0]; ids = (await get(`/api/albums/${a.id}`)).json().tracks.map((t: any) => t.id); });
  it('likes with timestamps and returns full rows', async () => {
    await send('PUT', `/api/likes/${ids[0]}`, { at: 1000 }); await send('PUT', `/api/likes/${ids[1]}`);
    const l = (await get('/api/likes?full=1')).json(); expect(Object.keys(l.at).length).toBe(2); expect(l.items[0].id).toBe(ids[1]); // newest first
    await send('DELETE', `/api/likes/${ids[1]}`); expect(Object.keys((await get('/api/likes')).json().at).length).toBe(1);
  });
  it('playlists: create, add, move, remove, rename, delete', async () => {
    const p = (await send('POST', '/api/playlists', { name: 'Road', trackIds: ids.slice(0, 3) })).json();
    await send('POST', `/api/playlists/${p.id}/tracks`, { trackIds: [ids[3]] });
    await send('POST', `/api/playlists/${p.id}/move`, { from: 3, to: 0 });
    let d = (await get(`/api/playlists/${p.id}`)).json(); expect(d.tracks.map((t: any) => t.id)).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    await send('DELETE', `/api/playlists/${p.id}/tracks/1`);
    d = (await get(`/api/playlists/${p.id}`)).json(); expect(d.tracks.map((t: any) => t.id)).toEqual([ids[3], ids[1], ids[2]]); expect(d.cover).toBeTruthy();
    await send('PATCH', `/api/playlists/${p.id}`, { name: 'Road trip' });
    expect((await get('/api/playlists')).json().items[0].name).toBe('Road trip');
    await send('DELETE', `/api/playlists/${p.id}`); expect((await get(`/api/playlists/${p.id}`)).statusCode).toBe(404);
  });
  it('records plays (deduped) and builds Home from them', async () => {
    expect((await send('POST', '/api/plays', { trackId: ids[0], at: 5000 })).json().dup).toBeUndefined();
    expect((await send('POST', '/api/plays', { trackId: ids[0], at: 5500 })).json().dup).toBe(true);
    await send('POST', '/api/plays', { trackId: ids[2], at: Date.now() });
    const h = (await get('/api/home')).json();
    expect(h.recentAlbums.length).toBe(1); expect(h.topTracks[0].id).toBe(ids[2]); expect(h.newestAlbums.length).toBe(5);
    expect((await get('/api/history')).json().items[0].track.id).toBe(ids[2]);
  });
  it('patches prefs', async () => {
    await send('PATCH', '/api/prefs', { quality: 'aac-160' }); await send('PATCH', '/api/prefs', { theme: 'dark' });
    expect((await get('/api/prefs')).json()).toEqual({ quality: 'aac-160', theme: 'dark' });
  });
  it('admin status and scan trigger', async () => {
    const s = (await send('POST', '/api/admin/scan')).json(); expect(s.started).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    const st = (await get('/api/admin/status')).json(); expect(st.missingLyrics).toBe(8); expect(st.users).toBe(1);
  });
});

describe('session socket', () => {
  let port = 0;
  const hello = async (instance?: string, clientId = 'c_sharedtabid') => {
    if (!port) { await app.listen({ host: '127.0.0.1', port: 0 }); port = (app.server.address() as any).port; }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await new Promise((r) => ws.on('open', r));
    const got = new Promise<any>((resolve) => ws.on('message', (d: any) => { const m = JSON.parse(String(d)); if (m.type === 'hello-ok') resolve(m); }));
    let closed = false; ws.on('close', () => { closed = true; });
    ws.send(JSON.stringify({ type: 'hello', token: tok, clientId, instance, kind: 'web' }));
    return { ws, ok: await got, closed: () => closed };
  };
  it('two tabs sharing a stored id both stay connected, each with its own id', async () => {
    const a = await hello('i_tab_a');
    const b = await hello('i_tab_b');
    await new Promise((r) => setTimeout(r, 100));
    expect(a.ok.clientId).toBe('c_sharedtabid');
    expect(b.ok.clientId).not.toBe('c_sharedtabid');
    expect(a.closed()).toBe(false);
    // the same page reconnecting still replaces its own old socket
    const a2 = await hello('i_tab_a');
    await new Promise((r) => setTimeout(r, 100));
    expect(a2.ok.clientId).toBe('c_sharedtabid'); expect(a.closed()).toBe(true);
    for (const x of [b, a2]) x.ws.terminate();
  });
  it('two tabs of the old page code (no instance id) stop replacing each other too', async () => {
    const a = await hello(undefined, 'c_oldtabs');
    const b = await hello(undefined, 'c_oldtabs');
    await new Promise((r) => setTimeout(r, 100));
    expect(a.ok.clientId).toBe('c_oldtabs'); expect(b.ok.clientId).not.toBe('c_oldtabs');
    expect(a.closed()).toBe(false); expect(b.closed()).toBe(false);
    for (const x of [a, b]) x.ws.terminate();
  });
});
