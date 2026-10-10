import { describe, expect, it } from 'vitest';
import { albumLoudness, gainDb, parseEbur128 } from './loudness.js';

describe('gainDb', () => {
  it('turns a loud master down to -14 LUFS', () => {
    expect(gainDb({ loudness: -8.3, peak: 0.4 })).toBe(-5.7);
  });
  it('turns a quiet one up only as far as its peak allows (true peak stays at -1 dBTP)', () => {
    expect(gainDb({ loudness: -20, peak: -10 })).toBe(6); // room to spare
    expect(gainDb({ loudness: -20, peak: -3 })).toBe(2);  // stops at -1
    expect(gainDb({ loudness: -16, peak: 0.2 })).toBe(0); // already peaking: no boost, and no cut either
  });
  it('is null until measured, 0 for silence, and clamped', () => {
    expect(gainDb(null)).toBeNull();
    expect(gainDb({ loudness: null, peak: null })).toBeNull();
    expect(gainDb({ loudness: -70, peak: -70 })).toBe(0);
    expect(gainDb({ loudness: -45, peak: -40 })).toBe(12);
    expect(gainDb({ loudness: 0, peak: 2 })).toBe(-14);
    expect(Object.is(gainDb({ loudness: -14, peak: -1 }), -0)).toBe(false);
  });
});

describe('albumLoudness', () => {
  it('is the length-weighted energy average, with the loudest peak', () => {
    const a = albumLoudness([{ loudness: -10, peak: -0.5, durationMs: 200000 }, { loudness: -20, peak: -6, durationMs: 200000 }]);
    // equal lengths: 10*log10((10^-1 + 10^-2) / 2) = -12.6
    expect(a.loudness).toBeCloseTo(-12.6, 1);
    expect(a.peak).toBe(-0.5);
  });
  it('skips unmeasured and silent tracks', () => {
    expect(albumLoudness([{ loudness: null, peak: null, durationMs: 1000 }])).toEqual({ loudness: null, peak: null });
    expect(albumLoudness([{ loudness: -70, peak: -70, durationMs: 1000 }, { loudness: -9, peak: 0, durationMs: 1000 }]).loudness).toBe(-9);
  });
});

describe('parseEbur128', () => {
  const summary = `[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -11.3 LUFS
    Threshold: -21.6 LUFS

  Loudness range:
    LRA:         6.1 LU

  True peak:
    Peak:        0.4 dBFS`;
  it('reads integrated loudness and true peak from the summary', () => {
    expect(parseEbur128(`frame lines...\n${summary}\n`)).toEqual({ loudness: -11.3, peak: 0.4 });
  });
  it('maps -inf (digital silence) to the floor, and no summary to null', () => {
    expect(parseEbur128('Summary:\n    I:         -70.0 LUFS\n    Peak:       -inf dBFS')).toEqual({ loudness: -70, peak: -70 });
    expect(parseEbur128('ffmpeg: Invalid data found when processing input')).toBeNull();
  });
});
