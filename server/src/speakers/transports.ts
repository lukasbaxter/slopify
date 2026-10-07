// The speaker transports. All of them pull the stream themselves, so the URLs
// handed to them must be reachable from the speaker (the server's public
// address on the LAN), never localhost.
//
// Cast: the Default Media Receiver over CASTV2 (no registered app id).
// BluOS: the plain HTTP API on :11000 (undocumented but stable, no auth).
// Bridge: Slopify's own "slopify-speaker/1" HTTP API on :7780, small enough
// for a microcontroller (see BridgeTransport).
import http from 'node:http';
import { createRequire } from 'node:module';
import type { Speaker } from './discovery.js';

const require = createRequire(import.meta.url);
const castv2 = require('castv2-client');
// Swappable for tests (a fake receiver).
export const castDeps = { Client: castv2.Client, DefaultMediaReceiver: castv2.DefaultMediaReceiver };
// castv2-client has no timeouts of its own: a request to a receiver that went
// away is never answered, and one hung status read froze the account's player
// (its poll and every later command). Every call is bounded.
export const CAST_TIMEOUT_MS = 8000;
function bounded<T>(p: Promise<T>, what: string, ms = CAST_TIMEOUT_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(`Cast ${what} timed out`), { code: 'ECASTTIMEOUT' })), ms); })]).finally(() => clearTimeout(t));
}

