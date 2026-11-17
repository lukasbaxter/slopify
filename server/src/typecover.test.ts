// The playlist cover drawer: every style renders, titles keep every letter,
// and props find room off the artist.
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs';
import { renderTypeCover, renderDailyMix, renderRadio, renderMixBar, fontsDir, titlePath } from './typecover.js';

const flat = (w: number, h: number, c: string, alpha = 255) => sharp({ create: { width: w, height: h, channels: 4, background: { r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16), alpha: alpha / 255 } } }).png().toBuffer();
// Share of a region of the cover that is close to a colour.
async function share(img: Buffer, x0: number, y0: number, x1: number, y1: number, hex: string) {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let hit = 0, all = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * info.width + x) * 3; all++;
    if (Math.abs(data[i] - want[0]) + Math.abs(data[i + 1] - want[1]) + Math.abs(data[i + 2] - want[2]) < 40) hit++;
  }
  return hit / all;
}

describe('playlist covers', () => {
  it('ships its fonts', () => { expect(fs.existsSync(`${fontsDir}/Figtree-Black.ttf`)).toBe(true); });

  // opentype's toPathData wrote NaN for the "t" in "Reggaeton" and the
  // renderer dropped everything after it: the cover read "Re".
  it('writes no NaN into a title\'s outline', () => {
    for (let x = 0; x < 40; x += 0.7) expect(titlePath('Reggaeton', 100, x, 100)).not.toContain('NaN');
  });

  it('draws every letter of a title', async () => {
    const img = await renderTypeCover({ title: 'Reggaeton Hits', style: 'object', color: '#000000', size: 400 });
    // White ink across the whole first line, not just its first two letters.
    const right = await share(img, 200, 20, 380, 120, '#ffffff');
    expect(right).toBeGreaterThan(0.05);
  });

  it('renders each style at the size asked', async () => {
    const person = await flat(300, 500, '#00ff00');
    for (const style of ['editorial', 'behind', 'duotone', 'thisis', 'chart', 'object'] as const) {
      const img = await renderTypeCover({ title: 'Rock Classics', style, color: '#E13300', cutout: person, photo: await flat(400, 400, '#888888'), size: 320 });
      const m = await sharp(img).metadata();
      expect([style, m.width, m.height]).toEqual([style, 320, 320]);
    }
    for (const img of [await renderDailyMix(await flat(300, 300, '#336699'), 3, '#FA4A34', 320), await renderRadio('Daft Punk', [null, null, null], '#89BCF9', 320), await renderMixBar(null, 'House Mix', '#F3FD47', 320)]) {
      expect((await sharp(img).metadata()).width).toBe(320);
    }
  });

  it('a prop with no spot finds room without covering the artist', async () => {
    const person = await flat(320, 640, '#0000ff');
    const red = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#212121"/></svg>');
    const spec = { title: 'X', style: 'editorial' as const, color: '#000000', size: 640, cutout: person };
    const bare = await renderTypeCover(spec);
    const withProp = await renderTypeCover({ ...spec, props: [{ img: red, size: 0.2, tint: '#ff0000' }] });
    expect(await share(withProp, 0, 0, 640, 640, '#ff0000')).toBeGreaterThan(0.02); // it was placed
    expect(await share(withProp, 0, 0, 640, 640, '#0000ff')).toBeCloseTo(await share(bare, 0, 0, 640, 640, '#0000ff'), 3); // not on the artist
  });
});
