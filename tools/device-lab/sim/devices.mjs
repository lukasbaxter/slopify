#!/usr/bin/env node
// Protocol simulators for speakers nobody ships an emulator for: a Roku
// (ECP + Play on Roku) and a Sonos (ZonePlayer description, AVTransport,
// RenderingControl, ConnectionManager over SOAP). Both answer SSDP on the LAN
// like the real thing, so the server finds them by itself, and both really
// fetch and decode what they are given, in real time, with ffmpeg (to
// nowhere: nothing makes a sound), so a URL or format the server gets wrong
// fails here the way it would on the device.
//
// They are built from the vendors' public API docs and what Music Assistant
// and Home Assistant send to real units; they are not the vendors' firmware.
//
//   node tools/device-lab/sim/devices.mjs --roku "Lab Roku" --sonos "Lab Sonos"
//
// Env: SIM_IP (address to announce; default: the box's LAN address),
// ROKU_PORT (8060), SONOS_PORT (1400), FFMPEG (ffmpeg on PATH).
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const ROKU = arg('--roku'); const SONOS = arg('--sonos');
if (!ROKU && !SONOS) { console.error('usage: devices.mjs [--roku NAME] [--sonos NAME]'); process.exit(2); }
const lanIp = () => {
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (/^(br-|docker|veth|virbr|wg|tailscale|tun|tap)/.test(name) || a.family !== 'IPv4' || a.internal) continue;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
  }
  return null;
};
const IP = process.env.SIM_IP || lanIp();
if (!IP) { console.error('no LAN address; set SIM_IP'); process.exit(1); }
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const log = (who, m) => console.log(`${new Date().toISOString().slice(11, 23)} ${who}: ${m}`);
const idFor = (name) => crypto.createHash('sha1').update(`${os.hostname()}:${name}`).digest('hex');
const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xun = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ---- a real-time player: ffmpeg -re reads and decodes the URL ---------------
class Player {
  constructor(who) { this.who = who; this.ff = null; this.url = null; this.state = 'idle'; this.base = 0; this.at = 0; this.duration = 0; this.error = null; }
  position() { return this.state === 'playing' ? this.base + (Date.now() - this.at) / 1000 : this.base; }
  load(url, from = 0) {
    this.kill(); this.url = url; this.error = null;
    this.base = from; this.at = Date.now(); this.state = 'buffering';
    // The duration, as a renderer learns it from the stream itself.
    const probe = spawn(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url]);
    let out = ''; probe.stdout.on('data', (d) => { out += d; }); probe.on('exit', () => { const d = Number(out.trim()); if (d > 0) this.duration = d; }); // the length of what the URL serves (a transcode from startAt is shorter)
    probe.on('error', () => {});
    const ff = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-re', ...(from > 0 ? ['-ss', String(from)] : []), '-i', url, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.ff = ff;
    let err = ''; ff.stderr.on('data', (d) => { err += d; });
    // First decoded output: playing. ffmpeg -re has no progress line at
    // loglevel error, so a short start delay stands in for buffering.
    setTimeout(() => { if (this.ff === ff && this.state === 'buffering') { this.base = from; this.at = Date.now(); this.state = 'playing'; log(this.who, `playing ${url.replace(/token=[^&]+/, 'token=…')} from ${from}s`); } }, 300);
    ff.on('exit', (code, sig) => {
      if (this.ff !== ff) return;
      this.ff = null;
      if (code === 0) { this.base = this.position(); this.state = 'ended'; log(this.who, `ended at ${this.base.toFixed(1)}s`); }
      else if (!sig) { this.state = 'error'; this.error = err.trim().split('\n').pop() || `ffmpeg ${code}`; log(this.who, `error: ${this.error}`); }
    });
  }
  pause() { if (this.state !== 'playing' || !this.ff) return; this.base = this.position(); this.state = 'paused'; this.ff.kill('SIGSTOP'); }
  resume() { if (this.state !== 'paused' || !this.ff) return; this.at = Date.now(); this.state = 'playing'; this.ff.kill('SIGCONT'); }
  stop() { this.kill(); this.state = 'idle'; this.base = 0; }
  kill() { if (this.ff) { const f = this.ff; this.ff = null; try { f.kill('SIGCONT'); f.kill('SIGKILL'); } catch { /* gone */ } } }
}

