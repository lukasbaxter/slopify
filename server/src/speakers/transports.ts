// The two speaker transports. Both pull the stream themselves, so the URLs
// handed to them must be reachable from the speaker (the server's public
// address on the LAN), never localhost.
//
// Cast: the Default Media Receiver over CASTV2 (no registered app id).
// BluOS: the plain HTTP API on :11000 (undocumented but stable, no auth).
import http from 'node:http';
import { createRequire } from 'node:module';
import type { Speaker } from './discovery.js';

const require = createRequire(import.meta.url);
const { Client, DefaultMediaReceiver } = require('castv2-client');

export type PlayMeta = { title?: string; artist?: string; album?: string; artwork?: string; artworkFallback?: string; contentType?: string };
export type Status = { playing: boolean; state: string | null; title?: string | null; artist?: string | null; album?: string | null; position: number; duration: number; volume: number | null; streamUrl?: string | null; ended?: boolean; canSeek?: boolean; coarse?: boolean };
export interface Transport {
  play(url: string, meta?: PlayMeta, startAt?: number): Promise<unknown>;
  resume(): Promise<unknown>; pause(): Promise<unknown>; stop(): Promise<unknown>;
  seek(seconds: number): Promise<unknown>; setVolume(level: number): Promise<unknown>;
  status(): Promise<Status>; close(): void;
}

const promisify = (fn: any, ctx: any) => (...args: any[]) => new Promise<any>((resolve, reject) => { fn.call(ctx, ...args, (err: any, result: any) => (err ? reject(err) : resolve(result))); });

export class CastTransport implements Transport {
  private client: any = null;
  private player: any = null;
  private loading: Promise<any> | null = null;
  private lastState: string | null = null;
  constructor(private device: Speaker) {}

