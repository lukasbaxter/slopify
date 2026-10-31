import { describe, it, expect } from 'vitest';
import { airplayConfig, cliArgs, supportsAirPlay2 } from './airplay.js';
import { Discovery, type Speaker } from './discovery.js';

const raop = { port: 7000, name: 'AABBCCDDEEFF@Living Room', txt: { et: '0,3,5', cn: '0,1,2,3', md: '0,1,2', am: 'AppleTV14,1', pk: 'abc', ft: '0x4A7FDFD5,0xBC177FDE' } };
const airplay = { port: 7000, host: 'Living-Room.local', txt: { features: '0x4A7FDFD5,0xBC177FDE', deviceid: 'AA:BB:CC:DD:EE:FF', model: 'AppleTV14,1' } };
const dev = (extra: Partial<Speaker> = {}): Speaker => ({ id: 'airplay:aabbccddeeff', kind: 'airplay', name: 'Living Room', model: 'AppleTV14,1', host: '192.0.2.9', port: 7000, raop, airplay, ...extra });

describe('AirPlay', () => {
  it('reads AirPlay 2 from the features bits', () => {
    expect(supportsAirPlay2({ features: '0x4A7FDFD5,0xBC177FDE' })).toBe(true);
    expect(supportsAirPlay2({ features: '0x5A7FFFF7,0x1E' })).toBe(false); // an AirPort Express era receiver
    expect(supportsAirPlay2(undefined)).toBe(false);
  });
  it('hands the binary the TXT it needs to pick the route, the target last', () => {
    airplayConfig.dacp = 'ABCDEF0123456789';
    const a = cliArgs(dev(), '/tmp/p', null);
    expect(a.slice(0, 2)).toEqual(['--protocol', 'auto']);
    expect(a).toContain('--txt');
    expect(a[a.indexOf('--txt') + 1]).toContain('features=0x4A7FDFD5,0xBC177FDE');
    expect(a[a.indexOf('--port') + 1]).toBe('7000');
    expect(a[a.indexOf('--udn') + 1]).toBe('AABBCCDDEEFF@Living Room');
    expect(a[a.indexOf('--dacp') + 1]).toBe('ABCDEF0123456789');
    expect(a.at(-1)).toBe('192.0.2.9');
    expect(a).not.toContain('--auth');
  });
  it('stored pairing credentials and a password ride along', () => {
    const creds = 'a'.repeat(192);
    const a = cliArgs(dev(), '/tmp/p', creds, 'secret');
    expect(a[a.indexOf('--auth') + 1]).toBe(creds);
    expect(a[a.indexOf('--password') + 1]).toBe('secret');
    expect(cliArgs(dev(), '/tmp/p', 'short')).not.toContain('--auth');
  });
  it('a RAOP-only speaker without md gets no metadata', () => {
    const a = cliArgs(dev({ airplay: null, raop: { ...raop, txt: { et: '0,1', cn: '0,1' } } }), '/tmp/p', null);
    expect(a[a.indexOf('--md') + 1]).toBe('');
    expect(a).not.toContain('--txt');
  });
});

describe('one entry per box', () => {
  const d = new Discovery(() => {});
  const add = (s: Partial<Speaker>) => d.devices.set(s.id!, { model: '', port: 1, ...s } as Speaker);
  it('a box that speaks several protocols is listed by the best one, by name and address', () => {
    add({ id: 'bluos:1', kind: 'bluos', name: 'NODE 2i', host: '192.0.2.2' });
    add({ id: 'airplay:1', kind: 'airplay', name: 'NODE 2i', host: '192.0.2.2' });
    add({ id: 'upnp:denon', kind: 'upnp', name: 'Denon AVR-X1700H', host: '192.0.2.3' });
    add({ id: 'airplay:denon', kind: 'airplay', name: 'Denon AVR-X1700H', host: '192.0.2.3' });
    add({ id: 'cast:tv', kind: 'cast', name: 'Living Room TV', host: '192.0.2.4' });
    add({ id: 'upnp:tv', kind: 'upnp', name: 'Living Room TV', host: '192.0.2.4' });
    // Two different players on one machine both stay.
    add({ id: 'upnp:kodi', kind: 'upnp', name: 'Kodi (Lounge)', host: '192.0.2.5' });
    add({ id: 'airplay:shairport', kind: 'airplay', name: 'Lounge Speakers', host: '192.0.2.5' });
    expect(d.list().map((x) => x.id).sort()).toEqual(['airplay:shairport', 'bluos:1', 'cast:tv', 'upnp:denon', 'upnp:kodi']);
  });
});
