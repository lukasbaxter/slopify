import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The speaker's queue: autoplay (the brain's picks at the end of the queue),
// shuffle, and the poll's moves against the listener's commands. The brain
// answers what `brain.next` says, after `brain.delayMs`.
const brain = vi.hoisted(() => ({ next: [] as string[], delayMs: 0, asks: 0 }));
vi.mock('../brain.js', () => ({
  brainNext: async () => { brain.asks++; if (brain.delayMs) await new Promise((r) => setTimeout(r, brain.delayMs)); return brain.next.length ? [...brain.next] : null; },
}));

// What the next transportFor() hands out (a transfer builds its own).
const next = vi.hoisted(() => ({ transport: null as any }));
vi.mock('./transports.js', () => ({ transportFor: () => next.transport, BluOSTransport: class {} }));

import { ServerPlayer } from './player.js';

const noopDb = { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } as any;
const row = (id: string) => ({ Id: id, Name: id, Artists: ['A'], AlbumArtist: 'A', Album: 'B', AlbumId: 'b', RunTimeTicks: 300 * 10000000, ArtistItems: [], AlbumArtists: [], UserData: { IsFavorite: false }, _queued: false });

// A Cast speaker that plays whatever it is told; status is pluggable.
function speaker(calls: string[], status: () => Promise<any> = async () => ({ playing: true, state: 'PLAYING', position: 0, duration: 300, volume: 50 })) {
  return { async play(url: string) { calls.push(`play ${url.split('/api/stream/')[1]?.split('?')[0]}`); }, seek: async () => {}, resume: async () => {}, pause: async () => {}, stop: async () => { calls.push('stop'); }, setVolume: async () => {}, close: () => {}, status };
}
function player(calls: string[] = [], status?: () => Promise<any>) {
  const dev = { id: 'cast:x', kind: 'cast', name: 'TV', model: 'Cast', host: '192.168.1.50', port: 8009 };
  const p = new ServerPlayer('u', { db: noopDb, discovery: { get: (id: string) => (id === dev.id ? dev : null) } as any, publicUrl: 'http://x', token: () => 't', report: () => {}, reportQueue: () => {}, claim: () => {}, log: () => {} }) as any;
  p.rowsFor = (ids: string[]) => ids.map(row);
  p.device = dev; p.transport = speaker(calls, status);
  return p;
}
const ids = (q: any[]) => q.map((t) => t.Id);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); brain.next = []; brain.delayMs = 0; brain.asks = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('autoplay at the end of the queue', () => {
  it('adds each song once after a play from a list', async () => {
    const p = player();
    await p.execute({ action: 'play', trackIds: ['a', 'b'], index: 1 });
    brain.next = ['x1', 'x2'];
    await p.execute({ action: 'next' });
    expect(ids(p.queue)).toEqual(['a', 'b', 'x1', 'x2']);
    expect(p.current.Id).toBe('x1');
    await p.stopAll();
  });
  it('adds each song once after a transfer', async () => {
    const p = player();
    p.transport = null;
    const calls: string[] = [];
    next.transport = speaker(calls);
    await p.execute({ action: 'transfer', deviceId: 'cast:x', trackIds: ['a', 'b'], index: 1 });
    brain.next = ['x1', 'x2'];
    await p.execute({ action: 'next' });
    expect(ids(p.queue)).toEqual(['a', 'b', 'x1', 'x2']);
    await p.stopAll();
  });
});

describe('shuffle and queue edits', () => {
  it('turning shuffle off keeps songs added and leaves out songs removed while it was on', async () => {
    const p = player();
    await p.execute({ action: 'play', trackIds: ['a', 'b', 'c', 'd'], index: 0 });
    await p.execute({ action: 'setShuffle', mode: 'on' });
    expect(p.current.Id).toBe('a');
    await p.execute({ action: 'enqueue', trackIds: ['x'] });
    await p.execute({ action: 'queueRemove', index: p.queue.findIndex((t: any) => t.Id === 'c') });
    await p.execute({ action: 'setShuffle', mode: 'off' });
    expect(ids(p.queue)).toEqual(['a', 'x', 'b', 'd']);
    expect(p.current.Id).toBe('a');
    await p.stopAll();
  });
  it('a clear while shuffled stays cleared once shuffle is off', async () => {
    const p = player();
    await p.execute({ action: 'play', trackIds: ['a', 'b', 'c'], index: 0 });
    await p.execute({ action: 'setShuffle', mode: 'on' });
    await p.execute({ action: 'enqueue', trackIds: ['x', 'y'] });
    await p.execute({ action: 'queueClear' });
    await p.execute({ action: 'setShuffle', mode: 'off' });
    expect(ids(p.queue)).toEqual(['a', 'b', 'c']);
    await p.stopAll();
  });
  it('edits made with shuffle off survive shuffle on and off again', async () => {
    const p = player();
    await p.execute({ action: 'play', trackIds: ['a', 'b', 'c'], index: 0 });
    await p.execute({ action: 'enqueue', trackIds: ['x'] });
    await p.execute({ action: 'queueRemove', index: 2 }); // b
    await p.execute({ action: 'setShuffle', mode: 'on' });
    await p.execute({ action: 'setShuffle', mode: 'off' });
    expect(ids(p.queue)).toEqual(['a', 'x', 'c']);
    await p.stopAll();
  });
});

