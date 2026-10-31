// LAN discovery for the speaker families the server can drive:
//   _googlecast._tcp       -> Chromecast / Google TV / Cast speakers (CASTV2 on :8009)
//   _musc._tcp             -> Bluesound / BluOS players (plain HTTP on :11000)
//   _slopify-speaker._tcp  -> anything speaking the small "slopify-speaker/1" HTTP API on :7780
//                             (see BridgeTransport; e.g. an ESP32 bridge to a Bluetooth soundbar)
//   _raop._tcp / _airplay._tcp -> AirPlay receivers: Apple TV, HomePod, AirPlay speakers (airplay.ts)
//   SSDP MediaRenderer     -> DLNA renderers: Sonos, HEOS, smart TVs, Kodi... (upnp.ts)
//   SSDP roku:ecp          -> Roku players and TVs (roku.ts)
// A box that speaks several of these is listed once, by the best of them
// (BluOS, then Cast, then DLNA, then AirPlay, then Roku): a Denon receiver
// answers HEOS/DLNA and AirPlay, a Sonos DLNA and AirPlay, a Google TV Cast
// and DLNA.
// mDNS is not enough on its own: Google TV devices in particular go missing
// from the multicast browse (a wired Google TV Streamer never showed up
// while it answered on :8009 the whole time), so every minute the local /24
// is also swept for the three ports and anything that answers is asked for
// its name over plain HTTP. The server runs on the house LAN, so what it
// finds here is offered to every client of every account, wherever they are.
import { Bonjour, type Browser } from 'bonjour-service';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import { parseDescription, RENDERER, ROKU_ST, search, SONOS_ZP, type SsdpHit } from './ssdp.js';
import { parseRokuInfo, ROKU_PORT } from './roku.js';
import { airplayConfig } from './airplay.js';

export type SpeakerKind = 'cast' | 'bluos' | 'bridge' | 'upnp' | 'airplay' | 'roku';
export type Speaker = {
  id: string; kind: SpeakerKind; name: string; model: string; host: string; port: number; swept?: boolean;
  // Found by SSDP (missed searches count against it, like the sweep).
  ssdp?: boolean;
  // DLNA control endpoints (kind 'upnp').
  avTransport?: string; renderingControl?: string | null; connectionManager?: string | null; sonos?: boolean;
  // AirPlay services and their TXT records (kind 'airplay').
  raop?: { port: number; name: string; txt: Record<string, string> } | null;
  airplay?: { port: number; host: string; txt: Record<string, string> } | null;
};
// "Denon" + "Denon AVR-X1700H" is "Denon AVR-X1700H"; a long credits line
// for a manufacturer ("Ivo Clarysse, Henner Zeller") is left out.
function upnpModel(manufacturer: string, model: string) {
  const m = (model || '').trim(), maker = (manufacturer || '').trim().replace(/,? (inc|corp|corporation|ltd|gmbh|co)\.?$/i, '');
  if (!maker || maker.length > 24 || /,/.test(maker) || m.toLowerCase().startsWith(maker.toLowerCase().split(' ')[0])) return (m || maker || 'DLNA').slice(0, 64);
  return `${maker} ${m}`.trim().slice(0, 64);
}
// One entry per box: lower wins.
const RANK: Record<SpeakerKind, number> = { bluos: 0, bridge: 1, cast: 2, upnp: 3, airplay: 4, roku: 5 };

const CAST_PORT = 8009;
export const BLUOS_PORT = 11000;
export const BRIDGE_PORT = 7780;
// A TV whose home screen runs the Slopify TV agent: it can open the Slopify TV
// app on request, so a Cast target that is such a TV is played through the app.
export const TV_AGENT_PORT = 7781;
export type TvAgent = { host: string; port: number; name: string; app: boolean };
const SWEEP_EVERY = 60 * 1000;

