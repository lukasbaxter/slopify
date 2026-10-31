// UPnP / DLNA renderers over AVTransport + RenderingControl (SOAP): Sonos
// (S1 and S2 both still answer it), Denon / Marantz HEOS, most smart TVs,
// Kodi, WiiM, Yamaha MusicCast, gmrender... The renderer pulls the stream.
//
// Lessons taken from Music Assistant's DLNA provider (a large real-world
// fleet): stop before loading a new URI; escape every non-ASCII character in
// the DIDL as a numeric entity (HEOS mangles UTF-8); give the URL a file
// extension (some renderers pick the decoder from it); call Pause / Stop even
// when CurrentTransportActions says they are not available (stale on many
// devices); read SOAP replies leniently.
import type { Speaker } from './discovery.js';
import { httpText, xmlEscape, xtag } from './ssdp.js';
import type { PlayMeta, Status, Transport } from './transports.js';

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CM = 'urn:schemas-upnp-org:service:ConnectionManager:1';

export type UpnpSpeaker = Speaker & { avTransport?: string; renderingControl?: string | null; connectionManager?: string | null; sonos?: boolean };

// What each codec is called in a renderer's GetProtocolInfo sink list, and
// the extension the stream URL gets for it.
const FORMATS: Record<string, { mimes: RegExp; ext: string; mime: string }> = {
  'audio/flac': { mimes: /audio\/(x-)?flac/i, ext: 'flac', mime: 'audio/flac' },
  'audio/mpeg': { mimes: /audio\/(mpeg|mp3|x-mp3)/i, ext: 'mp3', mime: 'audio/mpeg' },
  'audio/mp4': { mimes: /audio\/(mp4|x-m4a|m4a|aac)/i, ext: 'm4a', mime: 'audio/mp4' },
  'audio/ogg': { mimes: /audio\/(x-)?ogg|application\/ogg/i, ext: 'ogg', mime: 'audio/ogg' },
  'audio/wav': { mimes: /audio\/(x-)?wav/i, ext: 'wav', mime: 'audio/wav' },
  'audio/aiff': { mimes: /audio\/(x-)?aiff/i, ext: 'aiff', mime: 'audio/aiff' },
};

