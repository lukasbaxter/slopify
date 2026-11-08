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
