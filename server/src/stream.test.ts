import { describe, expect, it } from 'vitest';
import { syntheticPlaylist } from './stream.js';
import fixtures from './fixtures.hls-durations.json' with { type: 'json' };

// The EXTINF sequences ffmpeg actually wrote for three real tracks (44.1, 48
// and 96 kHz), captured from /data/transcodes: the synthetic playlist must
// list the same segments with the same durations (to the ms), except that a
// final sliver under 150 ms is folded into the segment before it.
const durs = (pl: string) => [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));

describe('syntheticPlaylist', () => {
  for (const f of fixtures as { sr: number; ms: number; durs: number[] }[]) {
    it(`matches ffmpeg at ${f.sr} Hz`, () => {
      const pl = syntheticPlaylist(f.ms, f.sr)!;
      const d = durs(pl);
      const real = f.durs;
      const folded = real[real.length - 1] < 0.15;
      expect(d.length).toBe(folded ? real.length - 1 : real.length);
      for (let i = 0; i < d.length - 1; i++) expect(Math.abs(d[i] - real[i])).toBeLessThan(0.001);
      // Total within the database's 25 ms of the decoder's duration.
      expect(Math.abs(d.reduce((a, b) => a + b, 0) - real.reduce((a, b) => a + b, 0))).toBeLessThan(0.03);
      expect(pl).toContain('#EXT-X-PLAYLIST-TYPE:VOD'); expect(pl).toContain('#EXT-X-ENDLIST');
    });
  }
  it('is null without a duration', () => { expect(syntheticPlaylist(0, 44100)).toBeNull(); });
});
