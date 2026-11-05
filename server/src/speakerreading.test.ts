import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS from the web app
import { looksStalled, stillFlipping } from '../../web/src/player/speakerReading.js';

describe('readings from a speaker the app drives itself', () => {
  it('a pause is not undone by a reading from the speaker still flipping', () => {
    const paused = { playing: false, pos: 7, at: 1000 };
    expect(stillFlipping(paused, { playing: true }, 2000)).toBe(true);
    expect(stillFlipping(paused, { playing: true }, 3500)).toBe(false); // someone resumed it on the speaker
    expect(stillFlipping(paused, { playing: false }, 2000)).toBe(false);
    expect(stillFlipping({ playing: true, pos: 7, at: 1000 }, { playing: true }, 2000)).toBe(false);
  });
  it('a stuck counter restarts music that should be playing, never paused music', () => {
    expect(looksStalled({ playing: true, pos: 0 }, { playing: true }, 0)).toBe(true);
    expect(looksStalled({ playing: false, pos: 0 }, { playing: true }, 0)).toBe(false);
    expect(looksStalled({ playing: true, pos: 30 }, { playing: true }, 0)).toBe(false);
    expect(looksStalled({ playing: true, pos: 0 }, { playing: true }, 4)).toBe(false);
  });
});
