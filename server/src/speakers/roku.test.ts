import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RokuTransport, parseRokuInfo, PLAY_ON_ROKU } from './roku.js';

// A Roku as ECP shows it: Play on Roku in front, a media player state.
const roku = { calls: [] as string[], state: 'play', position: 12345, duration: 200000, app: { id: PLAY_ON_ROKU, name: 'Play on Roku' } };
let server: http.Server; let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    roku.calls.push(`${req.method} ${req.url}`);
    const u = req.url || '';
    if (u.startsWith('/query/media-player')) res.end(`<?xml version="1.0"?><player error="false" state="${roku.state}"><plugin bandwidth="1000 bps" id="${roku.app.id}" name="${roku.app.name}"/><format audio="mp3"/><position>${roku.position} ms</position><duration>${roku.duration} ms</duration><is_live>false</is_live></player>`);
    else if (u.startsWith('/query/active-app')) res.end(`<?xml version="1.0"?><active-app><app id="${roku.app.id}" type="appl" version="1.0">${roku.app.name}</app></active-app>`);
    else res.end('');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());
beforeEach(() => { roku.calls = []; roku.state = 'play'; roku.position = 12345; roku.app = { id: PLAY_ON_ROKU, name: 'Play on Roku' }; });
const tv = () => new RokuTransport({ id: 'roku:x', kind: 'roku', name: 'Den Roku', model: 'Roku Ultra', host: '127.0.0.1', port });
const URL0 = 'http://192.0.2.1:8090/api/stream/abc?token=t0k';

describe('Roku', () => {
  it('plays through Play on Roku with the mp3 stream and the song details', async () => {
    await tv().play(URL0, { title: 'Song é', artist: 'Band', artwork: 'http://192.0.2.1:8090/api/image/a?size=640' }, 0);
    const launch = roku.calls.find((c) => c.startsWith(`POST /launch/${PLAY_ON_ROKU}?`))!;
    const q = new URL(`http://x${launch.slice(5)}`).searchParams;
    expect(q.get('t')).toBe('a');
    expect(q.get('songName')).toBe('Song é');
    expect(q.get('songFormat')).toBe('mp3');
    expect(q.get('albumArtUrl')).toContain('/api/image/a');
    const u = new URL(q.get('u')!);
    expect(u.pathname).toBe('/api/stream/abc/track.mp3');
    expect(u.searchParams.get('token')).toBe('t0k');
    expect(u.searchParams.get('startAt')).toBeNull();
  });
  it('a seek is a new launch from that point, and the clock counts from it', async () => {
    const t = tv();
    await t.play(URL0, {}, 0);
    await t.seek(61.7);
    const last = roku.calls.filter((c) => c.includes('/launch/')).pop()!;
    expect(new URL(new URL(`http://x${last.slice(5)}`).searchParams.get('u')!).searchParams.get('startAt')).toBe('61');
    roku.position = 2000;
    expect((await t.status()).position).toBeCloseTo(63, 5);
  });
  it('play/pause is a toggle: pressed only when the state is the other one', async () => {
    const t = tv();
    roku.state = 'play'; await t.resume();
    expect(roku.calls.some((c) => c.includes('/keypress/Play'))).toBe(false);
    await t.pause();
    expect(roku.calls.filter((c) => c.includes('/keypress/Play'))).toHaveLength(1);
  });
  it('reads position and duration in seconds, and the end of our track', async () => {
    const t = tv();
    await t.play(URL0, {}, 0);
    let s = await t.status();
    expect(s.playing).toBe(true); expect(s.position).toBeCloseTo(12.345); expect(s.duration).toBe(200);
    roku.state = 'close';
    s = await t.status();
    expect(s.ended).toBe(true);
  });
  it('another app in front means the TV was taken', async () => {
    const t = tv();
    await t.play(URL0, {}, 0);
    roku.app = { id: '12', name: 'Netflix' };
    const s = await t.status();
    expect(s.state).toBe('stream');
    expect(s.serviceName).toBe('Netflix');
    expect(s.streamUrl).not.toContain('/api/stream');
  });
  it('stop leaves the player with Back only when our app is in front', async () => {
    const t = tv();
    await t.stop();
    expect(roku.calls).toHaveLength(0); // never played: nothing touched
    await t.play(URL0, {}, 0);
    roku.app = { id: '12', name: 'Netflix' };
    await t.stop();
    expect(roku.calls.some((c) => c.includes('/keypress/Back'))).toBe(false);
  });
  it('device-info gives the name people chose and the model', () => {
    const info = parseRokuInfo('<device-info><udn>29600009-1234</udn><vendor-name>TCL</vendor-name><model-name>55R635</model-name><user-device-name>Lounge TV</user-device-name></device-info>');
    expect(info).toEqual({ udn: '29600009-1234', name: 'Lounge TV', model: 'Roku TCL 55R635' });
    expect(parseRokuInfo('<device-info><udn>u</udn><vendor-name>Roku</vendor-name><model-name>Roku Ultra</model-name></device-info>')?.model).toBe('Roku Ultra');
  });
});