// ---- SSDP: answer searches for what we are --------------------------------
const answers = []; // { st: string[], location, usn }
function ssdp() {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf, rinfo) => {
    const msg = buf.toString();
    if (!/^M-SEARCH/i.test(msg)) return;
    const st = (/^ST:\s*(.+)$/im.exec(msg) || [])[1]?.trim();
    if (!st) return;
    for (const a of answers) {
      const match = st === 'ssdp:all' ? a.st[0] : a.st.find((x) => x.toLowerCase() === st.toLowerCase());
      if (!match) continue;
      const res = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${a.location}\r\nSERVER: ${a.server}\r\nST: ${match}\r\nUSN: ${a.usn}::${match}\r\n\r\n`;
      sock.send(res, rinfo.port, rinfo.address);
    }
  });
  sock.bind(1900, () => { try { sock.addMembership('239.255.255.250', IP); } catch (e) { console.error(`ssdp: ${e.message}`); } });
}

const listen = (port, handler, who) => new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { try { handler(req, res, body); } catch (e) { res.statusCode = 500; res.end(String(e)); } });
  });
  s.listen(port, IP, () => { log(who, `at http://${IP}:${port}`); resolve(s); });
});

// ---- Roku -----------------------------------------------------------------
if (ROKU) {
  const port = Number(process.env.ROKU_PORT || 8060);
  const udn = `29600000-0000-1000-8000-${idFor(ROKU).slice(0, 12)}`;
  const p = new Player(ROKU);
  let app = { id: '', name: 'Roku' }; // the home screen
  let paused = false;
  const sendXml = (res, x) => { res.setHeader('content-type', 'text/xml; charset="utf-8"'); res.end(`<?xml version="1.0" encoding="UTF-8" ?>\n${x}`); };
  await listen(port, (req, res) => {
    const u = new URL(req.url, `http://${IP}`);
    if (req.method === 'GET' && u.pathname === '/') return sendXml(res, `<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:roku-com:device:player:1-0</deviceType><friendlyName>${xesc(ROKU)}</friendlyName><manufacturer>Roku</manufacturer><modelName>Roku Ultra</modelName><UDN>uuid:${udn}</UDN></device></root>`);
    if (u.pathname === '/query/device-info') return sendXml(res, `<device-info><udn>${udn}</udn><serial-number>LAB${udn.slice(-8)}</serial-number><vendor-name>Roku</vendor-name><model-name>Roku Ultra</model-name><model-number>4850X</model-number><user-device-name>${xesc(ROKU)}</user-device-name><software-version>15.0.4</software-version><supports-audio-volume-control>false</supports-audio-volume-control></device-info>`);
    if (u.pathname === '/query/active-app') return sendXml(res, `<active-app>${app.id ? `<app id="${app.id}" type="appl" version="1.0.0">${xesc(app.name)}</app>` : '<app>Roku</app>'}</active-app>`);
    if (u.pathname === '/query/media-player') {
      // Play on Roku's states: startup / buffer / play / pause / stop / close / none.
      const st = !app.id ? 'none' : p.state === 'playing' ? 'play' : p.state === 'paused' ? 'pause' : p.state === 'buffering' ? 'buffer' : p.state === 'ended' ? 'close' : p.state === 'error' ? 'stop' : 'none';
      return sendXml(res, `<player error="${p.state === 'error'}" state="${st}"><plugin bandwidth="4000000 bps" id="${app.id}" name="${xesc(app.name)}"/><format audio="mp3" captions="none" container="mp3" drm="none" video="none" video_res="none"/><position>${Math.round(p.position() * 1000)} ms</position><duration>${Math.round(p.duration * 1000)} ms</duration><is_live>false</is_live></player>`);
    }
    if (req.method !== 'POST') { res.statusCode = 404; return res.end(); }
    const m = /^\/launch\/(\d+)$/.exec(u.pathname);
    if (m) {
      if (m[1] !== '15985') { res.statusCode = 404; return res.end(); } // not installed
      const q = Object.fromEntries(u.searchParams);
      log(ROKU, `launch Play on Roku t=${q.t} song="${q.songName}" artist="${q.artistName}" format=${q.songFormat} art=${q.albumArtUrl ? 'yes' : 'no'}`);
      if (q.t !== 'a' || !q.u) { res.statusCode = 400; return res.end(); }
      app = { id: '15985', name: 'Play on Roku' }; paused = false;
      p.load(q.u, 0); // the URL carries startAt itself
      return res.end();
    }
    const k = /^\/keypress\/(\w+)$/.exec(u.pathname);
    if (k) {
      log(ROKU, `keypress ${k[1]}`);
      if (k[1] === 'Play') { if (p.state === 'playing') { p.pause(); paused = true; } else if (p.state === 'paused') { p.resume(); paused = false; } }
      else if (k[1] === 'Back' || k[1] === 'Home') { p.stop(); app = { id: '', name: 'Roku' }; }
      return res.end();
    }
    res.statusCode = 404; res.end();
  }, ROKU);
  answers.push({ st: ['roku:ecp'], location: `http://${IP}:${port}/`, usn: `uuid:roku:ecp:LAB${udn.slice(-8)}`, server: 'Roku/15.0 UPnP/1.0 Roku/15.0' });
  void paused;
}

