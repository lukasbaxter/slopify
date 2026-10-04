import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BluOSTransport } from './transports.js';

// A BluOS unit: grouped units answer /Status with the group's volume.
const unit = { status: '', volume: '<volume db="-43.1" mute="0">11</volume>', volumeReads: 0 };
let server: http.Server; let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/Volume')) unit.volumeReads += 1;
    res.end(req.url?.startsWith('/Status') ? unit.status : unit.volume);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());
const speaker = () => new BluOSTransport({ id: 'bluos:x', kind: 'bluos', name: 'Node', model: 'BluOS', host: '127.0.0.1', port });

describe('BluOS volume', () => {
  it("a grouped speaker reports its own volume, not the group's 0", async () => {
    unit.status = '<status><groupName>Towers + 3</groupName><state>stream</state><volume>0</volume><mute>0</mute><secs>5</secs></status>';
    const t = speaker();
    expect((await t.status()).volume).toBe(11);
    const reads = unit.volumeReads;
    await t.status();
    expect(unit.volumeReads).toBe(reads); // cached between the 4-a-second polls
  });
  it('a speaker on its own reads the volume from its status', async () => {
    unit.status = '<status><state>play</state><volume>42</volume><mute>0</mute><secs>5</secs></status>';
    expect((await speaker().status()).volume).toBe(42);
  });
  it('no volume (fixed output) is unknown, not 0', async () => {
    unit.status = '<status><state>play</state><mute>0</mute><secs>5</secs></status>';
    expect((await speaker().status()).volume).toBeNull();
    unit.status = '<status><state>play</state><volume>-1</volume><mute>0</mute><secs>5</secs></status>';
    expect((await speaker().status()).volume).toBeNull();
  });
});
