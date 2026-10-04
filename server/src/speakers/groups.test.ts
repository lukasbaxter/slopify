import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../library.js', () => ({
  tracksByIds: (_db: unknown, ids: string[]) => ids.map((id) => ({ id, title: `Song ${id}`, artists: ['A'], artistIds: ['a'], albumArtist: 'A', album: 'B', albumId: 'b', durationMs: 200000, codec: 'flac' })),
  mixFor: () => [],
}));

import { speakerGroups } from './groups.js';
import { ServerPlayer, linkedGroups } from './player.js';
import type { Speaker } from './discovery.js';

// A tiny in-memory kv for the group store.
const kvDb = () => { const kv = new Map<string, string>(); return { prepare: (sql: string) => ({
  get: (k: string) => (kv.has(k) ? { v: kv.get(k) } : undefined),
  run: (...a: any[]) => { if (/INSERT INTO kv/.test(sql)) kv.set(a[0], a[1]); },
  all: () => [],
}) } as any; };

describe('the group store', () => {
  it('joins, keeps one group per speaker, and drops groups of one', () => {
    const g = speakerGroups(kvDb());
    g.join('a', ['b']); g.join('c', ['d']);
    expect(g.list()).toEqual([['a', 'b'], ['c', 'd']]);
    expect(g.groupOf('b')).toEqual(['b', 'a']);
    g.join('a', ['d']); // d leaves c's group, which is then just c
    expect(g.list()).toEqual([['a', 'b', 'd']]);
    g.unjoin('a'); g.unjoin('b');
    expect(g.list()).toEqual([]);
    expect(g.groupOf('d')).toEqual(['d']);
    g.join('a', ['b']); g.join('c', ['d']); g.clear();
    expect(g.list()).toEqual([]);
  });
});

