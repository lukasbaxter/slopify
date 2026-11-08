import { describe, it, expect } from 'vitest';
import { playTracker, type PlayEvent } from './playEvents.js';

describe('play events of a song played again', () => {
  it('repeat-one never merges the laps into one listen', () => {
    const out: PlayEvent[] = []; let t = 0;
    const tr = playTracker((e) => out.push(e), () => t);
    const at = (sec: number, pos: number) => { t = sec * 1000; tr.report('c1', 'u1', 'Phone', { itemId: 'a', playing: true, position: pos, duration: 30 }); };
    for (let lap = 0; lap < 3; lap++) for (let s = 0; s <= 28; s += 2) at(lap * 30 + s, s);
    tr.close('c1');
    expect(out.map((e) => e.reason)).toEqual(['ended', 'ended', 'ended']);
    expect(out.every((e) => e.track_id === 'a' && e.ms_played <= 30000)).toBe(true);
    expect(out[1].at).toBe(30000);
  });
  it('a seek inside the song is still the same listen', () => {
    const out: PlayEvent[] = []; let t = 0;
    const tr = playTracker((e) => out.push(e), () => t);
    const at = (sec: number, pos: number) => { t = sec * 1000; tr.report('c1', 'u1', 'Phone', { itemId: 'a', playing: true, position: pos, duration: 200 }); };
    at(0, 0); at(2, 2); at(4, 4); at(6, 60); at(8, 62); at(10, 30); at(12, 32);
    tr.close('c1');
    expect(out.length).toBe(1);
  });
});