export type PlayMeta = { title?: string; artist?: string; album?: string; artwork?: string; artworkFallback?: string; contentType?: string };
export type Status = { playing: boolean; state: string | null; title?: string | null; artist?: string | null; album?: string | null; position: number; duration: number; volume: number | null; muted?: boolean; streamUrl?: string | null; ended?: boolean; gone?: boolean; canSeek?: boolean; coarse?: boolean; service?: string | null; serviceName?: string | null; inputId?: string | null; image?: string | null };
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
  // The connection died under us (socket error, receiver closed it): the
  // tick must read that as "gone", never as the track having ended.
  private gone = false;
  constructor(private device: Speaker) {}

  private async connect() {
    if (this.player) return this.player;
    const client = new castDeps.Client();
    this.client = client;
    this.gone = false;
    await bounded(new Promise<void>((resolve, reject) => {
      const onError = (err: any) => { client.removeListener('error', onError); reject(err); };
      client.once('error', onError);
      client.connect(this.device.host, () => { client.removeListener('error', onError); resolve(); });
    }), 'connect').catch((e) => { this.close(); throw e; });
    client.on('error', () => { this.gone = true; this.close(); });
    client.on('close', () => { this.player = null; this.gone = true; });
    const player = await bounded(promisify(client.launch, client)(castDeps.DefaultMediaReceiver), 'launch').catch((e) => { this.close(); throw e; });
    // The receiver app closed (its idle timeout, or another app cast to the
    // device): this media session is over. Without this the player object
    // stayed and every request went to a session that no longer exists.
    player.on?.('close', () => { if (this.player === player) { this.player = null; this.gone = true; } });
    this.player = player;
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
    const status = await bounded(promisify(player.load, player)(media, opts), 'load');
    // A receiver that cannot play (TV off, stream unreachable) still ACKs the load, then flips to IDLE/ERROR.
    const settled: any = await new Promise((resolve) => {
      const onStatus = (s: any) => { if (s.playerState === 'PLAYING' || s.playerState === 'BUFFERING' || (s.playerState === 'IDLE' && s.idleReason === 'ERROR')) done(s); };
      const done = (s: any) => { player.removeListener('status', onStatus); resolve(s); };
      player.on('status', onStatus);
      setTimeout(() => done(null), 6000);
    });
    if (settled && settled.playerState === 'IDLE' && settled.idleReason === 'ERROR') throw Object.assign(new Error(`${this.device.name} could not play this. If it drives a TV, check the TV is on.`), { code: 'ECASTLOAD' });
    await bounded(promisify(player.getStatus, player)(), 'status').catch(() => {}); // refresh the media session id
    this.lastState = 'PLAYING';
    return settled || status;
  }
  private async withPlayer(method: string, ...args: any[]) {
    const player = await this.connect();
    try { return await bounded(promisify(player[method], player)(...args), method); }
    catch (err: any) {
      if (err?.code === 'ECASTTIMEOUT') { this.lost(); throw err; }
      if (!/INVALID_MEDIA_SESSION_ID/.test(err?.message || '')) throw err;
      const s = await bounded(promisify(player.getStatus, player)(), 'status').catch(() => null);
      if (!s || !s.mediaSessionId) return null;
      return bounded(promisify(player[method], player)(...args), method);
    }
  }
  // A receiver that stopped answering: treat the connection as gone, so the
  // player releases the session instead of waiting on it.
  private lost() { this.gone = true; this.close(); }
  resume() { return this.withPlayer('play'); }
  pause() { return this.withPlayer('pause'); }
  seek(seconds: number) { return this.withPlayer('seek', Math.max(0, Math.round(seconds))); }
  async stop() {
    // Nothing of ours is on the device (never connected, or the session is
    // gone): there is nothing to stop. Connecting only to stop launched the
    // receiver app again, which can turn a TV on and end whatever is on it now.
    if (!this.player || this.gone) { this.close(); return null; }
    try {
      return await this.withPlayer('stop');
    } catch {
      try { if (this.client) await bounded(promisify(this.client.stop, this.client)(this.player), 'stop'); } catch { /* fall through */ }
      this.close();
      return null;
    }
  }
  async setVolume(level: number) {
    await this.connect();
    return bounded(promisify(this.client.setVolume, this.client)({ level: Math.max(0, Math.min(1, level / 100)) }), 'volume');
  }
  private async receiverVolume(): Promise<{ level: number | null; muted: boolean }> {
    if (!this.client) return { level: null, muted: false };
    try { const st: any = await bounded(new Promise((resolve) => this.client.getStatus((e: any, x: any) => resolve(e ? null : x))), 'receiver status').catch(() => null); return { level: typeof st?.volume?.level === 'number' ? Math.round(st.volume.level * 100) : null, muted: !!st?.volume?.muted }; }
    catch { return { level: null, muted: false }; }
  }
  async status(): Promise<Status> {
    if (!this.player) { const v = await this.receiverVolume(); return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: v.level, muted: v.muted, gone: this.gone }; }
    let s: any;
    try { s = await this.withPlayer('getStatus'); }
    catch (e: any) { if (e?.code === 'ECASTTIMEOUT' || this.gone) return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: null, gone: true }; throw e; }
    if (!s) { const v = await this.receiverVolume(); return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: v.level, muted: v.muted, ended: !this.gone && this.lastState === 'PLAYING', gone: this.gone }; }
    const md = s.media?.metadata || {};
    const ended = s.playerState === 'IDLE' && s.idleReason === 'FINISHED';
    this.lastState = s.playerState;
    const v = await this.receiverVolume();
    return { playing: s.playerState === 'PLAYING', state: s.playerState, title: md.title || null, artist: md.artist || null, album: md.albumName || null, position: s.currentTime || 0, duration: s.media?.duration || 0, volume: v.level, muted: v.muted, streamUrl: s.media?.contentId || null, ended, canSeek: true };
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
  private metaSafe: { ok: boolean; probed: boolean; at: number } | null = null;
  private lastVolume: number | undefined;
  private wasPlaying = false;
  private ownVol: { at: number; level: number | null; muted: boolean } | null = null;
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
  // A probe that answered is final; one that failed (a dropped /SyncStatus)
  // is retried after 10 minutes, not held against the speaker forever.
  private async metadataIsSafe() {
    if (this.metaSafe && (this.metaSafe.probed || Date.now() - this.metaSafe.at < 10 * 60 * 1000)) return this.metaSafe.ok;
    try {
      const xml = await this.get('/SyncStatus');
      const versions = [...xml.matchAll(/version="([0-9]+(?:\.[0-9]+)+)"/g)].map((m) => m[1]);
      const bluos = versions.find((v) => v.split('.').length >= 3) || versions[0];
      const [maj, min] = (bluos || '0.0').split('.').map(Number);
      this.metaSafe = { ok: !!bluos && (maj > 4 || (maj === 4 && min >= 16)), probed: true, at: Date.now() };
    } catch { this.metaSafe = { ok: false, probed: false, at: Date.now() }; }
    return this.metaSafe.ok;
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
  setVolume(level: number) { this.ownVol = null; return this.get(`/Volume?level=${Math.max(0, Math.min(100, Math.round(level)))}`); }
  // This speaker's own level, even while it leads a group: tell_slaves=0 so
  // a leader does not pass the change on (the group's balance is set per
  // speaker by the player), and /Volume reads the speaker's own, not the group's.
  setOwnVolume(level: number) { this.ownVol = null; return this.get(`/Volume?level=${Math.max(0, Math.min(100, Math.round(level)))}&tell_slaves=0`); }
  async ownVolume(): Promise<number | null> {
    const xml = await this.get('/Volume');
    const v = Number(tag(xml, 'volume'));
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  // In a group, every member's /Status carries the group's volume (0 while
  // the leader sits at 0), not the speaker's own: mirrored back, it snapped
  // the slider to 0 after every change. /Volume is the speaker's own; it is
  // read at most once a second (status() runs four times a second).
  private async volumeOf(statusXml: string): Promise<{ level: number | null; muted: boolean }> {
    const num = (v: string | null) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    if (!/<groupName>/i.test(statusXml)) return { level: num(tag(statusXml, 'volume')), muted: tag(statusXml, 'mute') === '1' };
    if (this.ownVol && Date.now() - this.ownVol.at < 1000) return this.ownVol;
    try {
      const xml = await this.get('/Volume');
      this.ownVol = { at: Date.now(), level: num(tag(xml, 'volume')), muted: /\smute="1"/.test(xml) };
    } catch { this.ownVol = { at: Date.now(), level: null, muted: false }; }
    return this.ownVol;
  }
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
    const { level: rawVol, muted } = await this.volumeOf(xml);
    if (!muted && rawVol != null && rawVol >= 0) this.lastVolume = rawVol;
    const playing = state === 'play' || state === 'stream';
    const position = Number(tag(xml, 'secs') ?? 0), duration = Number(tag(xml, 'totlen') ?? 0);
    // The stream ran out: stopped by itself near the end of what it was playing.
    const ended = this.wasPlaying && state === 'stop' && duration > 0 && position >= duration - 3;
    return { playing, state, title: tag(xml, 'title1'), artist: tag(xml, 'title2'), album: tag(xml, 'title3'), volume: muted ? (this.lastVolume ?? rawVol) : rawVol != null && rawVol >= 0 ? rawVol : null, muted, position, duration, canSeek: tag(xml, 'canSeek') === '1', streamUrl: tag(xml, 'streamUrl'), ended, coarse: true, service: tag(xml, 'service'), serviceName: tag(xml, 'serviceName'), inputId: tag(xml, 'inputId'), image: tag(xml, 'image') };
  }
  close() { /* nothing to hold */ }

  // --- BluOS sync (grouping) -------------------------------------------------
  // Who this unit follows, and who follows it.
  async sync(): Promise<{ master: { host: string; port: number } | null; slaves: { host: string; port: number }[] }> {
    const xml = await this.get('/SyncStatus');
    const m = /<master(?:\s+port="(\d+)")?[^>]*>([^<]+)<\/master>/i.exec(xml);
    const slaves = [...xml.matchAll(/<slave\s+id="([^"]+)"\s+port="(\d+)"/gi)].map((x) => ({ host: x[1], port: Number(x[2]) }));
    return { master: m ? { host: m[2].trim(), port: Number(m[1] || BLUOS_DEFAULT_PORT) } : null, slaves };
  }
  // The unit's own inputs (Bluetooth, HDMI, Spotify...): name and what to play.
  async inputs(): Promise<{ id: string; name: string; url: string }[]> {
    const xml = await this.get('/RadioBrowse?service=Capture');
    return [...xml.matchAll(/<item\b([^>]*)>/gi)].map((m) => {
      const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`, 'i').exec(m[1])?.[1] ?? '';
      const dec = (v: string) => { try { return decodeURIComponent(v.replace(/&amp;/g, '&')); } catch { return v; } };
      return { id: attr('id'), name: dec(attr('text')), url: dec(attr('URL')) };
    }).filter((i) => i.name && i.url);
  }
  playUrl(url: string) { this.wasPlaying = true; return this.get(`/Play?${new URLSearchParams({ url })}`); }
  skip() { return this.get('/Skip'); }
  back() { return this.get('/Back'); }
  addSlave(host: string, port: number) { return this.get(`/AddSlave?${new URLSearchParams({ slave: host, port: String(port) })}`); }
  removeSlave(host: string, port: number) { return this.get(`/RemoveSlave?${new URLSearchParams({ slave: host, port: String(port) })}`); }
  // Out of any group: away from its master, and its own followers let go.
  // Out of any group it is a member of, and rid of its own slaves, except the
  // ones in `keep` ("host:port"): a leader re-forming its group keeps the
  // members it already has (dropping them all left them unlinked and silent).
  async standAlone(keep: Set<string> = new Set()) {
    const st = await this.sync();
    if (st.master) await new BluOSTransport({ ...this.device, host: st.master.host, port: st.master.port }).removeSlave(this.device.host, this.device.port);
    for (const sl of st.slaves) if (!keep.has(`${sl.host}:${sl.port}`)) await this.removeSlave(sl.host, sl.port);
  }
}

const BLUOS_DEFAULT_PORT = 11000;

// ---- slopify-speaker/1 ------------------------------------------------------
// The whole protocol, plain GETs with JSON replies (no auth, LAN only):
//   /info                  {api:"slopify-speaker/1", id, name, model, formats:["mp3"], maxKbps}
//   /play?url=&startAt=s   fetch that http:// URL and play it, starting the stream at s seconds
//                          (the device appends startAt to the URL; the server's mp3 route honours it)
//   /pause  /resume  /stop
//   /volume?level=0-100
//   /status                {state: playing|buffering|paused|idle|stream, position, volume, ended,
//                           source, url, error}
// state "stream" means something else pushed audio to it (source names it,
// e.g. Spotify): to the player that reads as the speaker taken by another app.
// The device decodes nothing but MP3, at a bitrate it names, so every track is
// handed over as the server's progressive mp3 transcode; a seek is a new /play.
export class BridgeTransport implements Transport {
  private info: { formats: string[]; maxKbps: number } | null = null;
  private last: string | null = null;
  private failures = 0;
  constructor(private device: Speaker) {}
  private async get(path: string, timeoutMs = 6000): Promise<any> {
    const body = await request(this.device.host, this.device.port, path, timeoutMs);
    return body ? JSON.parse(body) : {};
  }
  private async kbps() {
    if (!this.info) { const i = await this.get('/info'); this.info = { formats: i.formats || ['mp3'], maxKbps: Number(i.maxKbps) || 160 }; }
    return this.info.maxKbps;
  }
  // /api/stream/<id>?token=... -> /api/stream/<id>/mp3?token=...&bitrate=...
  private mp3Url(url: string, kbps: number) {
    const u = new URL(url);
    if (!/\/mp3$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/mp3`;
    u.searchParams.set('bitrate', String(kbps * 1000));
    u.searchParams.delete('startAt');
    return u.toString();
  }
  async play(url: string, _meta: PlayMeta = {}, startAt = 0) {
    if (!/^http:/i.test(url)) throw new Error(`${this.device.name} can only fetch http:// streams; set PUBLIC_URL to the server's plain LAN address`);
    this.last = this.mp3Url(url, await this.kbps());
    return this.get(`/play?${new URLSearchParams({ url: this.last, startAt: String(Math.max(0, startAt)) })}`, 15000);
  }
  resume() { return this.get('/resume', 15000); }
  pause() { return this.get('/pause'); }
  stop() { return this.get('/stop').catch(() => null); }
  async seek(seconds: number) {
    if (!this.last) return null;
    return this.get(`/play?${new URLSearchParams({ url: this.last, startAt: String(Math.max(0, seconds)) })}`, 15000);
  }
  setVolume(level: number) { return this.get(`/volume?level=${Math.max(0, Math.min(100, Math.round(level)))}`); }
  async status(): Promise<Status> {
    let s: any;
    try { s = await this.get('/status', 4000); this.failures = 0; }
    catch (e) {
      // One missed poll is WiFi; a few in a row is a device that went away.
      if (++this.failures >= 3) return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: null, gone: true };
      throw e;
    }
    const state = String(s.state || 'idle');
    const theirs = state === 'stream';
    return {
      playing: state === 'playing' || state === 'buffering' || theirs,
      state: theirs ? 'stream' : state === 'paused' ? 'PAUSED' : state === 'idle' ? 'IDLE' : state === 'buffering' ? 'BUFFERING' : 'PLAYING',
      position: Number(s.position) || 0, duration: 0,
      volume: typeof s.volume === 'number' ? s.volume : null,
      ended: !!s.ended,
      service: theirs ? (s.source || 'stream') : 'url',
      serviceName: theirs ? (s.source || 'another app') : null,
      streamUrl: s.url || null,
      canSeek: true,
    };
  }
  close() {}
}

export function transportFor(device: Speaker): Transport {
  return device.kind === 'cast' ? new CastTransport(device) : device.kind === 'bridge' ? new BridgeTransport(device) : new BluOSTransport(device);
}
