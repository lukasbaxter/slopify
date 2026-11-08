import { test, expect } from '@playwright/test';
import { open, longest } from './player-helpers';

// A play() that never settles (iOS holds it for a page in the background,
// and the promise then neither resolves nor rejects) must not leave the start
// half done: the track was never marked loaded and its play never reported.
test.skip(({ isMobile }) => isMobile, 'one run is enough');

test('a start whose play() never settles still counts the song as loaded and played', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const orig = HTMLMediaElement.prototype.play;
    // The song in __hangFor plays (slowed, so it outlasts the 8 s a play
    // takes to count), but the promise of its first play() never settles.
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      const p = orig.call(this);
      if (w.__hangFor && this.dataset.track === w.__hangFor) { w.__hangFor = null; this.playbackRate = 0.4; p.catch(() => {}); return new Promise(() => {}); }
      return p;
    };
  });
  await open(page);
  const plays: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/plays')) plays.push(r.postData() || ''); });
  const id = await longest(page, 'Analytical');
  await page.evaluate((x) => { (window as any).__hangFor = x; }, id);
  // Not awaited: on the old code the start never finishes.
  await page.evaluate(async (x) => { const w = window as any; const p = w.__player; if (p.mirroring) p.relay?.claim(); const rows = await w.__jf.itemsByIds([x]); void p.playQueue(rows, 0, null); }, id);
  try {
    await expect.poll(() => page.evaluate(() => (window as any).__player.debugElement()), { timeout: 15000 }).toBeGreaterThan(0.2);
    await expect.poll(() => plays.some((b) => b.includes(id)), { timeout: 16000 }).toBe(true);
  } finally {
    await page.evaluate(() => { const p = (window as any).__player; if (p.playing) p.toggle(); }).catch(() => {});
  }
});
