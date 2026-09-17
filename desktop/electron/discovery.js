'use strict';
// LAN discovery for the two device families we can actually drive:
//   _googlecast._tcp  -> Chromecast / Google TV / Chromecast Audio (CASTV2 on :8009)
//   _musc._tcp        -> Bluesound / BluOS players (plain HTTP on :11000)
// BluOS supports neither Chromecast nor UPnP/DLNA by vendor decision, so it needs
// its own transport. Between them these two cover the whole house.
//
// mDNS is not enough on its own: Google TV devices in particular go missing
// from the multicast browse (a wired Google TV Streamer here never showed up
// while it answered on :8009 the whole time -- Spotify finds it through its
// cloud, not mDNS). So every minute the local /24 is also swept for the two
// ports and anything that answers is asked for its name over plain HTTP.

const { Bonjour } = require('bonjour-service');
const net = require('net');
const os = require('os');
const http = require('http');

const CAST_TYPE = 'googlecast';
const BLUOS_TYPE = 'musc';
const BLUOS_PORT = 11000;
const CAST_PORT = 8009;
const SWEEP_EVERY = 60 * 1000;

class Discovery {
  constructor(onChange) {
    this.onChange = onChange;
    this.devices = new Map();
    this.bonjour = null;
    this.browsers = [];
  }

  // The LAN's own IPv4 (not Tailscale's 100.64/10, not link-local): the mDNS
  // socket is pinned to it, because with a Tailscale exit node on, macOS
  // routes multicast into the tunnel and nothing on the LAN ever answers.
  _lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
        if (a.address.startsWith('169.254.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue;
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
      }
    }
    return undefined;
  }

  start() {
    if (this.bonjour) return;
    const iface = this._lanAddress();
    this.bonjour = new Bonjour(iface ? { interface: iface } : undefined);
    const cast = this.bonjour.find({ type: CAST_TYPE }, (s) => this._add(this._fromCast(s)));
    const blu = this.bonjour.find({ type: BLUOS_TYPE }, (s) => this._add(this._fromBluOS(s)));
    this.browsers = [cast, blu];
    // Services that vanish (device powered off) should leave the picker.
    for (const b of this.browsers) b.on('down', (s) => this._remove(s));
    this._missed = new Map(); // host -> sweeps in a row it did not answer
    this._sweepTimer = setInterval(() => this._sweep().catch(() => {}), SWEEP_EVERY);
    setTimeout(() => this._sweep().catch(() => {}), 1500);
  }

  stop() {
    clearInterval(this._sweepTimer); this._sweepTimer = null;
    for (const b of this.browsers) {
      try { b.stop(); } catch (e) { /* already torn down */ }
    }
    this.browsers = [];
    if (this.bonjour) {
      try { this.bonjour.destroy(); } catch (e) { /* already torn down */ }
      this.bonjour = null;
    }
  }

  list() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  _address(service) {
    // Prefer IPv4; mDNS usually advertises both families.
    const v4 = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    return v4 || (service.addresses || [])[0] || service.host;
  }

  _fromCast(service) {
    const txt = service.txt || {};
    return {
      id: `cast:${txt.id || service.fqdn || service.name}`,
      kind: 'cast',
      // `fn` is the user-set friendly name ("Living Room"); service.name is the raw id.
      name: txt.fn || service.name,
      model: txt.md || 'Google Cast',
      host: this._address(service),
      port: service.port || 8009,
    };
  }

  _fromBluOS(service) {
    return {
      id: `bluos:${this._address(service)}`,
      kind: 'bluos',
      name: service.name,
      model: 'BluOS',
      host: this._address(service),
      port: BLUOS_PORT,
    };
  }

  _add(dev) {
    if (!dev || !dev.host) return;
    this.devices.set(dev.id, dev);
    this.onChange(this.list());
  }

  _remove(service) {
    const host = this._address(service);
    for (const [id, d] of this.devices) {
      // A swept device is kept until the sweep itself loses it.
      if (d.host === host && !d.swept) this.devices.delete(id);
    }
    this.onChange(this.list());
  }

  // ---- port sweep -------------------------------------------------------------
  // The /24 of every LAN interface this machine has (the usual home network).
  _subnets() {
    const out = new Set();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal || a.address.startsWith('169.254.')) continue;
        out.add(a.address.split('.').slice(0, 3).join('.'));
      }
    }
    return [...out];
  }

  _open(host, port, ms = 800) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok) => { try { sock.destroy(); } catch (e) { /* closed */ } resolve(ok); };
      sock.setTimeout(ms, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }

  _get(url, ms = 2000) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: ms }, (res) => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    });
  }

  async _identifyCast(host) {
    const body = await this._get(`http://${host}:8008/setup/eureka_info?params=name,device_info&options=detail`);
    const info = JSON.parse(body);
    const udn = String(info.ssdp_udn || info.device_info?.ssdp_udn || '').replace(/-/g, '');
    if (!info.name) return null;
    return {
      // Same id mDNS would give (its `id` TXT is the UDN without dashes).
      id: `cast:${udn || host}`,
      kind: 'cast',
      name: info.name,
      model: info.device_info?.model_name || 'Google Cast',
      host,
      port: CAST_PORT,
      swept: true,
    };
  }

  async _identifyBluOS(host) {
    const xml = await this._get(`http://${host}:${BLUOS_PORT}/SyncStatus`);
    const name = (/\sname="([^"]*)"/.exec(xml) || [])[1];
    if (!name) return null;
    return { id: `bluos:${host}`, kind: 'bluos', name: name.replace(/&amp;/g, '&'), model: 'BluOS', host, port: BLUOS_PORT, swept: true };
  }

  async _sweep() {
    if (!this.bonjour) return;
    const hosts = [];
    for (const net24 of this._subnets()) for (let i = 1; i < 255; i++) hosts.push(`${net24}.${i}`);
    const known = new Map([...this.devices.values()].map((d) => [`${d.host}:${d.port}`, d]));
    const seen = new Set();
    let changed = false;
    // 64 probes at a time: a /24 for two ports takes ~7 s at the 800 ms timeout.
    const queue = hosts.flatMap((h) => [[h, CAST_PORT], [h, BLUOS_PORT]]);
    const worker = async () => {
      while (queue.length) {
        const [host, port] = queue.shift();
        if (!(await this._open(host, port))) continue;
        seen.add(`${host}:${port}`);
        if (known.has(`${host}:${port}`)) continue;
        try {
          const dev = port === CAST_PORT ? await this._identifyCast(host) : await this._identifyBluOS(host);
          if (dev && !this.devices.has(dev.id)) { this.devices.set(dev.id, dev); changed = true; }
        } catch (e) { /* answers on the port but is not one of ours */ }
      }
    };
    await Promise.all(Array.from({ length: 64 }, worker));
    // Swept devices that stopped answering for two sweeps running leave the list.
    for (const [id, d] of this.devices) {
      if (!d.swept) continue;
      const key = `${d.host}:${d.port}`;
      if (seen.has(key)) { this._missed.delete(key); continue; }
      const n = (this._missed.get(key) || 0) + 1;
      this._missed.set(key, n);
      if (n >= 2) { this.devices.delete(id); this._missed.delete(key); changed = true; }
    }
    if (changed) this.onChange(this.list());
  }
}

module.exports = { Discovery, BLUOS_PORT };