// ---- Sonos ----------------------------------------------------------------
if (SONOS) {
  const port = Number(process.env.SONOS_PORT || 1400);
  const rincon = `RINCON_${idFor(SONOS).slice(0, 12).toUpperCase()}01400`;
  const p = new Player(SONOS);
  let uri = ''; let meta = ''; let volume = 22; let mute = false;
  const desc = `<?xml version="1.0" encoding="utf-8" ?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device>
<deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>${IP} - Sonos One - ${rincon}</friendlyName><manufacturer>Sonos, Inc.</manufacturer><manufacturerURL>http://www.sonos.com</manufacturerURL><modelNumber>S18</modelNumber><modelDescription>Sonos One</modelDescription><modelName>Sonos One</modelName><softwareVersion>85.0-66270</softwareVersion><roomName>${xesc(SONOS)}</roomName><displayName>One</displayName><UDN>uuid:${rincon}</UDN>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>${IP} - Sonos One Media Server</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelName>Sonos One</modelName><UDN>uuid:${rincon}_MS</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><controlURL>/MediaServer/ContentDirectory/Control</controlURL><eventSubURL>/MediaServer/ContentDirectory/Event</eventSubURL><SCPDURL>/xml/ContentDirectory1.xml</SCPDURL></service></serviceList></device>
<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>${xesc(SONOS)} - Sonos One Media Renderer</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelName>Sonos One</modelName><UDN>uuid:${rincon}_MR</UDN><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId><controlURL>/MediaRenderer/RenderingControl/Control</controlURL><eventSubURL>/MediaRenderer/RenderingControl/Event</eventSubURL><SCPDURL>/xml/RenderingControl1.xml</SCPDURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><controlURL>/MediaRenderer/ConnectionManager/Control</controlURL><eventSubURL>/MediaRenderer/ConnectionManager/Event</eventSubURL><SCPDURL>/xml/ConnectionManager1.xml</SCPDURL></service>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><serviceId>urn:upnp-org:serviceId:AVTransport</serviceId><controlURL>/MediaRenderer/AVTransport/Control</controlURL><eventSubURL>/MediaRenderer/AVTransport/Event</eventSubURL><SCPDURL>/xml/AVTransport1.xml</SCPDURL></service>
</serviceList></device></deviceList></device></root>`;
  // What a Sonos lists in GetProtocolInfo (abridged to the audio types).
  const SINK = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'application/ogg', 'audio/aiff', 'audio/x-aiff', 'audio/x-ms-wma'].map((m) => `http-get:*:${m}:*`).join(',');
  const hms = (s) => { const t = Math.max(0, Math.floor(s)); return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const arg = (body, n) => xun((new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(body) || [])[1] || '');
  const fault = (res, code, desc) => { res.statusCode = 500; res.setHeader('content-type', 'text/xml'); res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
  const ok = (res, svc, action, inner = '') => { res.setHeader('content-type', 'text/xml; charset="utf-8"'); res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${svc}:1">${inner}</u:${action}Response></s:Body></s:Envelope>`); };
  await listen(port, (req, res, body) => {
    const u = new URL(req.url, `http://${IP}`);
    if (req.method === 'GET' && u.pathname === '/xml/device_description.xml') { res.setHeader('content-type', 'text/xml'); return res.end(desc); }
    if (req.method !== 'POST') { res.statusCode = 404; return res.end(); }
    const action = String(req.headers.soapaction || '').replace(/"/g, '').split('#')[1] || '';
    if (u.pathname === '/MediaRenderer/ConnectionManager/Control' && action === 'GetProtocolInfo') return ok(res, 'ConnectionManager', action, `<Source></Source><Sink>${SINK}</Sink>`);
    if (u.pathname === '/MediaRenderer/RenderingControl/Control') {
      if (action === 'GetVolume') return ok(res, 'RenderingControl', action, `<CurrentVolume>${volume}</CurrentVolume>`);
      if (action === 'SetVolume') { volume = Math.max(0, Math.min(100, Number(arg(body, 'DesiredVolume')) || 0)); log(SONOS, `volume ${volume}`); return ok(res, 'RenderingControl', action); }
      if (action === 'GetMute') return ok(res, 'RenderingControl', action, `<CurrentMute>${mute ? 1 : 0}</CurrentMute>`);
      if (action === 'SetMute') { mute = arg(body, 'DesiredMute') === '1'; return ok(res, 'RenderingControl', action); }
      return fault(res, 401, 'Invalid Action');
    }
    if (u.pathname !== '/MediaRenderer/AVTransport/Control') { res.statusCode = 404; return res.end(); }
    switch (action) {
      case 'SetAVTransportURI': {
        const next = arg(body, 'CurrentURI');
        meta = arg(body, 'CurrentURIMetaData');
        // A Sonos refuses a type it cannot play (714 Illegal MIME-type).
        const mime = (/protocolInfo="http-get:\*:([^:"]+)/.exec(meta) || [])[1];
        if (mime && !SINK.includes(`:${mime}:`)) return fault(res, 714, 'Illegal MIME-type');
        if (!/^https?:/.test(next)) return fault(res, 716, 'Resource not found');
        uri = next; p.stop();
        log(SONOS, `SetAVTransportURI ${uri.replace(/token=[^&]+/, 'token=…')} (${mime || 'no DIDL'}; title "${(/<dc:title>([^<]*)/.exec(meta) || [])[1] || ''}")`);
        return ok(res, 'AVTransport', action);
      }
      case 'Play': if (p.state === 'paused') p.resume(); else if (uri && p.state !== 'playing' && p.state !== 'buffering') p.load(uri, 0); return ok(res, 'AVTransport', action);
      case 'Pause': if (p.state !== 'playing') return fault(res, 701, 'Transition not available'); p.pause(); return ok(res, 'AVTransport', action);
      case 'Stop': p.stop(); return ok(res, 'AVTransport', action);
      case 'Seek': {
        if (arg(body, 'Unit') !== 'REL_TIME' || !uri) return fault(res, 710, 'Seek mode not supported');
        const [h, m2, s] = arg(body, 'Target').split(':').map(Number);
        const to = h * 3600 + m2 * 60 + s;
        log(SONOS, `Seek ${to}s`);
        const wasPaused = p.state === 'paused';
        p.load(uri, to);
        if (wasPaused) setTimeout(() => p.pause(), 350);
        return ok(res, 'AVTransport', action);
      }
      case 'GetTransportInfo': {
        const st = p.state === 'playing' ? 'PLAYING' : p.state === 'paused' ? 'PAUSED_PLAYBACK' : p.state === 'buffering' ? 'TRANSITIONING' : 'STOPPED';
        return ok(res, 'AVTransport', action, `<CurrentTransportState>${st}</CurrentTransportState><CurrentTransportStatus>${p.state === 'error' ? 'ERROR_OCCURRED' : 'OK'}</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`);
      }
      case 'GetPositionInfo': {
        const at = p.state === 'idle' ? 0 : p.position();
        return ok(res, 'AVTransport', action, `<Track>${uri ? 1 : 0}</Track><TrackDuration>${hms(p.duration)}</TrackDuration><TrackMetaData>${xesc(meta)}</TrackMetaData><TrackURI>${xesc(uri)}</TrackURI><RelTime>${hms(at)}</RelTime><AbsTime>NOT_IMPLEMENTED</AbsTime><RelCount>2147483647</RelCount><AbsCount>2147483647</AbsCount>`);
      }
      default: return fault(res, 401, 'Invalid Action');
    }
  }, SONOS);
  answers.push({ st: ['urn:schemas-upnp-org:device:ZonePlayer:1', 'urn:schemas-upnp-org:device:MediaRenderer:1'], location: `http://${IP}:${port}/xml/device_description.xml`, usn: `uuid:${rincon}`, server: 'Linux UPnP/1.0 Sonos/85.0-66270 (ZPS18)' });
}
ssdp();
