import { test, expect } from '@playwright/test';
import { open, albumIds, play } from './player-helpers';

// A gapless (or crossfade) start whose next song will not play gives the music
// back to the song that was ending, which then ends and advances the ordinary
// way. The queue position had already moved to the next song, so that advance
// went one further and the next song was skipped.
test.skip(({ isMobile }) => isMobile, 'desktop player (Web Audio)');

test('a gapless start that fails falls back without skipping the next song', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const orig = HTMLMediaElement.prototype.play;
    // The first play() asked of the song in __failOnce is refused, as a
    // browser refuses an element it will not start.
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (w.__failOnce && this.dataset.track === w.__failOnce) { w.__failOnce = null; return Promise.reject(new DOMException('refused by the test', 'NotAllowedError')); }
      return orig.call(this);
    };
  });
  await open(page);
  try {
    await page.evaluate(() => (window as any).__updatePrefs({ crossfade: 0, gapless: true }));
    const { albumId, ids } = await albumIds(page, 'Second Wind');
    await page.evaluate((id) => { (window as any).__failOnce = id; }, ids[1]);
    await play(page, ids.slice(0, 3), albumId);
    // The transition was tried and refused.
    await expect.poll(() => page.evaluate(() => ((window as any).__slopifyMediaLog || []).join('\n')), { timeout: 30000 }).toMatch(/next would not play/);
    // The next song that plays after the first is the second, not the third.
    await expect.poll(() => page.evaluate((first) => ((window as any).__ev as any[]).filter((e) => e.t === 'playing' && e.track && e.track !== first).map((e) => e.track)[0] || null, ids[0]), { timeout: 20000 }).not.toBeNull();
    const after = await page.evaluate((first) => ((window as any).__ev as any[]).filter((e) => e.t === 'playing' && e.track && e.track !== first).map((e) => e.track)[0], ids[0]);
    expect(after).toBe(ids[1]);
    expect(await page.evaluate(() => (window as any).__player.current?.Id)).toBe(ids[1]);
  } finally {
    await page.evaluate(() => { const p = (window as any).__player; if (p.playing) p.toggle(); }).catch(() => {});
  }
});
