import { describe, expect, it } from 'vitest';
import { Discovery } from './discovery.js';

// The minute sweep, with the network stubbed: `up` says which host:port
// answers right now. No /24 is swept, only what is already known.
function sweeper(up: Set<string>) {
  const lists: any[][] = [];
  const d = new Discovery((l) => lists.push(l)) as any;
  d.bonjour = {};
  d.subnets = () => [];
  d.open = async (host: string, port: number) => up.has(`${host}:${port}`);
  return { d, lists };
}
const cast = { id: 'cast:abc', kind: 'cast', name: 'Den TV', model: 'Chromecast', host: '192.168.1.40', port: 8009 };
const castGroup = { id: 'cast:grp', kind: 'cast', name: 'Upstairs', model: 'Google Cast Group', host: '192.168.1.40', port: 32187 };
const air = { id: 'airplay:aabb', kind: 'airplay', name: 'Kitchen', model: 'HomePod', host: '192.168.1.41', port: 7000 };

describe('speakers found by mDNS age out like the rest', () => {
  it('one that went away without a goodbye is gone after two sweeps without an answer', async () => {
    const up = new Set<string>();
    const { d, lists } = sweeper(up);
    for (const x of [cast, castGroup, air]) d.devices.set(x.id, { ...x });
    await d.sweep();
    expect([...d.devices.keys()].sort()).toEqual(['airplay:aabb', 'cast:abc', 'cast:grp']); // one miss: kept
    await d.sweep();
    expect([...d.devices.keys()]).toEqual([]);
    expect(lists.at(-1)).toEqual([]);
  });
  it('one slow to answer once is not dropped, and one that answers stays', async () => {
    const up = new Set(['192.168.1.40:32187']);
    const { d } = sweeper(up);
    for (const x of [cast, castGroup]) d.devices.set(x.id, { ...x });
    await d.sweep();                        // the TV misses one
    up.add('192.168.1.40:8009');
    await d.sweep();                        // and answers again
    up.delete('192.168.1.40:8009');
    await d.sweep();                        // one miss again: still listed
    expect([...d.devices.keys()].sort()).toEqual(['cast:abc', 'cast:grp']);
  });
});