describe('two accounts and one speaker', () => {
  const bluos = (id: string) => ({ id: `bluos:${id}`, kind: 'bluos', name: id, model: 'BluOS', host: id, port: 11000 });
  const grouped = (uid: string, leader: any) => {
    const p = new ServerPlayer(uid, { db: noopDb, discovery: { get: () => null } as any, publicUrl: 'http://x', token: () => 't', report: () => {}, reportQueue: () => {}, claim: () => {}, log: () => {} }) as any;
    p.device = leader; p.transport = { ...speaker([]), removeSlave: async () => {} };
    p.queue = [row('a')]; p.index = 0;
    return p;
  };
  it('each taking a speaker of the other\'s group at the same moment does not lock both up', async () => {
    const LA = bluos('10.0.0.1'), MA = bluos('10.0.0.2'), LB = bluos('10.0.0.3'), MB = bluos('10.0.0.4');
    const A = grouped('ua', LA), B = grouped('ub', LB);
    await A.claimDevice(LA); await A.claimDevice(MA); A.members = [MA];
    await B.claimDevice(LB); await B.claimDevice(MB); B.members = [MB];
    // Each claims the other's member from inside its own command line, the
    // way a regroup that adds a speaker on purpose does.
    A.ops = A.ops.then(() => A.claimDevice(MB));
    B.ops = B.ops.then(() => B.claimDevice(MA));
    let both = false;
    void Promise.all([A.ops, B.ops]).then(() => { both = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(both).toBe(true);
    expect(A.members).toEqual([]); expect(B.members).toEqual([]);
    // And the next command still runs.
    let later = false;
    void A.execute({ action: 'setRepeat', mode: 'all' }).then(() => { later = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(later).toBe(true);
    await A.stopAll(); await B.stopAll();
  });
  it('the speaker the music started on hands the music on, and the new owner does not wait behind the old one\'s commands', async () => {
    const L = bluos('10.0.1.1'), M = bluos('10.0.1.2');
    const calls: string[] = [];
    const A = grouped('uc', L);
    A.transport = { ...speaker(calls), removeSlave: async () => {} };
    A.d.discovery = { get: (id: string) => (id === M.id ? M : null) };
    await A.claimDevice(L); await A.claimDevice(M); A.members = [M];
    // A's command line is busy (a slow command still running).
    let release: () => void = () => {};
    A.ops = A.ops.then(() => new Promise<void>((r) => { release = r; }));
    const B = grouped('ud', bluos('10.0.1.9'));
    let got = false;
    void B.claimDevice(L).then(() => { got = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(got).toBe(true);                     // B has L now, without waiting on A
    expect(calls).toContain('stop');            // A stopped L before B got it
    expect(A.device).toBe(null);
    next.transport = { ...speaker(calls), removeSlave: async () => {} };
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(A.device?.id).toBe(M.id);            // A plays on, on the rest of its group
    expect(plays(calls)).toEqual(['play a']);
    await A.stopAll(); await B.stopAll();
  });
});
const plays = (calls: string[]) => calls.filter((c) => c.startsWith('play'));

describe('the poll moves on one command at a time', () => {
  const ended = { playing: false, state: 'IDLE', position: 0, duration: 300, volume: 50, ended: true };
  const playingAt = (position: number) => ({ playing: true, state: 'PLAYING', position, duration: 300, volume: 50 });
  const atTheEnd = (p: any, list: string[]) => {
    p.queue = list.map(row); p.original = [...p.queue]; p.index = 0;
    p.duration = 300; p.playing = true; p.anchor = { pos: 299, at: Date.now() }; p.reached = 299;
  };

  it('a next pressed while a reading of the old track is on its way is not undone by that reading', async () => {
    let answer: (s: any) => void = () => {};
    const calls: string[] = [];
    let n = 0;
    const p = player(calls, () => (n++ === 0 ? new Promise((r) => { answer = r; }) : Promise.resolve(playingAt(0))));
    atTheEnd(p, ['a', 'b', 'c']);
    const tick = p.tick();                       // asks the speaker...
    const cmd = p.execute({ action: 'next' });   // ...the listener presses next meanwhile
    await vi.advanceTimersByTimeAsync(0);
    answer(ended);                               // the old track's end arrives after the press
    await tick; await cmd;
    expect(p.current.Id).toBe('b');
    expect(p.transport).not.toBe(null);          // not released as an outside stop
    expect(plays(calls)).toEqual(['play b']);    // one move, not two
    await p.stopAll();
  });

  it('a next pressed while the end of the queue is waiting on the brain is that same move', async () => {
    const calls: string[] = [];
    let n = 0;
    const p = player(calls, async () => (n++ === 0 ? ended : playingAt(1)));
    atTheEnd(p, ['a']);
    brain.next = ['x1', 'x2']; brain.delayMs = 1500;
    const tick = p.tick();
    await vi.advanceTimersByTimeAsync(500);      // the brain is still thinking
    const cmd = p.execute({ action: 'next' });
    await vi.advanceTimersByTimeAsync(3000);
    await tick; await cmd;
    expect(brain.asks).toBe(1);
    expect(ids(p.queue)).toEqual(['a', 'x1', 'x2']);
    expect(p.current.Id).toBe('x1');
    expect(plays(calls)).toEqual(['play x1']);
    await p.stopAll();
  });

  it('a command waits for the move the poll already started', async () => {
    const calls: string[] = [];
    let n = 0;
    const p = player(calls, async () => (n++ === 0 ? ended : playingAt(1)));
    atTheEnd(p, ['a', 'b', 'c']);
    p.transport.play = async (url: string) => { calls.push(`play ${url.split('/api/stream/')[1]?.split('?')[0]}`); await new Promise((r) => setTimeout(r, 1000)); };
    const tick = p.tick();
    await vi.advanceTimersByTimeAsync(100);      // b is loading on the speaker
    const cmd = p.execute({ action: 'seek', pos: 42 });
    await vi.advanceTimersByTimeAsync(2000);
    await tick; await cmd;
    expect(p.current.Id).toBe('b');
    expect(p.anchor.pos).toBe(42);               // the seek landed on b, after its start, not under it
    await p.stopAll();
  });
});

describe('plays logged from a speaker', () => {
  it('repeat-one on a short song: every lap is a play, even under a minute apart', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE plays (user_id TEXT, track_id TEXT, at INTEGER, client TEXT, PRIMARY KEY (user_id, at, track_id))');
    const p = player();
    p.d.db = db;
    await p.execute({ action: 'play', trackIds: ['a'], index: 0 });
    p.repeat = 'one';
    await vi.advanceTimersByTimeAsync(9000);
    expect(db.prepare('SELECT count(*) n FROM plays').get()).toEqual({ n: 1 });
    // the 20 s song ends and comes round again
    await vi.advanceTimersByTimeAsync(11000);
    await p.next(true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(db.prepare('SELECT count(*) n FROM plays').get()).toEqual({ n: 2 });
    await p.stopAll();
  });
  it('a song handed over mid-way that was just logged elsewhere is not logged twice', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE plays (user_id TEXT, track_id TEXT, at INTEGER, client TEXT, PRIMARY KEY (user_id, at, track_id))');
    db.prepare('INSERT INTO plays VALUES (?, ?, ?, ?)').run('u', 'a', Date.now() - 20000, 'phone');
    const p = player();
    p.d.db = db;
    await p.execute({ action: 'play', trackIds: ['a'], index: 0, startAt: 30 });
    await vi.advanceTimersByTimeAsync(9000);
    expect(db.prepare('SELECT count(*) n FROM plays').get()).toEqual({ n: 1 });
    await p.stopAll();
  });
});

describe('a burst of skips', () => {
  // 11-11: eight back presses in seven seconds on the bathroom speakers, each one loaded in turn
  // (7 s each), kept the speaker playing through them for a minute after the presses stopped.
  const slow = (p: any, calls: string[]) => { p.transport.play = async (url: string) => { calls.push(`play ${url.split('/api/stream/')[1]?.split('?')[0]}`); await new Promise((r) => setTimeout(r, 1000)); }; };
  it('loads only the song it lands on, not every song pressed through', async () => {
    const calls: string[] = [];
    const p = player(calls);
    await p.execute({ action: 'play', trackIds: ['a', 'b', 'c', 'd', 'e', 'f'], index: 5 });
    calls.length = 0; slow(p, calls);
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) { all.push(p.execute({ action: 'previous' })); await vi.advanceTimersByTimeAsync(300); } // a tap every 300 ms, 1 s loads
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(all);
    expect(p.current.Id).toBe('b');
    expect(calls).toEqual(['play e', 'play b']);
    await p.stopAll();
  });
  it('a burst that ends on a skip going nowhere still plays the song it shows', async () => {
    const calls: string[] = [];
    const p = player(calls);
    await p.execute({ action: 'play', trackIds: ['a', 'b', 'c'], index: 0 });
    calls.length = 0; slow(p, calls);
    const all: Promise<unknown>[] = [];
    for (const c of [{ action: 'next' }, { action: 'next' }, { action: 'skipTo', index: 99 }]) { all.push(p.execute(c)); await vi.advanceTimersByTimeAsync(300); }
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(all);
    expect(p.current.Id).toBe('c');
    expect(calls).toEqual(['play b', 'play c']);
    await p.stopAll();
  });
});
