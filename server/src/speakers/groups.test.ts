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
  let hall: Unit, study: Unit, patio: Unit, porch: Unit;
  const speakers = new Map<string, Speaker>();
  const sp = (u: Unit): Speaker => speakers.get(`bluos:${u.port}`)!;
  beforeAll(async () => {
    [hall, study, patio, porch] = [await unit('Hall'), await unit('Study'), await unit('Patio'), await unit('Porch')];
    for (const u of units) speakers.set(`bluos:${u.port}`, { id: `bluos:${u.port}`, kind: 'bluos', name: u.name, model: 'BluOS', host: '127.0.0.1', port: u.port });
  });
  const db = kvDb();
  const groups = speakerGroups(db);
  const reports: Record<string, any> = {};
  const player = (uid: string) => new ServerPlayer(uid, {
    db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } as any,
    discovery: { get: (id: string) => speakers.get(id) ?? null } as any,
    publicUrl: 'http://music', token: () => 't', log: () => {}, claim: () => {}, reportQueue: () => {},
    report: (np) => { reports[uid] = np; }, groupOf: (id) => groups.groupOf(id),
  });

  it('two people play on two groups at once, each linked by BluOS sync', async () => {
    groups.join(sp(hall).id, [sp(study).id]);
    groups.join(sp(patio).id, [sp(porch).id]);
    const alice = player('alice'), bob = player('bob');
    await alice.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t1', 't2'], index: 0, position: 0, playing: true });
    await bob.execute({ action: 'transfer', deviceId: sp(patio).id, trackIds: ['t3'], index: 0, position: 0, playing: true });
    // Picking the Study played its whole group, led by the Study.
    expect([...study.slaves]).toEqual([hall.port]);
    expect(hall.master).toBe(study.port);
    expect([...patio.slaves]).toEqual([porch.port]);
    expect(reports.alice.device).toMatchObject({ id: sp(study).id, members: [sp(hall).id], name: 'Study + Hall' });
    expect(reports.bob.device).toMatchObject({ id: sp(patio).id, members: [sp(porch).id] });
    expect(linkedGroups.get(sp(study).id)).toEqual([sp(hall).id]);
    await alice.stopAll(); await bob.stopAll();
  });

  it('a regroup or a re-pick of the same speaker keeps the members linked', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(study).id, [sp(hall).id]);
    const p = player('alice-regroup');
    try {
      await p.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect(hall.master).toBe(study.port);
      // Someone edits an unrelated group: every player regroups.
      groups.join(sp(patio).id, [sp(porch).id]);
      await p.regroup();
      expect(hall.master).toBe(study.port);
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(hall).id]);
      // Picking the speaker that is already playing.
      await p.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t2'], index: 0, position: 0, playing: true });
      expect(hall.master).toBe(study.port);
      expect([...study.slaves]).toEqual([hall.port]);
    } finally { await p.stopAll(); for (const id of [sp(study).id, sp(hall).id, sp(patio).id, sp(porch).id]) groups.unjoin(id); for (const g of saved) groups.join(g[0], g.slice(1)); }
  });

  it('a server shutdown never stops a speaker another app took over', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(study).id, [sp(hall).id]);
    const alice = player('alice-shutdown');
    try {
      await alice.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      study.foreign = true; study.state = 'stream'; // Spotify, before Slopify noticed
      study.calls.length = 0; hall.calls.length = 0;
      await alice.shutdown();
      expect(study.calls.filter((c) => /^\/(Play|Stop|Pause|RemoveSlave)/.test(c))).toEqual([]);
      expect(hall.calls.filter((c) => /^\/(Play|Stop|Pause)/.test(c))).toEqual([]);
      expect(hall.master).toBe(study.port);
      // Our own stream is still stopped at shutdown.
      study.foreign = false;
      await alice.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      study.calls.length = 0;
      await alice.shutdown();
      expect(study.calls.some((c) => c.startsWith('/Stop') || c.startsWith('/Pause'))).toBe(true);
    } finally {
      study.foreign = false; study.state = 'stop';
      await alice.stopAll();
      groups.unjoin(sp(study).id); groups.unjoin(sp(hall).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

  it('lets go of a speaker another app takes over, without stopping it or its group', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(study).id, [sp(hall).id]);
    const alice = player('alice-lose');
    try {
      await alice.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t1', 't2'], index: 0, position: 0, playing: true });
      expect([...study.slaves]).toEqual([hall.port]);
      study.calls.length = 0; hall.calls.length = 0;
      // Bob casts Spotify to the Study (and with it the group).
      study.foreign = true; study.state = 'stream';
      await new Promise((r) => setTimeout(r, 1500));
      expect(reports['alice-lose']).toBeNull(); // the session lets go, paused where it was
      expect(study.calls.filter((c) => /^\/(Play|Stop|Pause|RemoveSlave)/.test(c))).toEqual([]);
      expect(hall.calls.filter((c) => /^\/(Play|Stop|Pause)/.test(c))).toEqual([]);
      expect(hall.master).toBe(study.port); // the group keeps playing Spotify
    } finally {
      study.foreign = false; study.state = 'stop';
      await alice.stopAll();
      groups.unjoin(sp(study).id); groups.unjoin(sp(hall).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

  it("picking one speaker leaves a group member that is busy with other music alone", async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(porch).id, [sp(study).id]);
    study.state = 'stream'; // Spotify, from someone's phone
    study.calls.length = 0;
    const alice = player('alice5');
    try {
      await alice.execute({ action: 'transfer', deviceId: sp(porch).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect(porch.slaves.size).toBe(0);
      expect(study.master).toBeNull();
      expect(study.calls.filter((c) => /^\/(Play|Stop|Pause)/.test(c))).toEqual([]);
      expect(reports.alice5.device.members).toEqual([]);
      // Added on purpose while the music plays, it joins.
      groups.join(sp(porch).id, [sp(study).id]);
      await alice.regroup(new Set([sp(study).id]));
      expect([...porch.slaves]).toEqual([study.port]);
      // A speaker skipped for being busy is not taken when another joins.
      await alice.execute({ action: 'transfer', deviceId: sp(porch).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      groups.unjoin(sp(study).id); await alice.regroup();
      groups.join(sp(porch).id, [sp(study).id]);
      study.state = 'stream';
      await alice.stopAll();
      await alice.execute({ action: 'transfer', deviceId: sp(porch).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect(porch.slaves.size).toBe(0); // study busy: left out
      groups.join(sp(porch).id, [sp(patio).id]);
      await alice.regroup(new Set([sp(patio).id]));
      expect([...porch.slaves]).toEqual([patio.port]); // patio joined, study still left alone
    } finally {
      await alice.stopAll();
      study.state = 'stop';
      groups.unjoin(sp(study).id); groups.unjoin(sp(porch).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

  it('volume reaches every speaker of the group', async () => {
    const alice = player('alice2');
    await alice.execute({ action: 'transfer', deviceId: sp(hall).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
    hall.calls.length = 0; study.calls.length = 0;
    await alice.execute({ action: 'setVolume', level: 25 });
    // Equal levels (30 each): both land on 25; the leader does not pass it on.
    expect(hall.calls).toContain('/Volume?level=25&tell_slaves=0');
    expect(study.calls).toContain('/Volume?level=25&tell_slaves=0');
    await alice.stopAll();
  });

  it("taking a member of someone's group takes only that speaker", async () => {
    const alice = player('alice3'), bob = player('bob3');
    await alice.execute({ action: 'transfer', deviceId: sp(hall).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
    expect([...hall.slaves]).toEqual([study.port]);
    await bob.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t3'], index: 0, position: 0, playing: true });
    // Alice plays on, on the Hall alone; Bob has the Study, without the busy Hall.
    expect(alice.transport).not.toBeNull();
    expect(alice.device?.id).toBe(sp(hall).id);
    expect(alice.members).toEqual([]);
    expect(hall.slaves.size).toBe(0);
    expect(bob.device?.id).toBe(sp(study).id);
    expect(bob.members).toEqual([]);
    await bob.stopAll(); await alice.stopAll();
    expect(study.master).toBeNull();
  });

  it("taking the speaker someone's music started on moves their music to the rest of their group", async () => {
    const alice = player('alice6'), bob = player('bob6');
    await alice.execute({ action: 'transfer', deviceId: sp(hall).id, trackIds: ['t1', 't2'], index: 1, position: 0, playing: true });
    expect([...hall.slaves]).toEqual([study.port]);
    await bob.execute({ action: 'transfer', deviceId: sp(hall).id, trackIds: ['t3'], index: 0, position: 0, playing: true });
    await alice.execute({ action: 'noop' }); // let the hand-off finish
    expect(alice.device?.id).toBe(sp(study).id);
    expect(alice.current?.Id).toBe('t2');
    expect(alice.playing).toBe(true);
    expect(study.master).toBeNull();
    expect(bob.device?.id).toBe(sp(hall).id);
    expect(bob.members).toEqual([]); // the Study is Alice's now: left out
    expect(hall.slaves.size).toBe(0);
    await bob.stopAll(); await alice.stopAll();
  });

  it('ungrouping while music plays takes the speaker out of the music', async () => {
    const alice = player('alice4');
    await alice.execute({ action: 'transfer', deviceId: sp(patio).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
    expect([...patio.slaves]).toEqual([porch.port]);
    groups.unjoin(sp(porch).id);
    await alice.regroup();
    expect([...patio.slaves]).toEqual([]);
    expect(alice.members).toEqual([]);
    await alice.stopAll();
  });
  it('the group slider keeps the balance: a speaker muted at 0 stays muted, a drag down and back up comes back', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(porch).id, [sp(hall).id, sp(study).id]);
    const p = player('alice-vol');
    try {
      await p.execute({ action: 'transfer', deviceId: sp(porch).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      // A mixed balance: Porch 13, Hall muted, Study 25. The group reads as its loudest.
      porch.vol = 13; hall.vol = 0; study.vol = 25;
      (p as any).volumeHeldUntil = 0; (p as any).groupReadAt = 0; await (p as any).tick();
      expect(reports['alice-vol'].volume).toBe(25);
      // One drag: down to 5, then back up to 25.
      await p.execute({ action: 'setVolume', level: 5 });
      expect([porch.vol, hall.vol, study.vol]).toEqual([3, 0, 5]);
      await p.execute({ action: 'setVolume', level: 25 });
      expect([porch.vol, hall.vol, study.vol]).toEqual([13, 0, 25]);
      // Up past it scales too, and the leader never passes its change on.
      await p.execute({ action: 'setVolume', level: 50 });
      expect([porch.vol, hall.vol, study.vol]).toEqual([26, 0, 50]);
      expect(porch.calls.filter((c) => c.startsWith('/Volume?level')).every((c) => c.includes('tell_slaves=0'))).toBe(true);
      expect(reports['alice-vol'].volume).toBe(50);
    } finally { await p.stopAll(); for (const id of [sp(porch).id, sp(hall).id, sp(study).id]) groups.unjoin(id); for (const g of saved) groups.join(g[0], g.slice(1)); }
  });

  // The Porch dropped off the network while it was in the Study's
  // group. Every command then waited ~3 s on it (two play taps ran late, back
  // to back, and cancelled out), and the Study, resumed with a missing member,
  // played 5 s and stopped.
  it('a member that stops answering leaves the group; the rest plays on and never waits on it', async () => {
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    const kitchen = await unit('Kitchen');
    speakers.set(`bluos:${kitchen.port}`, { id: `bluos:${kitchen.port}`, kind: 'bluos', name: 'Kitchen', model: 'BluOS', host: '127.0.0.1', port: kitchen.port });
    groups.join(sp(study).id, [sp(hall).id, sp(kitchen).id]);
    const p = player('alice-dead');
    try {
      await p.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      expect([...study.slaves].sort()).toEqual([hall.port, kitchen.port].sort());
      // The Kitchen goes away (unplugged, off the WiFi).
      const gone = servers[servers.length - 1];
      const closed = new Promise<void>((r) => gone.close(() => r()));
      gone.closeAllConnections();
      await closed;
      (p as any).groupReadAt = 0; await (p as any).tick();
      (p as any).groupReadAt = 0; await (p as any).tick();
      await p.execute({ action: 'noop' });
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(hall).id]);
      await vi.waitFor(() => expect(study.calls).toContain(`/RemoveSlave?slave=127.0.0.1&port=${kitchen.port}`));
      expect(reports['alice-dead'].device).toMatchObject({ name: 'Study + Hall', members: [sp(hall).id] });
      expect(linkedGroups.get(sp(study).id)).toEqual([sp(hall).id]);
      // Volume and play/pause only talk to the speakers that are there.
      study.calls.length = 0;
      await p.execute({ action: 'setVolume', level: 20 });
      await p.execute({ action: 'setPlaying', playing: false });
      expect(study.calls.some((c) => c.startsWith('/Pause'))).toBe(true);
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(hall).id]);
      // It stays in its group, and a regroup does not try it again right away.
      expect(groups.groupOf(sp(study).id)).toContain(sp(kitchen).id);
      await p.regroup();
      expect(p.members.map((m: Speaker) => m.id)).toEqual([sp(hall).id]);
    } finally {
      await p.stopAll();
      for (const id of [sp(study).id, sp(hall).id, sp(kitchen).id]) groups.unjoin(id);
      speakers.delete(`bluos:${kitchen.port}`); units.splice(units.indexOf(kitchen), 1); servers.pop();
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

  it('a busy-member check or a regroup never leaves a member that is still there', async () => {
    // A regroup while a member is missing from discovery (a sweep that missed
    // it) keeps it linked: only a member that stops answering is dropped.
    const saved = groups.list();
    for (const g of saved) for (const id of g) groups.unjoin(id);
    groups.join(sp(study).id, [sp(hall).id]);
    const p = player('alice-flap');
    const towersSp = sp(hall);
    try {
      await p.execute({ action: 'transfer', deviceId: sp(study).id, trackIds: ['t1'], index: 0, position: 0, playing: true });
      speakers.delete(towersSp.id);
      await p.regroup();
      expect(p.members.map((m: Speaker) => m.id)).toEqual([towersSp.id]);
      expect(hall.master).toBe(study.port);
    } finally {
      speakers.set(towersSp.id, towersSp);
      await p.stopAll(); groups.unjoin(sp(study).id); groups.unjoin(sp(hall).id);
      for (const g of saved) groups.join(g[0], g.slice(1));
    }
  });

});
