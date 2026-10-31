// AirPlay: Apple TV, HomePod, AirPort Express, and the many speakers, TVs and
// receivers that take AirPlay (Sonos, Denon, Samsung, LG...). Unlike every
// other speaker here, an AirPlay receiver does not fetch a URL: the sender
// pushes timed audio to it. The protocol work (RAOP and AirPlay 2, PTP / NTP
// timing, HomeKit pairing, encryption, ALAC) is done by `cliairplay`, Music
// Assistant's GPL-3.0 streaming binary (github.com/music-assistant/airplay-cli),
// shipped in the image as a separate program. This transport feeds it PCM on
// stdin (ffmpeg decodes our own stream URL) and drives it through its command
// pipe: one process per speaker for the whole session, flushed and refilled
// on a seek or a new track.
//
// Apple devices render silence on a plain NTP-timed AirPlay 1 stream (Music
// Assistant measured this on hardware), which is why the work is not done by
// hand here: the binary picks RAOP or AirPlay 2 from the speaker's mDNS TXT.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type { Speaker } from './discovery.js';
import type { PlayMeta, Status, Transport } from './transports.js';

export type AirPlaySpeaker = Speaker & {
  raop?: { port: number; name: string; txt: Record<string, string> } | null;
  airplay?: { port: number; host: string; txt: Record<string, string> } | null;
};

// Set once at start (session.ts): where the binary is, the DACP id this server
// signs pairings with (must stay the same across restarts), and stored
// pairing credentials per speaker id.
export const airplayConfig: {
  binary: string | null; dacp: string; credentials: (id: string) => string | null; password?: (id: string) => string | null; log: (m: string) => void; iface?: string;
} = { binary: null, dacp: randomBytes(8).toString('hex').toUpperCase(), credentials: () => null, log: () => {} };

export function findBinary(): string | null {
  const candidates = [process.env.CLIAIRPLAY, '/usr/local/bin/cliairplay', ...(process.env.PATH || '').split(':').map((d) => path.join(d, 'cliairplay'))].filter(Boolean) as string[];
  for (const c of candidates) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ } }
  return null;
}

const SR = 44100;
const BYTES_PER_SEC = SR * 4; // s16le stereo
const START_LEAD_MS = 400;
const TAIL_SECONDS = 4;

const txtString = (txt: Record<string, string>) => Object.entries(txt).map(([k, v]) => `${k}=${v}`).join(' ');
// AirPlay 2 support from the features bitmask (bit 38 = SupportsUnifiedMediaControl,
// bit 48 = SupportsCoreUtilsPairingAndEncryption), the same test the binary uses.
export function supportsAirPlay2(txt: Record<string, string> | undefined): boolean {
  const f = txt?.features || txt?.ft;
  if (!f) return false;
  const [lo, hi] = f.split(',').map((x) => parseInt(x, 16) || 0);
  const bits = BigInt(lo >>> 0) | (BigInt((hi || 0) >>> 0) << 32n);
  return ((bits >> 38n) & 1n) === 1n || ((bits >> 48n) & 1n) === 1n;
}

export function cliArgs(device: AirPlaySpeaker, pipe: string, creds: string | null, password: string | null = null): string[] {
  const ap2 = !!device.airplay && supportsAirPlay2(device.airplay.txt);
  const args = ['--protocol', ap2 && !device.raop ? 'airplay2' : 'auto', '--dacp', airplayConfig.dacp, '--activeremote', String(1000000000 + Math.floor(Math.random() * 3000000000)), '--cmdpipe', pipe, '--samplerate', String(SR), '--bitdepth', '16'];
  if (ap2 && device.airplay) args.push('--port', String(device.airplay.port), '--name', device.name, '--hostname', device.airplay.host);
  else if (device.raop) args.push('--port', String(device.raop.port));
  if (device.raop) {
    args.push('--udn', device.raop.name);
    for (const k of ['et', 'am', 'pk', 'pw', 'cn']) if (device.raop.txt[k]) args.push(`--${k}`, device.raop.txt[k]);
    // A RAOP-only receiver without md takes no metadata at all (some drop the
    // connection on a metadata push).
    if (device.raop.txt.md || !ap2) args.push('--md', device.raop.txt.md || '');
  }
  let txt = device.airplay ? txtString(device.airplay.txt) : '';
  if (device.airplay && !(device.airplay.txt.features || device.airplay.txt.ft) && device.raop?.txt.ft) txt = `${txt} ft=${device.raop.txt.ft}`.trim();
  if (txt) args.push('--txt', txt);
  if (creds && creds.length === 192) args.push('--auth', creds);
  if (password) args.push('--password', password);
  if (airplayConfig.iface) args.push('--if', airplayConfig.iface);
  args.push(device.host);
  return args;
}

