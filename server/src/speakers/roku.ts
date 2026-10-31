// Roku players and Roku TVs, over ECP (External Control Protocol, plain HTTP
// on :8060, no auth; "Control by mobile apps" must be on, the default).
// Audio goes through Play on Roku (app 15985, present on every Roku): a
// launch with the URL and song details, the same call Home Assistant makes.
// The Roku pulls the stream; it plays mp3 everywhere, so tracks are handed
// over as the server's progressive mp3 and a seek is a new launch from that
// point (Play on Roku ignores ECP seek keys). Volume exists only on Roku TVs
// and only as up / down keys, so it is not offered.
import type { Speaker } from './discovery.js';
import { httpText, xtag } from './ssdp.js';
import type { PlayMeta, Status, Transport } from './transports.js';

export const ROKU_PORT = 8060;
export const PLAY_ON_ROKU = '15985';

export class RokuTransport implements Transport {
  private last: { url: string; meta: PlayMeta } | null = null;
  private offset = 0;
  private lastState: string | null = null;
  private ours = false;
  private failures = 0;
  constructor(private device: Speaker) {}
  private base() { return `http://${this.device.host}:${this.device.port || ROKU_PORT}`; }
  private async post(path: string, ms = 6000) {
    const r = await httpText(`${this.base()}${path}`, ms, 'POST', '');
    if (r.status === 403) throw new Error(`${this.device.name} refused the command: turn on Settings > System > Advanced system settings > Control by mobile apps`);
    if (r.status < 200 || r.status >= 300) throw new Error(`Roku ${path.split('?')[0]} -> HTTP ${r.status}`);
    return r.body;
  }
  private async get(path: string, ms = 4000) {
    const r = await httpText(`${this.base()}${path}`, ms);
    if (r.status < 200 || r.status >= 300) throw new Error(`Roku ${path} -> HTTP ${r.status}`);
    return r.body;
  }
  static mp3Url(url: string, startAt = 0) {
    const u = new URL(url);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/track.mp3`;
    u.searchParams.set('bitrate', '320000');
    if (startAt > 0) u.searchParams.set('startAt', String(Math.floor(startAt))); else u.searchParams.delete('startAt');
    return u.toString();
  }
  async play(url: string, meta: PlayMeta = {}, startAt = 0) {
    if (!/^http:/i.test(url)) throw new Error(`${this.device.name} can only fetch http:// streams; set PUBLIC_URL to the server's plain LAN address`);
    this.last = { url, meta };
    return this.launch(startAt);
  }
  private async launch(startAt: number) {
    if (!this.last) return null;
    const { url, meta } = this.last;
    this.offset = Math.max(0, Math.floor(startAt));
    const q = new URLSearchParams({ t: 'a', u: RokuTransport.mp3Url(url, this.offset), songName: meta.title || 'Unknown title', artistName: meta.artist || ' ', songFormat: 'mp3' });
    if (meta.artwork) q.set('albumArtUrl', meta.artwork);
    this.lastState = null;
    await this.post(`/launch/${PLAY_ON_ROKU}?${q}`, 15000);
    this.ours = true;
    return null;
  }
  private async state(): Promise<string> {
    return (/<player[^>]*\bstate="([^"]*)"/i.exec(await this.get('/query/media-player')) || [])[1] || 'none';
  }
  // Play is a toggle on Roku: only pressed when the state is the other one.
  async resume() { if ((await this.state()) === 'pause') await this.post('/keypress/Play'); return null; }
  async pause() { if ((await this.state()) === 'play') await this.post('/keypress/Play'); return null; }
  async stop() {
    if (!this.ours) return null;
    this.ours = false;
    // Back leaves the player; only when our app is the one in front.
    const app = await this.activeApp().catch(() => null);
    if (app?.id === PLAY_ON_ROKU) await this.post('/keypress/Back').catch(() => null);
    return null;
  }
  async seek(seconds: number) { return this.launch(seconds); }
  async setVolume() { return null; }
  private async activeApp(): Promise<{ id: string; name: string } | null> {
    const xml = await this.get('/query/active-app');
    const m = /<app\b[^>]*\bid="([^"]*)"[^>]*>([^<]*)<\/app>/i.exec(xml);
    return m ? { id: m[1], name: m[2].trim() } : (/<screensaver/i.test(xml) ? { id: 'screensaver', name: 'Screensaver' } : null);
  }
  async status(): Promise<Status> {
    let xml: string; let app: { id: string; name: string } | null;
    try { [xml, app] = await Promise.all([this.get('/query/media-player'), this.activeApp().catch(() => null)]); this.failures = 0; }
    catch (e) {
      if (++this.failures >= 3) return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: null, gone: true };
      throw e;
    }
    const state = (/<player[^>]*\bstate="([^"]*)"/i.exec(xml) || [])[1] || 'none';
    const ms = (v: string | null) => { const n = parseInt(v || '', 10); return Number.isFinite(n) ? n / 1000 : 0; };
    const position = ms(xtag(xml, 'position')) + this.offset;
    const durRaw = ms(xtag(xml, 'duration'));
    // Another app in front (Netflix, YouTube, the home screen) while we
    // thought we were playing: the Roku was taken.
    const theirs = this.ours && !!app && app.id !== PLAY_ON_ROKU && app.id !== 'screensaver';
    const playing = state === 'play' || state === 'buffer' || state === 'startup';
    const done = state === 'close' || state === 'stop' || state === 'finished' || state === 'none';
    const ended = !theirs && done && this.lastState === 'play';
    this.lastState = state === 'buffer' || state === 'startup' ? this.lastState : state;
    return {
      playing: playing || theirs,
      state: theirs ? 'stream' : state === 'pause' ? 'PAUSED' : done ? 'IDLE' : state === 'buffer' || state === 'startup' ? 'BUFFERING' : 'PLAYING',
      position, duration: durRaw > 0 ? durRaw + this.offset : 0,
      volume: null, ended,
      service: theirs ? app!.name : 'url', serviceName: theirs ? app!.name : null,
      streamUrl: theirs ? `roku-app:${app!.id}` : this.last?.url || null,
      canSeek: true,
    };
  }
  close() {}
}

// /query/device-info: the name people gave it, and the model.
export function parseRokuInfo(xml: string): { udn: string; name: string; model: string } | null {
  const udn = xtag(xml, 'udn') || xtag(xml, 'serial-number') || xtag(xml, 'device-id');
  if (!udn) return null;
  const name = xtag(xml, 'user-device-name') || xtag(xml, 'friendly-device-name') || xtag(xml, 'default-device-name') || 'Roku';
  const model = [xtag(xml, 'vendor-name') && !/^roku$/i.test(xtag(xml, 'vendor-name') || '') ? xtag(xml, 'vendor-name') : null, xtag(xml, 'model-name')].filter(Boolean).join(' ') || 'Roku';
  return { udn, name: name.slice(0, 64), model: /roku/i.test(model) ? model : `Roku ${model}` };
}
