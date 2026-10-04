// What the server checks about its surroundings before it starts, so a
// first install says what is wrong in plain words instead of a stack trace:
// folders it cannot write, an empty music folder, a container whose network
// cannot reach speakers. Also works out the defaults that depend on where it
// runs (the name it announces, the address speakers fetch audio from).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lanAddress } from './speakers/discovery.js';

type Log = { info(m: string): void; warn(m: string): void };

// Docker's default (bridge) network: the container has its own hostname, the
// short container id, and its own private address the LAN cannot reach.
export function bridgedContainer(hostname = os.hostname(), dockerenv = fs.existsSync('/.dockerenv')): boolean {
  return dockerenv && /^[0-9a-f]{12}$/.test(hostname);
}

export const defaultServerName = (hostname = os.hostname(), bridged = bridgedContainer(hostname)) =>
  bridged ? 'Slopify' : `Slopify on ${hostname.split('.')[0] || 'this server'}`;

// The address speakers fetch audio from: PUBLIC_URL, or this machine's LAN
// address. Inside a bridged container there is no address worth guessing.
export function speakerUrl(o: { publicUrl: string; port: number; bridged?: boolean; lan?: string }): string {
  if (o.publicUrl) return o.publicUrl;
  if (o.bridged ?? bridgedContainer()) return '';
  const lan = 'lan' in o ? o.lan : lanAddress();
  return lan ? `http://${lan}:${o.port}` : '';
}

const writable = (dir: string) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };
const uid = () => (process.getuid ? process.getuid() : -1);

// Folders the server must write. Throws with the fix in the message.
export function checkStateDirs(dirs: { name: string; dir: string }[]) {
  for (const { name, dir } of dirs) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported below */ }
    if (!fs.existsSync(dir) || !writable(dir)) {
      throw new Error(`${name} (${dir}) is not writable by the user the server runs as (uid ${uid()}). `
        + `On the host, run: chown -R ${uid()} <the folder mounted at ${dir}>. `
        + `(Without a "user:" line in compose, the container fixes this itself; PUID/PGID pick the user.)`);
    }
  }
}

export type Surroundings = {
  musicDir: string; saveToLibrary: boolean; speakers: boolean; mdns: boolean;
  publicUrl: string; port: number; bridged?: boolean; lan?: string;
};

// Warnings for the log; returns what to change (saveToLibrary off when the
// library cannot be written, the speaker URL to use).
export function checkSurroundings(s: Surroundings, log: Log): { saveToLibrary: boolean; speakerUrl: string } {
  const bridged = s.bridged ?? bridgedContainer();
  let saveToLibrary = s.saveToLibrary;
  let entries: string[] = [];
  try { entries = fs.readdirSync(s.musicDir).filter((n) => !n.startsWith('.')); } catch { /* missing */ }
  if (!fs.existsSync(s.musicDir)) log.warn(`MUSIC_DIR ${s.musicDir} does not exist: mount your music folder there (volumes: - /path/to/music:${s.musicDir}).`);
  else if (!entries.length) log.warn(`MUSIC_DIR ${s.musicDir} is empty: is your music folder mounted there?`);
  if (saveToLibrary && fs.existsSync(s.musicDir) && !writable(s.musicDir)) {
    log.warn(`SAVE_TO_LIBRARY=1 but ${s.musicDir} is not writable by uid ${uid()}: lyrics and artwork are kept in the server's own folders instead.`);
    saveToLibrary = false;
  }
  const url = speakerUrl({ publicUrl: s.publicUrl, port: s.port, bridged, ...('lan' in s ? { lan: s.lan } : {}) });
  if (bridged && s.speakers) log.warn('Speaker discovery needs host networking (network_mode: host); on Docker\'s default network no speakers will be found. Set SPEAKERS=0 to silence this.');
  if (bridged && s.mdns) log.info('On Docker\'s default network the server cannot announce itself; Home Assistant will need its address typed in.');
  if (s.speakers && !bridged) {
    if (!s.publicUrl && url) log.info(`Speakers will fetch audio from ${url} (set PUBLIC_URL if that address is wrong).`);
    if (!url) log.warn('No LAN address found for speakers to fetch audio from: set PUBLIC_URL to this server\'s LAN address, e.g. http://192.168.1.10:8080.');
  }
  return { saveToLibrary, speakerUrl: url };
}

export const stateDirs = (dataDir: string, cacheDir: string) =>
  [{ name: 'CONFIG_DIR', dir: dataDir }, ...(path.resolve(cacheDir) !== path.resolve(dataDir) ? [{ name: 'CACHE_DIR', dir: cacheDir }] : [])];