// Four BluOS units, each its own little HTTP server, keeping BluOS sync state.
type Unit = { port: number; name: string; slaves: Set<number>; master: number | null; calls: string[]; state: string; native?: boolean };
const units: Unit[] = [];
const byPort = (p: number) => units.find((u) => u.port === p)!;
async function unit(name: string): Promise<Unit> {
  const u: Unit = { port: 0, name, slaves: new Set(), master: null, calls: [], state: 'stop' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x'); u.calls.push(url.pathname + url.search);
    const slave = Number(url.searchParams.get('port'));
    if (url.pathname === '/AddSlave') { u.slaves.add(slave); byPort(slave).master = u.port; }
    if (url.pathname === '/RemoveSlave') { u.slaves.delete(slave); if (byPort(slave).master === u.port) byPort(slave).master = null; }
    if (url.pathname === '/Play') { u.state = 'stream'; u.native = false; }
    if (url.pathname === '/Pause' || url.pathname === '/Stop') u.state = 'pause';
    if (url.pathname === '/SyncStatus') return res.end(`<SyncStatus>${u.master ? `<master port="${u.master}">127.0.0.1</master>` : ''}${[...u.slaves].map((p) => `<slave id="127.0.0.1" port="${p}"></slave>`).join('')}</SyncStatus>`);
    if (url.pathname === '/Status') return res.end(`<status><state>${u.state}</state><volume>30</volume><mute>0</mute><secs>1</secs><totlen>200</totlen><canSeek>1</canSeek></status>`);
    if (url.pathname === '/Volume') return res.end('<volume mute="0">30</volume>');
    res.end('<ok/>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  u.port = (srv.address() as AddressInfo).port;
  servers.push(srv); units.push(u);
  return u;
}
const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

describe('playing on speaker groups', () => {
  let towers: Unit, node: Unit, garage: Unit, pulse: Unit;
  const speakers = new Map<string, Speaker>();
  const sp = (u: Unit): Speaker => speakers.get(`bluos:${u.port}`)!;
  beforeAll(async () => {
    [towers, node, garage, pulse] = [await unit('Towers'), await unit('Node'), await unit('Garage'), await unit('Pulse')];
    for (const u of units) speakers.set(`bluos:${u.port}`, { id: `bluos:${u.port}`, kind: 'bluos', name: u.name, model: 'BluOS', host: '127.0.0.1', port: u.port });
  });
  const db = kvDb();
  const groups = speakerGroups(db);
  const reports: Record<string, any> = {};
  const player = (uid: string) => new ServerPlayer(uid, {
    db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } as any,
    discovery: { get: (id: string) => speakers.get(id) ?? null } as any,
    publicUrl: 'http://music', token: 't', log: () => {}, claim: () => {}, reportQueue: () => {},
    report: (np) => { reports[uid] = np; }, groupOf: (id) => groups.groupOf(id),
  });

  it('two people play on two groups at once, each linked by BluOS sync', async () => {
    groups.join(sp(towers).id, [sp(node).id]);
    groups.join(sp(garage).id, [sp(pulse).id]);
    const lukas = player('lukas'), henry = player('henry');
    await lukas.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t1', 't2'], index: 0, position: 0, playing: true });
    await henry.execute({ action: 'transfer', deviceId: sp(garage).id, trackIds: ['t3'], index: 0, position: 0, playing: true });
    // Picking the Node played its whole group, led by the Node.
    expect([...node.slaves]).toEqual([towers.port]);
    expect(towers.master).toBe(node.port);
    expect([...garage.slaves]).toEqual([pulse.port]);
    expect(reports.lukas.device).toMatchObject({ id: sp(node).id, members: [sp(towers).id], name: 'Node + Towers' });
    expect(reports.henry.device).toMatchObject({ id: sp(garage).id, members: [sp(pulse).id] });
    expect(linkedGroups.get(sp(node).id)).toEqual([sp(towers).id]);
    await lukas.stopAll(); await henry.stopAll();
  });

  it("picking one speaker leaves a group member that is busy with other music alone", async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(pulse).id, [sp(node).id]);
    node.state = 'stream'; // Spotify, from someone's phone
    node.calls.length = 0;
    const lukas = player('lukas5');
    try {
      await lukas.execute({ action: 'transfer', deviceId: sp(pulse).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect(pulse.slaves.size).toBe(0);
      expect(node.master).toBeNull();
      expect(node.calls.filter((c) => /^\/(Play|Stop|Pause)/.test(c))).toEqual([]);
      expect(reports.lukas5.device.members).toEqual([]);
      // Added on purpose while the music plays, it joins.
      groups.join(sp(pulse).id, [sp(node).id]);
      await lukas.regroup(new Set([sp(node).id]));
      expect([...pulse.slaves]).toEqual([node.port]);
      // A speaker skipped for being busy is not taken when another joins.
      await lukas.execute({ action: 'transfer', deviceId: sp(pulse).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      groups.unjoin(sp(node).id); await lukas.regroup();
      groups.join(sp(pulse).id, [sp(node).id]);
      node.state = 'stream';
      await lukas.stopAll();
      await lukas.execute({ action: 'transfer', deviceId: sp(pulse).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect(pulse.slaves.size).toBe(0); // node busy: left out
      groups.join(sp(pulse).id, [sp(garage).id]);
      await lukas.regroup(new Set([sp(garage).id]));
      expect([...pulse.slaves]).toEqual([garage.port]); // garage joined, node still left alone
    } finally {
      await lukas.stopAll();
      node.state = 'stop';
      groups.unjoin(sp(node).id); groups.unjoin(sp(pulse).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

  it('volume reaches every speaker of the group', async () => {
    const lukas = player('lukas2');
    await lukas.execute({ action: 'transfer', deviceId: sp(towers).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
    towers.calls.length = 0; node.calls.length = 0;
    await lukas.execute({ action: 'setVolume', level: 25 });
    expect(towers.calls).toContain('/Volume?level=25');
    expect(node.calls).toContain('/Volume?level=25');
    await lukas.stopAll();
  });

  it("taking someone's speaker takes their group; leaving unlinks it", async () => {
    const lukas = player('lukas3'), henry = player('henry3');
    await lukas.execute({ action: 'transfer', deviceId: sp(towers).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
    expect([...towers.slaves]).toEqual([node.port]);
    await henry.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t3'], index: 0, position: 0, playing: true });
    expect(lukas.transport).toBeNull(); // Lukas let go
    expect([...towers.slaves]).toEqual([]);
    expect([...node.slaves]).toEqual([towers.port]);
    await henry.stopAll();
    expect([...node.slaves]).toEqual([]);
    expect(towers.master).toBeNull();
  });

  it('ungrouping while music plays takes the speaker out of the music', async () => {
    const lukas = player('lukas4');
    await lukas.execute({ action: 'transfer', deviceId: sp(garage).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
    expect([...garage.slaves]).toEqual([pulse.port]);
    groups.unjoin(sp(pulse).id);
    await lukas.regroup();
    expect([...garage.slaves]).toEqual([]);
    expect(lukas.members).toEqual([]);
    await lukas.stopAll();
  });
});
