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
type Unit = { port: number; name: string; slaves: Set<number>; master: number | null; calls: string[]; state: string; native?: boolean; foreign?: boolean; vol: number };
const units: Unit[] = [];
const byPort = (p: number) => units.find((u) => u.port === p)!;
async function unit(name: string): Promise<Unit> {
  const u: Unit = { port: 0, name, slaves: new Set(), master: null, calls: [], state: 'stop', vol: 30 };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x'); u.calls.push(url.pathname + url.search);
    const slave = Number(url.searchParams.get('port'));
    if (url.pathname === '/AddSlave') { u.slaves.add(slave); byPort(slave).master = u.port; }
    if (url.pathname === '/RemoveSlave') { u.slaves.delete(slave); if (byPort(slave).master === u.port) byPort(slave).master = null; }
    if (url.pathname === '/Play') { u.state = 'stream'; u.native = false; }
    if (url.pathname === '/Pause' || url.pathname === '/Stop') u.state = 'pause';
    if (url.pathname === '/SyncStatus') return res.end(`<SyncStatus>${u.master ? `<master port="${u.master}">127.0.0.1</master>` : ''}${[...u.slaves].map((p) => `<slave id="127.0.0.1" port="${p}"></slave>`).join('')}</SyncStatus>`);
    if (url.pathname === '/Status') return res.end(`<status><state>${u.state}</state><volume>30</volume><mute>0</mute><secs>1</secs><totlen>200</totlen><canSeek>1</canSeek>${u.foreign ? '<service>Spotify</service><serviceName>Spotify</serviceName><streamUrl>Spotify:spotify_pcm01:pcm/44100/16/2/7</streamUrl>' : ''}</status>`);
    if (url.pathname === '/Volume') { const l = url.searchParams.get('level'); if (l != null) u.vol = Number(l); return res.end(`<volume mute="0">${u.vol}</volume>`); }
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

  it('a regroup or a re-pick of the same speaker keeps the members linked', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(node).id, [sp(towers).id]);
    const p = player('lukas-regroup');
    try {
      await p.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect(towers.master).toBe(node.port);
      // Someone edits an unrelated group: every player regroups.
      groups.join(sp(garage).id, [sp(pulse).id]);
      await p.regroup();
      expect(towers.master).toBe(node.port);
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(towers).id]);
      // Picking the speaker that is already playing.
      await p.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t2'], index: 0, position: 0, playing: true });
      expect(towers.master).toBe(node.port);
      expect([...node.slaves]).toEqual([towers.port]);
    } finally { await p.stopAll(); for (const id of [sp(node).id, sp(towers).id, sp(garage).id, sp(pulse).id]) groups.unjoin(id); for (const g of saved) groups.join(g[0], g.slice(1)); }
  });

  it('a server shutdown never stops a speaker another app took over', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(node).id, [sp(towers).id]);
    const lukas = player('lukas-shutdown');
    try {
      await lukas.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      node.foreign = true; node.state = 'stream'; // Spotify, before Slopify noticed
      node.calls.length = 0; towers.calls.length = 0;
      await lukas.shutdown();
      expect(node.calls.filter((c) => /^\/(Play|Stop|Pause|RemoveSlave)/.test(c))).toEqual([]);
      expect(towers.calls.filter((c) => /^\/(Play|Stop|Pause)/.test(c))).toEqual([]);
      expect(towers.master).toBe(node.port);
      // Our own stream is still stopped at shutdown.
      node.foreign = false;
      await lukas.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      node.calls.length = 0;
      await lukas.shutdown();
      expect(node.calls.some((c) => c.startsWith('/Stop') || c.startsWith('/Pause'))).toBe(true);
    } finally {
      node.foreign = false; node.state = 'stop';
      await lukas.stopAll();
      groups.unjoin(sp(node).id); groups.unjoin(sp(towers).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

  it('lets go of a speaker another app takes over, without stopping it or its group', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(node).id, [sp(towers).id]);
    const lukas = player('lukas-lose');
    try {
      await lukas.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t1', 't2'], index: 0, position: 0, playing: true });
      expect([...node.slaves]).toEqual([towers.port]);
      node.calls.length = 0; towers.calls.length = 0;
      // Henry casts Spotify to the Node (and with it the group).
      node.foreign = true; node.state = 'stream';
      await new Promise((r) => setTimeout(r, 1500));
      expect(reports['lukas-lose']).toBeNull(); // the session lets go, paused where it was
      expect(node.calls.filter((c) => /^\/(Play|Stop|Pause|RemoveSlave)/.test(c))).toEqual([]);
      expect(towers.calls.filter((c) => /^\/(Play|Stop|Pause)/.test(c))).toEqual([]);
      expect(towers.master).toBe(node.port); // the group keeps playing Spotify
    } finally {
      node.foreign = false; node.state = 'stop';
      await lukas.stopAll();
      groups.unjoin(sp(node).id); groups.unjoin(sp(towers).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
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
    // Equal levels (30 each): both land on 25; the leader does not pass it on.
    expect(towers.calls).toContain('/Volume?level=25&tell_slaves=0');
    expect(node.calls).toContain('/Volume?level=25&tell_slaves=0');
    await lukas.stopAll();
  });

  it("taking a member of someone's group takes only that speaker", async () => {
    const lukas = player('lukas3'), henry = player('henry3');
    await lukas.execute({ action: 'transfer', deviceId: sp(towers).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
    expect([...towers.slaves]).toEqual([node.port]);
    await henry.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t3'], index: 0, position: 0, playing: true });
    // Lukas plays on, on the Towers alone; Henry has the Node, without the busy Towers.
    expect(lukas.transport).not.toBeNull();
    expect(lukas.device?.id).toBe(sp(towers).id);
    expect(lukas.members).toEqual([]);
    expect(towers.slaves.size).toBe(0);
    expect(henry.device?.id).toBe(sp(node).id);
    expect(henry.members).toEqual([]);
    await henry.stopAll(); await lukas.stopAll();
    expect(node.master).toBeNull();
  });

  it("taking the speaker someone's music started on moves their music to the rest of their group", async () => {
    const lukas = player('lukas6'), henry = player('henry6');
    await lukas.execute({ action: 'transfer', deviceId: sp(towers).id, trackIds: ['t1', 't2'], index: 1, position: 0, playing: true });
    expect([...towers.slaves]).toEqual([node.port]);
    await henry.execute({ action: 'transfer', deviceId: sp(towers).id, trackIds: ['t3'], index: 0, position: 0, playing: true });
    await lukas.execute({ action: 'noop' }); // let the hand-off finish
    expect(lukas.device?.id).toBe(sp(node).id);
    expect(lukas.current?.Id).toBe('t2');
    expect(lukas.playing).toBe(true);
    expect(node.master).toBeNull();
    expect(henry.device?.id).toBe(sp(towers).id);
    expect(henry.members).toEqual([]); // the Node is Lukas's now: left out
    expect(towers.slaves.size).toBe(0);
    await henry.stopAll(); await lukas.stopAll();
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
  it('the group slider keeps the balance: a speaker muted at 0 stays muted, a drag down and back up comes back', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(pulse).id, [sp(towers).id, sp(node).id]);
    const p = player('lukas-vol');
    try {
      await p.execute({ action: 'transfer', deviceId: sp(pulse).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      // The household's balance: Pulse 13, Towers muted, Node 25. The group reads as its loudest.
      pulse.vol = 13; towers.vol = 0; node.vol = 25;
      (p as any).volumeHeldUntil = 0; (p as any).groupReadAt = 0; await (p as any).tick();
      expect(reports['lukas-vol'].volume).toBe(25);
      // One drag: down to 5, then back up to 25.
      await p.execute({ action: 'setVolume', level: 5 });
      expect([pulse.vol, towers.vol, node.vol]).toEqual([3, 0, 5]);
      await p.execute({ action: 'setVolume', level: 25 });
      expect([pulse.vol, towers.vol, node.vol]).toEqual([13, 0, 25]);
      // Up past it scales too, and the leader never passes its change on.
      await p.execute({ action: 'setVolume', level: 50 });
      expect([pulse.vol, towers.vol, node.vol]).toEqual([26, 0, 50]);
      expect(pulse.calls.filter((c) => c.startsWith('/Volume?level')).every((c) => c.includes('tell_slaves=0'))).toBe(true);
      expect(reports['lukas-vol'].volume).toBe(50);
    } finally { await p.stopAll(); for (const id of [sp(pulse).id, sp(towers).id, sp(node).id]) groups.unjoin(id); for (const g of saved) groups.join(g[0], g.slice(1)); }
  });

  // 2026-10-08: the Pulse dropped off the network while it was in the Node's
  // group. Every command then waited ~3 s on it (two play taps ran late, back
  // to back, and cancelled out), and the Node, resumed with a missing member,
  // played 5 s and stopped.
  it('a member that stops answering leaves the group; the rest plays on and never waits on it', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    const kitchen = await unit('Kitchen');
    speakers.set(`bluos:${kitchen.port}`, { id: `bluos:${kitchen.port}`, kind: 'bluos', name: 'Kitchen', model: 'BluOS', host: '127.0.0.1', port: kitchen.port });
    groups.join(sp(node).id, [sp(towers).id, sp(kitchen).id]);
    const p = player('lukas-dead');
    try {
      await p.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect([...node.slaves].sort()).toEqual([towers.port, kitchen.port].sort());
      // The Kitchen goes away (unplugged, off the WiFi).
      const gone = servers[servers.length - 1];
      const closed = new Promise<void>((r) => gone.close(() => r()));
      gone.closeAllConnections();
      await closed;
      (p as any).groupReadAt = 0; await (p as any).tick();
      (p as any).groupReadAt = 0; await (p as any).tick();
      await p.execute({ action: 'noop' });
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(towers).id]);
      await vi.waitFor(() => expect(node.calls).toContain(`/RemoveSlave?slave=127.0.0.1&port=${kitchen.port}`));
      expect(reports['lukas-dead'].device).toMatchObject({ name: 'Node + Towers', members: [sp(towers).id] });
      expect(linkedGroups.get(sp(node).id)).toEqual([sp(towers).id]);
      // Volume and play/pause only talk to the speakers that are there.
      node.calls.length = 0;
      await p.execute({ action: 'setVolume', level: 20 });
      await p.execute({ action: 'setPlaying', playing: false });
      expect(node.calls.some((c) => c.startsWith('/Pause'))).toBe(true);
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(towers).id]);
      // It stays in the household's group, and a regroup does not try it again right away.
      expect(groups.groupOf(sp(node).id)).toContain(sp(kitchen).id);
      await p.regroup();
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(towers).id]);
    } finally {
      await p.stopAll();
      for (const id of [sp(node).id, sp(towers).id, sp(kitchen).id]) groups.unjoin(id);
      speakers.delete(`bluos:${kitchen.port}`); units.splice(units.indexOf(kitchen), 1); servers.pop();
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

  it('a busy-member check or a regroup never leaves a member that is still there', async () => {
    // A regroup while a member is missing from discovery (a sweep that missed
    // it) keeps it linked: only a member that stops answering is dropped.
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(node).id, [sp(towers).id]);
    const p = player('lukas-flap');
    const towersSp = sp(towers);
    try {
      await p.execute({ action: 'transfer', deviceId: sp(node).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      speakers.delete(towersSp.id);
      await p.regroup();
      expect(p.members.map((m: Speaker) => m.id)).toEqual([towersSp.id]);
      expect(towers.master).toBe(node.port);
    } finally {
      speakers.set(towersSp.id, towersSp);
      await p.stopAll(); groups.unjoin(sp(node).id); groups.unjoin(sp(towers).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

});
