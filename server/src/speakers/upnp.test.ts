import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { didl, parseHms, UpnpTransport } from './upnp.js';
import { parseDescription, parseSsdp } from './ssdp.js';

// A Sonos as its description shows it: a ZonePlayer root with the room name,
// the MediaRenderer (and its services) embedded.
const SONOS = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>192.0.2.20 - Sonos One - RINCON_1</friendlyName>
<manufacturer>Sonos, Inc.</manufacturer><modelName>Sonos One</modelName><displayName>One</displayName><roomName>Kitchen</roomName><UDN>uuid:RINCON_1</UDN>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><UDN>uuid:RINCON_1_MS</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><controlURL>/MediaServer/ContentDirectory/Control</controlURL></service></serviceList></device>
<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Kitchen - Sonos One Media Renderer</friendlyName><UDN>uuid:RINCON_1_MR</UDN><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/MediaRenderer/RenderingControl/Control</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaRenderer/ConnectionManager/Control</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/MediaRenderer/AVTransport/Control</controlURL></service>
</serviceList></device></deviceList></device></root>`;

describe('UPnP description', () => {
  it('Sonos: the room name, the embedded renderer and its control URLs', () => {
    const d = parseDescription(SONOS, 'http://192.0.2.20:1400/xml/device_description.xml')!;
    expect(d.sonos).toBe(true);
    expect(d.name).toBe('Kitchen');
    expect(d.model).toBe('One');
    expect(d.udn).toBe('RINCON_1_MR');
    expect(d.avTransport).toBe('http://192.0.2.20:1400/MediaRenderer/AVTransport/Control');
    expect(d.renderingControl).toBe('http://192.0.2.20:1400/MediaRenderer/RenderingControl/Control');
  });
  it('a TV that puts its address in its name loses it; no AVTransport is not a renderer', () => {
    const tv = parseDescription('<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Living Room TV(192.0.2.5)</friendlyName><manufacturer>X</manufacturer><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>AVT/control</controlURL></service></serviceList></device></root>', 'http://192.0.2.5:16138/desc.xml')!;
    expect(tv.name).toBe('Living Room TV');
    expect(tv.avTransport).toBe('http://192.0.2.5:16138/AVT/control');
    expect(parseDescription('<root><device><friendlyName>NAS</friendlyName></device></root>', 'http://h/')).toBeNull();
  });
  it('SSDP answers and NOTIFYs', () => {
    expect(parseSsdp('HTTP/1.1 200 OK\r\nST: roku:ecp\r\nLOCATION: http://192.0.2.7:8060/\r\nUSN: uuid:roku:ecp:X\r\n\r\n', '192.0.2.7')).toMatchObject({ st: 'roku:ecp', location: 'http://192.0.2.7:8060/' });
    expect(parseSsdp('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n', 'h')).toBeNull();
  });
});

describe('DIDL', () => {
  it('non-ASCII as numeric entities (HEOS mangles UTF-8), duration as h:mm:ss', () => {
    const x = didl('http://h/api/stream/a/track.flac?token=t&x=1', { title: 'Café <Live>', artist: 'Sigur Rós', album: 'Ágætis byrjun', artwork: 'http://h/api/image/a' }, 'audio/flac', 3725);
    expect(x).toContain('Caf&#233; &lt;Live&gt;');
    expect(x).toContain('Sigur R&#243;s');
    expect(x).toContain('duration="01:02:05"');
    expect(x).toContain('http-get:*:audio/flac:');
    expect(x).toContain('token=t&amp;x=1');
    expect([...x].some((c) => c.charCodeAt(0) > 127)).toBe(false);
  });
  it('parses RelTime variants', () => {
    expect(parseHms('0:01:05')).toBe(65);
    expect(parseHms('00:00:30.500')).toBe(30.5);
    expect(parseHms('NOT_IMPLEMENTED')).toBe(0);
  });
});

// A renderer: records SOAP actions, answers with what the test sets.
const r = { actions: [] as { action: string; body: string }[], sink: 'http-get:*:audio/mpeg:*,http-get:*:audio/flac:*', state: 'PLAYING', rel: '0:00:10', dur: '0:03:00', uri: '' };
let server: http.Server; let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const action = String(req.headers.soapaction || '').replace(/"/g, '').split('#')[1] || '';
      r.actions.push({ action, body });
      if (action === 'SetAVTransportURI') r.uri = (/<CurrentURI>([^<]*)<\/CurrentURI>/.exec(body) || [])[1]?.replace(/&amp;/g, '&') || '';
      const out: Record<string, string> = {
        GetProtocolInfo: `<Source></Source><Sink>${r.sink}</Sink>`,
        GetTransportInfo: `<CurrentTransportState>${r.state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>`,
        GetPositionInfo: `<Track>1</Track><TrackDuration>${r.dur}</TrackDuration><TrackURI>${r.uri.replace(/&/g, '&amp;')}</TrackURI><RelTime>${r.rel}</RelTime>`,
        GetVolume: '<CurrentVolume>25</CurrentVolume>', GetMute: '<CurrentMute>0</CurrentMute>',
      };
      res.setHeader('content-type', 'text/xml');
      res.end(`<s:Envelope><s:Body><u:${action}Response>${out[action] || ''}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => { r.actions = []; r.state = 'PLAYING'; r.uri = ''; r.rel = '0:00:10'; r.sink = 'http-get:*:audio/mpeg:*,http-get:*:audio/flac:*'; });
