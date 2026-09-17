import { describe, it, expect } from 'vitest';
import { applyEvent, emptySession, positionNow } from './session.js';

describe('session reconciliation', () => {
  it('newest event wins; older ones are rejected', () => {
    const s = emptySession();
    expect(applyEvent(s, { type: 'queue', ts: 1000, queue: ['a', 'b', 'c'], index: 0 }, 'c1', 1000).changed).toBe(true);
    expect(s.active).toBe('c1'); expect(s.trackId).toBe('a'); expect(s.playing).toBe(true);
    expect(applyEvent(s, { type: 'pause', ts: 3000, positionMs: 2000 }, 'c2', 3000).changed).toBe(true);
    expect(s.playing).toBe(false); expect(s.positionMs).toBe(2000);
    // an offline client's action from t=2000 arrives late: rejected
    expect(applyEvent(s, { type: 'next', ts: 2000 }, 'c1', 3500)).toEqual({ changed: false, reason: 'stale' });
    expect(s.trackId).toBe('a');
  });
  it('interpolates the position from the anchor while playing', () => {
    const s = emptySession();
    applyEvent(s, { type: 'queue', ts: 1000, queue: ['a'], index: 0, positionMs: 0 }, 'c1', 1000);
    expect(positionNow(s, 4000)).toBe(3000);
    applyEvent(s, { type: 'pause', ts: 4000 }, 'c1', 4000);
    expect(positionNow(s, 9000)).toBe(3000);
    applyEvent(s, { type: 'seek', ts: 9000, positionMs: 60000 }, 'c1', 9000);
    applyEvent(s, { type: 'play', ts: 9500 }, 'c1', 9500);
    expect(positionNow(s, 10500)).toBe(61000);
  });
  it('progress only counts from the active client and never rewinds a newer action', () => {
    const s = emptySession();
    applyEvent(s, { type: 'queue', ts: 1000, queue: ['a', 'b'], index: 0 }, 'c1', 1000);
    expect(applyEvent(s, { type: 'progress', ts: 1500, positionMs: 500 }, 'c2', 1500).changed).toBe(false);
    expect(applyEvent(s, { type: 'progress', ts: 1500, positionMs: 500 }, 'c1', 1500).changed).toBe(true);
    applyEvent(s, { type: 'seek', ts: 2000, positionMs: 30000 }, 'c2', 2000);
    expect(applyEvent(s, { type: 'progress', ts: 1900, positionMs: 900 }, 'c1', 2100).changed).toBe(false);
    expect(s.positionMs).toBe(30000);
  });
  it('next/previous walk the queue; previous restarts after 3 s', () => {
    const s = emptySession();
    applyEvent(s, { type: 'queue', ts: 1, queue: ['a', 'b', 'c'], index: 1 }, 'c1', 1);
    applyEvent(s, { type: 'next', ts: 2 }, 'c1', 2); expect(s.trackId).toBe('c');
    applyEvent(s, { type: 'next', ts: 3 }, 'c1', 3); expect(s.trackId).toBe('a'); // wraps
    applyEvent(s, { type: 'previous', ts: 4, positionMs: 5000 }, 'c1', 4); expect(s.trackId).toBe('a'); expect(s.positionMs).toBe(0);
    applyEvent(s, { type: 'previous', ts: 5, positionMs: 1000 }, 'c1', 5); expect(s.trackId).toBe('a'); // at index 0: stays
  });
});
