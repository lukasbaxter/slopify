import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeTransport } from './transports.js';
import { Discovery } from './discovery.js';

// A slopify-speaker/1 device: remembers what it was asked, answers /status from `unit.status`.
const unit: { calls: string[]; status: any; down: boolean } = { calls: [], status: { state: 'idle' }, down: false };
let server: http.Server; let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (unit.down) { res.destroy(); return; }
    unit.calls.push(req.url || '');
    if (req.url?.startsWith('/info')) res.end(JSON.stringify({ api: 'slopify-speaker/1', id: 'AA:BB', name: 'Soundbar', model: 'JBL bridge', formats: ['mp3'], maxKbps: 128 }));
    else res.end(JSON.stringify(req.url?.startsWith('/status') ? unit.status : { state: 'buffering' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());
const speaker = () => new BridgeTransport({ id: 'bridge:aa:bb', kind: 'bridge', name: 'Soundbar', model: 'JBL bridge', host: '127.0.0.1', port });
const lastPlay = () => new URL(`http://x${unit.calls.filter((c) => c.startsWith('/play')).pop()}`).searchParams;

describe('slopify-speaker transport', () => {
  it('hands the device the mp3 transcode at the bitrate it asked for', async () => {
    const t = speaker();
    await t.play('http://192.168.1.85:8090/api/stream/abc?token=T', {}, 12.5);
    const q = lastPlay();
    expect(q.get('startAt')).toBe('12.5');
    const u = new URL(q.get('url')!);
    expect(u.pathname).toBe('/api/stream/abc/mp3');
    expect(u.searchParams.get('token')).toBe('T');
    expect(u.searchParams.get('bitrate')).toBe('128000');
  });
  it('seeks by playing the same stream from the new point', async () => {
    const t = speaker();
    await t.play('http://192.168.1.85:8090/api/stream/abc?token=T');
    await t.seek(61);
    expect(lastPlay().get('startAt')).toBe('61');
    expect(new URL(lastPlay().get('url')!).pathname).toBe('/api/stream/abc/mp3');
  });
  it('refuses a stream the device cannot fetch (https)', async () => {
    await expect(speaker().play('https://music.example/api/stream/abc?token=T')).rejects.toThrow(/http:\/\//);
  });
  it('our own stream reads as ours, a pushed one as another app', async () => {
    unit.status = { state: 'playing', position: 30.2, volume: 55, ended: false, source: 'url', url: 'http://192.168.1.85:8090/api/stream/abc/mp3?token=T' };
    let s = await speaker().status();
    expect(s).toMatchObject({ playing: true, state: 'PLAYING', position: 30.2, volume: 55, service: 'url' });
    unit.status = { state: 'stream', position: 0, volume: 55, source: 'Spotify', url: 'tcp:Spotify' };
    s = await speaker().status();
    expect(s).toMatchObject({ state: 'stream', service: 'Spotify', serviceName: 'Spotify', streamUrl: 'tcp:Spotify' });
    expect(s.streamUrl!.includes('/api/stream')).toBe(false);
  });
  it('the end of a track is reported as ended', async () => {
    unit.status = { state: 'idle', position: 200, ended: true, source: 'url', url: 'http://x/api/stream/abc/mp3' };
    expect(await speaker().status()).toMatchObject({ state: 'IDLE', ended: true, playing: false });
  });
  it('one missed poll is an error, three in a row is a device gone', async () => {
    const t = speaker();
    unit.down = true;
    await expect(t.status()).rejects.toThrow();
    await expect(t.status()).rejects.toThrow();
    expect((await t.status()).gone).toBe(true);
    unit.down = false;
  });
  it('discovery identifies it from /info', async () => {
    const d = await new Discovery(() => {}).identifyBridge('127.0.0.1', port);
    expect(d).toMatchObject({ id: 'bridge:aa:bb', kind: 'bridge', name: 'Soundbar', model: 'JBL bridge', host: '127.0.0.1', port });
  });
});