  private async connect() {
    if (this.player) return this.player;
    const client = new Client();
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: any) => { client.removeListener('error', onError); reject(err); };
      client.once('error', onError);
      client.connect(this.device.host, () => { client.removeListener('error', onError); resolve(); });
    });
    client.on('error', () => this.close());
    client.on('close', () => { this.player = null; });
    this.player = await promisify(client.launch, client)(DefaultMediaReceiver);
    return this.player;
  }

  async play(url: string, meta: PlayMeta = {}, startAt = 0) {
    // Serialise loads: two overlapping LOADs make two media sessions and the cached id goes stale.
    if (this.loading) await this.loading.catch(() => {});
    this.loading = this.doPlay(url, meta, startAt);
    try { return await this.loading; } finally { this.loading = null; }
  }
  private async doPlay(url: string, meta: PlayMeta, startAt: number) {
    const player = await this.connect();
    const media = {
      contentId: url, contentType: meta.contentType || 'audio/mpeg', streamType: 'BUFFERED',
      metadata: { type: 0, metadataType: 3, title: meta.title || 'Unknown title', artist: meta.artist || '', albumName: meta.album || '', images: [meta.artwork, meta.artworkFallback].filter(Boolean).map((u) => ({ url: u })) },
    };
    const opts: any = { autoplay: true };
    if (startAt > 0) opts.currentTime = Math.max(0, Math.floor(startAt));
    const status = await promisify(player.load, player)(media, opts);
    // A receiver that cannot play (TV off, stream unreachable) still ACKs the load, then flips to IDLE/ERROR.
    const settled: any = await new Promise((resolve) => {
      const onStatus = (s: any) => { if (s.playerState === 'PLAYING' || s.playerState === 'BUFFERING' || (s.playerState === 'IDLE' && s.idleReason === 'ERROR')) done(s); };
      const done = (s: any) => { player.removeListener('status', onStatus); resolve(s); };
      player.on('status', onStatus);
      setTimeout(() => done(null), 6000);
    });
    if (settled && settled.playerState === 'IDLE' && settled.idleReason === 'ERROR') throw Object.assign(new Error(`${this.device.name} could not play this. If it drives a TV, check the TV is on.`), { code: 'ECASTLOAD' });
    await promisify(player.getStatus, player)().catch(() => {}); // refresh the media session id
    this.lastState = 'PLAYING';
    return settled || status;
  }
  private async withPlayer(method: string, ...args: any[]) {
    const player = await this.connect();
    try { return await promisify(player[method], player)(...args); }
    catch (err: any) {
      if (!/INVALID_MEDIA_SESSION_ID/.test(err?.message || '')) throw err;
      const s = await promisify(player.getStatus, player)().catch(() => null);
      if (!s || !s.mediaSessionId) return null;
      return promisify(player[method], player)(...args);
    }
  }
  resume() { return this.withPlayer('play'); }
  pause() { return this.withPlayer('pause'); }
  seek(seconds: number) { return this.withPlayer('seek', Math.max(0, Math.round(seconds))); }
  async stop() {
    try {
      if (!this.player) await this.connect();
      return await this.withPlayer('stop');
    } catch {
      try { if (this.client) await promisify(this.client.stop, this.client)(this.player); } catch { /* fall through */ }
      this.close();
      return null;
    }
  }
  async setVolume(level: number) {
    await this.connect();
    return promisify(this.client.setVolume, this.client)({ level: Math.max(0, Math.min(1, level / 100)) });
  }
  private async receiverVolume(): Promise<number | null> {
    if (!this.client) return null;
    try { const st: any = await new Promise((resolve) => this.client.getStatus((e: any, x: any) => resolve(e ? null : x))); return typeof st?.volume?.level === 'number' ? Math.round(st.volume.level * 100) : null; }
    catch { return null; }
  }
  async status(): Promise<Status> {
    if (!this.player) return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: await this.receiverVolume() };
    const s = await this.withPlayer('getStatus');
    if (!s) return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: await this.receiverVolume(), ended: this.lastState === 'PLAYING' };
    const md = s.media?.metadata || {};
    const ended = s.playerState === 'IDLE' && s.idleReason === 'FINISHED';
    this.lastState = s.playerState;
    return { playing: s.playerState === 'PLAYING', state: s.playerState, title: md.title || null, artist: md.artist || null, album: md.albumName || null, position: s.currentTime || 0, duration: s.media?.duration || 0, volume: await this.receiverVolume(), streamUrl: s.media?.contentId || null, ended, canSeek: true };
  }
  close() {
    this.player = null;
    if (this.client) { try { this.client.close(); } catch { /* gone */ } this.client = null; }
  }
}

// ---- BluOS -------------------------------------------------------------------
function request(host: string, port: number, path: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(body); else reject(new Error(`BluOS ${path} -> HTTP ${res.statusCode}`)); });
    });
    req.on('timeout', () => req.destroy(new Error(`BluOS ${path} timed out`)));
    req.on('error', reject);
  });
}
// Only idempotent reads are retried: BluOS hangs up DURING a seek, and a
// retried /Play?seek= lands mid-transition and kills the stream.
const RETRYABLE = /^\/(Status|SyncStatus)\b/;
async function requestRetry(host: string, port: number, path: string) {
  try { return await request(host, port, path); }
  catch (err: any) {
    if (!/hang up|ECONNRESET|EPIPE|socket/i.test(err.message) || !RETRYABLE.test(path)) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return request(host, port, path);
  }
}
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

export class BluOSTransport implements Transport {
  private metaSafe: boolean | undefined;
  private lastVolume: number | undefined;
  private wasPlaying = false;
  constructor(private device: Speaker) {}
  private get(path: string) { return requestRetry(this.device.host, this.device.port, path); }