// Unblocks a writer waiting on a FIFO nobody will read.
async function releaseFifo(p: string) {
  try { const fh = await fs.promises.open(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); await fh.close(); } catch { /* gone */ }
}
// The binary's error codes, said the way a person can act on.
function explain(name: string, errors: string[], fallback: string) {
  const last = errors.slice(-1)[0] || '';
  if (/auth_required|401|password/i.test(errors.join(' '))) return `${name} asks for a password: set it in Settings › Speakers`;
  if (/pair|403|470/i.test(last)) return `${name} needs pairing first: Settings › Speakers › Pair`;
  if (/refused|unreachable|timed? ?out|no route/i.test(last)) return `${name} did not answer (is it on?)`;
  return `${name}: ${last || fallback}`;
}

// Waits for the binary's status lines. `after` makes a waiter count only
// matches that come after that other line: a refill arms its "audio" wait
// together with the "flushed" one, because the binary can print both in one
// chunk (an "audio" wait armed only once "flushed" resolved missed it, and
// the one-shot line never came again).
class Waiter {
  private waiting: { re: RegExp; after?: RegExp; armed: boolean; resolve: (l: string) => void; reject: (e: Error) => void; t: NodeJS.Timeout }[] = [];
  feed(line: string) {
    for (const w of [...this.waiting]) {
      if (!w.armed) { if (w.after!.test(line)) w.armed = true; continue; }
      if (w.re.test(line)) { clearTimeout(w.t); this.waiting.splice(this.waiting.indexOf(w), 1); w.resolve(line); }
    }
  }
  wait(re: RegExp, ms: number, what: string, after?: RegExp) {
    const p = new Promise<string>((resolve, reject) => {
      const w = { re, after, armed: !after, resolve, reject, t: setTimeout(() => { this.waiting.splice(this.waiting.indexOf(w), 1); reject(new Error(`AirPlay: no ${what} within ${ms / 1000} s`)); }, ms) };
      this.waiting.push(w);
    });
    p.catch(() => {}); // a wait nobody reached any more (a failed flush) must not be an unhandled rejection
    return p;
  }
  failAll(e: Error) { for (const w of this.waiting.splice(0)) { clearTimeout(w.t); w.reject(e); } }
}

function download(url: string, file: string, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: ms }, (res) => {
      if ((res.statusCode || 0) >= 300) { res.resume(); resolve(false); return; }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => resolve(true));
      out.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// Every cliairplay this process started: killed when it exits, so a crash or