const renderer = () => new UpnpTransport({ id: 'upnp:x', kind: 'upnp', name: 'Kitchen', model: 'Sonos One', host: '127.0.0.1', port: 1400, avTransport: `${base}/avt`, renderingControl: `${base}/rc`, connectionManager: `${base}/cm` });
const URL0 = 'http://192.0.2.1:8090/api/stream/abc?token=t0k';

describe('UPnP transport', () => {
  it('stop, load, play: the original file when the renderer takes its type', async () => {
    await renderer().play(URL0, { title: 'A', contentType: 'audio/flac', duration: 180 }, 0);
    expect(r.actions.map((a) => a.action)).toEqual(['GetProtocolInfo', 'Stop', 'SetAVTransportURI', 'Play']);
    expect(new URL(r.uri).pathname).toBe('/api/stream/abc/track.flac');
  });
  it("the server's mp3 when it does not, and a seek is a new stream from there", async () => {
    r.sink = 'http-get:*:audio/mpeg:*';
    const t = renderer();
    await t.play(URL0, { contentType: 'audio/ogg', duration: 180 }, 0);
    expect(new URL(r.uri).pathname).toBe('/api/stream/abc/track.mp3');
    expect(new URL(r.uri).searchParams.get('bitrate')).toBe('320000');
    await t.seek(42);
    expect(new URL(r.uri).searchParams.get('startAt')).toBe('42');
    expect(r.actions.some((a) => a.action === 'Seek')).toBe(false);
    r.rel = '0:00:03';
    expect((await t.status()).position).toBe(45); // the transcode counts from where it started
  });
  it('seeks in the original with REL_TIME', async () => {
    const t = renderer();
    await t.play(URL0, { contentType: 'audio/flac' }, 0);
    await t.seek(75);
    expect(r.actions.find((a) => a.action === 'Seek')?.body).toContain('<Target>00:01:15</Target>');
  });
  it('status: position, duration, volume; our stream finishing reads as ended', async () => {
    const t = renderer();
    await t.play(URL0, { contentType: 'audio/flac' }, 0);
    let s = await t.status();
    expect(s).toMatchObject({ playing: true, position: 10, duration: 180, volume: 25, ended: false });
    r.state = 'STOPPED';
    s = await t.status();
    expect(s.ended).toBe(true);
  });
  it('another source on it (Spotify on a Sonos) reads as taken', async () => {
    const t = renderer();
    r.uri = 'x-sonos-spotify:spotify%3atrack%3a123?sid=9&flags=8224&sn=1';
    const s = await t.status();
    expect(s.state).toBe('stream');
    expect(s.serviceName).toBe('Spotify');
  });
  it('stop never touches a renderer we did not play on', async () => {
    await renderer().stop();
    expect(r.actions).toHaveLength(0);
  });
});
