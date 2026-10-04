import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { bridgedContainer, checkStateDirs, checkSurroundings, defaultServerName, speakerUrl } from './startup.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-start-'));
const logger = () => { const out: string[] = []; return { out, log: { info: (m: string) => out.push(`info ${m}`), warn: (m: string) => out.push(`warn ${m}`) } }; };

describe('first start on someone else\'s machine', () => {
  it('names itself after the host, or plainly "Slopify" inside a container with a made-up hostname', () => {
    expect(bridgedContainer('d373ffe5e4ba', true)).toBe(true);
    expect(bridgedContainer('d373ffe5e4ba', false)).toBe(false);
    expect(bridgedContainer('nas', true)).toBe(false);
    expect(defaultServerName('d373ffe5e4ba', true)).toBe('Slopify');
    expect(defaultServerName('nas.lan', false)).toBe('Slopify on nas');
  });

  it('speakers fetch from PUBLIC_URL, else the LAN address, never a container-only address', () => {
    expect(speakerUrl({ publicUrl: 'http://x:1', port: 8080, bridged: true })).toBe('http://x:1');
    expect(speakerUrl({ publicUrl: '', port: 8080, bridged: false, lan: '192.168.1.20' })).toBe('http://192.168.1.20:8080');
    expect(speakerUrl({ publicUrl: '', port: 8080, bridged: true, lan: '172.18.0.2' })).toBe('');
    expect(speakerUrl({ publicUrl: '', port: 8080, bridged: false, lan: undefined })).toBe('');
  });

  it('a state folder it cannot write stops the start with the chown to run', () => {
    const d = tmp(); fs.chmodSync(d, 0o500);
    try {
      if (process.getuid?.() === 0) return; // root writes anyway
      expect(() => checkStateDirs([{ name: 'CONFIG_DIR', dir: d }])).toThrow(/CONFIG_DIR .* is not writable .* chown -R \d+/);
    } finally { fs.chmodSync(d, 0o700); }
    expect(() => checkStateDirs([{ name: 'CONFIG_DIR', dir: path.join(d, 'new') }])).not.toThrow();
  });

  it('warns about an empty or missing music folder and a read-only library, and stops writing to it', () => {
    const { out, log } = logger();
    const base = { saveToLibrary: false, speakers: false, mdns: false, publicUrl: '', port: 8080, bridged: false, lan: '192.168.1.2' };
    checkSurroundings({ ...base, musicDir: path.join(tmp(), 'nope') }, log);
    checkSurroundings({ ...base, musicDir: tmp() }, log);
    expect(out[0]).toMatch(/does not exist/);
    expect(out[1]).toMatch(/is empty/);
    const ro = tmp(); fs.writeFileSync(path.join(ro, 'a.flac'), ''); fs.chmodSync(ro, 0o500);
    try {
      if (process.getuid?.() === 0) return;
      const r = checkSurroundings({ ...base, musicDir: ro, saveToLibrary: true }, log);
      expect(r.saveToLibrary).toBe(false);
      expect(out.at(-1)).toMatch(/SAVE_TO_LIBRARY=1 but .* not writable/);
    } finally { fs.chmodSync(ro, 0o700); }
  });

  it('tells a bridged install why speakers are not found, and a host install where speakers fetch from', () => {
    const music = tmp(); fs.writeFileSync(path.join(music, 'a.flac'), '');
    const a = logger();
    expect(checkSurroundings({ musicDir: music, saveToLibrary: false, speakers: true, mdns: true, publicUrl: '', port: 8080, bridged: true }, a.log).speakerUrl).toBe('');
    expect(a.out.join('\n')).toMatch(/host networking/);
    const b = logger();
    expect(checkSurroundings({ musicDir: music, saveToLibrary: false, speakers: true, mdns: true, publicUrl: '', port: 8080, bridged: false, lan: '192.168.1.5' }, b.log).speakerUrl).toBe('http://192.168.1.5:8080');
    expect(b.out).toEqual(['info Speakers will fetch audio from http://192.168.1.5:8080 (set PUBLIC_URL if that address is wrong).']);
  });
});
