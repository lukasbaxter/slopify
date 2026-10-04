import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../library.js', () => ({
  tracksByIds: (_db: unknown, ids: string[]) => ids.map((id) => ({ id, title: `Song ${id}`, artists: ['A'], artistIds: ['a'], albumArtist: 'A', album: 'B', albumId: 'b', durationMs: 200000, codec: 'flac' })),
  mixFor: () => [],
}));

import { SpeakerStates } from './state.js';
import { ServerPlayer } from './player.js';
import type { Speaker } from './discovery.js';

// One BluOS unit with inputs, playing HDMI on its own.
const unit = { calls: [] as string[], state: 'stream', service: 'Capture', inputId: 'input2', volume: 23, slaves: new Set<number>() };
let port = 0; let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x'); unit.calls.push(url.pathname + url.search);
    if (url.pathname === '/RadioBrowse') return res.end('<radiotime service="Capture"><item text="Bluetooth" id="input3" URL="Capture%3Abluez%3Abluetooth"></item><item text="HDMI ARC" id="input2" URL="Capture%3Ahw%3Aimxspdif%2C0%2F1%2F25%2F2%3Fid%3Dinput2"></item><item text="Spotify" id="Spotify" URL="Spotify%3Aplay"></item></radiotime>');
    if (url.pathname === '/Status') return res.end(`<status><state>${unit.state}</state><service>${unit.service}</service><inputId>${unit.inputId}</inputId><title1>TV</title1>${unit.service === 'Spotify' ? '<serviceName>Spotify</serviceName><title2>Artist</title2><image>https://i.scdn.co/image/abc</image>' : '<image>/images/tv.png</image>'}<volume>${unit.volume}</volume><mute>0</mute><secs>3</secs></status>`);
    if (url.pathname === '/SyncStatus') return res.end(`<SyncStatus>${[...unit.slaves].map((p) => `<slave id="127.0.0.1" port="${p}"></slave>`).join('')}</SyncStatus>`);
    if (url.pathname === '/Volume' && url.searchParams.has('level')) unit.volume = Number(url.searchParams.get('level'));
    if (url.pathname === '/Play' && url.searchParams.get('url')?.startsWith('Spotify')) { unit.service = 'Spotify'; unit.inputId = ''; }
    if (url.pathname === '/Pause') unit.state = 'pause';
    res.end('<ok/>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

const speaker = (): Speaker => ({ id: 'bluos:towers', kind: 'bluos', name: 'Towers', model: 'BluOS', host: '127.0.0.1', port });
const discovery = () => ({ list: () => [speaker()], get: (id: string) => (id === 'bluos:towers' ? speaker() : null) }) as any;

describe('a speaker on its own', () => {
  it('reports its volume, its inputs and the input it plays', async () => {
    const changes: number[] = [];
    const s = new SpeakerStates(discovery(), () => changes.push(1));
    await s.poll();
    expect(s.get('bluos:towers')).toMatchObject({ volume: 23, state: 'stream', playing: true, input: 'HDMI ARC', image: `http://127.0.0.1:${port}/images/tv.png`, inputs: [{ name: 'Bluetooth' }, { name: 'HDMI ARC' }, { name: 'Spotify' }] });
    expect(changes).toHaveLength(1);
    await s.poll();
    expect(changes).toHaveLength(1); // nothing new, no broadcast
  });
  it('sets its volume, plays an input by name, and plays/pauses on its own', async () => {
    const s = new SpeakerStates(discovery(), () => {});
    await s.setVolume('bluos:towers', 41);
    expect(s.get('bluos:towers')?.volume).toBe(41);
    await s.playInput('bluos:towers', 'spotify');
    expect(unit.calls).toContain('/Play?url=Spotify%3Aplay');
    expect(s.get('bluos:towers')).toMatchObject({ input: 'Spotify', artist: 'Artist', image: 'https://i.scdn.co/image/abc' });
    await s.control('bluos:towers', 'pause');
    expect(s.get('bluos:towers')?.state).toBe('pause');
    await expect(s.playInput('bluos:towers', 'Vinyl')).rejects.toThrow(/no input called Vinyl/);
  });
  it('an input takes the speaker away from the Slopify music on it', async () => {
    const p = new ServerPlayer('u', {
      db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } as any,
      discovery: discovery(), publicUrl: 'http://music', token: 't', log: () => {}, claim: () => {}, reportQueue: () => {}, report: () => {},
    });
    await p.execute({ action: 'transfer', deviceId: 'bluos:towers', trackIds: ['t1'], index: 0, position: 0, playing: true });
    expect(p.transport).not.toBeNull();
    await new SpeakerStates(discovery(), () => {}).playInput('bluos:towers', 'Bluetooth');
    expect(p.transport).toBeNull();
    expect(unit.calls.at(-2)).toBe('/Play?url=Capture%3Abluez%3Abluetooth');
  });
});