// restart outside Docker does not leave one holding a speaker (an AirPlay
// receiver takes one sender at a time).
const children = new Set<ChildProcess>();
process.once('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

export class AirPlayTransport implements Transport {
  private proc: ChildProcess | null = null;
  private pipeFd: fs.promises.FileHandle | null = null;
  private pipePath = '';
  private ff: ChildProcess | null = null;
  private waiter = new Waiter();
  private errors: string[] = [];
  private gone = false;
  private anchored = false; // a START was acked since connect (a refill needs a FLUSH first)
  // The clock: `pos` seconds were audible at `at` (ms); frozen while paused.
  private clock = { pos: 0, at: 0, playing: false };
  private fedBytes = 0; private fedFrom = 0; private feedDone = false;
  private volume: number | null = null;
  private meta: PlayMeta = {};
  private duration = 0;
  private gen = 0;
  private url = '';
  private cycleFrom = 0; // where the current start cycle began in the track (s)
  constructor(private device: AirPlaySpeaker) {}

  private log(m: string) { airplayConfig.log(`airplay ${this.device.name}: ${m}`); }
  private async connect() {
    if (this.proc && !this.gone) return;
    const bin = airplayConfig.binary;
    if (!bin) throw new Error('AirPlay needs the cliairplay program (bundled in the Docker image; set CLIAIRPLAY to its path otherwise)');
    this.gone = false; this.anchored = false; this.errors = [];
    this.pipePath = path.join(os.tmpdir(), `slopify-airplay-${process.pid}-${randomBytes(4).toString('hex')}`);
    await new Promise<void>((resolve, reject) => execFile('mkfifo', [this.pipePath], (e) => (e ? reject(e) : resolve())));
    const args = cliArgs(this.device, this.pipePath, airplayConfig.credentials(this.device.id), airplayConfig.password?.(this.device.id) ?? null);
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    children.add(proc);
    proc.once('exit', () => children.delete(proc));
    proc.stdin!.on('error', () => {}); // EPIPE when it exits
    const lines = (stream: NodeJS.ReadableStream) => { let buf = ''; stream.setEncoding?.('utf8'); stream.on('data', (c: string) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) this.onLine(l); } }); };
    lines(proc.stderr!); lines(proc.stdout!);
    proc.on('exit', (code, sig) => {
      if (this.proc !== proc) return;
      this.gone = true; this.proc = null; this.clock.playing = false;
      this.waiter.failAll(new Error(`${this.device.name}: AirPlay ended (${this.errors.slice(-1)[0] || `exit ${code ?? sig}`})`));
      this.cleanupPipe();
    });
    proc.on('error', (e) => { this.errors.push(e.message); });
    const connected = this.waiter.wait(/\[STATUS\] connected/, 20000, 'connection');
    const exited = new Promise<never>((_, rej) => proc.once('exit', () => rej(new Error('exited'))));
    try {
      // Opening a FIFO for writing waits until the binary opens it for
      // reading. A binary that quits first (wrong password, unreachable)
      // never does: the open is released by opening the read end ourselves,
      // or it would hold one of libuv's few file threads for good.
      const opening = fs.promises.open(this.pipePath, 'w');
      this.pipeFd = await Promise.race([opening, exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('AirPlay: command pipe not opened')), 10000))])
        .catch(async (e) => { await releaseFifo(this.pipePath); (await opening.catch(() => null))?.close().catch(() => {}); throw e; });
      await Promise.race([connected, exited]);
    } catch (e: any) {
      connected.catch(() => {});
      this.kill();
      throw new Error(explain(this.device.name, this.errors, e.message));
    }
    this.log(`connected (${this.device.host})`);
  }
  private onLine(l: string) {
    if (process.env.AIRPLAY_DEBUG) this.log(`cli: ${l.slice(0, 300)}`);
    // The binary's own count of what has been heard since this start (it
    // runs on across a pause): the clock follows it, instead of guessing how
    // long a resume took to become audible.
    const el = /\[STATUS\] playing elapsed_ms=(\d+)/.exec(l);
    if (el && this.clock.playing) {
      const pos = this.cycleFrom + Number(el[1]) / 1000;
      if (Math.abs(this.now() - pos) > 0.1) this.clock = { pos, at: Date.now(), playing: true };
    }
    if (/\[STATUS\] error|error|fail/i.test(l) && !/\[STATUS\] (connected|audio|started|flushed|playing)/.test(l)) { this.errors.push(l.replace(/^.*?\[STATUS\] /, '').slice(0, 200)); if (this.errors.length > 20) this.errors.shift(); }
    if (/\[STATUS\] (route|latency|error|eof|connected)/.test(l)) this.log(l.replace(/^.*?\[STATUS\] /, ''));
    this.waiter.feed(l);
  }
  private async cmd(text: string) {
    if (!this.pipeFd) return false;
    try { await this.pipeFd.write(text.endsWith('\n') ? text : `${text}\n`); return true; } catch { return false; }
  }
  private stopFeed() {
    if (this.ff) { const f = this.ff; this.ff = null; f.stdout?.unpipe(); try { f.kill('SIGKILL'); } catch { /* gone */ } }
  }
  private drained(ms = 2000) {
    const w = this.proc?.stdin;
    if (!w || !w.writableLength) return Promise.resolve();
    return new Promise<void>((r) => { const t = setTimeout(r, ms); w.once('drain', () => { clearTimeout(t); r(); }); });
  }
  private feed(url: string, startAt: number) {
    this.stopFeed();
    this.fedBytes = 0; this.fedFrom = startAt; this.feedDone = false;
    const gen = this.gen;
    const ff = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...(startAt > 0 ? ['-ss', String(startAt)] : []), '-i', url, '-map', '0:a:0', '-vn', '-f', 's16le', '-ar', String(SR), '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ff = ff;
    ff.stderr!.on('data', (d) => this.log(`ffmpeg: ${String(d).trim().slice(0, 200)}`));
    ff.stdout!.on('data', (c: Buffer) => { if (this.gen === gen) this.fedBytes += c.length; });
    ff.stdout!.pipe(this.proc!.stdin!, { end: false });
    ff.on('exit', (code) => {
      if (this.gen !== gen) return;
      this.feedDone = true;
      // Nothing came out (the stream would not open): say so now, not after the 25 s wait.
      if (!this.fedBytes) { this.waiter.failAll(new Error(`${this.device.name}: the stream could not be read (ffmpeg exit ${code})`)); return; }
      // The binary holds the last ~2 s it was given until more comes (stdin
      // stays open between tracks): silence after the end lets the track play
      // out to its last sample; the next track's flush drops what is left.
      try { this.proc?.stdin?.write(Buffer.alloc(BYTES_PER_SEC * TAIL_SECONDS)); } catch { /* gone */ }
    });
    ff.on('error', (e) => this.log(`ffmpeg: ${e.message}`));
  }
  private async sendMeta(meta: PlayMeta, duration: number) {
    const clean = (s?: string) => String(s || '').replace(/[\r\n]+/g, ' ');
    let art = '';
    if (meta.artwork) {
      const file = `${this.pipePath}.jpg`;
      if (await download(meta.artwork, file)) art = `ARTWORKFILE=${file}\n`;
    }
    await this.cmd(`TITLE=${clean(meta.title)}\nARTIST=${clean(meta.artist)}\nALBUM=${clean(meta.album)}\nDURATION=${Math.round(duration)}\n${art}ACTION=SENDMETA`);
  }

  async play(url: string, meta: PlayMeta = {}, startAt = 0) {
    this.gen += 1;
    this.meta = meta; this.url = url;
    await this.connect();
    let audio: Promise<string>;
    if (this.anchored) {
      this.stopFeed();
      // What the old feed already handed to stdin goes first, so none of it
      // lands after the flush as the start of the new audio.
      await this.drained();
      const flushed = this.waiter.wait(/\[STATUS\] flushed/, 8000, 'flush');
      audio = this.waiter.wait(/\[STATUS\] audio/, 25000, 'audio from the stream', /\[STATUS\] flushed/);
      await this.cmd('ACTION=FLUSH');
      await flushed.catch((e) => this.log(e.message));
    } else audio = this.waiter.wait(/\[STATUS\] audio/, 25000, 'audio from the stream');
    this.clock = { pos: startAt, at: Date.now(), playing: false };
    this.feed(url, startAt);
    await audio;
    this.duration = meta.duration || 0;
    await this.sendMeta(meta, this.duration);
    const at = Date.now() + START_LEAD_MS;
    const started = this.waiter.wait(/\[STATUS\] started/, 8000, 'start');
    await this.cmd(`START_UNIX_MS=${at}\nACTION=START`);
    let audibleAt = at;
    try { const l = await started; const m = /at_unix_ms=(\d+)/.exec(l); if (m) audibleAt = Number(m[1]); } catch (e: any) { this.log(e.message); }
    this.anchored = true;
    this.cycleFrom = startAt;
    this.clock = { pos: startAt, at: audibleAt, playing: true };
    if (this.volume != null) await this.cmd(`VOLUME=${this.volume}`);
    await this.cmd(`PROGRESS=${Math.round(startAt)}`);
    return null;
  }
  private now() { const c = this.clock; return c.playing ? c.pos + Math.max(0, Date.now() - c.at) / 1000 : c.pos; }
  async pause() {
    if (!this.proc) return null;
    const pos = this.now();
    await this.cmd('ACTION=PAUSE');
    this.clock = { pos, at: Date.now(), playing: false };
    return null;
  }
  async resume() {
    if (!this.proc || this.gone) throw new Error(`${this.device.name}: AirPlay session is gone`);
    await this.cmd('ACTION=PLAY');
    // The binary re-anchors playout a short lead ahead.
    this.clock = { pos: this.clock.pos, at: Date.now() + START_LEAD_MS, playing: true };
    return null;
  }
  async seek(seconds: number) {
    if (!this.url) return null;
    return this.play(this.url, this.meta, seconds);
  }
  async setVolume(level: number) {
    this.volume = Math.max(0, Math.min(100, Math.round(level)));
    if (this.proc) await this.cmd(`VOLUME=${this.volume}`);
    return null;
  }
  async stop() {
    this.stopFeed();
    if (!this.proc) return null;
    await this.cmd('ACTION=STOP');
    const p = this.proc;
    try { p.stdin?.end(); } catch { /* gone */ }
    await new Promise((r) => { const t = setTimeout(r, 3000); p.once('exit', () => { clearTimeout(t); r(null); }); });
    this.kill();
    return null;
  }
  async status(): Promise<Status> {
    if (this.gone || !this.proc) return { playing: false, state: 'IDLE', position: this.clock.pos, duration: this.duration, volume: this.volume, gone: this.gone };
    const pos = this.now();
    // The feed ran out and everything fed has been heard: the track ended.
    const end = this.fedFrom + this.fedBytes / BYTES_PER_SEC;
    const ended = this.feedDone && this.clock.playing && pos >= end - 0.1;
    if (ended) this.clock = { pos: end, at: Date.now(), playing: false };
    return { playing: this.clock.playing && !ended, state: ended ? 'IDLE' : this.clock.playing ? 'PLAYING' : 'PAUSED', position: Math.min(pos, this.feedDone ? end : pos), duration: this.duration, volume: this.volume, ended, canSeek: true, streamUrl: null, service: 'url' };
  }
  private kill() {
    this.stopFeed();
    const p = this.proc; this.proc = null;
    if (p) { try { p.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref(); }
    this.cleanupPipe();
  }
  private cleanupPipe() {
    const fd = this.pipeFd; this.pipeFd = null;
    if (fd) fd.close().catch(() => {});
    else if (this.pipePath) void releaseFifo(this.pipePath);
    if (this.pipePath) { for (const f of [this.pipePath, `${this.pipePath}.jpg`]) fs.promises.unlink(f).catch(() => {}); }
  }
  close() { this.kill(); }
}