// The LAN's own IPv4 (not a VPN's, not link-local); mDNS sockets are pinned
// to it so multicast does not wander into a tunnel. Same interface filter as
// the sweep: a Docker bridge carries a private address too.
export function lanAddress(): string | undefined {
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (/^(br-|docker|veth|virbr|wg|tailscale|tun|tap)/.test(name)) continue;
    if (a.family !== 'IPv4' || a.internal) continue;
    if (a.address.startsWith('169.254.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
  }
  return undefined;
}

export class Discovery {
  devices = new Map<string, Speaker>();
  agents = new Map<string, TvAgent>(); // by host
  private missedAgents = new Map<string, number>();
  private bonjour: Bonjour | null = null;
  private browsers: Browser[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private missed = new Map<string, number>();
  private sweeping = false;
  constructor(private onChange: (list: Speaker[]) => void, private log: (m: string) => void = () => {}) {}

  start() {
    if (this.bonjour) return;
    const iface = lanAddress();
    // Bound to every address, joined on the LAN interface: a socket bound to
    // the interface's own address (multicast-dns's default when given one)
    // never receives multicast on Linux, so pinned browsing heard no
    // announcements at all (advertise.ts has the same fix).
    try { this.bonjour = new Bonjour((iface ? { interface: iface, bind: '0.0.0.0', reuseAddr: true } : undefined) as any); }
    catch (e: any) { this.log(`mdns: ${e.message}`); return; }
    const cast = this.bonjour.find({ type: 'googlecast' }, (s) => this.add(this.fromCast(s)));
    const blu = this.bonjour.find({ type: 'musc' }, (s) => this.add(this.fromBluOS(s)));
    const bridge = this.bonjour.find({ type: 'slopify-speaker' }, (s) => { this.identifyBridge(this.address(s), s.port || BRIDGE_PORT).then((d) => d && this.add({ ...d, swept: false })).catch(() => {}); });
    const raop = this.bonjour.find({ type: 'raop' }, (s) => this.addAirPlay(s, 'raop'));
    const air = this.bonjour.find({ type: 'airplay' }, (s) => this.addAirPlay(s, 'airplay'));
    this.browsers = [cast, blu, bridge];
    for (const b of this.browsers) b.on('down', (s) => this.remove(s));
    for (const b of [raop, air]) b.on('down', (s) => this.removeAirPlay(s));
    this.browsers.push(raop, air);
    this.sweepTimer = setInterval(() => { this.sweep().catch(() => {}); this.ssdpSweep().catch(() => {}); }, SWEEP_EVERY);
    setTimeout(() => { this.sweep().catch(() => {}); this.ssdpSweep().catch(() => {}); }, 1500);
  }
  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer); this.sweepTimer = null;
    for (const b of this.browsers) { try { b.stop(); } catch { /* torn down */ } }
    this.browsers = [];
    if (this.bonjour) { try { this.bonjour.destroy(); } catch { /* torn down */ } this.bonjour = null; }
  }
  // Every box once, by the best way to drive it: an entry is hidden when a
  // better kind on the same address has the same name (a Denon is "Denon
  // AVR-X1700H" over HEOS/DLNA and over AirPlay). Two different players on
  // one machine (Kodi with AirPlay, a Linux box with a DLNA renderer and
  // shairport-sync) have their own names and both stay.
  list(): Speaker[] {
    const all = [...this.devices.values()];
    const norm = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const same = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };
    return all
      .filter((d) => !all.some((o) => o !== d && o.host === d.host && RANK[o.kind] < RANK[d.kind] && same(o.name, d.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  get(id: string) { return this.devices.get(id) ?? null; }
  agentAt(host: string): TvAgent | null { return this.agents.get(host) ?? null; }
  async identifyTvAgent(host: string, port = TV_AGENT_PORT): Promise<TvAgent | null> {
    const info = JSON.parse(await this.getText(`http://${host}:${port}/info`));
    if (!info || info.kind !== 'slopify-tv') return null;
    return { host, port, name: String(info.name || 'TV').slice(0, 56), app: !!info.app };
  }

  // Only an address on a home network: an announcement is unauthenticated,
  // and the stream URL (with the account's speaker token) goes to this host.
  private address(service: any): string {
    const v4 = (service.addresses || []).find((a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+(\.\d+)?$/.test(a) && /^\d+\.\d+\.\d+\.\d+$/.test(a));
    return v4 || '';
  }
  private fromCast(service: any): Speaker {
    const txt = service.txt || {};
    return { id: `cast:${txt.id || service.fqdn || service.name}`, kind: 'cast', name: txt.fn || service.name, model: txt.md || 'Google Cast', host: this.address(service), port: service.port || CAST_PORT };
  }
  private fromBluOS(service: any): Speaker {
    return { id: `bluos:${this.address(service)}`, kind: 'bluos', name: service.name, model: 'BluOS', host: this.address(service), port: BLUOS_PORT };
  }
  private add(dev: Speaker) {
    if (!dev || !dev.host) return;
    const before = JSON.stringify(this.devices.get(dev.id));
    this.devices.set(dev.id, dev);
    if (before !== JSON.stringify(dev)) this.onChange(this.list());
  }
  private remove(service: any) {
    const host = this.address(service);
    let changed = false;
    for (const [id, d] of this.devices) if (d.host === host && !d.swept && !d.ssdp && d.kind !== 'airplay') { this.devices.delete(id); changed = true; }
    if (changed) this.onChange(this.list());
  }

  // ---- AirPlay (mDNS) --------------------------------------------------------
  // _raop._tcp is "AABBCCDDEEFF@Kitchen" with the stream TXT (et, cn, md, pk...);
  // _airplay._tcp is "Kitchen" with features / deviceid / model. Both are
  // merged into one speaker per address.
  private airplaySeen = new Map<string, { raop?: any; airplay?: any }>();
  private addAirPlay(service: any, which: 'raop' | 'airplay') {
    const host = this.address(service);
    if (!airplayConfig.binary) return; // nothing to stream with
    if (!host) return;
    const entry = this.airplaySeen.get(host) || {};
    entry[which] = service;
    this.airplaySeen.set(host, entry);
    const txt = (s: any): Record<string, string> => Object.fromEntries(Object.entries(s?.txt || {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('utf8') : String(v)]));
    const r = entry.raop, a = entry.airplay;
    const rt = r ? txt(r) : null, at = a ? txt(a) : null;
    const mac = (at?.deviceid || (r ? String(r.name).split('@')[0] : '') || host).replace(/[^0-9a-f]/gi, '').toLowerCase();
    const name = a ? String(a.name) : String(r.name).split('@').slice(1).join('@') || String(r.name);
    this.add({
      id: `airplay:${mac}`, kind: 'airplay', name: name.slice(0, 64), model: at?.model || rt?.am || 'AirPlay', host, port: a?.port || r?.port || 7000,
      raop: r ? { port: r.port, name: String(r.name), txt: rt! } : null,
      airplay: a ? { port: a.port, host: String(a.host || host), txt: at! } : null,
    });
  }
  private removeAirPlay(service: any) {
    const host = this.address(service);
    this.airplaySeen.delete(host);
    let changed = false;
    for (const [id, d] of this.devices) if (d.kind === 'airplay' && d.host === host) { this.devices.delete(id); changed = true; }
    if (changed) this.onChange(this.list());
  }

  // ---- SSDP: DLNA renderers and Rokus -----------------------------------------
  private described = new Map<string, { at: number; dev: Speaker | null }>(); // by LOCATION
  private ssdpMissed = new Map<string, number>();
  private ssdpBusy = false;
  async ssdpSweep() {
    if (this.ssdpBusy) return;
    this.ssdpBusy = true;
    try {
      const hits = await search([RENDERER, SONOS_ZP, ROKU_ST], lanAddress());
      const byLocation = new Map<string, SsdpHit>();
      for (const h of hits) if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h.host) && !byLocation.has(h.location)) byLocation.set(h.location, h);
      const seen = new Set<string>();
      let changed = false;
      await Promise.all([...byLocation.values()].map(async (h) => {
        const dev = await this.describe(h).catch(() => null);
        if (!dev) return;
        seen.add(dev.id);
        const before = JSON.stringify(this.devices.get(dev.id));
        this.devices.set(dev.id, dev);
        if (before !== JSON.stringify(dev)) changed = true;
      }));
      // UDP answers go missing: three searches in a row without it.
      for (const [id, d] of this.devices) {
        if (!d.ssdp) continue;
        if (seen.has(id)) { this.ssdpMissed.delete(id); continue; }
        const n = (this.ssdpMissed.get(id) || 0) + 1;
        this.ssdpMissed.set(id, n);
        if (n >= 3) { this.devices.delete(id); this.ssdpMissed.delete(id); changed = true; }
      }
      if (changed) this.onChange(this.list());
    } finally { this.ssdpBusy = false; }
  }
  private async describe(h: SsdpHit): Promise<Speaker | null> {
    const cached = this.described.get(h.location);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.dev;
    let dev: Speaker | null = null;
    const loc = new URL(h.location);
    if (loc.hostname !== h.host) return null; // a description elsewhere than the answer came from
    if (/roku:ecp/i.test(h.st)) {
      const info = parseRokuInfo(await this.getText(`http://${h.host}:${loc.port || ROKU_PORT}/query/device-info`));
      if (info) dev = { id: `roku:${info.udn.toLowerCase()}`, kind: 'roku', name: info.name, model: info.model, host: h.host, port: Number(loc.port) || ROKU_PORT, ssdp: true };
    } else {
      const d = parseDescription(await this.getText(h.location, 3000), h.location);
      if (d) dev = { id: `upnp:${d.udn.toLowerCase()}`, kind: 'upnp', name: d.name, model: d.sonos ? `Sonos ${d.model}`.replace(/^Sonos Sonos/, 'Sonos') : upnpModel(d.manufacturer, d.model), host: h.host, port: Number(loc.port) || 80, ssdp: true, avTransport: d.avTransport, renderingControl: d.renderingControl, connectionManager: d.connectionManager, sonos: d.sonos };
    }
    this.described.set(h.location, { at: Date.now(), dev });
    return dev;
  }

  // ---- port sweep -------------------------------------------------------------
  // Only real LAN interfaces: with host networking every Docker bridge (and
  // the VPNs) shows up here too, and sweeping 20-odd of them took over a
  // minute after each restart, during which nobody could see a speaker.
  private subnets(): string[] {
    const out = new Set<string>();
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
      if (/^(br-|docker|veth|virbr|wg|tailscale|tun|tap)/.test(name)) continue;
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      out.add(a.address.split('.').slice(0, 3).join('.'));
    }
    return [...out];
  }
  private open(host: string, port: number, ms = 800): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok: boolean) => { try { sock.destroy(); } catch { /* closed */ } resolve(ok); };
      sock.setTimeout(ms, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }
  private getText(url: string, ms = 2000): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: ms }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve(body)); });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }
  private async identifyCast(host: string): Promise<Speaker | null> {
    const info = JSON.parse(await this.getText(`http://${host}:8008/setup/eureka_info?params=name,device_info&options=detail`));
    const udn = String(info.ssdp_udn || info.device_info?.ssdp_udn || '').replace(/-/g, '');
    if (!info.name) return null;
    return { id: `cast:${udn || host}`, kind: 'cast', name: info.name, model: info.device_info?.model_name || 'Google Cast', host, port: CAST_PORT, swept: true };
  }
  private async identifyBluOS(host: string): Promise<Speaker | null> {
    const xml = await this.getText(`http://${host}:${BLUOS_PORT}/SyncStatus`);
    const name = (/\sname="([^"]*)"/.exec(xml) || [])[1];
    if (!name) return null;
    return { id: `bluos:${host}`, kind: 'bluos', name: name.replace(/&amp;/g, '&'), model: 'BluOS', host, port: BLUOS_PORT, swept: true };
  }
  // A "slopify-speaker/1" device says who it is at /info.
  async identifyBridge(host: string, port = BRIDGE_PORT): Promise<Speaker | null> {
    const info = JSON.parse(await this.getText(`http://${host}:${port}/info`));
    if (!/^slopify-speaker\//.test(String(info.api || '')) || !info.name) return null;
    return { id: `bridge:${String(info.id || host).toLowerCase()}`, kind: 'bridge', name: String(info.name), model: String(info.model || 'Speaker'), host, port, swept: true };
  }
  async sweep() {
    if (!this.bonjour || this.sweeping) return;
    this.sweeping = true;
    try {
      const hosts: string[] = [];
      for (const net24 of this.subnets()) for (let i = 1; i < 255; i++) hosts.push(`${net24}.${i}`);
      const known = new Map([...this.devices.values()].map((d) => [`${d.host}:${d.port}`, d]));
      const seen = new Set<string>();
      let changed = false;
      const queue = hosts.flatMap((h) => [[h, CAST_PORT], [h, BLUOS_PORT], [h, BRIDGE_PORT], [h, TV_AGENT_PORT]] as [string, number][]);
      const agentsSeen = new Set<string>();
      const worker = async () => {
        while (queue.length) {
          const [host, port] = queue.shift()!;
          if (!(await this.open(host, port))) continue;
          if (port === TV_AGENT_PORT) {
            try { const a = await this.identifyTvAgent(host, port); if (a) { agentsSeen.add(host); if (!this.agents.has(host)) this.log(`tv agent: ${a.name} at ${host}`); this.agents.set(host, a); } } catch { /* not ours */ }
            continue;
          }
          seen.add(`${host}:${port}`);
          if (known.has(`${host}:${port}`)) continue;
          try {
            const dev = port === CAST_PORT ? await this.identifyCast(host) : port === BLUOS_PORT ? await this.identifyBluOS(host) : await this.identifyBridge(host, port);
            if (dev && !this.devices.has(dev.id)) { this.devices.set(dev.id, dev); changed = true; }
          } catch { /* answers on the port but is not one of ours */ }
        }
      };
      await Promise.all(Array.from({ length: 64 }, worker));
      for (const host of [...this.agents.keys()]) {
        if (agentsSeen.has(host)) { this.missedAgents.delete(host); continue; }
        const n = (this.missedAgents.get(host) || 0) + 1;
        this.missedAgents.set(host, n);
        if (n >= 2) { this.agents.delete(host); this.missedAgents.delete(host); }
      }
      for (const [id, d] of this.devices) {
        if (!d.swept || d.ssdp) continue;
        const key = `${d.host}:${d.port}`;
        if (seen.has(key)) { this.missed.delete(key); continue; }
        const n = (this.missed.get(key) || 0) + 1;
        this.missed.set(key, n);
        if (n >= 2) { this.devices.delete(id); this.missed.delete(key); changed = true; }
      }
      if (changed) this.onChange(this.list());
    } finally { this.sweeping = false; }
  }
}
