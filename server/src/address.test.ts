import { describe, expect, it } from 'vitest';
import { serviceUrl } from './config.js';
// @ts-expect-error plain JS from the apps
import { addressTries } from '../../web/src/api/address.js';
// @ts-expect-error plain JS from the apps
import { addressTries as phoneTries } from '../../mobile/address.js';

describe('addresses people type', () => {
  it('settings: http:// is optional, a trailing slash goes', () => {
    expect(serviceUrl('')).toBe('');
    expect(serviceUrl('192.168.1.10:8686')).toBe('http://192.168.1.10:8686');
    expect(serviceUrl('lidarr:8686/')).toBe('http://lidarr:8686');
    expect(serviceUrl(' http://lidarr:8686/ ')).toBe('http://lidarr:8686');
    expect(serviceUrl('https://lidarr.example.com')).toBe('https://lidarr.example.com');
  });

  for (const [app, tries] of [['web', addressTries], ['phone', phoneTries]] as const) {
    it(`${app}: nothing typed in front tries both, best guess first`, () => {
      expect(tries('music.example.com')).toEqual(['https://music.example.com', 'http://music.example.com']);
      expect(tries('192.168.1.10:8080')).toEqual(['http://192.168.1.10:8080', 'https://192.168.1.10:8080']);
      expect(tries('nas:8080/')).toEqual(['http://nas:8080', 'https://nas:8080']);
    });
    it(`${app}: what was typed in front is kept, nonsense is nothing`, () => {
      expect(tries('http://music.example.com')).toEqual(['http://music.example.com']);
      expect(tries('HTTPS://Music.Example.com/')).toEqual(['https://music.example.com']);
      expect(tries('')).toEqual([]);
      expect(tries('not an address')).toEqual([]);
      expect(tries('ftp://x.com')).toEqual([]);
    });
  }
});