  // Seeking before the stream is open tears it down (playing=true, position frozen at 0, silence).
  async waitUntilSeekable(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.status().catch(() => null);
      if (s && s.canSeek && (s.playing || s.position > 0)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }
  // Firmware before 4.16 makes the stream unseekable when metadata rides along with the URL.
  private async metadataIsSafe() {
    if (this.metaSafe !== undefined) return this.metaSafe;
    try {
      const xml = await this.get('/SyncStatus');
      const versions = [...xml.matchAll(/version="([0-9]+(?:\.[0-9]+)+)"/g)].map((m) => m[1]);
      const bluos = versions.find((v) => v.split('.').length >= 3) || versions[0];
      if (!bluos) { this.metaSafe = false; return false; }
      const [maj, min] = bluos.split('.').map(Number);
      this.metaSafe = maj > 4 || (maj === 4 && min >= 16);
    } catch { this.metaSafe = false; }
    return this.metaSafe;
  }
  // BluOS cannot open a stream at an offset: play from zero muted, seek, unmute.
  async play(url: string, meta: PlayMeta = {}, startAt = 0) {
    const q = new URLSearchParams({ url });
    if (await this.metadataIsSafe()) {
      if (meta.title) q.set('title1', meta.title);
      if (meta.artist) q.set('title2', meta.artist);
      if (meta.album) q.set('title3', meta.album);
      if (meta.artwork) q.set('image', meta.artwork);
    }
    const target = Math.max(0, Math.round(startAt || 0));
    this.wasPlaying = true;
    if (target < 2) return this.get(`/Play?${q.toString()}`);
    let muted = false;
    try {
      await this.get('/Volume?mute=1'); muted = true;
      const res = await this.get(`/Play?${q.toString()}`);
      await this.seek(target).catch(() => {});
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) { const s = await this.status().catch(() => null); if (s && s.position >= target - 1) break; await new Promise((r) => setTimeout(r, 150)); }
      return res;
    } finally { if (muted) await this.get('/Volume?mute=0').catch(() => {}); }
  }
  resume() { return this.get('/Play'); }
  pause() { return this.get('/Pause'); }
  async stop() {
    this.wasPlaying = false;
    await this.get('/Pause').catch(() => {});
    const res = await this.get('/Stop');
    await this.get('/Clear').catch(() => {});
    return res;
  }
  setVolume(level: number) { return this.get(`/Volume?level=${Math.max(0, Math.min(100, Math.round(level)))}`); }
  async seek(seconds: number) {
    if (!(await this.waitUntilSeekable())) throw Object.assign(new Error('BluOS stream is not seekable yet'), { code: 'ENOSEEK' });
    const target = Math.max(0, Math.round(seconds));
    await this.get(`/Play?seek=${target}`).catch((err: any) => { if (!/hang up|ECONNRESET|EPIPE|socket/i.test(err.message)) throw err; });
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const after = await this.status().catch(() => null);
      if (!after) continue;
      if (Math.abs(after.position - target) <= 12 || after.position > target) return after;
    }
    throw Object.assign(new Error(`BluOS ignored seek (asked ${target}s)`), { code: 'ESEEKDRIFT' });
  }
  async status(): Promise<Status> {
    const xml = await this.get('/Status');
    const state = tag(xml, 'state');
    const rawVol = Number(tag(xml, 'volume') ?? 0);
    const muted = tag(xml, 'mute') === '1';
    if (!muted && Number.isFinite(rawVol)) this.lastVolume = rawVol;
    const playing = state === 'play' || state === 'stream';
    const position = Number(tag(xml, 'secs') ?? 0), duration = Number(tag(xml, 'totlen') ?? 0);
    // The stream ran out: stopped by itself near the end of what it was playing.
    const ended = this.wasPlaying && state === 'stop' && duration > 0 && position >= duration - 3;
    return { playing, state, title: tag(xml, 'title1'), artist: tag(xml, 'title2'), album: tag(xml, 'title3'), volume: muted ? (this.lastVolume ?? rawVol) : rawVol, position, duration, canSeek: tag(xml, 'canSeek') === '1', streamUrl: tag(xml, 'streamUrl'), ended, coarse: true };
  }
  close() { /* nothing to hold */ }
}

export function transportFor(device: Speaker): Transport { return device.kind === 'cast' ? new CastTransport(device) : new BluOSTransport(device); }