// The server's progressive mp3 of a track (every renderer plays it; seeking
// is a new stream from that point).
function mp3Of(url: string) {
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/track.mp3`;
  u.searchParams.set('bitrate', '320000');
  return { url: u.toString(), mime: 'audio/mpeg', seekable: false };
}

export class SoapError extends Error { constructor(msg: string, public code: number | null) { super(msg); } }

// Every non-ASCII character as a numeric entity, after the XML escape.
const asciiEscape = (s: string) => xmlEscape(s).replace(/[^\x20-\x7e]/g, (c) => `&#${c.codePointAt(0)};`);
const hms = (s: number) => { const t = Math.max(0, Math.floor(s)); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
export const parseHms = (v: string | null | undefined): number => {
  if (!v || /NOT_IMPLEMENTED/i.test(v)) return 0;
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(\.\d+)?/.exec(v.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) : 0) : 0;
};

export function didl(url: string, meta: PlayMeta, mime: string, duration: number): string {
  const art = meta.artwork ? `<upnp:albumArtURI>${asciiEscape(meta.artwork)}</upnp:albumArtURI>` : '';
  const dur = duration > 0 ? ` duration="${hms(duration)}"` : '';
  return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">'
    + '<item id="slopify" parentID="0" restricted="1">'
    + `<dc:title>${asciiEscape(meta.title || 'Unknown title')}</dc:title>`
    + `<dc:creator>${asciiEscape(meta.artist || '')}</dc:creator><upnp:artist>${asciiEscape(meta.artist || '')}</upnp:artist>`
    + `<upnp:album>${asciiEscape(meta.album || '')}</upnp:album>${art}`
    + '<upnp:class>object.item.audioItem.musicTrack</upnp:class>'
    + `<res${dur} protocolInfo="http-get:*:${mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01500000000000000000000000000000">${asciiEscape(url)}</res>`
    + '</item></DIDL-Lite>';
}

export async function soap(controlUrl: string, service: string, action: string, args: Record<string, string | number> = {}, ms = 6000): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r = await httpText(controlUrl, ms, 'POST', body, { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"` });
  if (r.status >= 200 && r.status < 300) return r.body;
  const code = Number(xtag(r.body, 'errorCode')) || null;
  throw new SoapError(`${action} -> HTTP ${r.status}${code ? ` (UPnP error ${code}${xtag(r.body, 'errorDescription') ? `: ${xtag(r.body, 'errorDescription')}` : ''})` : ''}`, code);
}

export class UpnpTransport implements Transport {
  private sink: string | null = null; // GetProtocolInfo Sink, read once
  private last: { url: string; meta: PlayMeta; seekable: boolean; base: string } | null = null;
  private offset = 0; // a transcode started at `offset` reports positions from 0
  private lastState: string | null = null;
  private playedOurs = false;
  private failures = 0;
  private vol: { at: number; level: number | null; muted: boolean } | null = null;
  constructor(private device: UpnpSpeaker) {}

  private get avt() { if (!this.device.avTransport) throw new Error(`${this.device.name} has no AVTransport`); return this.device.avTransport; }
  private av(action: string, args: Record<string, string | number> = {}, ms?: number) { return soap(this.avt, AVT, action, { InstanceID: 0, ...args }, ms); }

  private async protocolInfo(): Promise<string> {
    if (this.sink != null) return this.sink;
    if (!this.device.connectionManager) return (this.sink = '');
    try { this.sink = xtag(await soap(this.device.connectionManager, CM, 'GetProtocolInfo'), 'Sink') || ''; }
    catch { this.sink = ''; }
    return this.sink;
  }
  // The original file when the renderer lists its type (byte ranges, so it
  // seeks), else the server's progressive mp3, which every renderer takes.
  async pick(url: string, contentType = 'audio/mpeg'): Promise<{ url: string; mime: string; seekable: boolean }> {
    const sink = await this.protocolInfo();
    const f = FORMATS[contentType];
    const u = new URL(url);
    const base = u.pathname.replace(/\/+$/, '');
    if (f && sink && (f.mimes.test(sink) || /http-get:\*:audio\/\*:/i.test(sink))) { u.pathname = `${base}/track.${f.ext}`; return { url: u.toString(), mime: f.mime, seekable: true }; }
    return mp3Of(url);
  }

  async play(url: string, meta: PlayMeta = {}, startAt = 0) {
    if (!/^http:/i.test(url)) throw new Error(`${this.device.name} can only fetch http:// streams; set PUBLIC_URL to the server's plain LAN address`);
    const choice = await this.pick(url, meta.contentType);
    this.last = { url: choice.url, meta, seekable: choice.seekable, base: url };
    return this.load(choice, meta, startAt);
  }
  private async load(choice: { url: string; mime: string; seekable: boolean }, meta: PlayMeta, startAt: number) {
    let target = choice.url;
    this.offset = 0;
    if (!choice.seekable && startAt > 0) { const u = new URL(target); u.searchParams.set('startAt', String(Math.floor(startAt))); target = u.toString(); this.offset = Math.floor(startAt); }
    this.lastState = null;
    await this.av('Stop').catch(() => {}); // clears what the renderer had queued
    await this.av('SetAVTransportURI', { CurrentURI: target, CurrentURIMetaData: didl(target, meta, choice.mime, Math.max(0, (meta.duration || 0) - this.offset)) }, 15000);
    await this.av('Play', { Speed: 1 }, 15000);
    this.playedOurs = true;
    if (choice.seekable && startAt > 1) await this.seekWhenReady(startAt);
    return null;
  }
  // A Seek before the renderer has opened the stream is refused (or lost).
  private async seekWhenReady(seconds: number, timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const st = xtag(await this.av('GetTransportInfo').catch(() => ''), 'CurrentTransportState');
      if (st === 'PLAYING' || st === 'PAUSED_PLAYBACK') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.av('Seek', { Unit: 'REL_TIME', Target: hms(seconds) }, 10000);
  }
  async resume() { return this.av('Play', { Speed: 1 }, 15000); }
  async pause() {
    try { return await this.av('Pause'); }
    catch (e) { if (e instanceof SoapError) return this.av('Stop'); throw e; }
  }
  async stop() {
    if (!this.playedOurs) return null; // never touch what someone else is playing on it
    this.playedOurs = false;
    return this.av('Stop').catch(() => null);
  }
  async seek(seconds: number) {
    if (!this.last) return null;
    if (this.last.seekable) {
      try { return await this.av('Seek', { Unit: 'REL_TIME', Target: hms(seconds) }, 10000); }
      catch { /* renderer cannot seek this stream: reload it from there */ }
    }
    return this.load(mp3Of(this.last.base), this.last.meta, seconds);
  }
  async setVolume(level: number) {
    if (!this.device.renderingControl) return null;
    const v = Math.max(0, Math.min(100, Math.round(level)));
    this.vol = { at: Date.now(), level: v, muted: false };
    return soap(this.device.renderingControl, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: v });
  }
  private async volume(): Promise<{ level: number | null; muted: boolean }> {
    if (!this.device.renderingControl) return { level: null, muted: false };
    if (this.vol && Date.now() - this.vol.at < 3000) return this.vol;
    try {
      const x = await soap(this.device.renderingControl, RC, 'GetVolume', { InstanceID: 0, Channel: 'Master' }, 3000);
      const n = Number(xtag(x, 'CurrentVolume'));
      const m = await soap(this.device.renderingControl, RC, 'GetMute', { InstanceID: 0, Channel: 'Master' }, 3000).then((r) => /^(1|true)$/i.test(xtag(r, 'CurrentMute') || '')).catch(() => false);
      this.vol = { at: Date.now(), level: Number.isFinite(n) && xtag(x, 'CurrentVolume') !== '' ? n : null, muted: m };
    } catch { this.vol = { at: Date.now(), level: null, muted: false }; }
    return this.vol;
  }
  async status(): Promise<Status> {
    let ti: string; let pi: string;
    try { [ti, pi] = await Promise.all([this.av('GetTransportInfo', {}, 4000), this.av('GetPositionInfo', {}, 4000)]); this.failures = 0; }
    catch (e) {
      // One missed poll is WiFi; a few in a row is a renderer that went away.
      if (++this.failures >= 3) return { playing: false, state: 'IDLE', position: 0, duration: 0, volume: null, gone: true };
      throw e;
    }
    const state = (xtag(ti, 'CurrentTransportState') || 'STOPPED').toUpperCase();
    const trackUri = xtag(pi, 'TrackURI') || '';
    const meta = xtag(pi, 'TrackMetaData') || '';
    const v = await this.volume();
    const ours = !trackUri || trackUri.includes('/api/stream');
    // Our stream finished: the renderer goes back to STOPPED (or NO_MEDIA).
    const stopped = state === 'STOPPED' || state === 'NO_MEDIA_PRESENT';
    const ended = stopped && ours && this.lastState === 'PLAYING';
    this.lastState = state === 'TRANSITIONING' ? this.lastState : state;
    const playing = state === 'PLAYING' || state === 'TRANSITIONING';
    // Sonos and friends say what else is on: x-rincon-* (grouped or line-in),
    // x-sonos-spotify:, aac:// radio...
    const theirs = !ours && playing;
    return {
      playing,
      state: theirs ? 'stream' : state === 'PAUSED_PLAYBACK' ? 'PAUSED' : stopped ? 'IDLE' : state === 'TRANSITIONING' ? 'BUFFERING' : 'PLAYING',
      title: xtag(meta.replace(/&lt;/g, '<').replace(/&gt;/g, '>'), 'title'),
      position: parseHms(xtag(pi, 'RelTime')) + this.offset,
      duration: parseHms(xtag(pi, 'TrackDuration')) ? parseHms(xtag(pi, 'TrackDuration')) + this.offset : 0,
      volume: v.level, muted: v.muted,
      streamUrl: trackUri || null,
      ended,
      service: theirs ? (/^x-sonos-spotify|spotify/i.test(trackUri) ? 'Spotify' : trackUri.split(':')[0] || 'other') : 'url',
      serviceName: theirs ? (/spotify/i.test(trackUri) ? 'Spotify' : 'another app') : null,
      canSeek: true,
      coarse: true, // whole seconds (RelTime is hh:mm:ss on nearly every renderer)
    };
  }
  close() {}
}
