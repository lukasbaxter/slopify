// LAN discovery for the two speaker families the server can drive:
//   _googlecast._tcp  -> Chromecast / Google TV / Cast speakers (CASTV2 on :8009)
//   _musc._tcp        -> Bluesound / BluOS players (plain HTTP on :11000)
// mDNS is not enough on its own: Google TV devices in particular go missing
// from the multicast browse (a wired Google TV Streamer never showed up
// while it answered on :8009 the whole time), so every minute the local /24
// is also swept for the two ports and anything that answers is asked for
// its name over plain HTTP. The server runs on the house LAN, so what it
// finds here is offered to every client of every account, wherever they are.
import { Bonjour, type Browser } from 'bonjour-service';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';

export type Speaker = { id: string; kind: 'cast' | 'bluos'; name: string; model: string; host: string; port: number; swept?: boolean };

const CAST_PORT = 8009;
export const BLUOS_PORT = 11000;
const SWEEP_EVERY = 60 * 1000;

export class Discovery {
  devices = new Map<string, Speaker>();
  private bonjour: Bonjour | null = null;
  private browsers: Browser[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private missed = new Map<string, number>();
  private sweeping = false;
  constructor(private onChange: (list: Speaker[]) => void, private log: (m: string) => void = () => {}) {}

  // The LAN's own IPv4 (not a VPN's, not link-local); the mDNS socket is
  // pinned to it so multicast does not wander into a tunnel.
  private lanAddress(): string | undefined {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
    return undefined;
  }

  start() {
    if (this.bonjour) return;
    const iface = this.lanAddress();
    try { this.bonjour = new Bonjour((iface ? { interface: iface } : undefined) as any); }
    catch (e: any) { this.log(`mdns: ${e.message}`); return; }
    const cast = this.bonjour.find({ type: 'googlecast' }, (s) => this.add(this.fromCast(s)));
    const blu = this.bonjour.find({ type: 'musc' }, (s) => this.add(this.fromBluOS(s)));
    this.browsers = [cast, blu];
    for (const b of this.browsers) b.on('down', (s) => this.remove(s));
    this.sweepTimer = setInterval(() => this.sweep().catch(() => {}), SWEEP_EVERY);
    setTimeout(() => this.sweep().catch(() => {}), 1500);
  }
  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer); this.sweepTimer = null;
    for (const b of this.browsers) { try { b.stop(); } catch { /* torn down */ } }
    this.browsers = [];
    if (this.bonjour) { try { this.bonjour.destroy(); } catch { /* torn down */ } this.bonjour = null; }
  }
  list(): Speaker[] { return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id: string) { return this.devices.get(id) ?? null; }

  private address(service: any): string {
    const v4 = (service.addresses || []).find((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    return v4 || (service.addresses || [])[0] || service.host;
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
    for (const [id, d] of this.devices) if (d.host === host && !d.swept) { this.devices.delete(id); changed = true; }
    if (changed) this.onChange(this.list());
  }

  // ---- port sweep -------------------------------------------------------------
  private subnets(): string[] {
    const out = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
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
  async sweep() {
    if (!this.bonjour || this.sweeping) return;
    this.sweeping = true;
    try {
      const hosts: string[] = [];
      for (const net24 of this.subnets()) for (let i = 1; i < 255; i++) hosts.push(`${net24}.${i}`);
      const known = new Map([...this.devices.values()].map((d) => [`${d.host}:${d.port}`, d]));
      const seen = new Set<string>();
      let changed = false;
      const queue = hosts.flatMap((h) => [[h, CAST_PORT], [h, BLUOS_PORT]] as [string, number][]);
      const worker = async () => {
        while (queue.length) {
          const [host, port] = queue.shift()!;
          if (!(await this.open(host, port))) continue;
          seen.add(`${host}:${port}`);
          if (known.has(`${host}:${port}`)) continue;
          try {
            const dev = port === CAST_PORT ? await this.identifyCast(host) : await this.identifyBluOS(host);
            if (dev && !this.devices.has(dev.id)) { this.devices.set(dev.id, dev); changed = true; }
          } catch { /* answers on the port but is not one of ours */ }
        }
      };
      await Promise.all(Array.from({ length: 64 }, worker));
      for (const [id, d] of this.devices) {
        if (!d.swept) continue;
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