// HomeKit pair-setup (Apple TV, some HomePods / Macs): the speaker shows a
// PIN, the binary reads it on stdin and prints the credentials to keep.
export class AirPlayPairing {
  private proc: ChildProcess | null = null;
  private out = '';
  constructor(private device: AirPlaySpeaker) {}
  start(): Promise<void> {
    const bin = airplayConfig.binary;
    if (!bin) return Promise.reject(new Error('AirPlay needs the cliairplay program'));
    const port = this.device.airplay?.port || this.device.raop?.port || 7000;
    this.proc = spawn(bin, ['--pair-setup', '--port', String(port), '--dacp', airplayConfig.dacp, this.device.host], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', (d) => { this.out += String(d); });
    this.proc.stderr!.on('data', (d) => { this.out += String(d); });
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 4000); // the PIN is on the TV by now
      this.proc!.once('exit', (code) => { clearTimeout(t); reject(new Error(`pairing ended (${code}): ${this.out.trim().split('\n').slice(-1)[0] || ''}`)); });
    });
  }
  finish(pin: string): Promise<string> {
    const p = this.proc;
    if (!p) return Promise.reject(new Error('no pairing in progress'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error('pairing timed out')); }, 20000);
      p.once('exit', () => {
        clearTimeout(t);
        const m = /CREDENTIALS:\s*([0-9a-fA-F]{192})/.exec(this.out);
        if (m) resolve(m[1]); else reject(new Error(`pairing failed: ${this.out.trim().split('\n').slice(-1)[0] || 'wrong PIN?'}`));
      });
      p.stdin!.write(`${String(pin).replace(/\D/g, '')}\n`);
    });
  }
  cancel() { try { this.proc?.kill(); } catch { /* gone */ } this.proc = null; }
}
