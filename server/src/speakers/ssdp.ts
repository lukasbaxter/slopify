// SSDP (UPnP discovery) for the speaker families found that way:
//   urn:schemas-upnp-org:device:MediaRenderer:1  -> DLNA renderers: Sonos, Denon/Marantz HEOS,
//                                                   most smart TVs, Kodi, gmrender, WiiM...
//   roku:ecp                                     -> Roku players and Roku TVs (ECP on :8060)
// A search goes out on the LAN interface every minute; every answer's
// description is read once (cached by LOCATION) and turned into a Speaker.
import dgram from 'node:dgram';
import http from 'node:http';

export const SSDP_ADDR = '239.255.255.250';
export const SSDP_PORT = 1900;
export const RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';
export const SONOS_ZP = 'urn:schemas-upnp-org:device:ZonePlayer:1';
export const ROKU_ST = 'roku:ecp';

export type SsdpHit = { st: string; location: string; usn: string; server: string; host: string };

export function parseSsdp(msg: string, host: string): SsdpHit | null {
  const lines = msg.split(/\r?\n/);
  if (!/^HTTP\/1\.\d 200|^NOTIFY /i.test(lines[0] || '')) return null;
  const h: Record<string, string> = {};
  for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  const st = h.st || h.nt || '';
  if (!h.location || !st) return null;
  return { st, location: h.location, usn: h.usn || '', server: h.server || '', host };
}

// One M-SEARCH per target, answers collected for `ms`.
export function search(targets: string[], iface: string | undefined, ms = 3000): Promise<SsdpHit[]> {
  return new Promise((resolve) => {
    const hits: SsdpHit[] = [];
    let sock: dgram.Socket;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { resolve(hits); return; }
    const finish = () => { try { sock.close(); } catch { /* closed */ } resolve(hits); };
    sock.on('error', finish);
    sock.on('message', (buf, rinfo) => { const hit = parseSsdp(buf.toString('utf8'), rinfo.address); if (hit) hits.push(hit); });
    sock.bind(0, iface, () => {
      try { if (iface) sock.setMulticastInterface(iface); } catch { /* default route */ }
      for (const st of targets) {
        const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\nUSER-AGENT: Slopify UPnP/1.1\r\n\r\n`);
        // Twice: UDP on WiFi drops packets, and a renderer that misses one search is gone for a minute.
        sock.send(m, SSDP_PORT, SSDP_ADDR, () => {});
        setTimeout(() => { try { sock.send(m, SSDP_PORT, SSDP_ADDR, () => {}); } catch { /* closed */ } }, 400);
      }
      setTimeout(finish, ms);
    });
  });
}

export function httpText(url: string, ms = 3000, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    // A connection per request: UPnP stacks (libupnp, HEOS) close the socket
    // after each answer, and a kept-alive socket reused after that fails the
    // next call with "socket hang up".
    const req = http.request(url, { method, timeout: ms, agent: false, headers: { Connection: 'close', ...(body != null ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(new Error('too large')); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export const xmlUnescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
export const xmlEscape = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export function xtag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(xml);
  return m ? xmlUnescape(m[1].trim()) : null;
}

export type RendererDesc = {
  udn: string; name: string; model: string; manufacturer: string; sonos: boolean;
  avTransport: string; renderingControl: string | null; connectionManager: string | null;
};

// The device description: the MediaRenderer device may be the root or
// embedded (Sonos: ZonePlayer > MediaRenderer); its services' control URLs
// are relative to URLBase, else to the description's own address.
export function parseDescription(xml: string, location: string): RendererDesc | null {
  const base = xtag(xml, 'URLBase') || location;
  const devices = [...xml.matchAll(/<device>([\s\S]*?)(?=<device>|<\/deviceList>|<\/root>)/gi)].map((m) => m[1]);
  const root = devices[0] || xml;
  const renderer = devices.find((d) => /<deviceType>[^<]*MediaRenderer/i.test(d)) || root;
  const services = [...renderer.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => ({ type: xtag(m[1], 'serviceType') || '', control: xtag(m[1], 'controlURL') || '' }));
  const url = (type: RegExp) => { const s = services.find((x) => type.test(x.type)); if (!s || !s.control) return null; try { return new URL(s.control, base).toString(); } catch { return null; } };
  const avTransport = url(/:service:AVTransport:/i);
  if (!avTransport) return null;
  const manufacturer = xtag(root, 'manufacturer') || '';
  const sonos = /sonos/i.test(manufacturer);
  // Sonos names its rooms in roomName; the friendlyName is "<ip> - Sonos One".
  const name = (sonos ? xtag(root, 'roomName') : null) || xtag(renderer, 'friendlyName') || xtag(root, 'friendlyName') || 'Speaker';
  return {
    udn: (xtag(renderer, 'UDN') || xtag(root, 'UDN') || location).replace(/^uuid:/i, ''),
    name: name.replace(/\s*\(\d+\.\d+\.\d+\.\d+\)\s*$/, '').slice(0, 64),
    model: (sonos ? xtag(root, 'displayName') || xtag(root, 'modelName') : xtag(renderer, 'modelName') || xtag(root, 'modelName')) || 'DLNA',
    manufacturer, sonos,
    avTransport, renderingControl: url(/:service:RenderingControl:/i), connectionManager: url(/:service:ConnectionManager:/i),
  };
}
