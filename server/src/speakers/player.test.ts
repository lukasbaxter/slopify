import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A BluOS speaker as the server sees it: whole-second clock, sound starting
// some buffer after the command, seeks landing on a whole second.
const fake = vi.hoisted(() => ({
  soundFrom: 0, basePos: 0, lagMs: 1200,
  now: () => Date.now(),
  truePos() { return Math.max(0, this.basePos + (this.now() - this.soundFrom) / 1000); },
}));
vi.mock('./transports.js', () => ({
  transportFor: () => ({
    async play() { fake.basePos = 0; fake.soundFrom = Date.now() + fake.lagMs; },
    async seek(sec: number) { fake.basePos = Math.round(sec); fake.soundFrom = Date.now() + 800; },
    async status() {
      const pos = Date.now() < fake.soundFrom ? fake.basePos : fake.truePos();
      return { playing: true, state: 'stream', position: Math.floor(pos), duration: 300, volume: 50, coarse: true };
    },
    resume: async () => {}, pause: async () => {}, stop: async () => {}, setVolume: async () => {}, close: () => {},
  }),
}));

import { ServerPlayer } from './player.js';
import { transportFor } from './transports.js';

const noopDb = { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } as any;
const row = { Id: 't1', Name: 'Song', Artists: ['A'], AlbumArtist: 'A', Album: 'B', AlbumId: 'b', RunTimeTicks: 300 * 10000000, ArtistItems: [], AlbumArtists: [], UserData: { IsFavorite: false }, _queued: false };
const row2 = { ...row, Id: 't2', Name: 'Song 2' };

function player() {
  const p = new ServerPlayer('u', { db: noopDb, discovery: {} as any, publicUrl: 'http://x', token: 't', report: () => {}, reportQueue: () => {}, claim: () => {}, log: () => {} });
  const any = p as any;
  any.device = { id: 'bluos:1', kind: 'bluos', name: 'NODE' };
  any.transport = transportFor(any.device);
  p.queue = [row as any]; p.index = 0;
  return any;
}
// A bare player with its deps pluggable (report sink, discovery), no transport yet.
function custom(opts: { report?: (np: any) => void; discovery?: any; uid?: string } = {}) {
  const p = new ServerPlayer(opts.uid || 'u', { db: noopDb, discovery: opts.discovery || ({} as any), publicUrl: 'http://x', token: 't', report: opts.report || (() => {}), reportQueue: () => {}, claim: () => {}, log: () => {} });
  return p as any;
}

describe('ServerPlayer clock on a whole-second speaker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('follows the sound, not the play command, after a start', async () => {
    const p = player();
    await p.start(row, 0, true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(Math.abs(p.position - fake.truePos())).toBeLessThan(0.2);
    p.stopAll();
  });

  it('lands on where a seek really went', async () => {
    const p = player();
    await p.start(row, 0, true);
    await vi.advanceTimersByTimeAsync(3000);
    await p.seek(58.48);
    await vi.advanceTimersByTimeAsync(4000);
    expect(Math.abs(p.position - fake.truePos())).toBeLessThan(0.2);
    p.stopAll();
  });
});

// A Cast speaker as tick() sees it: a canned status, with the calls recorded.
const castFake = (status: any, calls: string[] = []) => ({
  async play() { calls.push('play'); }, async seek() {}, resume: async () => {}, pause: async () => {},
  async stop() { calls.push('stop'); }, setVolume: async () => {}, close: () => { calls.push('close'); },
  async status() { return { playing: false, state: 'IDLE', position: 0, duration: 300, volume: null, ...status }; },
});

describe('Cast ended guard', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not trust 'ended' far from the end: releases the session instead of advancing", async () => {
    const reports: any[] = [];
    const p = custom({ report: (np) => reports.push(np) });
    p.device = { id: 'cast:x', kind: 'cast', name: 'TV' };
    p.queue = [row, row2]; p.index = 0; p.duration = 300;
    p.playing = true; p.anchor = { pos: 20, at: Date.now() };
    const calls: string[] = [];
    p.transport = castFake({ ended: true }, calls);
    await p.tick();
    expect(p.index).toBe(0);                          // no auto-advance
    expect(p.transport).toBe(null);                   // yielded, not relaunched
    expect(calls).toContain('stop');
    expect(reports[reports.length - 1]).toBe(null);   // session released
  });

  it("trusts 'ended' near the end and moves on", async () => {
    const p = custom();
    p.device = { id: 'cast:x', kind: 'cast', name: 'TV' };
    p.queue = [row, row2]; p.index = 0; p.duration = 300;
    p.playing = true; p.anchor = { pos: 298, at: Date.now() };
    const calls: string[] = [];
    p.transport = castFake({ ended: true }, calls);
    await p.tick();
    expect(p.index).toBe(1);
    expect(calls).toContain('play');
    await p.stopAll();
  });

  it('a transport that lost its connection reads as gone, never as ended', async () => {
    const reports: any[] = [];
    const p = custom({ report: (np) => reports.push(np) });
    p.device = { id: 'cast:x', kind: 'cast', name: 'TV' };
    p.queue = [row, row2]; p.index = 0; p.duration = 300;
    p.playing = true; p.anchor = { pos: 299, at: Date.now() }; // even at the end
    p.transport = castFake({ gone: true });
    await p.tick();
    expect(p.index).toBe(0);
    expect(p.transport).toBe(null);
    expect(reports[reports.length - 1]).toBe(null);
  });
});

describe('speaker arbitration and command order', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('the latest claim of a speaker wins: the previous owner yields first', async () => {
    const dev = { id: 'bluos:9', kind: 'bluos', name: 'NODE', model: 'BluOS', host: 'h', port: 11000 };
    const discovery = { get: (id: string) => (id === dev.id ? dev : null) };
    const repA: any[] = [];
    const pA = custom({ report: (np) => repA.push(np), discovery, uid: 'ua' });
    const pB = custom({ discovery, uid: 'ub' });
    pA.queue = [row]; pB.queue = [row];
    await pA.execute({ action: 'transfer', deviceId: dev.id, trackIds: ['t1'] });
    expect(pA.transport).toBeTruthy();
    await pB.execute({ action: 'transfer', deviceId: dev.id, trackIds: ['t1'] });
    expect(pA.transport).toBe(null);                  // stopped and yielded
    expect(repA[repA.length - 1]).toBe(null);         // its session released
    expect(pB.transport).toBeTruthy();                // new owner drives it
    await pA.stopAll(); await pB.stopAll();
  });

  it('commands run one at a time, in order', async () => {
    const order: string[] = [];
    const p = custom();
    p.device = { id: 'bluos:1', kind: 'bluos', name: 'NODE' };
    p.queue = [row]; p.index = 0; p.playing = true;
    p.transport = {
      async seek() { order.push('seek:in'); await new Promise((r) => setTimeout(r, 50)); order.push('seek:out'); },
      async pause() { order.push('pause'); },
      resume: async () => {}, play: async () => {}, stop: async () => {}, setVolume: async () => {}, close: () => {},
      async status() { return { playing: true, state: 'stream', position: 0, duration: 300, volume: 50 }; },
    };
    const a = p.execute({ action: 'seek', pos: 10 });
    const b = p.execute({ action: 'toggle' });
    await vi.advanceTimersByTimeAsync(100);
    await a; await b;
    expect(order).toEqual(['seek:in', 'seek:out', 'pause']);
  });
});
