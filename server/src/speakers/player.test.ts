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

function player() {
  const p = new ServerPlayer('u', { db: noopDb, discovery: {} as any, publicUrl: 'http://x', token: 't', report: () => {}, reportQueue: () => {}, claim: () => {}, log: () => {} });
  const any = p as any;
  any.device = { id: 'bluos:1', kind: 'bluos', name: 'NODE' };
  any.transport = transportFor(any.device);
  p.queue = [row as any]; p.index = 0;
  return any;
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
